import type { Source } from '../types';
import type { Retriever } from './base_provider';
import { recordUsage } from '../lib/usage-sink';

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
  annotations?: UrlCitation[];
}

interface OutputItem {
  type?: string;
  content?: OutputContent[];
}

interface ResponsesPayload {
  output?: OutputItem[];
}

export class OpenAIWebSearchRetriever implements Retriever {
  readonly name = 'openai-web-search';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.model =
      (typeof process !== 'undefined' ? process.env?.FAULTLINE_OPENAI_SEARCH_MODEL : undefined) ||
      DEFAULT_MODEL;
  }

  async retrieve(claimText: string): Promise<Source[]> {
    if (!this.apiKey) return [];
    try {
      const data = await this.callAPI(claimText);
      return parseResponsesSources(data, MAX_RESULTS);
    } catch (err) {
      // Retrieval must never throw into the consensus engine — [] degrades the
      // claim to parametric judgement, surfaced honestly by the providers.
      if (typeof process !== 'undefined' && process.env?.FAULTLINE_DEBUG) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openai-web-search] retrieve failed: ${msg}\n`);
      }
      return [];
    }
  }

  /**
   * Call the OpenAI Responses API with the web_search tool. Isolated for easy
   * mocking in tests (mirrors OpenAIProvider.callAPI).
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
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI Responses API error: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as ResponsesPayload;
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
    return payload;
  }
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
