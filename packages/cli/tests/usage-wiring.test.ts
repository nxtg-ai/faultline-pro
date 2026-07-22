/**
 * usage-wiring.test.ts — BLG-005 phase-2: adapters actually EMIT real usage.
 *
 * The composition (replay test) and the ALS sink (concurrency test) are proven
 * separately; this closes the wiring gap — that each provider/retriever calls
 * recordUsage() with the REAL provider-reported tokens when driven through its
 * public method inside a captureUsage() scope. fetch is mocked (no network).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { captureUsage } from '../lib/usage-sink.js';
import { createOpenAIProvider } from '../providers/openai_provider.js';
import { createClaudeProvider } from '../providers/claude_provider.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import type { Claim, Source } from '../types.js';

const claim: Claim = { id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 3 };
const sources: Source[] = [{ title: 't', uri: 'https://example.com', snippet: 's' }];
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => { vi.unstubAllGlobals(); });

describe('usage-wiring (adapters emit real usage)', () => {
  it('UW-01: OpenAI grounded verify records a leg with real prompt/completion tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      choices: [{ message: { content: '{"status":"supported","explanation":"ok"}' } }],
      usage: { prompt_tokens: 137, completion_tokens: 42 },
    })));
    const { legs } = await captureUsage(async () => {
      await createOpenAIProvider('k').verifyClaimGrounded!(claim, sources);
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 137, outputTokens: 42, isGrounding: false });
  });

  it('UW-02: Claude grounded verify records a leg priced at the real opus model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      content: [{ type: 'text', text: '{"status":"supported","explanation":"ok"}' }],
      usage: { input_tokens: 512, output_tokens: 96 },
    })));
    const { legs } = await captureUsage(async () => {
      await createClaudeProvider('k').verifyClaimGrounded!(claim, sources);
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8', inputTokens: 512, outputTokens: 96, isGrounding: false });
  });

  it('UW-03: web_search retriever records the grounding leg (isGrounding, real usage)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      output: [],
      usage: { input_tokens: 17262, output_tokens: 634 },
    })));
    const { legs } = await captureUsage(async () => {
      await new OpenAIWebSearchRetriever('k').retrieve('the sky is blue');
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o', callType: 'web_search', inputTokens: 17262, outputTokens: 634, isGrounding: true });
  });

  it('UW-04: calls OUTSIDE a capture scope record nothing (hot path unaffected)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      choices: [{ message: { content: '{"status":"supported","explanation":"ok"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })));
    // no captureUsage wrapper → recordUsage is a no-op, must not throw
    await expect(createOpenAIProvider('k').verifyClaimGrounded!(claim, sources)).resolves.toBeTruthy();
  });
});
