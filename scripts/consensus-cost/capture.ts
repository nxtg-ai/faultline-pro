/**
 * capture.ts — engine-fidelity request capture layer (G1 heart).
 *
 * Every LLM call the Faultline engine makes ultimately goes through `fetch`
 * (openai/claude/web_search via raw fetch; gemini via @google/genai → fetch).
 * This module installs a transport-level `fetch` interceptor, RUNS the engine's
 * OWN functions, and records the exact outgoing HTTP request the engine builds.
 *
 * Because we execute the engine's real code path, the captured prompt bytes are
 * the production prompt bytes BY CONSTRUCTION — no re-implementation, no
 * copy-paste. This is how fidelity is preserved for the two call-types whose
 * prompt is inlined (extraction, web_search) and cannot be statically imported.
 *
 * NO NETWORK, NO SPEND: in capture mode the interceptor returns a canned local
 * response so the engine function completes without a real API call.
 */

import type { Claim, Source } from '../../packages/cli/types';

export type CallType = 'extraction' | 'web_search' | 'grounded-verify:openai' | 'grounded-verify:claude' | 'grounded-verify:gemini';

export interface CapturedRequest {
  callType: CallType;
  url: string;
  method: string;
  /** Request headers with any auth/api-key field stripped (never logged). */
  headers: Record<string, string>;
  /** Parsed JSON request body the engine emitted. */
  body: any;
  /** The extracted prompt/input string for the fidelity assertion. */
  prompt: string;
}

/** Representative sample inputs (one per call-type) used for the fidelity gate. */
export const SAMPLE = {
  extractionText:
    'The Eiffel Tower was completed in 1889 and stands 330 metres tall. It attracts roughly 7 million visitors each year.',
  claim: { id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 } as Claim,
  sources: [
    { title: 'History of the Eiffel Tower', uri: 'https://example.org/eiffel', snippet: 'Completed March 1889.' },
    { title: 'Paris Landmarks', uri: 'https://example.org/paris', snippet: 'Built for the 1889 Exposition.' },
  ] as Source[],
};

const AUTH_HEADER_KEYS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']);

function stripAuth(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = AUTH_HEADER_KEYS.has(k.toLowerCase()) ? '<stripped>' : v;
  }
  return out;
}

/** Canned local response keyed by endpoint so the engine fn completes (no spend). */
function cannedResponse(url: string): Response {
  let payload: unknown;
  if (url.includes('/v1/responses')) {
    payload = { output: [{ type: 'message', content: [{ type: 'output_text', text: '', annotations: [] }] }], usage: { input_tokens: 0, output_tokens: 0 } };
  } else if (url.includes('openai.com')) {
    payload = { choices: [{ message: { content: '{"status":"mixed","explanation":"n/a"}' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
  } else if (url.includes('anthropic.com')) {
    payload = { content: [{ type: 'text', text: '{"status":"mixed","explanation":"n/a"}' }], usage: { input_tokens: 0, output_tokens: 0 } };
  } else {
    // Gemini generateContent (googleapis / @google/genai transport)
    payload = { candidates: [{ content: { parts: [{ text: '[]' }] } }], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } };
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Run an engine call-path with `fetch` intercepted. Returns every HTTP request
 * the engine emitted during `run()`. Restores the real fetch afterwards.
 */
async function withCapture(run: () => Promise<unknown>): Promise<Array<{ url: string; method: string; headers: Record<string, string>; body: any }>> {
  const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = (init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET').toUpperCase();
    const rawHeaders: Record<string, string> = {};
    const h = init?.headers ?? (typeof input === 'object' ? input?.headers : undefined);
    if (h) {
      if (h instanceof Headers) h.forEach((v, k) => (rawHeaders[k] = v));
      else if (Array.isArray(h)) for (const [k, v] of h) rawHeaders[k] = v as string;
      else Object.assign(rawHeaders, h);
    }
    let body: any = undefined;
    const rawBody = init?.body ?? (typeof input === 'object' ? input?.body : undefined);
    if (typeof rawBody === 'string') {
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    }
    captured.push({ url, method, headers: stripAuth(rawHeaders), body });
    return cannedResponse(url);
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

/** Pull the prompt/input text out of a captured request body, per provider shape. */
export function extractPrompt(callType: CallType, body: any): string {
  if (!body || typeof body !== 'object') return '';
  switch (callType) {
    case 'extraction':
    case 'grounded-verify:gemini': {
      // Gemini generateContent. The @google/genai SDK normalizes both the object
      // form ({ parts:[{text}] }) and the string form (contents: prompt) into a
      // structured wire body: { contents: [{ role, parts:[{text}] }] }. Also
      // tolerate the raw string form for robustness.
      const contents = body.contents;
      if (typeof contents === 'string') return contents;
      const first = Array.isArray(contents) ? contents[0] : contents;
      const parts = first?.parts;
      const textPart = Array.isArray(parts) ? parts.find((p: any) => typeof p?.text === 'string') : undefined;
      return textPart?.text ?? '';
    }
    case 'grounded-verify:openai':
    case 'grounded-verify:claude': {
      const content = body.messages?.[0]?.content;
      if (Array.isArray(content)) return content.find((c: any) => typeof c?.text === 'string')?.text ?? '';
      return typeof content === 'string' ? content : '';
    }
    case 'web_search':
      return typeof body.input === 'string' ? body.input : '';
  }
}

/**
 * Capture the exact request the engine emits for every call-type, executing the
 * engine's real code (no reimplementation). Dynamic import AFTER this file loads
 * so the engine binds our stubbed fetch at call time.
 */
export async function captureAll(): Promise<Record<CallType, CapturedRequest>> {
  const gemini = await import('../../packages/cli/services/geminiService');
  const { createOpenAIProvider, createClaudeProvider } = await import('../../packages/cli/providers');
  const { OpenAIWebSearchRetriever } = await import('../../packages/cli/providers/openai_web_search_retriever');

  const DUMMY = 'CAPTURE-NO-SPEND';
  const out = {} as Record<CallType, CapturedRequest>;

  const record = (callType: CallType, reqs: Array<{ url: string; method: string; headers: Record<string, string>; body: any }>): void => {
    const req = reqs.find((r) => extractPrompt(callType, r.body).length > 0) ?? reqs[0];
    if (!req) throw new Error(`capture: engine emitted NO request for ${callType} — capture failed, cannot prove fidelity`);
    out[callType] = { callType, url: req.url, method: req.method, headers: req.headers, body: req.body, prompt: extractPrompt(callType, req.body) };
  };

  record('extraction', await withCapture(() => gemini.extractClaims(SAMPLE.extractionText, DUMMY)));
  record('web_search', await withCapture(() => new OpenAIWebSearchRetriever(DUMMY).retrieve(SAMPLE.claim.text)));
  record('grounded-verify:openai', await withCapture(() => createOpenAIProvider(DUMMY).verifyClaimGrounded!(SAMPLE.claim, SAMPLE.sources)));
  record('grounded-verify:claude', await withCapture(() => createClaudeProvider(DUMMY).verifyClaimGrounded!(SAMPLE.claim, SAMPLE.sources)));
  record('grounded-verify:gemini', await withCapture(() => gemini.verifyClaimGrounded(SAMPLE.claim, SAMPLE.sources, DUMMY)));

  return out;
}
