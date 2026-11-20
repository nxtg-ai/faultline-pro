// Validates: GoPMO 1.18.11.1.68: a claim extraction Google rate-limits is retried once on the
// extraction model, then run once on GEMINI_EXTRACTION_FALLBACK_MODEL; any other error is not
// retried; the usage leg names the model that answered; the log names the quota, never the key.
// The SDK is mocked at the module boundary; each model's behaviour is a queue set per test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  calls: [] as string[],
  // Per model: a queue of outcomes, consumed one per call; 'ok' once the queue is empty.
  queue: {} as Record<string, Array<'ok' | Error>>,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { model: string }) => {
        sdk.calls.push(req.model);
        const next = (sdk.queue[req.model] ?? []).shift() ?? 'ok';
        if (next instanceof Error) throw next;
        return {
          text: JSON.stringify([{ id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 }]),
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          candidates: [{ finishReason: 'STOP' }],
        };
      },
    };
  },
}));

const JUDGE = 'gemini-3.1-pro-preview';
const EXTRACT = 'gemini-3.5-flash-lite';
const OTHER = 'gemini-3.8-flash';
const SECRET = 'AIzaTESTKEYshouldNeverBeLogged0000000';
const rateLimited = () => new Error(
  'got status: 429 Too Many Requests. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel","quotaValue":"4000"}]}]}}',
);
const serverError = () => new Error('got status: 500 Internal Server Error');
const outOfCredits = () => new Error('got status: 429 Too Many Requests: insufficient_quota');

const ENV = ['FAULTLINE_GEMINI_MODEL', 'FAULTLINE_GEMINI_EXTRACTION_MODEL', 'FAULTLINE_GEMINI_EXTRACTION_FALLBACK_MODEL', 'FAULTLINE_EXTRACTION_RETRY_MS'] as const;
let saved: Record<string, string | undefined>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.FAULTLINE_GEMINI_MODEL = JUDGE;
  process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL = EXTRACT;
  delete process.env.FAULTLINE_GEMINI_EXTRACTION_FALLBACK_MODEL;
  process.env.FAULTLINE_EXTRACTION_RETRY_MS = '0';
  sdk.calls = [];
  sdk.queue = {};
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
  return { service, sink };
}

describe('claim extraction under a Google rate limit (1.18.11.1.68)', () => {
  it('no rate limit: one call on the extraction model', async () => {
    const { service, sink } = await load();
    const { result, legs } = await sink.captureUsage(() => service.extractClaims('The Eiffel Tower is in Paris.', SECRET));
    expect(result.map((c) => c.id)).toEqual(['c1']);
    expect(sdk.calls).toEqual([EXTRACT]);
    expect(legs.map((l) => l.model)).toEqual([EXTRACT]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('one 429, then success: retried once on the extraction model, no fallback', async () => {
    sdk.queue[EXTRACT] = [rateLimited()];
    const { service, sink } = await load();
    const { result, legs } = await sink.captureUsage(() => service.extractClaims('The Eiffel Tower is in Paris.', SECRET));
    expect(result.length).toBe(1);
    expect(sdk.calls).toEqual([EXTRACT, EXTRACT]);
    expect(legs.map((l) => l.model)).toEqual([EXTRACT]);
  });

  it('two 429s: falls back once to the judge model by default, and the leg names it', async () => {
    sdk.queue[EXTRACT] = [rateLimited(), rateLimited()];
    const { service, sink } = await load();
    expect(service.GEMINI_EXTRACTION_FALLBACK_MODEL).toBe(JUDGE);
    const { result, legs } = await sink.captureUsage(() => service.extractClaims('The Eiffel Tower is in Paris.', SECRET));
    expect(result.length).toBe(1);
    expect(sdk.calls).toEqual([EXTRACT, EXTRACT, JUDGE]);
    expect(legs.map((l) => l.model)).toEqual([JUDGE]);
  });

  it('FAULTLINE_GEMINI_EXTRACTION_FALLBACK_MODEL overrides the fallback model', async () => {
    process.env.FAULTLINE_GEMINI_EXTRACTION_FALLBACK_MODEL = OTHER;
    sdk.queue[EXTRACT] = [rateLimited(), rateLimited()];
    const { service } = await load();
    await service.extractClaims('The Eiffel Tower is in Paris.', SECRET);
    expect(sdk.calls).toEqual([EXTRACT, EXTRACT, OTHER]);
  });

  it('three 429s: the extraction fails as rate_limited after exactly three calls', async () => {
    sdk.queue[EXTRACT] = [rateLimited(), rateLimited()];
    sdk.queue[JUDGE] = [rateLimited()];
    const { service } = await load();
    const err = await service.extractClaims('The Eiffel Tower is in Paris.', SECRET).catch((e) => e);
    expect(err?.name ?? err?.constructor?.name).toMatch(/ExtractionError/);
    expect(err.reason).toBe('rate_limited');
    expect(sdk.calls).toEqual([EXTRACT, EXTRACT, JUDGE]);
  });

  it('extraction model equal to the judge model: retries once, no fallback call', async () => {
    process.env.FAULTLINE_GEMINI_EXTRACTION_MODEL = JUDGE;
    sdk.queue[JUDGE] = [rateLimited(), rateLimited()];
    const { service } = await load();
    expect(service.GEMINI_EXTRACTION_FALLBACK_MODEL).toBeNull();
    const err = await service.extractClaims('The Eiffel Tower is in Paris.', SECRET).catch((e) => e);
    expect(err.reason).toBe('rate_limited');
    expect(sdk.calls).toEqual([JUDGE, JUDGE]);
  });

  it('a non-rate-limit error is not retried', async () => {
    sdk.queue[EXTRACT] = [serverError()];
    const { service } = await load();
    const err = await service.extractClaims('The Eiffel Tower is in Paris.', SECRET).catch((e) => e);
    expect(err.reason).not.toBe('rate_limited');
    expect(sdk.calls).toEqual([EXTRACT]);
  });

  it('an empty account (429 insufficient_quota) is not retried', async () => {
    sdk.queue[EXTRACT] = [outOfCredits()];
    const { service } = await load();
    await service.extractClaims('The Eiffel Tower is in Paris.', SECRET).catch(() => undefined);
    expect(sdk.calls).toEqual([EXTRACT]);
  });

  it('the warning names the model and the quota, never the key', async () => {
    sdk.queue[EXTRACT] = [rateLimited()];
    const { service } = await load();
    await service.extractClaims('The Eiffel Tower is in Paris.', SECRET);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(EXTRACT);
    expect(line).toContain('quotaId=GenerateRequestsPerMinutePerProjectPerModel quotaValue=4000');
    expect(line).not.toContain(SECRET);
  });

  it('rateLimitQuotaOf says so when Google names no quota', async () => {
    const { service } = await load();
    expect(service.rateLimitQuotaOf(new Error('got status: 429 Too Many Requests'))).toBe('quota not named');
  });
});
