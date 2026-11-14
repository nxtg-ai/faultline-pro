// Validates: GoPMO 1.18.11.7.127 (ruling on the judge model A/B: extraction can run on a
// different Gemini model from the judge). The SDK is mocked at the module boundary.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdk = vi.hoisted(() => ({ calls: [] as Array<{ model: string }>, queries: undefined as string[] | undefined }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { model: string }) => {
        sdk.calls.push({ model: req.model });
        const isExtraction = sdk.calls.length === 1;
        return {
          text: isExtraction
            ? JSON.stringify([{ id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 }])
            : JSON.stringify({ status: 'supported', explanation: 'e' }),
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 't', uri: 'https://example.org/a' } }], ...(sdk.queries ? { webSearchQueries: sdk.queries } : {}) } }],
        };
      },
    };
  },
}));

const ENV = ['FAULTLINE_GEMINI_MODEL', 'FAULTLINE_GEMINI_EXTRACTION_MODEL'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  sdk.calls = [];
  sdk.queries = undefined;
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function load() {
  const service = await import('../services/geminiService.js');
  const sink = await import('../lib/usage-sink.js');
  return { service, sink };
}

describe('the Gemini extraction model setting', () => {
  it('unset: extraction and the judge both run on FAULTLINE_GEMINI_MODEL, as before', async () => {
    process.env.FAULTLINE_GEMINI_MODEL = 'gemini-3.1-pro-preview';
    delete process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL;
    const { service } = await load();
    expect(service.GEMINI_MODEL).toBe('gemini-3.1-pro-preview');
    expect(service.GEMINI_EXTRACTION_MODEL).toBe('gemini-3.1-pro-preview');
  });

  it('both unset: the 2.5-flash default for both', async () => {
    delete process.env.FAULTLINE_GEMINI_MODEL;
    delete process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL;
    const { service } = await load();
    expect(service.GEMINI_MODEL).toBe('gemini-2.5-flash');
    expect(service.GEMINI_EXTRACTION_MODEL).toBe('gemini-2.5-flash');
  });

  it('set: extraction calls and records the extraction model; the judge keeps FAULTLINE_GEMINI_MODEL', async () => {
    process.env.FAULTLINE_GEMINI_MODEL = 'gemini-3.1-pro-preview';
    process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL = ' gemini-3.5-flash-lite ';
    const { service, sink } = await load();
    const { result, legs } = await sink.captureUsage(async () => {
      const claims = await service.extractClaims('The Eiffel Tower is in Paris.', 'key');
      const verdict = await service.verifyClaim(claims[0], 'key');
      return { claims, verdict };
    });
    expect(result.claims.length).toBeGreaterThan(0);
    expect(sdk.calls.map((c) => c.model)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-pro-preview']);
    expect(legs.map((l) => [l.callType, l.model])).toEqual([
      ['extraction', 'gemini-3.5-flash-lite'],
      ['grounded-verify:gemini', 'gemini-3.1-pro-preview'],
    ]);
  });

  it('a grounded Gemini leg records how many search queries it ran', async () => {
    process.env.FAULTLINE_GEMINI_MODEL = 'gemini-3.1-pro-preview';
    const { service, sink } = await load();
    sdk.calls.push({ model: 'skip-extraction-branch' });
    sdk.queries = ['eiffel tower location', 'eiffel tower paris'];
    const { legs } = await sink.captureUsage(() => service.verifyClaim({ id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 }, 'key'));
    expect(legs).toHaveLength(1);
    expect(legs[0].isGrounding).toBe(true);
    expect(legs[0].searchQueries).toBe(2);
  });

  it('a blank extraction setting falls back to FAULTLINE_GEMINI_MODEL', async () => {
    process.env.FAULTLINE_GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL = '   ';
    const { service } = await load();
    expect(service.GEMINI_EXTRACTION_MODEL).toBe('gemini-3.8-flash');
  });
});
