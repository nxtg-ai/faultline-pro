import type { Source } from '../types';
import type { RetrievalOutcome, StatusRetriever } from './base_provider';
import { recordUsage } from '../lib/usage-sink';
import { RetrievalError } from './retrieval-error';
import { outOfCreditsTag, readErrorBody } from './out-of-credits';
import { CALL_CEILINGS } from './call-ceilings';

/**
 * ParallelSearchRetriever: sources for a claim from Parallel's Search API.
 *
 * It is the retrieval half of the `parallel` grounding mode (cli/grounding.ts):
 * this finds the sources, then Gemini judges the claim against them with no
 * search tool of its own. Parallel's terms allow that use, provided one query's
 * output is never given to another customer (docs/grounding-providers.md).
 *
 * Wire shape (POST https://api.parallel.ai/v1/search, header x-api-key; the
 * v1 Search API reference on docs.parallel.ai, read 2026-11-05):
 *   request   { objective, search_queries: [string], mode,
 *               max_chars_total, advanced_settings: { max_results,
 *               excerpt_settings: { max_chars_per_result } } }
 *   response  { search_id, results: [{ url, title, publish_date, excerpts: [string] }], warnings, usage }
 * The request schema refuses unlisted fields, so nothing else is sent.
 * advanced_settings.source_policy and fetch_policy are left unset: no domain
 * is preferred or excluded, and Parallel's default page cache applies.
 *
 * Mode: FAULTLINE_PARALLEL_MODE, default `advanced` (Parallel's own default and
 * its highest-quality mode, about 3 s). Priced per request in the API's rate
 * table: advanced and basic 5 USD per 1,000, fast and turbo 1 USD per 1,000
 * (parallel.ai/pricing, 2026-11-05).
 */

/** The endpoint. Fixed: never derived from input. */
export const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';

/** The modes the v1 Search API takes. */
export const PARALLEL_SEARCH_MODES = ['advanced', 'basic', 'fast', 'turbo'] as const;
export type ParallelSearchMode = (typeof PARALLEL_SEARCH_MODES)[number];

/** The default mode: Parallel's own default. */
export const DEFAULT_PARALLEL_MODE: ParallelSearchMode = 'advanced';

/** A listed mode, else the default. Case and surrounding space ignored. */
export function parseParallelMode(value: unknown): ParallelSearchMode {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (PARALLEL_SEARCH_MODES as readonly string[]).includes(v) ? (v as ParallelSearchMode) : DEFAULT_PARALLEL_MODE;
}

/** The label usage and provenance record for a mode, e.g. 'parallel-search-advanced'. It keys the rate table. */
export function parallelSearchModel(mode: ParallelSearchMode): string {
  return `parallel-search-${mode}`;
}

/**
 * The call ceiling, from the one table (providers/call-ceilings.ts). A search
 * reply has no output tokens, so the bound is on how many results one request
 * may return and how much excerpt text reaches the judge's prompt.
 */
export const PARALLEL_SEARCH_CEILING = CALL_CEILINGS.parallelSearch.retrieve;

/** Deadline for one search request. advanced runs about 3 s. */
export const PARALLEL_SEARCH_TIMEOUT_MS = 20_000;

/** At most this many keyword queries, each at most this many words (the reference asks for 3 to 6). */
const MAX_QUERIES = 2;
const QUERY_WORDS = 6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'that', 'this',
  'these', 'those', 'it', 'its', 'which', 'who', 'whom', 'than', 'then', 'there', 'their', 'they', 'he', 'she',
  'his', 'her', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'about', 'over', 'also', 'not',
]);

/**
 * Keyword queries for a claim: its content words (stopwords dropped,
 * punctuation stripped) in order, in groups of up to six, at most two groups.
 * A claim with no content word gets its own text, cut to six words.
 */
const WORD_START = /^[\p{L}\p{N}$£€]$/u;
const WORD_END = /^[\p{L}\p{N}%$.,-]$/u;

