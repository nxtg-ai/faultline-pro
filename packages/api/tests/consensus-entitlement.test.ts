/**
 * Consensus is an Enterprise-only feature, enforced server-side on POST /scan/stream.
 *
 * Asif ruling 2026-09-30, re-ruled to ENTERPRISE ONLY (al:252ac668b119d9cf):
 * before this, `pipelineConfig.consensus` was an opt-in any key could set, and a
 * consensus scan costs $0.20–0.71. A caller below Enterprise is REFUSED (403),
 * never silently downgraded to a single-model scan.
 *
 * The tier comes from `x-user-tier` only when the caller holds the server's own
 * key (faultline-web); for any keystore key the header is ignored (ae4987a).
 *
 * Validates: N-231 (consensus tier gate — Enterprise only, server-side).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resolveEntitledTier, isConsensusEntitled } from '../src/plugins/consensus-entitlement.js';

const ADMIN_KEY = 'test-consensus-admin-key';
const TEXT = 'The Eiffel Tower is located in Berlin.';

const CONSENSUS_BODY = {
  text: TEXT,
  provider: 'mock',
  pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['mock'] },
};

async function post(
  server: FastifyInstance,
  apiKey: string,
  body: Record<string, unknown>,
  userTier?: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null; body: string }> {
  const headers: Record<string, string> = { 'x-api-key': apiKey, 'content-type': 'application/json' };
  if (userTier !== undefined) headers['x-user-tier'] = userTier;
  const res = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: JSON.stringify(body) });
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* SSE body */ }
  return { statusCode: res.statusCode, json, body: res.body };
}

function consensusVerdictReached(body: string): boolean {
  return body
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>)
    .some((e) => e.type === 'claim_verified' && (e.verdict as Record<string, unknown>)?.consensus !== undefined);
}

describe('resolveEntitledTier', () => {
  beforeEach(() => resetKeyStore());

  it('honours a forwarded plan from the server key', () => {
    expect(resolveEntitledTier('admin', 'enterprise')).toBe('enterprise');
    expect(resolveEntitledTier('admin', 'pro')).toBe('pro');
    expect(resolveEntitledTier('admin', 'free')).toBe('free');
    expect(resolveEntitledTier('admin', ['personal'])).toBe('personal');
  });

  it('treats the server key with no forwarded plan as an internal enterprise caller', () => {
    expect(resolveEntitledTier('admin', undefined)).toBe('enterprise');
    expect(resolveEntitledTier('admin', '')).toBe('enterprise');
  });

  it('fails closed to free on a forwarded value that is not a plan', () => {
    expect(resolveEntitledTier('admin', 'widget')).toBe('free');
    expect(resolveEntitledTier('admin', 'ENTERPRISE')).toBe('free');
  });

  it('ignores the header for a keystore key', () => {
    const k = getKeyStore().create('direct', ['scan']);
    expect(resolveEntitledTier(k.id, 'enterprise')).toBe('personal');
    const p = getKeyStore().create('direct-pro', ['scan', 'pro']);
    expect(resolveEntitledTier(p.id, 'enterprise')).toBe('pro');
  });

  it('entitles enterprise only', () => {
    expect(isConsensusEntitled('enterprise')).toBe(true);
    for (const t of ['pro', 'personal', 'free', 'anon', 'userkey'] as const) {
      expect(isConsensusEntitled(t)).toBe(false);
    }
  });
});

describe('POST /scan/stream — consensus tier gate', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetKeyStore();
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    resetKeyStore();
  });

  it('serves consensus to a forwarded enterprise user', async () => {
    const res = await post(server, ADMIN_KEY, CONSENSUS_BODY, 'enterprise');
    expect(res.statusCode).toBe(200);
    expect(consensusVerdictReached(res.body)).toBe(true);
  });

  it('serves consensus to the server key with no forwarded plan (internal caller)', async () => {
    const res = await post(server, ADMIN_KEY, CONSENSUS_BODY);
    expect(res.statusCode).toBe(200);
    expect(consensusVerdictReached(res.body)).toBe(true);
  });

  for (const tier of ['pro', 'personal', 'free', 'anon', 'userkey', 'widget']) {
    it(`refuses consensus for a forwarded ${tier} user with 403, no scan`, async () => {
      const res = await post(server, ADMIN_KEY, CONSENSUS_BODY, tier);
      expect(res.statusCode).toBe(403);
      expect(res.json?.error).toBe('consensus_not_in_plan');
      expect(res.body).not.toContain('claim_verified');
    });
  }

  it('refuses a keystore key that spoofs x-user-tier: enterprise', async () => {
    const k = getKeyStore().create('spoofer', ['scan', 'pro']);
    const res = await post(server, k.key, CONSENSUS_BODY, 'enterprise');
    expect(res.statusCode).toBe(403);
    expect(res.json?.plan).toBe('pro');
  });

  it('leaves non-consensus scans untouched for a free user', async () => {
    const res = await post(server, ADMIN_KEY, { text: TEXT, provider: 'mock' }, 'free');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('claim_verified');
  });

  it('leaves consensus: false untouched for a free user', async () => {
    const res = await post(
      server, ADMIN_KEY,
      { text: TEXT, provider: 'mock', pipelineConfig: { consensus: false } },
      'free',
    );
    expect(res.statusCode).toBe(200);
  });
});
