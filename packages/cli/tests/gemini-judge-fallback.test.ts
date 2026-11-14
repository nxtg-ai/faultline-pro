// Validates: GoPMO 1.18.11.7.127 (owner's ruling, option C): the Gemini verdict judge runs on
// FAULTLINE_GEMINI_MODEL; a judge call Google rate-limits is retried ONCE on
// FAULTLINE_GEMINI_FALLBACK_MODEL, and every verdict names the model that produced it.
// The SDK is mocked at the module boundary; each model's behaviour is set per test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Claim } from '../types.js';

type Behaviour = 'ok' | Error;

const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; contents: string }>,
  // Per model: what a call on that model does. A function picks by prompt text.
  byModel: {} as Record<string, unknown>,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { model: string; contents: string }) => {
        sdk.calls.push({ model: req.model, contents: req.contents });
        const rule = sdk.byModel[req.model];
        const behaviour = (typeof rule === 'function' ? (rule as (p: string) => unknown)(req.contents) : rule) ?? 'ok';
        if (behaviour instanceof Error) throw behaviour;
        // 'not-addressed': the judge says the sources are not about the claim; 'no-source': no grounding chunk.
        return {
          text: JSON.stringify({ status: 'supported', sourcesAddressClaim: behaviour !== 'not-addressed', explanation: 'e' }),
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          candidates: [{
            finishReason: 'STOP',
            groundingMetadata: { groundingChunks: behaviour === 'no-source' ? [] : [{ web: { title: 't', uri: 'https://example.org/a' } }] },
          }],
        };
      },
    };
  },
}));

