/**
 * POST /scan takes `pipelineConfig.consensus` and `consensusProviders`, the same
 * fields as POST /scan/stream, behind the same Enterprise-only gate.
 *
 * Before, the /scan body schema did not list them and Fastify stripped them, so a
 * caller who asked for consensus got a single-provider scan with no word that
 * consensus had not run.
 *
 * Validates: consensus is Enterprise only, enforced server-side on POST /scan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';

// Every provider the engine builds comes through getProvider, so a spy on it shows
// whether a request reached any provider at all.
const getProviderSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return {
    ...actual,
    getProvider: vi.fn((...args: Parameters<typeof actual.getProvider>) => {
      getProviderSpy.calls += 1;
      return actual.getProvider(...args);
    }),
  };
});

const SERVER_KEY = 'scan-consensus-gate-server-key';
const TEXT = 'The Eiffel Tower is located in Berlin.';
const CONSENSUS_BODY = {
  text: TEXT,
  provider: 'mock',
  pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['mock'] },
};

let server: FastifyInstance;

function postScan(apiKey: string, body: Record<string, unknown>, userTier?: string) {
  const headers: Record<string, string> = { 'x-api-key': apiKey, 'content-type': 'application/json' };
  if (userTier !== undefined) headers['x-user-tier'] = userTier;
  return server.inject({ method: 'POST', url: '/scan', headers, payload: JSON.stringify(body) });
}

function consensusVerdicts(json: Record<string, unknown>): unknown[] {
  const verifications = (json.verifications ?? {}) as Record<string, { consensus?: unknown }>;
  return Object.values(verifications).map((v) => v.consensus).filter((c) => c !== undefined);
}

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  getProviderSpy.calls = 0;
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
  resetKeyStore();
});

describe('POST /scan: consensus behind the plan gate', () => {
  it('refuses consensus for a forwarded free user with 403 and makes no provider call', async () => {
    const res = await postScan(SERVER_KEY, CONSENSUS_BODY, 'free');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'consensus_not_in_plan', plan: 'free' });
    expect(getProviderSpy.calls).toBe(0);
  });

  it('refuses consensus for a keystore key, whatever plan it claims, with no provider call', async () => {
    const k = getKeyStore().create('direct', ['scan']);
    const res = await postScan(k.key, CONSENSUS_BODY, 'enterprise');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('consensus_not_in_plan');
    expect(getProviderSpy.calls).toBe(0);
  });

  it('serves a consensus scan to the server key (mock provider)', async () => {
    const res = await postScan(SERVER_KEY, CONSENSUS_BODY);
    expect(res.statusCode).toBe(200);
    const verdicts = consensusVerdicts(res.json());
    expect(verdicts.length).toBeGreaterThan(0);
    expect(getProviderSpy.calls).toBeGreaterThan(0);
  });

  it('serves a consensus scan to a forwarded enterprise user', async () => {
    const res = await postScan(SERVER_KEY, CONSENSUS_BODY, 'enterprise');
    expect(res.statusCode).toBe(200);
    expect(consensusVerdicts(res.json()).length).toBeGreaterThan(0);
  });

  it('leaves consensus: false untouched for a free user (single-provider scan)', async () => {
    const res = await postScan(SERVER_KEY, { text: TEXT, provider: 'mock', pipelineConfig: { consensus: false } }, 'free');
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Object.keys(json.verifications).length).toBeGreaterThan(0);
    expect(consensusVerdicts(json)).toHaveLength(0);
  });

  it('rejects an unknown consensus provider with 400, never strips it', async () => {
    const res = await postScan(SERVER_KEY, {
      text: TEXT, provider: 'mock', pipelineConfig: { consensus: true, consensusProviders: ['not-a-provider'] },
    });
    expect(res.statusCode).toBe(400);
    expect(getProviderSpy.calls).toBe(0);
  });
});
