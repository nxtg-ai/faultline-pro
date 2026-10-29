/**
 * A scan counts toward the monthly quota only when its delivered result holds
 * at least one billable verdict: supported, contradicted or mixed, with at
 * least one source, and not an API error (billableVerdictCount). A non-consensus
 * Gemini scan can answer 200 with nothing billable in it; that scan must not use
 * up a customer's allowance, on bare /scan, on /scan with a query string, or on
 * /scan/stream.
 *
 * Only the Google SDK is mocked; the routes, the gates and the scan engine are real.
 * Text extraction is a pass-through spy, so the upload test can prove it never ran.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Mode = 'error' | 'unverified' | 'no-sources' | 'sourced';
const sdk = vi.hoisted(() => ({ mode: 'sourced' as string, calls: 0 }));

const CLAIM_TEXT = 'The Eiffel Tower was completed in 1889.';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        sdk.calls += 1;
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (!grounded) {
          return {
            text: JSON.stringify([{ id: 'c1', text: CLAIM_TEXT, type: 'fact', importance: 5 }]),
            usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
          };
        }
        if (sdk.mode === 'error') throw new Error('503 Service Unavailable: the model is overloaded');
        const chunks = sdk.mode === 'no-sources'
          ? []
          : [{ web: { title: 'Publisher', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' } }];
        const status = sdk.mode === 'unverified' ? 'unverified' : 'supported';
        return {
          text: JSON.stringify({ status, explanation: 'Checked against the search results.' }),
          modelVersion: 'gemini-2.5-flash',
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
          candidates: [{ groundingMetadata: { groundingChunks: chunks } }],
        };
      },
    };
  },
}));

// A pass-through spy, so the upload test can prove no text extraction ran.
vi.mock('@nxtg/faultline/cli/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/extract.js')>();
  return { ...actual, extractTextFromBuffer: vi.fn(actual.extractTextFromBuffer) };
});

import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { getUsageMeter, resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { extractTextFromBuffer } from '@nxtg/faultline/cli/extract.js';

const ENV_KEYS = [
  'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'FAULTLINE_CONSENSUS',
  'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_USAGE_CAP', 'FAULTLINE_CAP_PRO',
];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-scan-quota-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.FAULTLINE_EVIDENCE_FETCH = 'off';
  sdk.mode = 'sourced';
  sdk.calls = 0;
  vi.mocked(extractTextFromBuffer).mockClear();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetUsageMeter();
  resetCache();
  resetCircuitBreaker();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Verdict { status?: string; sources?: unknown[]; apiError?: boolean }

/** One scan through `url`; returns the HTTP status and the verdicts it delivered. */
async function runScan(url: string, key: string): Promise<{ status: number; verdicts: Verdict[] }> {
  const res = await server.inject({
    method: 'POST', url,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload: { text: CLAIM_TEXT, provider: 'gemini' },
  });
  if (res.statusCode !== 200) return { status: res.statusCode, verdicts: [] };
  if (url.startsWith('/scan/stream')) {
    const verdicts = res.body.split('\n\n')
      .map((chunk) => chunk.replace(/^data: /, ''))
      .filter((chunk) => chunk.includes('"claim_verified"'))
      .map((chunk) => (JSON.parse(chunk) as { verdict: Verdict }).verdict);
    return { status: 200, verdicts };
  }
  return { status: 200, verdicts: Object.values(res.json().verifications as Record<string, Verdict>) };
}

const proKey = () => {
  const entry = getKeyStore().create('Pro Key', ['pro', 'scan']);
  return { key: entry.key, id: entry.id };
};

