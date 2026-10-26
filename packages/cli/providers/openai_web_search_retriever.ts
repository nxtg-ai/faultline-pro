import type { Source } from '../types';
import type { StatusRetriever, RetrievalOutcome } from './base_provider';
import { recordUsage } from '../lib/usage-sink';
import { CALL_CEILINGS } from './call-ceilings';
import { isOutputTruncatedError, isResponsesTruncated, OutputTruncatedError } from './output-truncation';

/**
 * OpenAIWebSearchRetriever — provider-agnostic grounding via OpenAI's Responses
 * API web_search tool. This is the PRIMARY retriever for consensus (funded key,
 * not rate-throttled like the free-tier gemini native googleSearch). It is one
 * impl of the Retriever interface; GeminiGroundingRetriever stays as an alternate.
 *
 * Wire shape (verified live against gpt-4o + web_search, 2026-06-21):
 *   response.output[]  — contains a { type:'message' } item
 *   message.content[]  — a { type:'output_text', text, annotations[] } item
 *   annotations[]      — { type:'url_citation', title, url, start_index, end_index }
 *
 * The url_citation start/end index slice the message `text` into a per-source
 * span (the PREFERRED snippet path). When indices are missing/invalid the full
 * message text is used as a shared snippet fallback.
 */
const DEFAULT_MODEL = 'gpt-4o';
const MAX_RESULTS = 6;

interface UrlCitation {
  type?: string;
  title?: string;
  url?: string;
  start_index?: number;
  end_index?: number;
}

interface OutputContent {
  type?: string;
  text?: string;
  /** Set on a { type:'refusal' } item: the model declined the request. */
  refusal?: string;
  annotations?: UrlCitation[];
}

interface OutputItem {
  type?: string;
  /** Set on a { type:'web_search_call' } item: 'failed' when the search itself failed. */
  status?: string;
  content?: OutputContent[];
}

interface ResponsesPayload {
  output?: OutputItem[];
  status?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

export class OpenAIWebSearchRetriever implements StatusRetriever {
  readonly name = 'openai-web-search';
  private readonly apiKey: string;
  /** The model that runs the web_search call (recorded in provenance and usage). */
  readonly model: string;

  /** Deadline for one search request in ms; absent means no deadline (the consensus path's behaviour). */
  private readonly timeoutMs?: number;

  /** `opts.model` overrides FAULTLINE_OPENAI_SEARCH_MODEL and the default. */
  constructor(apiKey: string, opts: { model?: string; timeoutMs?: number } = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.model =
      opts.model ||
      (typeof process !== 'undefined' ? process.env?.FAULTLINE_OPENAI_SEARCH_MODEL : undefined) ||
      DEFAULT_MODEL;
  }

  /** The sources, or [] when the search failed or found nothing. Never throws (the consensus engine relies on that). */
  async retrieve(claimText: string): Promise<Source[]> {
    return (await this.retrieveWithStatus(claimText)).sources;
  }

  /** The search with how it ended (see RetrievalStatus). Never throws. */
  async retrieveWithStatus(claimText: string): Promise<RetrievalOutcome> {
    if (!this.apiKey) return { status: 'provider_error', sources: [], detail: 'missing api key' };
    let data: ResponsesPayload;
    try {
      data = await this.callAPI(claimText);
    } catch (err) {
      // Retrieval must never throw into the consensus engine: [] degrades the
      // claim to parametric judgement, surfaced honestly by the providers.
      const outcome = classifyRetrievalError(err);
      if (typeof process !== 'undefined' && process.env?.FAULTLINE_DEBUG) {
        process.stderr.write(`[openai-web-search] retrieve failed: ${outcome.status} (${outcome.detail})\n`);
      }
      return outcome;
    }
    return classifyResponsesPayload(data, MAX_RESULTS);
  }

