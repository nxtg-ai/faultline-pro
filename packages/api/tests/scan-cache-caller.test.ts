// Validates: N-234 (EP4 Amendment 2 item 7: the JSON /scan cache is per caller, says when it was checked, and never holds Gemini Grounded Results; emma-soul al:193832a732e0b82e)
/**
 * The JSON /scan cache served one caller's 24-hour-old verdicts to another
 * caller with only an X-Cache header. Now:
 * - a cached result is served back only to the caller that ran it (API key,
 *   and behind faultline-web's server key, the forwarded user ref);
 * - a hit says so in the body: cache {hit: true, checkedAt};
 * - a Gemini-grounded result is never cached (Google's terms: "will not ...
 *   cache ... Grounded Results").
 * Only the Google SDK and a fixture provider are mocked; route and store are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (grounded) {
          return {
            text: '{"status":"supported","explanation":"ok"}',
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 'g', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' } }] } }],
          };
        }
        return {
          text: JSON.stringify([{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 }]),
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetCache, getScanCache, holdsGroundedResults } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { registerProvider } from '@nxtg/faultline/providers/registry.js';

registerProvider('mock', () => ({
  name: 'Cache fixture',
  modelId: 'fixture-v1',
  extractClaims: async () => [{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 }],
  verifyClaim: async (c: { id: string }) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [{ title: 'p', uri: 'https://publisher.example/a' }] }),
  generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
}) as never);

const SERVER_KEY = 'srv-cache-caller-test-key-0123456789';
const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'FAULTLINE_CONSENSUS', 'FAULTLINE_API_KEY'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-cache-caller-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function withServer<T>(fn: (post: (key: string, provider: string, headers?: Record<string, string>) => Promise<{ cache: string | undefined; body: Record<string, any> }>) => Promise<T>): Promise<T> {
  const server = buildServer();
  await server.ready();
  try {
    return await fn(async (key, provider, headers = {}) => {
      const res = await server.inject({
        method: 'POST', url: '/scan',
        headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers },
        payload: { text: 'The Eiffel Tower was completed in 1889.', provider },
      });
      expect(res.statusCode).toBe(200);
      return { cache: res.headers['x-cache'] as string | undefined, body: res.json() };
    });
  } finally {
    await server.close();
  }
}

describe('JSON /scan cache', () => {
  it('a hit goes back only to the same key, and says in the body when it was checked', async () => {
    const a = getKeyStore().create('A', ['pro', 'scan']).key;
    const b = getKeyStore().create('B', ['pro', 'scan']).key;
    await withServer(async (post) => {
      const first = await post(a, 'mock');
      expect(first.cache).toBe('MISS');
      expect(first.body.cache).toBeUndefined();
      const again = await post(a, 'mock');
      expect(again.cache).toBe('HIT');
      expect(again.body.cache.hit).toBe(true);
      expect(again.body.cache.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(again.body.cache.checkedAt)).toBeLessThanOrEqual(Date.now());
      const other = await post(b, 'mock');
      expect(other.cache).toBe('MISS');
      expect(other.body.cache).toBeUndefined();
    });
  }, 30_000);

  it('behind the server key, two users (x-faultline-user-ref) never share an entry', async () => {
    await withServer(async (post) => {
      expect((await post(SERVER_KEY, 'mock', { 'x-faultline-user-ref': 'user_aaaaaaaa' })).cache).toBe('MISS');
      expect((await post(SERVER_KEY, 'mock', { 'x-faultline-user-ref': 'user_aaaaaaaa' })).cache).toBe('HIT');
      expect((await post(SERVER_KEY, 'mock', { 'x-faultline-user-ref': 'user_bbbbbbbb' })).cache).toBe('MISS');
    });
  }, 30_000);

  it('a forwarded user ref from a key that is not the server key is ignored (the key is one caller)', async () => {
    const a = getKeyStore().create('A', ['pro', 'scan']).key;
    await withServer(async (post) => {
      expect((await post(a, 'mock', { 'x-faultline-user-ref': 'user_aaaaaaaa' })).cache).toBe('MISS');
      expect((await post(a, 'mock', { 'x-faultline-user-ref': 'user_cccccccc' })).cache).toBe('HIT');
    });
  }, 30_000);

  it('a Gemini-grounded scan is never cached, not even for its own caller', async () => {
    const a = getKeyStore().create('A', ['pro', 'scan']).key;
    await withServer(async (post) => {
      const first = await post(a, 'gemini');
      expect(first.body.verifications.c1.provenance.retriever).toBe('gemini-grounding');
      expect((await post(a, 'gemini')).cache).toBe('MISS');
      expect(getScanCache().stats().size).toBe(0);
    });
  }, 30_000);
});

describe('holdsGroundedResults', () => {
  it('spots a gemini-grounding verdict, a gemini provider, or a grounding Link source', () => {
    const v = (over: Record<string, unknown>) => ({ verifications: { c1: { status: 'supported', sources: [], ...over } } });
    expect(holdsGroundedResults(v({ provenance: { provider: 'consensus', retriever: 'gemini-grounding' } }))).toBe(true);
    expect(holdsGroundedResults(v({ provenance: { provider: 'gemini' } }))).toBe(true);
    expect(holdsGroundedResults(v({ sources: [{ uri: 'https://VERTEXAISEARCH.cloud.google.com/grounding-api-redirect/z' }] }))).toBe(true);
    expect(holdsGroundedResults(v({ provenance: { provider: 'openai' }, sources: [{ uri: 'https://publisher.example/a' }] }))).toBe(false);
    expect(getScanCache().set('k', 't', 'p', v({ provenance: { provider: 'gemini', model: 'm', verifiedAt: 'T' } }) as never)).toBe(false);
  });
});
