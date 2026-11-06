/**
 * Direct DOI check for citation claims (N-237). Deterministic: no model, no
 * search.
 *
 * A citation claim that carries a DOI is first looked up in the DOI handle
 * registry (doi.org). A DOI the registry has never heard of is a fabricated or
 * broken reference: `contradicted`. A DOI that resolves is then looked up in
 * Crossref and its registered title is compared, here, with the cited title:
 * a match is `supported`, a clear mismatch is `contradicted` (the DOI belongs
 * to a different work). Anything less certain returns null and the claim goes
 * to the normal search-based verify.
 *
 * PRIVACY RULE (binding): the only scan data either lookup sends is the
 * normalized DOI, in the URL path. No title, author, claim text, query
 * parameter, user id or key id goes in the URL, the headers or a body; the
 * only header is our fixed User-Agent. Crossref is called only after doi.org
 * answers responseCode 1, and the title comparison runs locally.
 *
 * A network error, a timeout, a redirect, a non-JSON reply or any registry
 * answer other than 1 or 100 never invents a verdict: null, normal verify.
 */
import type { Claim, Source, VerificationResult } from '../types.js';
import { normalizeDoi } from '../lib/citation.js';
import type { EvidenceFetch } from './passage.js';

/** The retriever name a DOI verdict carries in its provenance; billing requires a non-empty retriever. */
export const DOI_RETRIEVER = 'doi-resolver';

/** The only header a DOI lookup sends. */
export const DOI_USER_AGENT = 'Faultline (+https://faultline.nxtg.ai)';

/** Per-request deadline in ms. */
export const DOI_TIMEOUT_MS = 5000;

/** Largest reply read from either registry; a Crossref work record with its reference list is well under this. */
const MAX_REPLY_CHARS = 2_000_000;

/** Title similarity at or above this is the same work. */
export const TITLE_MATCH_THRESHOLD = 0.85;

/** Title similarity below this, with no containment, is a different work. Between the two: not settled here. */
export const TITLE_MISMATCH_THRESHOLD = 0.4;

/** A cited title shorter than this (in words) is never called a mismatch: too little to compare. */
const MIN_TITLE_WORDS_FOR_MISMATCH = 3;

/** Longest registered title quoted back in an explanation or a source title. */
const MAX_QUOTED_TITLE_CHARS = 300;

