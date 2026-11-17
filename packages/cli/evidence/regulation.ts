/**
 * Deterministic check for US healthcare regulation citations.
 *
 * A claim that cites a CFR section, a National Coverage Determination or a
 * Local Coverage Determination is looked up at the official public source
 * before any model or search runs:
 *
 *   - CFR: the eCFR versioner API (https://www.ecfr.gov/api/versioner/v1).
 *     `GET /versions/title-{title}.json?part=&section=` — HTTP 200 with an
 *     empty version list, or HTTP 404 `{"status":404,"error":"Not Found"}`,
 *     means that section is not in the Code. A paragraph such as (c) is then
 *     read from that section's XML. Measured 2026-11-17.
 *   - NCD: `GET https://api.coverage.cms.gov/v1/reports/national-coverage-ncd/`
 *     (the full list; no key). The display id is matched locally. A complete
 *     list (`next_token` empty) that does not contain it means the NCD is not
 *     published. Measured 2026-11-17: 345 NCDs, `next_token` empty.
 *   - LCD: document endpoints require a license token. `GET /v1/metadata/license-agreement`
 *     returns `data[0].Token` (a UUID, one hour). Retrieving it is how CMS
 *     records acceptance of the AMA CPT, ADA CDT and AHA UB-04 agreements
 *     (Coverage API 1.5 release notes, 2025-06-17). The token is sent only as
 *     `Authorization: Bearer` on `GET /v1/data/lcd/?lcdid=`. HTTP 200 with an
 *     empty `data` array and a note that the parameters returned 0 results
 *     means that LCD is not in the database. HTTP 401 means the token was
 *     missing or refused, which is a failed lookup, not a missing document.
 *
 * Verdicts, and only these:
 *   - the section or document is not there → `contradicted`, source = the lookup URL
 *   - an explicit title clearly does not match the official one → `mixed`
 *   - it is there, and the claim only asserts the citation (and, when it
 *     gives one, a title that matches) → `supported`
 *   - the claim asserts more than the citation, and the citation is real
 *     with no title mismatch → null (the normal verify judges the assertion)
 *   - a timeout, a redirect, a non-JSON body, a 401/429/5xx, an incomplete
 *     NCD list, or any shape we do not document → null. A failed lookup
 *     never produces a verdict.
 *
 * PRIVACY: the only scan data in a request is the allowlisted identifier, in
 * the path or the `part` / `section` / `lcdid` query. No title, claim text,
 * user or key. The only headers are the fixed User-Agent and, for an LCD
 * document, the license token. The token never goes in the URL.
 */
import type { Claim, Source, VerificationResult } from '../types.js';
import type { EvidenceFetch } from './passage.js';
import { compareTitles } from './doi.js';
import {
  MAX_REGULATION_CITATIONS,
  cfrHeading,
  cfrParagraphPaths,
  findRegulationCitations,
  isIdentityClaim,
  type RegulationCitation,
} from '../lib/regulation-citation.js';

/** The retriever name a regulation verdict carries. Billing requires a non-empty retriever. */
export const REGULATION_RETRIEVER = 'regulation-resolver';

/** The only User-Agent a regulation lookup sends. */
export const REGULATION_USER_AGENT = 'Faultline (+https://faultline.nxtg.ai)';

/** Per-request deadline in ms. */
export const REGULATION_TIMEOUT_MS = 5000;

const MAX_REPLY_CHARS = 2_000_000;
const MAX_QUOTED_TITLE_CHARS = 300;

const ECFR_ORIGIN = 'https://www.ecfr.gov';
const CMS_ORIGIN = 'https://api.coverage.cms.gov';

export const NCD_REPORT_URL = `${CMS_ORIGIN}/v1/reports/national-coverage-ncd/`;
export const LCD_LICENSE_URL = `${CMS_ORIGIN}/v1/metadata/license-agreement`;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RegulationCheckOptions {
  /**
   * One-hop fetch. The API passes its SSRF-guarded fetchOutbound; the CLI
   * uses global fetch. A 3xx is not followed: it reads as unavailable.
   */
  fetch: EvidenceFetch;
  /** Per-request deadline in ms (default REGULATION_TIMEOUT_MS). */
  timeoutMs?: number;
}

type Reply = { status: number; text: string };

/** GET `url`. A 3xx, a throw, a timeout or an oversized body is null. */
async function get(url: string, opts: RegulationCheckOptions, headers: Record<string, string>): Promise<Reply | null> {
  try {
    const res = await opts.fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? REGULATION_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await res.text();
    if (text.length > MAX_REPLY_CHARS) return null;
    return { status: res.status, text };
  } catch {
    return null;
  }
}