const PRIMARY = 'gemini-3.1-pro-preview';
const FALLBACK = 'gemini-3.8-flash';
const rateLimited = () => new Error('got status: 429 Too Many Requests. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
const serverError = () => new Error('got status: 500 Internal Server Error');
// An empty account often arrives as a 429 too; it is not a rate limit (out-of-credits.ts).
const outOfCredits = () => new Error('got status: 429 Too Many Requests: insufficient_quota');

const ENV = ['FAULTLINE_GEMINI_MODEL', 'FAULTLINE_GEMINI_FALLBACK_MODEL', 'FAULTLINE_GEMINI_EXTRACTION_MODEL'] as const;
let saved: Record<string, string | undefined>;

const claim = (id: string, text = `Claim ${id} about the Eiffel Tower.`): Claim => ({ id, text, type: 'fact', importance: 3 });
const SOURCES = [{ title: 'Source', uri: 'https://example.org/a', snippet: 'The Eiffel Tower is in Paris.' }];
const retriever = { name: 'parallel-search', model: 'parallel-search-default', retrieve: async () => SOURCES.map((s) => ({ ...s })) };

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.FAULTLINE_GEMINI_MODEL = PRIMARY;
  process.env.FAULTLINE_GEMINI_FALLBACK_MODEL = FALLBACK;
  delete process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL;
  sdk.calls = [];
  sdk.byModel = {};
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

async function load() {
  const service = await import('../services/geminiService.js');
  const sink = await import('../lib/usage-sink.js');
  const runner = await import('../cli/verify-runner.js');
  const { createGeminiProvider } = await import('../providers/gemini_provider.js');
  return { service, sink, runner, provider: createGeminiProvider('test-key') };
}

describe('the judge fallback setting', () => {
  it('reads FAULTLINE_GEMINI_FALLBACK_MODEL, trimmed', async () => {
    process.env.FAULTLINE_GEMINI_FALLBACK_MODEL = `  ${FALLBACK} `;
    const { service } = await load();
    expect(service.GEMINI_FALLBACK_MODEL).toBe(FALLBACK);
  });

  it('unset, blank or equal to the primary: null', async () => {
    delete process.env.FAULTLINE_GEMINI_FALLBACK_MODEL;
    expect((await load()).service.GEMINI_FALLBACK_MODEL).toBeNull();
    vi.resetModules();
    process.env.FAULTLINE_GEMINI_FALLBACK_MODEL = '   ';
    expect((await load()).service.GEMINI_FALLBACK_MODEL).toBeNull();
    vi.resetModules();
    process.env.FAULTLINE_GEMINI_FALLBACK_MODEL = PRIMARY;
    expect((await load()).service.GEMINI_FALLBACK_MODEL).toBeNull();
  });
});

describe('parallel mode (retrieveThenVerify): a rate-limited judge falls back once', () => {
  it('every rate-limited claim gets its verdict from the fallback model, and says so', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    const { sink, runner, provider } = await load();
    const claims = [claim('a'), claim('b'), claim('c')];
    const { result: verdicts, legs } = await sink.captureUsage(() =>
      Promise.all(claims.map((c) => runner.retrieveThenVerify(c, provider, 'gemini', retriever))));

    expect(verdicts).toHaveLength(3);
    for (const v of verdicts) {
      expect(v.status).toBe('supported');
      expect(v.apiError).toBeUndefined();
      expect(v.sources.length).toBeGreaterThan(0);
      expect(v.provenance?.model).toBe(FALLBACK);
      expect(v.provenance?.judgeFallback).toBe(true);
      expect(v.provenance?.provider).toBe('gemini');
      expect(v.provenance?.retriever).toBe('parallel-search');
    }
    // One primary attempt and exactly one fallback call per claim.
    expect(sdk.calls.map((c) => c.model).sort()).toEqual([PRIMARY, PRIMARY, PRIMARY, FALLBACK, FALLBACK, FALLBACK].sort());
    // A rejected 429 returns no usage, so the legs are the three fallback calls, priced at the fallback model.
    expect(legs).toHaveLength(3);
    expect(legs.every((l) => l.model === FALLBACK && l.callType === 'grounded-verify:gemini' && l.isGrounding === false)).toBe(true);
  });

  it('mixed batch: each verdict and each usage leg names the model that answered', async () => {
    sdk.byModel[PRIMARY] = (prompt: string) => (prompt.includes('THROTTLED') ? rateLimited() : 'ok');
    const { sink, runner, provider } = await load();
    const { result: verdicts, legs } = await sink.captureUsage(async () => {
      const out = [];
      out.push(await runner.retrieveThenVerify(claim('p', 'A plain claim.'), provider, 'gemini', retriever));
      out.push(await runner.retrieveThenVerify(claim('f', 'A THROTTLED claim.'), provider, 'gemini', retriever));
      return out;
    });
    expect(verdicts.map((v) => [v.claimId, v.status, v.provenance?.model, v.provenance?.judgeFallback])).toEqual([
      ['p', 'supported', PRIMARY, undefined],
      ['f', 'supported', FALLBACK, true],
    ]);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
    expect(legs.map((l) => l.model)).toEqual([PRIMARY, FALLBACK]);
  });

  it('a fallback that is also rate-limited: not checked, apiError, no provenance', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    sdk.byModel[FALLBACK] = rateLimited();
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.status).toBe('unverified');
    expect(v.apiError).toBe(true);
    expect(v.provenance).toBeUndefined();
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
  });

  it('a fallback that errors: not checked, apiError, never attributed to the primary', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    sdk.byModel[FALLBACK] = serverError();
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.status).toBe('unverified');
    expect(v.apiError).toBe(true);
    expect(v.provenance?.model).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(PRIMARY);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
  });

  it('an out-of-credits error on the primary does not fall back', async () => {
    sdk.byModel[PRIMARY] = outOfCredits();
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.apiError).toBe(true);
    expect(v.apiErrorReason).toBe('provider_out_of_credits');
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });

  it('a non-rate-limit error on the primary does not fall back', async () => {
    sdk.byModel[PRIMARY] = serverError();
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.apiError).toBe(true);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });

  it('fallback unset: one call, the claim is not checked, exactly as before', async () => {
    delete process.env.FAULTLINE_GEMINI_FALLBACK_MODEL;
    sdk.byModel[PRIMARY] = rateLimited();
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.status).toBe('unverified');
    expect(v.apiError).toBe(true);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });

  it('a fallback verdict the judge marks not checkable still names the fallback model', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    sdk.byModel[FALLBACK] = 'not-addressed';
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.notCheckable).toBe(true);
    expect(v.status).toBe('unverified');
    expect(v.apiError).toBeUndefined();
    expect(v.provenance?.model).toBe(FALLBACK);
    expect(v.provenance?.judgeFallback).toBe(true);
  });

  it('a primary verdict keeps the configured model and no judgeFallback field', async () => {
    const { runner, provider } = await load();
    const v = await runner.retrieveThenVerify(claim('a'), provider, 'gemini', retriever);
    expect(v.status).toBe('supported');
    expect(v.provenance?.model).toBe(PRIMARY);
    expect(v.provenance && 'judgeFallback' in v.provenance).toBe(false);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });
});