describe.each(['/scan', '/scan?x=1', '/scan/stream'])('POST %s monthly scan quota', (url) => {
  it('every verification an API error: 200, counted 0', async () => {
    sdk.mode = 'error' satisfies Mode;
    const { key, id } = proKey();
    const { status, verdicts } = await runScan(url, key);
    expect(status).toBe(200);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.apiError === true)).toBe(true);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);

  it('every verification unverified: 200, counted 0', async () => {
    sdk.mode = 'unverified' satisfies Mode;
    const { key, id } = proKey();
    const { status, verdicts } = await runScan(url, key);
    expect(status).toBe(200);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.status === 'unverified' && v.apiError !== true)).toBe(true);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);

  it('the model said supported but the search returned no source: 200, counted 0', async () => {
    sdk.mode = 'no-sources' satisfies Mode;
    const { key, id } = proKey();
    const { status, verdicts } = await runScan(url, key);
    expect(status).toBe(200);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.status === 'supported' && Array.isArray(v.sources) && v.sources.length === 0)).toBe(true);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);

  it('a sourced supported verdict: counted 1, and at the cap the next request is 402', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '1';
    sdk.mode = 'sourced' satisfies Mode;
    const { key, id } = proKey();
    const first = await runScan(url, key);
    expect(first.status).toBe(200);
    expect(first.verdicts.length).toBeGreaterThan(0);
    expect(first.verdicts.some((v) => v.status === 'supported' && (v.sources?.length ?? 0) > 0)).toBe(true);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);

    const callsBefore = sdk.calls;
    const second = await runScan(url, key);
    expect(second.status).toBe(402);
    expect(sdk.calls).toBe(callsBefore);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);

  it('scans with nothing billable never reach the cap', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '1';
    sdk.mode = 'error' satisfies Mode;
    const { key, id } = proKey();
    expect((await runScan(url, key)).status).toBe(200);
    expect((await runScan(url, key)).status).toBe(200);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);
});

function multipart(boundary: string, buffer: Buffer, mimetype: string): Buffer {
  const crlf = '\r\n';
  return Buffer.concat([
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="provider"${crlf}${crlf}gemini${crlf}`),
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="doc.pdf"${crlf}Content-Type: ${mimetype}${crlf}${crlf}`),
    buffer,
    Buffer.from(`${crlf}--${boundary}--${crlf}`),
  ]);
}

async function upload(key: string): Promise<{ statusCode: number; body: string }> {
  const boundary = 'QuotaUploadBoundary';
  return server.inject({
    method: 'POST', url: '/scan/upload',
    headers: { 'x-api-key': key, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, Buffer.from('%PDF-1.4 fixture'), 'application/pdf'),
  });
}

describe('POST /scan/upload monthly scan quota', () => {
  it('a key at its cap gets 402 on a valid upload: no text extraction, no provider call', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '1';
    const { key, id } = proKey();
    getUsageMeter().increment(id); // at the cap

    const res = await upload(key);
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).error).toContain('quota exceeded');
    expect(extractTextFromBuffer).not.toHaveBeenCalled();
    expect(sdk.calls).toBe(0);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);

  it('below the cap, an upload with a sourced verdict counts 1 and one with only API errors counts 0', async () => {
    vi.mocked(extractTextFromBuffer).mockResolvedValueOnce(CLAIM_TEXT).mockResolvedValueOnce(CLAIM_TEXT);
    const { key, id } = proKey();

    sdk.mode = 'error' satisfies Mode;
    expect((await upload(key)).statusCode).toBe(200);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);

    sdk.mode = 'sourced' satisfies Mode;
    expect((await upload(key)).statusCode).toBe(200);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
    expect(sdk.calls).toBeGreaterThan(0);
  }, 30_000);
});

async function batch(key: string, texts: string[]): Promise<{ statusCode: number; json: Record<string, any> }> {
  const res = await server.inject({
    method: 'POST', url: '/scan/batch',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload: { texts, provider: 'gemini' },
  });
  return { statusCode: res.statusCode, json: res.json() };
}

describe('POST /scan/batch monthly scan quota', () => {
  it('a key at its cap gets the same 402 body as /scan for the whole batch: no provider call, no count', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '1';
    const { key, id } = proKey();
    getUsageMeter().increment(id); // at the cap

    const single = await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: { text: CLAIM_TEXT, provider: 'gemini' },
    });
    expect(single.statusCode).toBe(402);

    const res = await batch(key, [CLAIM_TEXT, CLAIM_TEXT]);
    expect(res.statusCode).toBe(402);
    expect(res.json).toEqual(single.json());
    expect(sdk.calls).toBe(0);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);

  it('a batch larger than what is left is refused whole, never part-served', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '2';
    const { key, id } = proKey();
    getUsageMeter().increment(id); // one scan left

    const res = await batch(key, [CLAIM_TEXT, CLAIM_TEXT]);
    expect(res.statusCode).toBe(402);
    expect(res.json).toMatchObject({ limit: 2, used: 1, remaining: 1 });
    expect(sdk.calls).toBe(0);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);

  it('a batch that fits is served, and each text with a sourced verdict counts one scan', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '3';
    const { key, id } = proKey();
    getUsageMeter().increment(id);

    const res = await batch(key, [CLAIM_TEXT, CLAIM_TEXT]);
    expect(res.statusCode).toBe(200);
    expect(res.json.succeeded).toBe(2);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(3);
  }, 30_000);
});