function baseHeaders(): Record<string, string> {
  return { 'user-agent': REGULATION_USER_AGENT };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function queryIs(parsed: URL, keys: string[], values: Record<string, RegExp>): boolean {
  const got = [...parsed.searchParams.keys()];
  if (got.length !== keys.length || got.some((key, i) => key !== keys[i])) return false;
  return keys.every((key) => {
    const all = parsed.searchParams.getAll(key);
    return all.length === 1 && values[key]!.test(all[0]!);
  });
}

/**
 * True when `url` is one of the four lookup URLs this checker builds: eCFR
 * versions or section XML, the NCD report, the LCD license, or one LCD
 * document. Anything else — another host, a query we did not mean, a `.` or
 * `..` segment — is not requested.
 */
export function regulationUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (parsed.href.includes('..') || parsed.pathname.toLowerCase().includes('%2e')) return false;
  const partSection = { part: /^[1-9]\d{0,3}$/, section: /^[1-9]\d{0,3}\.[1-9]\d{0,3}$/ };
  if (parsed.origin === ECFR_ORIGIN) {
    const versions = /^\/api\/versioner\/v1\/versions\/title-([1-9]\d?)\.json$/.exec(parsed.pathname);
    const full = /^\/api\/versioner\/v1\/full\/(\d{4}-\d{2}-\d{2})\/title-([1-9]\d?)\.xml$/.exec(parsed.pathname);
    if (!versions && !full) return false;
    if (!queryIs(parsed, ['part', 'section'], partSection)) return false;
    const section = parsed.searchParams.get('section') ?? '';
    return section.split('.')[0] === parsed.searchParams.get('part');
  }
  if (parsed.origin !== CMS_ORIGIN) return false;
  if (parsed.pathname === '/v1/reports/national-coverage-ncd/' && parsed.search === '') return true;
  if (parsed.pathname === '/v1/metadata/license-agreement' && parsed.search === '') return true;
  if (parsed.pathname === '/v1/data/lcd/') return queryIs(parsed, ['lcdid'], { lcdid: /^[1-9]\d{3,5}$/ });
  if (parsed.pathname === '/v1/data/ncd/') {
    return queryIs(parsed, ['ncdid', 'ncdver'], { ncdid: /^[1-9]\d{0,7}$/, ncdver: /^[1-9]\d{0,7}$/ });
  }
  return false;
}

export function ecfrVersionsUrl(title: string, part: string, section: string): string {
  const url = new URL(`${ECFR_ORIGIN}/api/versioner/v1/versions/title-${title}.json`);
  url.searchParams.set('part', part);
  url.searchParams.set('section', section);
  return url.href;
}

export function ecfrSectionUrl(date: string, title: string, part: string, section: string): string {
  const url = new URL(`${ECFR_ORIGIN}/api/versioner/v1/full/${date}/title-${title}.xml`);
  url.searchParams.set('part', part);
  url.searchParams.set('section', section);
  return url.href;
}

export function ncdDocumentUrl(id: string, version: string): string {
  const url = new URL(`${CMS_ORIGIN}/v1/data/ncd/`);
  url.searchParams.set('ncdid', id);
  url.searchParams.set('ncdver', version);
  return url.href;
}

export function lcdDocumentUrl(id: string): string {
  const url = new URL(`${CMS_ORIGIN}/v1/data/lcd/`);
  url.searchParams.set('lcdid', id);
  return url.href;
}

interface CmsBody {
  statusId: number;
  notes: string;
  nextToken: string | undefined;
  data: unknown[];
}