  /**
   * Call the OpenAI Responses API with the web_search tool, capped at the
   * retrieve ceiling (providers/call-ceilings.ts). Throws OutputTruncatedError
   * when the reply stopped there. Isolated for easy mocking in tests (mirrors
   * OpenAIProvider.callAPI).
   */
  async callAPI(claimText: string): Promise<ResponsesPayload> {
    const input =
      `Find authoritative web sources (with their URLs) that CONFIRM or REFUTE the ` +
      `following claim. Quote the relevant span from each source.\n\nClaim: "${claimText}"`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        tools: [{ type: 'web_search' }],
        max_output_tokens: CALL_CEILINGS.openaiResponses.retrieve.maxOutputTokens,
        input,
      }),
      ...(this.timeoutMs ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
    });

    if (!response.ok) throw new RetrievalHttpError(response.status, response.statusText);

    let payload: ResponsesPayload;
    try {
      payload = (await response.json()) as ResponsesPayload;
    } catch {
      throw new RetrievalParseError();
    }
    // JSON null, a list or a bare value is not a Responses payload: say so
    // before anything below reads a field off it.
    if (!isObject(payload)) throw new RetrievalShapeError();
    // BLG-005 defect-1+2: the web_search retrieval leg is ~84–90% of per-scan
    // cost and sits behind the Retriever seam (NOT the LLMProvider fan-out) —
    // capture it here or production undercounts by ~10×. isGrounding bills the
    // per-call web_search tool fee on top of the model's search-content tokens.
    const usage = (payload as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    recordUsage({
      provider: 'openai',
      model: this.model,
      callType: 'web_search',
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      isGrounding: true,
    });
    // A search cut off at its ceiling is a failed retrieval: retrieve() turns the throw into [].
    if (isResponsesTruncated(payload)) throw new OutputTruncatedError('openai-web-search', 'retrieve');
    return payload;
  }
}

/** The Responses API answered non-2xx. */
export class RetrievalHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`OpenAI Responses API error: ${status} ${statusText}`);
    this.name = 'RetrievalHttpError';
    this.status = status;
  }
}

/** A 2xx reply whose body was not JSON. */
export class RetrievalParseError extends Error {
  constructor() {
    super('OpenAI Responses API reply was not valid JSON');
    this.name = 'RetrievalParseError';
  }
}

/** A 2xx reply that was JSON but not an object (null, a list or a bare value). */
export class RetrievalShapeError extends Error {
  constructor() {
    super('OpenAI Responses API reply was not an object');
    this.name = 'RetrievalShapeError';
  }
}

/**
 * The status for a search that threw. The detail is a fixed phrase, never the
 * error message, so no response text reaches a report.
 */
export function classifyRetrievalError(err: unknown): RetrievalOutcome {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return { status: 'timeout', sources: [], detail: 'deadline reached' };
  if (err instanceof RetrievalHttpError) return { status: 'provider_error', sources: [], detail: `http ${err.status}` };
  if (err instanceof RetrievalParseError) return { status: 'parse_error', sources: [], detail: 'bad json' };
  if (err instanceof RetrievalShapeError) return { status: 'parse_error', sources: [], detail: 'unexpected shape' };
  if (isOutputTruncatedError(err)) return { status: 'provider_error', sources: [], detail: 'output truncated' };
  if (err instanceof TypeError) return { status: 'provider_error', sources: [], detail: 'network error' };
  return { status: 'provider_error', sources: [], detail: 'request failed' };
}

/** Response statuses that end a search without a usable answer. */
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'incomplete']);

const PARSE_ERROR: RetrievalOutcome = { status: 'parse_error', sources: [], detail: 'unexpected shape' };

/**
 * The status for a 2xx Responses payload. Failures are read first, so a
 * message that cites pages never turns a failed search into hits:
 *
 * - a content-filter stop is policy_block;
 * - a response status of failed, cancelled or incomplete, a response error
 *   object, or a web_search_call item that failed is provider_error (or
 *   timeout or policy_block when the error code says so);
 * - a refusal is policy_block;
 * - a payload that is not an object, an output that is not a list of objects,
 *   a message whose content is not a list of objects, an output_text block
 *   whose text is not a string or whose annotations are not a list, or a
 *   url_citation whose url is not a string, is parse_error.
 *
 * Only a reply that passes all of that and cites nothing is zero. Details are
 * fixed phrases: no error message, code or response text is carried.
 */