async function deep(key: string): Promise<{ statusCode: number; cache?: string; verdicts: Verdict[] }> {
  const res = await server.inject({
    method: 'POST', url: '/scan/deep',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload: { text: CLAIM_TEXT, provider: 'gemini' },
  });
  const verdicts = res.statusCode === 200 ? Object.values(res.json().verifications as Record<string, Verdict>) : [];
  return { statusCode: res.statusCode, cache: res.headers['x-cache'] as string | undefined, verdicts };
}

describe('POST /scan/deep monthly scan quota', () => {
  it('a sourced supported deep scan counts 1', async () => {
    const { key, id } = proKey();
    const res = await deep(key);
    expect(res.statusCode).toBe(200);
    expect(res.cache).toBe('MISS');
    expect(res.verdicts.some((v) => v.status === 'supported' && (v.sources?.length ?? 0) > 0)).toBe(true);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);

  it('a deep scan with only API errors counts 0', async () => {
    sdk.mode = 'error' satisfies Mode;
    const { key, id } = proKey();
    const res = await deep(key);
    expect(res.statusCode).toBe(200);
    expect(res.verdicts.length).toBeGreaterThan(0);
    expect(res.verdicts.every((v) => v.apiError === true)).toBe(true);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);

  it('a key at its cap gets 402 before any provider call', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '1';
    const { key, id } = proKey();
    getUsageMeter().increment(id);
    const res = await deep(key);
    expect(res.statusCode).toBe(402);
    expect(sdk.calls).toBe(0);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);
});

/**
 * The synchronous scan routes that serve something other than the scan JSON (a
 * diff, a PDF, a compliance analysis or gate) count like /scan: once on success,
 * when what they served holds a billable verdict.
 */
const SYNC_ROUTES: Array<{ url: string; payload: Record<string, unknown>; served: number[] }> = [
  { url: '/scan/diff', payload: { before: CLAIM_TEXT, after: CLAIM_TEXT, provider: 'gemini' }, served: [200] },
  { url: '/scan/report', payload: { text: CLAIM_TEXT, provider: 'gemini' }, served: [200] },
  { url: '/scan/eu-report', payload: { text: CLAIM_TEXT, provider: 'gemini' }, served: [200] },
  { url: '/scan/compliance/healthcare', payload: { text: CLAIM_TEXT, provider: 'gemini' }, served: [200] },
  // A failed gate (422) still served the scan.
  { url: '/scan/compliance-gate', payload: { text: CLAIM_TEXT, provider: 'gemini' }, served: [200, 422] },
];

describe.each(SYNC_ROUTES)('POST $url monthly scan quota', ({ url, payload, served }) => {
  const send = (key: string) => server.inject({
    method: 'POST', url,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload,
  });

  it('a sourced verdict is served and counted 1; at the cap the next request is 402 with no provider call', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '1';
    const { key, id } = proKey();
    const first = await send(key);
    expect(served).toContain(first.statusCode);
    expect(first.rawPayload.length).toBeGreaterThan(0);
    expect(sdk.calls).toBeGreaterThan(0);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);

    const callsBefore = sdk.calls;
    const second = await send(key);
    expect(second.statusCode).toBe(402);
    expect(second.json()).toMatchObject({ error: 'Monthly scan quota exceeded.', limit: 1, used: 1, remaining: 0 });
    expect(sdk.calls).toBe(callsBefore);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  }, 30_000);

  it('a result with only API errors is served and counted 0', async () => {
    sdk.mode = 'error' satisfies Mode;
    const { key, id } = proKey();
    const res = await send(key);
    expect(served).toContain(res.statusCode);
    expect(sdk.calls).toBeGreaterThan(0);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);

  it('a scan that fails is not counted', async () => {
    delete process.env.GEMINI_API_KEY;
    const { key, id } = proKey();
    const res = await send(key);
    expect(served).not.toContain(res.statusCode);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(0);
  }, 30_000);
});