function readCms(body: unknown): CmsBody | null {
  if (!body || typeof body !== 'object') return null;
  const meta = (body as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  const status = (meta as { status?: unknown }).status;
  if (!status || typeof status !== 'object') return null;
  const statusId = (status as { id?: unknown }).id;
  if (typeof statusId !== 'number') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const notes = (meta as { notes?: unknown }).notes;
  const nextToken = (meta as { next_token?: unknown }).next_token;
  return {
    statusId,
    notes: typeof notes === 'string' ? notes : '',
    nextToken: typeof nextToken === 'string' ? nextToken : undefined,
    data,
  };
}

function safeInt(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  return /^[1-9]\d{0,7}$/.test(text) ? text : null;
}

/** Markup out, entities decoded, whitespace collapsed. A quoted title is plain text. */
function plainOfficial(value: string): string {
  let out = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '<') { depth += 1; continue; }
    if (ch === '>') { if (depth > 0) depth -= 1; continue; }
    if (depth === 0) out += ch;
  }
  return out
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, ent: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (ent[0] === '#') {
        const cp = (ent[1] === 'x' || ent[1] === 'X') ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
        return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
      }
      return named[ent.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function quote(title: string): string {
  const flat = plainOfficial(title);
  return flat.length > MAX_QUOTED_TITLE_CHARS ? `${flat.slice(0, MAX_QUOTED_TITLE_CHARS - 1)}…` : flat;
}

type TitleVerdict = 'ok' | 'mismatch' | 'unsure';

/** How an explicit cited title compares with one or more official titles. No cited title is `ok`. */
function titlesVerdict(cited: string | undefined, officials: string[]): { verdict: TitleVerdict; official: string | null } {
  const cleaned = officials.map(plainOfficial).filter((t) => t.length > 0);
  const official = cleaned[0] ?? null;
  if (!cited) return { verdict: 'ok', official };
  if (!official) return { verdict: 'unsure', official: null };
  const compared = cleaned.map((title) => compareTitles(cited, title));
  if (compared.includes('match')) return { verdict: 'ok', official };
  if (compared.every((c) => c === 'mismatch')) return { verdict: 'mismatch', official };
  return { verdict: 'unsure', official };
}

type Hit = {
  kind: 'not_found' | 'mismatch' | 'ok' | 'failed' | 'unsure';
  explanation: string;
  sources: Source[];
};

function notFound(explanation: string, source: Source): Hit {
  return { kind: 'not_found', explanation, sources: [source] };
}

function failed(): Hit {
  return { kind: 'failed', explanation: '', sources: [] };
}

interface EcfrVersion {
  date: string;
  name: string | null;
  removed: boolean;
}

function readVersions(body: unknown, section: string): { empty: boolean } | { current: EcfrVersion } | null {
  if (!body || typeof body !== 'object') return null;
  const versions = (body as { content_versions?: unknown }).content_versions;
  const countRaw = (body as { meta?: { result_count?: unknown } }).meta?.result_count;
  const count = countRaw === undefined || countRaw === null ? null : Number(countRaw);
  if (!Array.isArray(versions)) return null;
  if (versions.length === 0 && (count === null || count === 0)) return { empty: true };
  if (versions.length === 0 || count === 0) return null;
  const usable: EcfrVersion[] = [];
  for (const row of versions) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as { date?: unknown; identifier?: unknown; name?: unknown; removed?: unknown; type?: unknown };
    if (rec.identifier !== section || typeof rec.date !== 'string' || !DATE_SHAPE.test(rec.date)) continue;
    if (rec.type !== undefined && rec.type !== 'section') continue;
    usable.push({ date: rec.date, name: typeof rec.name === 'string' ? rec.name : null, removed: rec.removed === true });
  }
  if (usable.length === 0) return null;
  usable.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { current: usable[usable.length - 1]! };
}

async function lookupCfr(cite: RegulationCitation, opts: RegulationCheckOptions): Promise<Hit> {
  const title = cite.cfrTitle!;
  const part = cite.part!;
  const section = cite.section!;
  const versionsUrl = ecfrVersionsUrl(title, part, section);
  if (!regulationUrlAllowed(versionsUrl)) return failed();
  const reply = await get(versionsUrl, opts, baseHeaders());
  if (!reply) return failed();
  const body = parseJson(reply.text);
  const source: Source = { title: `eCFR versions lookup for ${cite.label}`, uri: versionsUrl };
  if (reply.status === 404 && body && typeof body === 'object'
    && (body as { status?: unknown }).status === 404
    && (body as { error?: unknown }).error === 'Not Found') {
    return notFound(`${cite.label} is not in the Code of Federal Regulations. The eCFR has no title ${title}.`, source);
  }
  if (reply.status !== 200) return failed();
  const versions = readVersions(body, section);
  if (!versions) return failed();
  if ('empty' in versions) {
    return notFound(`${cite.label} is not in the Code of Federal Regulations. The eCFR has no section ${section} in title ${title}.`, source);
  }
  if (versions.current.removed) {
    return notFound(`${cite.label} is not in the Code of Federal Regulations. Section ${section} of title ${title} has been removed.`, source);
  }
  const heading = versions.current.name ? cfrHeading(versions.current.name) : null;
  const paragraphs = cite.paragraphs ?? [];
  let paragraphSource: Source | null = null;
  if (paragraphs.length > 0) {
    const xmlUrl = ecfrSectionUrl(versions.current.date, title, part, section);
    if (!regulationUrlAllowed(xmlUrl)) return failed();
    const xml = await get(xmlUrl, opts, baseHeaders());
    if (!xml || xml.status !== 200) return failed();
    const paths = cfrParagraphPaths(xml.text, section);
    if (!paths) return failed();
    paragraphSource = { title: heading ? quote(heading) : `eCFR section ${title} CFR ${section}`, uri: xmlUrl };
    if (!paths.has(paragraphs.join('.'))) {
      const chain = paragraphs.map((p) => `(${p})`).join('');
      return notFound(
        `${cite.label} is not in the Code of Federal Regulations. Section ${section} has no paragraph ${chain}.`,
        paragraphSource,
      );
    }
  }
  const titles = titlesVerdict(cite.title, heading ? [heading] : []);
  const recordSource = paragraphSource ?? { title: heading ? quote(heading) : cite.label, uri: versionsUrl };
  const sources = paragraphSource ? [recordSource, source] : [recordSource];
  return finish(cite, titles, sources, `${cite.label} is in the eCFR${heading ? `, in section ${section} "${quote(heading)}"` : ''}.`);
}