/** One word with leading and trailing punctuation removed, in one linear pass over its characters. */
function trimWord(word: string): string {
  const chars = Array.from(word);
  let start = 0;
  let end = chars.length;
  while (start < end && !WORD_START.test(chars[start])) start += 1;
  while (end > start && !WORD_END.test(chars[end - 1])) end -= 1;
  while (end > start && (chars[end - 1] === '.' || chars[end - 1] === ',')) end -= 1;
  return chars.slice(start, end).join('');
}

export function keywordQueries(claimText: string): string[] {
  const words = claimText
    .split(/\s+/)
    .map(trimWord)
    .filter((w) => w.length > 0);
  const content = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const pool = content.length > 0 ? content : words;
  const queries: string[] = [];
  for (let i = 0; i < pool.length && queries.length < MAX_QUERIES; i += QUERY_WORDS) {
    queries.push(pool.slice(i, i + QUERY_WORDS).join(' '));
  }
  return queries.length > 0 ? queries : [claimText.trim().slice(0, 200)];
}

/** The objective: the claim, and what would confirm or refute it. */
export function searchObjective(claimText: string): string {
  return `Check this claim: "${claimText}". Find authoritative, primary sources that state whether it is true or false: `
    + 'evidence that confirms it, and evidence that refutes or contradicts it, including the dates and figures involved.';
}

interface ParallelResult {
  url?: unknown;
  title?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
}

interface ParallelPayload {
  search_id?: unknown;
  results?: unknown;
}

export class ParallelSearchRetriever implements StatusRetriever {
  readonly name = 'parallel-search';
  readonly mode: ParallelSearchMode;
  /** The mode label recorded in provenance and usage. */
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  /** `opts.mode` overrides FAULTLINE_PARALLEL_MODE; an unknown value is the default. */
  constructor(apiKey: string, opts: { mode?: string; timeoutMs?: number } = {}) {
    this.apiKey = apiKey;
    this.mode = parseParallelMode(opts.mode ?? process.env.FAULTLINE_PARALLEL_MODE);
    this.model = parallelSearchModel(this.mode);
    this.timeoutMs = opts.timeoutMs ?? PARALLEL_SEARCH_TIMEOUT_MS;
  }

  /**
   * The sources found. Every failure throws RetrievalError with a classified
   * reason, so the claim reads as not checked: no key, a non-200 answer, a
   * timeout, an unreadable payload, and a search that returned no usable result.
   * Nothing here falls back to another search.
   */
  async retrieve(claimText: string): Promise<Source[]> {
    if (!this.apiKey) throw new RetrievalError('provider_error', new Error('no Parallel API key for the source search'));
    try {
      const payload = await this.callAPI(claimText);
      const sources = parseParallelResults(payload);
      if (sources.length === 0) throw new RetrievalError('provider_error', new Error('Parallel search returned no usable result'));
      return sources;
    } catch (err) {
      const failure = RetrievalError.fromError(err);
      if (process.env.FAULTLINE_DEBUG) {
        // The reason only: the raw error can carry the provider payload.
        process.stderr.write(`[parallel-search] retrieve failed: ${failure.reason}\n`);
      }
      throw failure;
    }
  }

  /**
   * The same search, with how it ended (see RetrievalStatus). Never throws.
   * Details are fixed phrases: no error text, claim text or key is carried.
   * A 200 whose results hold no source a reader can open is zero here, where
   * retrieve() rejects it; a body that is not JSON, has no results list, or
   * holds any malformed result entry, is parse_error.
   */
  async retrieveWithStatus(claimText: string): Promise<RetrievalOutcome> {
    if (!this.apiKey) return { status: 'provider_error', sources: [], detail: 'missing api key' };
    let payload: unknown;
    try {
      payload = await this.callAPI(claimText);
    } catch (err) {
      const outcome = classifyParallelError(err);
      if (process.env.FAULTLINE_DEBUG) process.stderr.write(`[parallel-search] retrieve failed: ${outcome.status} (${outcome.detail})\n`);
      return outcome;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !Array.isArray((payload as ParallelPayload).results)) {
      return { status: 'parse_error', sources: [], detail: 'unexpected shape' };
    }
    // Checked before parseParallelResults, which drops a malformed entry: one
    // malformed entry makes the whole reply parse_error, even next to valid ones.
    if (!((payload as ParallelPayload).results as unknown[]).every(isWellFormedResult)) {
      return { status: 'parse_error', sources: [], detail: 'unexpected shape' };
    }
    const sources = parseParallelResults(payload as ParallelPayload);
    return sources.length > 0 ? { status: 'hits', sources } : { status: 'zero', sources: [] };
  }

