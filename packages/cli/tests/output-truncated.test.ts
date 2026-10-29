/**
 * A reply cut off at its output ceiling is never a verdict (GoPMO 1.18.11.7.18).
 *
 * Each wire reports the cut-off its own way: Gemini finishReason MAX_TOKENS,
 * Chat Completions finish_reason 'length', Responses status 'incomplete' with
 * reason max_output_tokens, Anthropic stop_reason 'max_tokens'. On a verify call
 * the claim is unchecked with reason 'output_truncated' (status 'unverified',
 * apiError true, sources [] or the shared set for a consensus vote), so it is
 * unbilled exactly like 'provider_unparseable'. An extraction fails with that
 * reason instead of returning fewer claims. A retrieval returns no sources; a
 * critique takes its fallback. The replies below parse cleanly on purpose: the
 * cut-off flag, not the parser, must decide.
 */
// Validates: N-234 (billable unit and cost ceilings, GoPMO 1.18.11.7.18)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Claim, VerificationResult } from '../types';

const sdk = vi.hoisted(() => ({ reply: {} as Record<string, unknown> }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, ...sdk.reply }) };
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { extractClaims, verifyClaim, retrieveSources, verifyClaimGrounded, generateCritiqueAndPrompt } from '../services/geminiService';
import { createOpenAIProvider } from '../providers/openai_provider';
import { createClaudeProvider } from '../providers/claude_provider';
import { createPerplexityProvider } from '../providers/perplexity_provider';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever';
import { truncatedVerdict } from '../providers/verdict-reply';
import { ExtractionError, isExtractionError } from '../providers/extraction-error';
import {
  OutputTruncatedError, isOutputTruncatedError, isGeminiTruncated, isChatCompletionTruncated, isResponsesTruncated, isClaudeTruncated,
} from '../providers/output-truncation';
import { consensusVerify } from '../consensus/consensus_engine';
import type { Retriever } from '../providers/base_provider';
import { toClaimVerdict, isProviderUnchecked } from '../cli/verdict';
import { evaluateGuard, formatGuardReport } from '../cli/guard';
import { isBillableVerdict } from '../lib/verdict-guard';
import { classifyError } from '../cli/telemetry';

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 };
const SOURCES = [{ title: 's', uri: 'https://example.org/a' }];
const VERDICT = '{"status":"supported","explanation":"Holds."}';
const CRITIQUE = '{"critique":"real critique","improvedPrompt":"real prompt"}';
const CLAIM_ARRAY = '[{"id":"c1","text":"The Eiffel Tower is in Paris.","type":"fact","importance":3}]';
const FALLBACK_CRITIQUE = { critique: 'Analysis incomplete.', improvedPrompt: 'Verify facts before trusting AI outputs.' };

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}
const chat = (content: string, finish: string) => ok({ choices: [{ message: { content }, finish_reason: finish }], citations: ['https://example.org/c'], usage: {} });
const anthropic = (text: string, stop: string) => ok({ content: [{ type: 'text', text }], stop_reason: stop, usage: {} });
const groundedGemini = (text: string, finishReason: string) => ({
  text,
  candidates: [{ finishReason, groundingMetadata: { groundingChunks: [{ web: { title: 'G', uri: 'https://example.org/g' } }] } }],
});

function expectTruncated(r: VerificationResult, sources: unknown[] = []) {
  expect(r.status).toBe('unverified');
  expect(r.status).not.toBe('mixed');
  expect(r.apiError).toBe(true);
  expect(r.apiErrorReason).toBe('output_truncated');
  expect(r.sources).toEqual(sources);
  expect(r.provenance).toBeUndefined();
  expect(r.parseFallback).toBeUndefined();
  expect(isBillableVerdict(r)).toBe(false);
}

async function extractionReason(run: () => Promise<unknown>): Promise<string> {
  const err = await run().then(() => null, (e: unknown) => e);
  expect(isExtractionError(err)).toBe(true);
  return (err as ExtractionError).reason;
}