function finish(cite: RegulationCitation, titles: { verdict: TitleVerdict; official: string | null }, sources: Source[], exists: string): Hit {
  if (titles.verdict === 'mismatch' && titles.official) {
    return {
      kind: 'mismatch',
      explanation: `The cited title does not match the official title of ${cite.label} ("${quote(titles.official)}").`,
      sources,
    };
  }
  if (titles.verdict === 'unsure') return { kind: 'unsure', explanation: '', sources: [] };
  return { kind: 'ok', explanation: exists, sources };
}

async function lookupNcd(cite: RegulationCitation, opts: RegulationCheckOptions): Promise<Hit> {
  if (!regulationUrlAllowed(NCD_REPORT_URL)) return failed();
  const reply = await get(NCD_REPORT_URL, opts, baseHeaders());
  if (!reply || reply.status !== 200) return failed();
  const cms = readCms(parseJson(reply.text));
  if (!cms || cms.statusId !== 200 || cms.nextToken !== '') return failed();
  const report: Source = { title: `CMS national coverage determination list`, uri: NCD_REPORT_URL };
  const rows = cms.data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object'
    && (row as { document_display_id?: unknown }).document_display_id === cite.ncdId);
  if (rows.length === 0) {
    return notFound(`${cite.label} is not in the CMS national coverage determination list.`, report);
  }
  const officials = rows.map((row) => (typeof row.title === 'string' ? row.title : '')).filter((t) => t.length > 0);
  const id = safeInt(rows[0]!.document_id);
  const version = safeInt(rows[0]!.document_version);
  const document = id && version
    ? { title: officials[0] ? quote(officials[0]) : cite.label, uri: ncdDocumentUrl(id, version) }
    : report;
  const titles = titlesVerdict(cite.title, officials);
  const named = officials[0] ? `, "${quote(officials[0])}"` : '';
  return finish(cite, titles, document.uri === report.uri ? [document] : [document, report],
    `${cite.label} is a national coverage determination${named}.`);
}

async function lookupLcd(cite: RegulationCitation, opts: RegulationCheckOptions): Promise<Hit> {
  const docUrl = lcdDocumentUrl(cite.lcdNumber!);
  if (!regulationUrlAllowed(LCD_LICENSE_URL) || !regulationUrlAllowed(docUrl)) return failed();
  const license = await get(LCD_LICENSE_URL, opts, baseHeaders());
  if (!license || license.status !== 200) return failed();
  const issued = readCms(parseJson(license.text));
  const token = issued && issued.statusId === 200 && issued.data[0] && typeof issued.data[0] === 'object'
    ? (issued.data[0] as { Token?: unknown }).Token
    : undefined;
  if (typeof token !== 'string' || !UUID_SHAPE.test(token)) return failed();
  const reply = await get(docUrl, opts, { ...baseHeaders(), authorization: `Bearer ${token}` });
  if (!reply) return failed();
  if (reply.status === 401 || reply.status === 400) return failed();
  if (reply.status !== 200) return failed();
  const cms = readCms(parseJson(reply.text));
  if (!cms || cms.statusId !== 200) return failed();
  const source: Source = { title: `CMS Coverage API lookup for ${cite.label}`, uri: docUrl };
  if (cms.data.length === 0) {
    if (!cms.notes.includes('0 results')) return failed();
    return notFound(`${cite.label} is not in the CMS Medicare Coverage Database.`, source);
  }
  const rows = cms.data.filter((row): row is Record<string, unknown> => {
    if (!row || typeof row !== 'object') return false;
    return safeInt((row as { lcd_id?: unknown }).lcd_id) === cite.lcdNumber;
  });
  if (rows.length === 0) return failed();
  const officials = rows.map((row) => (typeof row.title === 'string' ? row.title : '')).filter((t) => t.length > 0);
  const titles = titlesVerdict(cite.title, officials);
  const named = officials[0] ? `, "${quote(officials[0])}"` : '';
  const record: Source = { title: officials[0] ? quote(officials[0]) : cite.label, uri: docUrl };
  return finish(cite, titles, [record], `${cite.label} is a local coverage determination${named}.`);
}