export interface DoiCheckOptions {
  /**
   * One-hop fetch. The API passes its SSRF-guarded fetchOutbound; the CLI
   * uses global fetch. A 3xx is not followed: it reads as unavailable.
   */
  fetch: EvidenceFetch;
  /** Per-request deadline in ms (default DOI_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** The DOI as URL path segments, each percent-encoded, `/` kept as the separator. */
export function doiPath(doi: string): string {
  return doi.split('/').map(encodeURIComponent).join('/');
}

/** The doi.org handle-registry lookup URL for a normalized DOI. */
export function doiHandleUrl(doi: string): string {
  return `https://doi.org/api/handles/${doiPath(doi)}`;
}

/** The Crossref work-record URL for a normalized DOI. */
export function crossrefWorkUrl(doi: string): string {
  return `https://api.crossref.org/works/${doiPath(doi)}`;
}

/** The public resolver link a reader can open. */
export function doiResolverUrl(doi: string): string {
  return `https://doi.org/${doiPath(doi)}`;
}

/** Lowercase words of a title, diacritics, markup and punctuation removed. */
export function titleWords(title: string): string[] {
  return title
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/**
 * How alike two titles are, 0 to 1. Identical word sequences, or one title's
 * whole word sequence inside the other (a cited title missing its subtitle, or
 * carrying one the registry stores separately), score 1 when the shorter has
 * at least 3 words. Otherwise the Dice coefficient of their word sets.
 *
 * @example
 *   titleSimilarity('Deep learning', 'Deep Learning.') // 1
 *   titleSimilarity('Deep learning', 'Protein folding with transformers') // 0
 */
export function titleSimilarity(a: string, b: string): number {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const ja = wa.join(' ');
  const jb = wb.join(' ');
  if (ja === jb) return 1;
  const [shorter, longer] = wa.length <= wb.length ? [ja, jb] : [jb, ja];
  if (Math.min(wa.length, wb.length) >= 3 && ` ${longer} `.includes(` ${shorter} `)) return 1;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return (2 * shared) / (sa.size + sb.size);
}

type Lookup = { ok: true; status: number; body: unknown } | { ok: false };

/**
 * GET `url` with only our User-Agent, under a deadline. The body is parsed as
 * JSON whatever the HTTP status (doi.org answers an unknown DOI with 404 and
 * `responseCode: 100`). A 3xx, a thrown error, a timeout, an oversized or
 * non-JSON body all read as `{ ok: false }`.
 */
async function lookup(url: string, opts: DoiCheckOptions): Promise<Lookup> {
  try {
    const res = await opts.fetch(url, {
      method: 'GET',
      headers: { 'user-agent': DOI_USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DOI_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    const text = await res.text();
    if (text.length > MAX_REPLY_CHARS) return { ok: false };
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: true, status: res.status, body: undefined };
    }
  } catch {
    return { ok: false };
  }
}

/** What doi.org said about a DOI. */
type HandleAnswer = 'found' | 'not_found' | 'unknown';

async function lookUpHandle(doi: string, opts: DoiCheckOptions): Promise<HandleAnswer> {
  // Privacy rule: only the normalized DOI, in the path; no query, no scan data.
  const reply = await lookup(doiHandleUrl(doi), opts);
  if (!reply.ok || !reply.body || typeof reply.body !== 'object') return 'unknown';
  const code = (reply.body as { responseCode?: unknown }).responseCode;
  if (code === 1 && reply.status === 200) return 'found';
  if (code === 100) return 'not_found';
  return 'unknown';
}

/** The registered title (and title with subtitle) Crossref holds, or null when it holds none we can read. */
async function lookUpCrossrefTitles(doi: string, opts: DoiCheckOptions): Promise<string[] | null> {
  // Privacy rule: only the normalized DOI, in the path; no mailto, no query, no scan data.
  const reply = await lookup(crossrefWorkUrl(doi), opts);
  if (!reply.ok || reply.status !== 200 || !reply.body || typeof reply.body !== 'object') return null;
  const message = (reply.body as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
  const titles = strings((message as { title?: unknown }).title);
  if (titles.length === 0) return null;
  const subtitles = strings((message as { subtitle?: unknown }).subtitle);
  const withSubtitle = subtitles.length > 0 ? [`${titles[0]}: ${subtitles[0]}`] : [];
  return [...titles, ...withSubtitle];
}

function quote(title: string): string {
  const flat = title.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_QUOTED_TITLE_CHARS ? `${flat.slice(0, MAX_QUOTED_TITLE_CHARS - 1)}…` : flat;
}

function verdict(claim: Claim, status: 'supported' | 'contradicted', explanation: string, sources: Source[], at: string): VerificationResult {
  return {
    claimId: claim.id,
    status,
    explanation,
    sources,
    provenance: { provider: DOI_RETRIEVER, model: 'doi.org+crossref', verifiedAt: at, retriever: DOI_RETRIEVER, retrievedAt: at },
  };
}

/**
 * Settle a citation claim from its DOI, or return null to send it to the
 * normal verify. Null for: a claim with no citation DOI (or one that fails
 * normalizeDoi), a doi.org answer other than 1 or 100, any lookup failure, a
 * DOI Crossref does not hold (another registration agency), a cited citation
 * with no title, and a title similarity between the two thresholds.
 */
export async function checkCitationDoi(claim: Claim, opts: DoiCheckOptions): Promise<VerificationResult | null> {
  const doi = normalizeDoi(claim.citation?.doi);
  if (!doi) return null;

  const handle = await lookUpHandle(doi, opts);
  if (handle === 'not_found') {
    return verdict(claim, 'contradicted',
      `The cited DOI ${doi} does not resolve: the DOI registry (doi.org) has no record of it, so the work cannot be found where the citation points.`,
      [{ title: `doi.org handle lookup for ${doi}`, uri: doiHandleUrl(doi) }],
      new Date().toISOString());
  }
  if (handle !== 'found') return null;

  const cited = claim.citation?.title;
  if (!cited) return null;
  const registered = await lookUpCrossrefTitles(doi, opts);
  if (!registered) return null;

  const best = registered
    .map((title) => ({ title, score: titleSimilarity(cited, title) }))
    .reduce((a, b) => (b.score > a.score ? b : a));
  const at = new Date().toISOString();
  const sources: Source[] = [
    { title: quote(registered[0]!), uri: doiResolverUrl(doi) },
    { title: `Crossref record for ${doi}`, uri: crossrefWorkUrl(doi) },
  ];
  if (best.score >= TITLE_MATCH_THRESHOLD) {
    return verdict(claim, 'supported',
      `The DOI ${doi} resolves, and the title registered for it ("${quote(best.title)}") matches the cited title.`,
      sources, at);
  }
  if (best.score < TITLE_MISMATCH_THRESHOLD && titleWords(cited).length >= MIN_TITLE_WORDS_FOR_MISMATCH) {
    return verdict(claim, 'contradicted',
      `This DOI belongs to a different work: "${quote(registered[0]!)}". The cited title does not match the record registered for ${doi}.`,
      sources, at);
  }
  return null;
}

/** True when the DOI check is switched off (FAULTLINE_DOI_CHECK=off). */
export function doiCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FAULTLINE_DOI_CHECK ?? '').toLowerCase() === 'off';
}

/** The CLI's DOI fetch: global fetch, one hop (the lookup sets `redirect: 'manual'` and a deadline). */
const globalDoiFetch: EvidenceFetch = (url, init) => fetch(url, init);

let defaultOptions: DoiCheckOptions = { fetch: globalDoiFetch };

/**
 * Set the DOI fetch every scan uses when it passes none of its own. The API
 * calls this once at boot with its SSRF-guarded fetchOutbound, so no route can
 * reach global fetch for a DOI lookup.
 */
export function setDefaultDoiCheck(options: DoiCheckOptions): void {
  defaultOptions = options;
}

/** Restore the CLI default (global fetch). Test seam. */
export function resetDefaultDoiCheck(): void {
  defaultOptions = { fetch: globalDoiFetch };
}

/**
 * The DOI options a verify run uses: none when FAULTLINE_DOI_CHECK=off or the
 * run passed `false`; else the run's own options, else the default.
 */
export function resolveDoiCheck(override?: DoiCheckOptions | false): DoiCheckOptions | null {
  if (override === false || doiCheckDisabled()) return null;
  return override ?? defaultOptions;
}