describe('a consensus vote (verifyClaimGrounded without the option) is unchanged', () => {
  it('a rate-limited vote is a failed vote, with no second call', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    const { provider } = await load();
    const v = await provider.verifyClaimGrounded!(claim('a'), SOURCES);
    expect(v.apiError).toBe(true);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });
});

describe('Google-grounded judge (verifyClaim): the same fallback', () => {
  it('a rate-limited call is answered by the fallback; provenance and the usage leg name it', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    const { sink, runner, provider } = await load();
    const { result, legs } = await sink.captureUsage(() => provider.verifyClaim(claim('a')));
    expect(result.status).toBe('supported');
    expect(result.provenance?.model).toBe(FALLBACK);
    expect(result.provenance?.judgeFallback).toBe(true);
    expect(legs.map((l) => [l.model, l.isGrounding])).toEqual([[FALLBACK, true]]);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
    // The runner's binding keeps both the model and the flag.
    const bound = runner.bindEngineProvenance(result, 'gemini', provider, new Date().toISOString());
    expect(bound.provenance?.model).toBe(FALLBACK);
    expect(bound.provenance?.judgeFallback).toBe(true);
  });

  it('a fallback verdict with no openable source abstains and keeps the fallback provenance', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    sdk.byModel[FALLBACK] = 'no-source';
    const { provider } = await load();
    const v = await provider.verifyClaim(claim('a'));
    expect(v.status).toBe('unverified');
    expect(v.noSourceAbstain).toBe(true);
    expect(v.provenance?.model).toBe(FALLBACK);
    expect(v.provenance?.judgeFallback).toBe(true);
  });

  it('fallback also rate-limited: not checked, no provenance', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    sdk.byModel[FALLBACK] = rateLimited();
    const { provider } = await load();
    const v = await provider.verifyClaim(claim('a'));
    expect(v.status).toBe('unverified');
    expect(v.apiError).toBe(true);
    expect(v.provenance).toBeUndefined();
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
  });

  it('out of credits: no fallback, the reason is kept', async () => {
    sdk.byModel[PRIMARY] = outOfCredits();
    const { provider } = await load();
    const v = await provider.verifyClaim(claim('a'));
    expect(v.apiErrorReason).toBe('provider_out_of_credits');
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });

  it('fallback unset: one call, as before', async () => {
    delete process.env.FAULTLINE_GEMINI_FALLBACK_MODEL;
    sdk.byModel[PRIMARY] = rateLimited();
    const { provider } = await load();
    const v = await provider.verifyClaim(claim('a'));
    expect(v.apiError).toBe(true);
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });
});

describe('extraction never falls back', () => {
  it('a rate-limited extraction fails with no second call', async () => {
    sdk.byModel[PRIMARY] = rateLimited();
    const { service } = await load();
    await expect(service.extractClaims('The Eiffel Tower is in Paris.', 'test-key')).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(sdk.calls.map((c) => c.model)).toEqual([PRIMARY]);
  });
});