async function lookupOne(cite: RegulationCitation, opts: RegulationCheckOptions): Promise<Hit> {
  if (cite.kind === 'cfr') return lookupCfr(cite, opts);
  if (cite.kind === 'ncd') return lookupNcd(cite, opts);
  return lookupLcd(cite, opts);
}

function verdict(claim: Claim, status: 'supported' | 'contradicted' | 'mixed', explanation: string, sources: Source[]): VerificationResult {
  const at = new Date().toISOString();
  return {
    claimId: claim.id,
    status,
    explanation,
    sources,
    provenance: {
      provider: REGULATION_RETRIEVER,
      model: 'ecfr+cms-coverage',
      verifiedAt: at,
      retriever: REGULATION_RETRIEVER,
      retrievedAt: at,
    },
  };
}

/**
 * Settle a claim from regulation citations in its text, or return null to
 * send it to the normal verify. Null when the text cites no regulation, cites
 * more than MAX_REGULATION_CITATIONS, a lookup fails, a title comparison is
 * not decisive, or the citation is real but the claim asserts something beyond
 * it (and no title mismatches).
 */
export async function checkRegulationCitation(claim: Claim, opts: RegulationCheckOptions): Promise<VerificationResult | null> {
  const text = typeof claim?.text === 'string' ? claim.text : '';
  const cites = findRegulationCitations(text);
  if (cites.length === 0 || cites.length > MAX_REGULATION_CITATIONS) return null;
  const hits: Hit[] = [];
  for (const cite of cites) hits.push(await lookupOne(cite, opts));

  const missing = hits.find((h) => h.kind === 'not_found');
  if (missing) return verdict(claim, 'contradicted', missing.explanation, missing.sources);
  const mismatch = hits.find((h) => h.kind === 'mismatch');
  if (mismatch) return verdict(claim, 'mixed', mismatch.explanation, mismatch.sources);
  if (hits.some((h) => h.kind === 'failed' || h.kind === 'unsure')) return null;
  if (!isIdentityClaim(text, cites.map((c) => ({ start: c.start, end: c.spanEnd })))) return null;
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    for (const source of hit.sources) {
      if (seen.has(source.uri)) continue;
      seen.add(source.uri);
      sources.push(source);
    }
  }
  return verdict(claim, 'supported', hits.map((h) => h.explanation).filter((e) => e.length > 0).join(' '), sources);
}

/** True when the regulation check is switched off (FAULTLINE_REGULATION_CHECK=off). */
export function regulationCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FAULTLINE_REGULATION_CHECK ?? '').toLowerCase() === 'off';
}

const globalRegulationFetch: EvidenceFetch = (url, init) => fetch(url, init);

let defaultOptions: RegulationCheckOptions = { fetch: globalRegulationFetch };

/**
 * Set the regulation fetch every scan uses when it passes none of its own.
 * The API calls this once at boot with its SSRF-guarded fetchOutbound.
 */
export function setDefaultRegulationCheck(options: RegulationCheckOptions): void {
  defaultOptions = options;
}

/** Restore the CLI default (global fetch). Test seam. */
export function resetDefaultRegulationCheck(): void {
  defaultOptions = { fetch: globalRegulationFetch };
}

/**
 * The regulation options a verify run uses: none when
 * FAULTLINE_REGULATION_CHECK=off or the run passed `false`; else the run's
 * own options, else the default.
 */
export function resolveRegulationCheck(override?: RegulationCheckOptions | false): RegulationCheckOptions | null {
  if (override === false || regulationCheckDisabled()) return null;
  return override ?? defaultOptions;
}