  /** The request body for one claim. Exported shape for tests; only fields the reference lists. */
  requestBody(claimText: string): Record<string, unknown> {
    return {
      objective: searchObjective(claimText),
      search_queries: keywordQueries(claimText),
      mode: this.mode,
      max_chars_total: PARALLEL_SEARCH_CEILING.maxCharsTotal,
      advanced_settings: {
        max_results: PARALLEL_SEARCH_CEILING.maxResults,
        excerpt_settings: { max_chars_per_result: PARALLEL_SEARCH_CEILING.maxCharsPerResult },
      },
    };
  }

  /** One POST, aborted at the deadline. A request that answered 200 is recorded as one billed search. */
  async callAPI(claimText: string): Promise<ParallelPayload> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Parallel search timed out', 'TimeoutError')), this.timeoutMs);
    try {
      const response = await fetch(PARALLEL_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify(this.requestBody(claimText)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const tag = outOfCreditsTag(response.status, await readErrorBody(response));
        throw new Error(`Parallel Search API error: ${response.status} ${response.statusText}${tag}`);
      }
      // A 200 is a billed request, whatever its body holds.
      recordUsage({ provider: 'parallel', model: this.model, callType: 'parallel-search', inputTokens: 0, outputTokens: 0, isGrounding: true });
      return (await response.json()) as ParallelPayload;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A result entry is an object whose url is a string; title and excerpts, when present, are a string and a list. */
export function isWellFormedResult(r: unknown): boolean {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false;
  const e = r as ParallelResult;
  if (typeof e.url !== 'string') return false;
  if (e.title !== undefined && e.title !== null && typeof e.title !== 'string') return false;
  return e.excerpts === undefined || e.excerpts === null || Array.isArray(e.excerpts);
}

/** The status for a search that threw. The detail is a fixed phrase, never the error message. */
function classifyParallelError(err: unknown): RetrievalOutcome {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return { status: 'timeout', sources: [], detail: 'deadline reached' };
  if (err instanceof SyntaxError) return { status: 'parse_error', sources: [], detail: 'bad json' };
  const http = err instanceof Error ? /^Parallel Search API error: (\d{3}) /.exec(err.message) : null;
  if (http) return { status: 'provider_error', sources: [], detail: `http ${http[1]}` };
  if (err instanceof TypeError) return { status: 'provider_error', sources: [], detail: 'network error' };
  return { status: 'provider_error', sources: [], detail: 'request failed' };
}

/**
 * Map Parallel results to sources: title, uri, publishDate, the excerpts as
 * returned, and the excerpts joined as the snippet the grounded judge reads.
 * A result without an http(s) url is not a source the reader can open and is
 * dropped; duplicates by url are dropped.
 */
export function parseParallelResults(payload: ParallelPayload, maxResults = PARALLEL_SEARCH_CEILING.maxResults): Source[] {
  const results = Array.isArray(payload?.results) ? (payload.results as ParallelResult[]) : [];
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const uri = typeof r?.url === 'string' ? r.url.trim() : '';
    if (!/^https?:\/\//i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    const title = typeof r.title === 'string' && r.title.trim().length > 0 ? r.title.trim() : uri;
    const excerpts = Array.isArray(r.excerpts)
      ? r.excerpts.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim())
      : [];
    const joined = excerpts.join(' … ');
    const snippet = joined.length > PARALLEL_SEARCH_CEILING.maxCharsPerResult
      ? `${joined.slice(0, PARALLEL_SEARCH_CEILING.maxCharsPerResult - 1)}…`
      : joined;
    const publishDate = typeof r.publish_date === 'string' && r.publish_date.trim().length > 0 ? r.publish_date.trim() : undefined;
    sources.push({
      title,
      uri,
      ...(snippet ? { snippet, excerpts } : {}),
      ...(publishDate ? { publishDate } : {}),
    });
    if (sources.length >= maxResults) break;
  }
  return sources;
}
