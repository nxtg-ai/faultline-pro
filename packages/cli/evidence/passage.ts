/**
 * Evidence passages taken from the fetched page, not from the model.
 *
 * A grounded verdict cites URLs; the examiner found that the only "span" we
 * carried was sliced from the model's own reply, and that no fetch time was
 * recorded (EP4 recert 02-codex-evidence.md row 3; Honor System point #3;
 * GoPMO 1.18.11.3 P1b). This module fetches each cited source through a fetch
 * the caller supplies (the API passes its SSRF-guarded fetch, which checks
 * every redirect hop), reads at most `maxBytes`, and keeps the passage of the
 * page text that best matches the claim, with the fetch time and a SHA-256 of
 * the bytes read. When no passage matches, it says so; it never invents one.
 *
 * Google's grounding terms govern Grounded Results (the model's answer, its
 * links and Search Suggestions). The passage is the publisher's own text,
 * fetched by following the cited link the way a reader's click would.
 */
import { createHash } from 'node:crypto';
import type { Source, SourceEvidence, VerificationResult } from '../types.js';

export type EvidenceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface EvidenceOptions {
  /** The fetch to use. The API passes its guarded fetchOutboundFollow. */
  fetch: EvidenceFetch;
  /** Per-source deadline in ms (default 6000). */
  timeoutMs?: number;
  /** Bytes read from each page at most (default 1,500,000). */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_BYTES = 1_500_000;
const PASSAGE_MAX_CHARS = 400;
const USER_AGENT = 'FaultlineEvidence/1.0 (+https://faultline.nxtg.ai)';
const TEXT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'from', 'has', 'have', 'had',
  'its', 'into', 'than', 'then', 'they', 'their', 'there', 'which', 'who', 'whom', 'will', 'would',
  'can', 'could', 'been', 'being', 'also', 'not', 'but', 'all', 'any', 'one', 'our', 'out', 'over',
  'such', 'some', 'more', 'most', 'other', 'about', 'after', 'before', 'between', 'during', 'per',
]);

/** Lowercase content tokens of at least 3 characters, numbers included, stopwords removed. */
export function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.,-]*[\p{L}\p{N}]|[\p{L}\p{N}]{3,}/gu) ?? [])
    .map((t) => t.replace(/[',]/g, '').replace(/\.$/, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Visible text of an HTML page: script, style, noscript, svg and template
 * bodies dropped, tags removed, entities decoded, whitespace collapsed. This
 * extracts text to read; it is never rendered, so it is not a sanitiser.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|blockquote)\s*>/gi, '. ')
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .replace(/(\.\s*){2,}/g, '. ')
    .trim();
}

/**
 * The page sentence that shares the most content tokens with the claim, with
 * the next sentence appended when the first is short, cut at PASSAGE_MAX_CHARS.
 * Null when no sentence shares at least max(2, 40% of the claim's tokens).
 */
export function pickPassage(pageText: string, claimText: string): string | null {
  const claim = new Set(contentTokens(claimText));
  if (claim.size === 0) return null;
  const need = Math.max(2, Math.ceil(claim.size * 0.4));
  const sentences = pageText.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  let best = -1;
  let bestScore = 0;
  sentences.forEach((s, i) => {
    const score = new Set(contentTokens(s).filter((t) => claim.has(t))).size;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best < 0 || bestScore < need) return null;
  let passage = sentences[best];
  if (passage.length < 80 && sentences[best + 1]) passage = `${passage} ${sentences[best + 1]}`;
  if (passage.length > PASSAGE_MAX_CHARS) {
    const cut = passage.slice(0, PASSAGE_MAX_CHARS);
    passage = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), PASSAGE_MAX_CHARS - 40))}…`;
  }
  return passage;
}

/** Read at most maxBytes of a body; reports whether it stopped early. */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { bytes, truncated };
}

const isBlocked = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'OutboundUrlBlockedError' || /blocked|not allowed|private address/i.test(err.message));

/** Fetch one source and find its passage. Never throws. */
export async function fetchSourceEvidence(source: Source, claimText: string, opts: EvidenceOptions): Promise<SourceEvidence> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const stamp = () => new Date().toISOString();
  if (typeof source.uri !== 'string' || !/^https?:\/\//i.test(source.uri)) {
    return { status: 'blocked', passage: null, fetchedAt: stamp() };
  }
  let res: Response;
  try {
    res = await opts.fetch(source.uri, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: isBlocked(err) ? 'blocked' : 'fetch_failed', passage: null, fetchedAt: stamp() };
  }
  const finalUri = res.url && res.url !== source.uri ? { finalUri: res.url } : {};
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 'http_error', passage: null, fetchedAt: stamp(), httpStatus: res.status, ...finalUri };
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TEXT_TYPES.includes(type)) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 'unsupported_type', passage: null, fetchedAt: stamp(), httpStatus: res.status, ...finalUri };
  }
  let read: { bytes: Uint8Array; truncated: boolean };
  try {
    read = await readCapped(res, maxBytes);
  } catch {
    return { status: 'fetch_failed', passage: null, fetchedAt: stamp(), httpStatus: res.status, ...finalUri };
  }
  const fetchedAt = stamp();
  const contentSha256 = createHash('sha256').update(read.bytes).digest('hex');
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(read.bytes);
  const text = type === 'text/plain' ? raw.replace(/\s+/g, ' ').trim() : htmlToText(raw);
  const passage = pickPassage(text, claimText);
  return {
    status: passage === null ? 'no_match' : 'ok',
    passage,
    fetchedAt,
    httpStatus: res.status,
    contentSha256,
    ...(read.truncated ? { truncated: true } : {}),
    ...finalUri,
  };
}

/**
 * The verdict with each cited source's evidence attached, fetched in
 * parallel. A verdict whose check never ran, or that cites nothing, is
 * returned as given. The verdict's status and explanation never change.
 */
export async function attachEvidence(result: VerificationResult, claimText: string, opts: EvidenceOptions): Promise<VerificationResult> {
  if (result.apiError === true || !Array.isArray(result.sources) || result.sources.length === 0) return result;
  const sources = await Promise.all(result.sources.map(async (s) => ({ ...s, evidence: await fetchSourceEvidence(s, claimText, opts) })));
  return { ...result, sources };
}