export function classifyResponsesPayload(data: ResponsesPayload, maxResults = MAX_RESULTS): RetrievalOutcome {
  if (!isObject(data) || !Array.isArray(data.output)) return PARSE_ERROR;
  if (isObject(data.incomplete_details) && data.incomplete_details.reason === 'content_filter') {
    return { status: 'policy_block', sources: [], detail: 'content filter' };
  }
  if (data.error !== undefined && data.error !== null) return classifyResponseError(data.error);
  if (typeof data.status === 'string' && TERMINAL_FAILURES.has(data.status)) {
    return { status: 'provider_error', sources: [], detail: `response ${data.status}` };
  }
  if (!data.output.every(isObject)) return PARSE_ERROR;
  if (data.output.some((it) => it.type === 'web_search_call' && it.status === 'failed')) {
    return { status: 'provider_error', sources: [], detail: 'search call failed' };
  }
  const messages = data.output.filter((it) => it.type === 'message');
  if (!messages.every((m) => Array.isArray(m.content) && m.content.every(isObject))) return PARSE_ERROR;
  const blocks = messages.flatMap((m) => m.content as OutputContent[]);
  if (blocks.some((c) => c.type === 'refusal')) return { status: 'policy_block', sources: [], detail: 'refusal' };
  if (!blocks.every(isWellFormedBlock)) return PARSE_ERROR;
  const sources = parseResponsesSources(data, maxResults);
  return sources.length > 0 ? { status: 'hits', sources } : { status: 'zero', sources: [] };
}

/** A response error object, named by its code only: the message may echo the request. */
function classifyResponseError(error: unknown): RetrievalOutcome {
  const code = isObject(error) && typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (code.includes('timeout') || code.includes('timed_out')) return { status: 'timeout', sources: [], detail: 'response timed out' };
  if (/content_filter|content_policy|safety|policy_violation/.test(code)) {
    return { status: 'policy_block', sources: [], detail: 'response blocked' };
  }
  return { status: 'provider_error', sources: [], detail: 'response failed' };
}

/** An output_text block must carry string text and a list of annotation objects; a url_citation, a string url. */
function isWellFormedBlock(block: OutputContent): boolean {
  if (block.type !== 'output_text') return true;
  if (typeof block.text !== 'string' || !Array.isArray(block.annotations)) return false;
  return block.annotations.every((a) => isObject(a) && (a.type !== 'url_citation' || typeof a.url === 'string'));
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a Responses-API payload into Source[]. Exported for direct unit testing
 * independent of any live API call.
 *
 * - Walks output[] for the message item, then its output_text content.
 * - Each url_citation annotation → one Source; per-source snippet sliced from the
 *   message text via start_index/end_index (PREFERRED). On invalid indices, falls
 *   back to the full message text as a shared snippet so evidence still flows.
 * - De-duplicates by URL (search tools commonly repeat a domain across spans).
 */
export function parseResponsesSources(data: ResponsesPayload, maxResults = MAX_RESULTS): Source[] {
  const output = Array.isArray(data?.output) ? data.output : [];
  const message = output.find((it) => it?.type === 'message');
  if (!message) return [];

  const contents = Array.isArray(message.content) ? message.content : [];
  const textBlock = contents.find((c) => typeof c?.text === 'string' && Array.isArray(c?.annotations))
    ?? contents.find((c) => Array.isArray(c?.annotations));
  if (!textBlock) return [];

  const fullText = typeof textBlock.text === 'string' ? textBlock.text : '';
  const annotations = Array.isArray(textBlock.annotations) ? textBlock.annotations : [];

  const sources: Source[] = [];
  const seen = new Set<string>();

  for (const ann of annotations) {
    if (ann?.type !== 'url_citation') continue;
    const uri = typeof ann.url === 'string' ? ann.url : '';
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);

    const title = typeof ann.title === 'string' && ann.title.length > 0 ? ann.title : uri;
    const snippet = sliceSpan(fullText, ann.start_index, ann.end_index);

    sources.push({ title, uri, snippet });
    if (sources.length >= maxResults) break;
  }

  return sources;
}

/**
 * Slice the per-source evidence span from the message text. Returns the trimmed
 * span when start/end are valid in-bounds integers; otherwise the full message
 * text as a shared-snippet fallback (or undefined when there is no text at all).
 */
function sliceSpan(text: string, start?: number, end?: number): string | undefined {
  if (!text) return undefined;
  const validSpan =
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= text.length &&
    end > start;
  if (validSpan) {
    const span = text.slice(start as number, end as number).trim();
    if (span.length > 0) return span;
  }
  return text;
}