beforeEach(() => {
  mockFetch.mockReset();
  sdk.reply = {};
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the wire readers', () => {
  it('read only the cut-off signal each wire documents', () => {
    expect(isGeminiTruncated({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe(true);
    for (const r of [{ candidates: [{ finishReason: 'STOP' }] }, { candidates: [] }, {}, null]) expect(isGeminiTruncated(r)).toBe(false);
    expect(isChatCompletionTruncated({ choices: [{ finish_reason: 'length' }] })).toBe(true);
    for (const r of [{ choices: [{ finish_reason: 'stop' }] }, { choices: [] }, {}, null]) expect(isChatCompletionTruncated(r)).toBe(false);
    expect(isResponsesTruncated({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).toBe(true);
    for (const r of [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, { status: 'completed' }, {}, null]) {
      expect(isResponsesTruncated(r)).toBe(false);
    }
    expect(isClaudeTruncated({ stop_reason: 'max_tokens' })).toBe(true);
    expect(isClaudeTruncated({ stop_reason: 'model_context_window_exceeded' })).toBe(true);
    expect(isClaudeTruncated({ stop_reason: 'end_turn' })).toBe(false);
    for (const r of [{ stop_reason: 'end_turn' }, {}, null]) expect(isClaudeTruncated(r)).toBe(false);
  });

  it('recognise the error by shape, so a second module copy still counts', () => {
    expect(isOutputTruncatedError(new OutputTruncatedError('openai', 'verify'))).toBe(true);
    const copy = Object.assign(new Error('x'), { name: 'OutputTruncatedError' });
    expect(isOutputTruncatedError(copy)).toBe(true);
    expect(isOutputTruncatedError(new Error('length'))).toBe(false);
  });
});

describe('Gemini (finishReason MAX_TOKENS)', () => {
  it('grounded verify: unchecked with reason output_truncated, though the text parses', async () => {
    sdk.reply = groundedGemini(VERDICT, 'MAX_TOKENS');
    expectTruncated(await verifyClaim(CLAIM, 'k'));
  });

  it('grounded verify with STOP is still a verdict', async () => {
    sdk.reply = groundedGemini(VERDICT, 'STOP');
    const r = await verifyClaim(CLAIM, 'k');
    expect(r.status).toBe('supported');
    expect(r.apiError).toBeUndefined();
  });

  it('shared-source judge: a failed vote carrying the shared sources', async () => {
    sdk.reply = { text: VERDICT, candidates: [{ finishReason: 'MAX_TOKENS' }] };
    expectTruncated(await verifyClaimGrounded(CLAIM, SOURCES, 'k'), SOURCES);
  });

  it('extraction: fails with output_truncated, for a parseable, a partial and an empty reply', async () => {
    for (const text of [CLAIM_ARRAY, CLAIM_ARRAY.slice(0, 40), '']) {
      sdk.reply = { text, candidates: [{ finishReason: 'MAX_TOKENS' }] };
      expect(await extractionReason(() => extractClaims('The Eiffel Tower is in Paris.', 'k'))).toBe('output_truncated');
    }
  });

  it('retrieval: a failed retrieval, rejected with reason output_truncated', async () => {
    sdk.reply = groundedGemini('summary', 'MAX_TOKENS');
    await expect(retrieveSources(CLAIM.text, 'k')).rejects.toMatchObject({ name: 'RetrievalError', reason: 'output_truncated' });
    sdk.reply = groundedGemini('summary', 'STOP');
    expect(await retrieveSources(CLAIM.text, 'k')).toEqual([{ title: 'G', uri: 'https://example.org/g' }]);
  });

  it('critique: the existing fallback', async () => {
    sdk.reply = { text: CRITIQUE, candidates: [{ finishReason: 'MAX_TOKENS' }] };
    expect(await generateCritiqueAndPrompt('text', [CLAIM], 'k')).toEqual(FALLBACK_CRITIQUE);
  });
});

const CHAT_WIRES = {
  openai: { factory: createOpenAIProvider, cut: (t: string) => chat(t, 'length'), whole: (t: string) => chat(t, 'stop'), envelope: true },
  perplexity: { factory: createPerplexityProvider, cut: (t: string) => chat(t, 'length'), whole: (t: string) => chat(t, 'stop'), envelope: true },
  claude: { factory: createClaudeProvider, cut: (t: string) => anthropic(t, 'max_tokens'), whole: (t: string) => anthropic(t, 'end_turn'), envelope: false },
} as const;

describe.each(Object.keys(CHAT_WIRES) as Array<keyof typeof CHAT_WIRES>)('%s', (name) => {
  const wire = CHAT_WIRES[name];
  const claims = wire.envelope ? `{"claims":${CLAIM_ARRAY}}` : CLAIM_ARRAY;

  it('verifyClaim: a cut-off reply is unchecked with reason output_truncated', async () => {
    mockFetch.mockResolvedValueOnce(wire.cut(VERDICT));
    expectTruncated(await wire.factory('k').verifyClaim(CLAIM));
  });

  it('verifyClaim: the same reply, not cut off, is a verdict', async () => {
    mockFetch.mockResolvedValueOnce(wire.whole(VERDICT));
    const r = await wire.factory('k').verifyClaim(CLAIM);
    expect(r.status).toBe('supported');
    expect(r.apiError).toBeUndefined();
    // A raw provider verdict carries no engine retriever, so it is not billable
    // as returned, whatever it cites. With a source and the provenance the
    // engine binds for a provider that retrieves (gemini), it would be.
    expect(r.provenance?.retriever).toBeUndefined();
    expect(isBillableVerdict(r)).toBe(false);
    expect(isBillableVerdict({ ...r, sources: SOURCES, provenance: { provider: 'gemini', model: 'm', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-01T00:00:00.000Z' } })).toBe(true);
  });

  it('extractClaims: fails with output_truncated, never fewer claims', async () => {
    mockFetch.mockResolvedValueOnce(wire.cut(claims));
    expect(await extractionReason(() => wire.factory('k').extractClaims('text'))).toBe('output_truncated');
    mockFetch.mockResolvedValueOnce(wire.whole(claims));
    expect(await wire.factory('k').extractClaims('text')).toHaveLength(1);
  });

  it('critique: the existing fallback', async () => {
    mockFetch.mockResolvedValueOnce(wire.cut(CRITIQUE));
    expect(await wire.factory('k').generateCritiqueAndPrompt('text', [CLAIM])).toEqual(FALLBACK_CRITIQUE);
  });
});

describe.each(['openai', 'claude'] as const)('%s verifyClaimGrounded (consensus vote)', (name) => {
  it('a cut-off reply is a failed vote with reason output_truncated and the shared sources', async () => {
    mockFetch.mockResolvedValueOnce(CHAT_WIRES[name].cut(VERDICT));
    expectTruncated(await CHAT_WIRES[name].factory('k').verifyClaimGrounded!(CLAIM, SOURCES), SOURCES);
  });

  it('any other failure still throws to the consensus engine', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({}) });
    await expect(CHAT_WIRES[name].factory('k').verifyClaimGrounded!(CLAIM, SOURCES)).rejects.toThrow(/503/);
  });
});

describe('OpenAI Responses web_search retriever', () => {
  const message = { type: 'message', content: [{ type: 'output_text', text: 'Paris.', annotations: [{ type: 'url_citation', url: 'https://example.org/r', title: 'R', start_index: 0, end_index: 6 }] }] };

  it('incomplete at max_output_tokens: a failed retrieval, rejected with reason output_truncated', async () => {
    mockFetch.mockResolvedValueOnce(ok({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message], usage: {} }));
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'output_truncated' });
  });

  it('a completed search still returns its sources', async () => {
    mockFetch.mockResolvedValueOnce(ok({ status: 'completed', output: [message], usage: {} }));
    expect(await new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).toEqual([{ title: 'R', uri: 'https://example.org/r', snippet: 'Paris.' }]);
  });
});

describe('consensus carries output_truncated end to end', () => {
  const retriever: Retriever = { name: 'test-retriever', retrieve: async () => SOURCES };
  const named = () => [
    { name: 'openai', provider: createOpenAIProvider('k') },
    { name: 'claude', provider: createClaudeProvider('k') },
  ];
  const route = (openai: unknown, claude: unknown) => mockFetch.mockImplementation(async (url: string) => (String(url).includes('anthropic') ? claude : openai));

  it('every vote cut off: the fused claim is unchecked with reason output_truncated, MCP says so', async () => {
    route(CHAT_WIRES.openai.cut(VERDICT), CHAT_WIRES.claude.cut(VERDICT));
    const fused = await consensusVerify(CLAIM, retriever, named());
    expect(fused).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'output_truncated' });
    expect(fused.providerVotes?.map((v) => v.apiErrorReason)).toEqual(['output_truncated', 'output_truncated']);
    expect(toClaimVerdict(CLAIM.text, fused).unchecked_reason).toBe('output_truncated');
    expect(isBillableVerdict(fused)).toBe(false);
  });

  it('one cut off and one unreadable: unchecked, no single reason, so provider_error', async () => {
    route(CHAT_WIRES.openai.cut(VERDICT), CHAT_WIRES.claude.whole('prose, no verdict'));
    const fused = await consensusVerify(CLAIM, retriever, named());
    expect(fused.apiError).toBe(true);
    expect(fused.apiErrorReason).toBeUndefined();
    expect(toClaimVerdict(CLAIM.text, fused).unchecked_reason).toBe('provider_error');
  });

  it('one cut off and one readable: the readable verdict stands, the failed vote keeps its reason', async () => {
    route(CHAT_WIRES.openai.cut(VERDICT), CHAT_WIRES.claude.whole(VERDICT));
    const fused = await consensusVerify(CLAIM, retriever, named());
    expect(fused.status).toBe('supported');
    expect(fused.apiError).toBeUndefined();
    expect(fused.providerVotes?.find((v) => v.provider === 'openai')?.apiErrorReason).toBe('output_truncated');
  });
});

describe('MCP verdict, guard and telemetry', () => {
  it('UNCHECKED with unchecked_reason output_truncated, and the guard reports degraded and says why', () => {
    const v = toClaimVerdict(CLAIM.text, truncatedVerdict('c1'));
    expect(v.verdict).toBe('UNCHECKED');
    expect(v.unchecked_reason).toBe('output_truncated');
    expect(isProviderUnchecked(v.unchecked_reason)).toBe(true);

    const report = evaluateGuard({ claims: [CLAIM], verifications: { c1: truncatedVerdict('c1') }, overallRisk: 'low' } as never);
    expect(report.degraded).toBe(true);
    expect(report.claims[0].verdict).toBe('UNCHECKED');
    expect(formatGuardReport(report)).toContain('cut off at its output limit');
  });

  it('a truncated extraction carries customer-safe text and classifies as a parse error', () => {
    const err = ExtractionError.fromProviderError(new OutputTruncatedError('claude', 'extract'));
    expect(err.reason).toBe('output_truncated');
    expect(err.message).toBe('Claim extraction failed: the extraction reply was cut off at its output limit. Nothing was verified.');
    expect(classifyError(err)).toBe('PARSE_ERROR');
  });
});
