/**
 * Per-tier verify cap, API half (GoPMO 1.18.11.3.5).
 *
 * The cap is a server-side table keyed by the ENTITLED plan (resolveEntitledTier:
 * x-user-tier is honoured only from the server's own key). No request field can
 * set it. Every plan is 8 today, so responses match the old fixed cap; each
 * response reports verification {tier, cap, eligibleClaims, verifiedClaims,
 * uncheckedClaims, uncheckedClaimIds}. The scan cache is keyed on the cap.
 *
 * Validates: 1.18.11.3.5 (per-tier verify cap)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Test-only cap overrides, so the plumbing can be proven with a cap other than 8
// (every real plan is 8, which a route that ignored the table would also return).
const capOverride = vi.hoisted(() => new Map<string, number>());

vi.mock('../src/plugins/verify-cap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/verify-cap.js')>();
  return {
    ...actual,
    resolveVerifyPolicy: (keyId: string, headerTier?: string | string[]) => {
      const policy = actual.resolveVerifyPolicy(keyId, headerTier);
      const override = capOverride.get(policy.tier);
      return override === undefined ? policy : { ...policy, cap: override };
    },
  };
});

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { getScanCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import {
  VERIFY_CAP_BY_TIER,
  verifyCapForTier,
  resolveVerifyPolicy,
  withVerificationTier,
} from '../src/plugins/verify-cap.js';

const ADMIN_KEY = 'test-verify-cap-admin-key';
const ALL_TIERS = ['enterprise', 'pro', 'personal', 'free', 'anon', 'userkey'] as const;

// Mock provider: one fact per sentence, importance 3,3,4,4,5,5,... → 12 eligible.
const TWELVE = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} states a checkable fact`).join('. ') + '.';
const UNCHECKED_AT_8 = ['c3', 'c4', 'c1', 'c2'];

type Json = Record<string, unknown>;

async function postScan(
  server: FastifyInstance,
  apiKey: string,
  body: Json,
  userTier?: string,
): Promise<{ statusCode: number; json: Json; cache: string | undefined }> {
  const headers: Record<string, string> = { 'x-api-key': apiKey, 'content-type': 'application/json' };
  if (userTier !== undefined) headers['x-user-tier'] = userTier;
  const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: JSON.stringify(body) });
  return { statusCode: res.statusCode, json: JSON.parse(res.body) as Json, cache: res.headers['x-cache'] as string | undefined };
}

function sseEvents(body: string): Json[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Json);
}

const verificationOf = (json: Json): Json => json.verification as Json;

describe('VERIFY_CAP_BY_TIER', () => {
  it('lists every plan, and every plan is 8', () => {
    expect(Object.keys(VERIFY_CAP_BY_TIER).sort()).toEqual([...ALL_TIERS].sort());
    for (const tier of ALL_TIERS) {
      expect(VERIFY_CAP_BY_TIER[tier]).toBe(8);
      expect(verifyCapForTier(tier)).toBe(8);
    }
  });

  it('is frozen, so a route cannot raise a plan at runtime', () => {
    expect(Object.isFrozen(VERIFY_CAP_BY_TIER)).toBe(true);
  });
});

describe('resolveVerifyPolicy — trusted tier', () => {
  beforeEach(() => resetKeyStore());
  afterEach(() => resetKeyStore());

  it('resolves every forwarded plan from the server key to cap 8', () => {
    for (const tier of ALL_TIERS) {
      expect(resolveVerifyPolicy('admin', tier)).toEqual({ tier, cap: 8 });
    }
  });

  it('a keystore key sending x-user-tier keeps its own plan', () => {
    const personal = getKeyStore().create('direct', ['scan']);
    expect(resolveVerifyPolicy(personal.id, 'enterprise')).toEqual({ tier: 'personal', cap: 8 });
    const pro = getKeyStore().create('direct-pro', ['scan', 'pro']);
    expect(resolveVerifyPolicy(pro.id, 'enterprise')).toEqual({ tier: 'pro', cap: 8 });
  });
});

describe('withVerificationTier', () => {
  it('adds the tier without mutating the cached result', () => {
    const cached = { overallRisk: 'low', verification: { cap: 8, eligibleClaims: 2, verifiedClaims: 2, uncheckedClaims: 0, uncheckedClaimIds: [] } };
    const out = withVerificationTier(cached, 'pro');
    expect(out.verification).toEqual({ cap: 8, eligibleClaims: 2, verifiedClaims: 2, uncheckedClaims: 0, uncheckedClaimIds: [], tier: 'pro' });
    expect(cached.verification).not.toHaveProperty('tier');
  });
});

describe('ScanCache — keyed on the verify cap', () => {
  beforeEach(() => getScanCache().flush());

  it('a result cached under one cap is not served under another', () => {
    const cache = getScanCache();
    cache.set('same text', 'mock', { marker: 'cap3' }, 3);
    expect(cache.get('same text', 'mock', 8)).toBeNull();
    expect(cache.get('same text', 'mock', 3)).toEqual({ marker: 'cap3' });
  });

  it('no cap means the engine default (8), so warm-up entries serve 8-cap plans', () => {
    const cache = getScanCache();
    cache.set('warm text', 'mock', { marker: 'default' });
    expect(cache.get('warm text', 'mock', 8)).toEqual({ marker: 'default' });
    expect(cache.get('warm text', 'mock', 3)).toBeNull();
  });
});

describe('routes — per-tier verify cap', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetKeyStore();
    resetCircuitBreaker();
    getScanCache().flush();
    capOverride.clear();
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    capOverride.clear();
    getScanCache().flush();
    resetKeyStore();
  });

  for (const tier of ALL_TIERS) {
    it(`POST /scan as a forwarded ${tier} user verifies 8 of 12 and reports tier ${tier}`, async () => {
      const res = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, tier);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json.verifications as Json)).toHaveLength(8);
      expect(verificationOf(res.json)).toEqual({
        tier,
        cap: 8,
        eligibleClaims: 12,
        verifiedClaims: 8,
        uncheckedClaims: 4,
        uncheckedClaimIds: UNCHECKED_AT_8,
      });
    });
  }

  it('POST /scan pipelineConfig path reports the tier and counts', async () => {
    const res = await postScan(server, ADMIN_KEY, {
      text: TWELVE, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', verificationProvider: 'mock' },
    }, 'free');
    expect(res.statusCode).toBe(200);
    expect(verificationOf(res.json)).toMatchObject({ tier: 'free', cap: 8, eligibleClaims: 12, verifiedClaims: 8, uncheckedClaims: 4 });
  });

  it('a body that tries to set the cap is accepted with the field stripped: cap stays 8', async () => {
    // Fastify's default Ajv runs removeAdditional, so additionalProperties:false
    // strips unknown fields instead of rejecting them. Assert the strip.
    const res = await postScan(server, ADMIN_KEY, {
      text: TWELVE,
      provider: 'mock',
      verifyCap: 50,
      cap: 50,
      pipelineConfig: { extractionProvider: 'mock', verifyCap: 50 },
    }, 'free');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json.verifications as Json)).toHaveLength(8);
    expect(verificationOf(res.json)).toMatchObject({ tier: 'free', cap: 8, verifiedClaims: 8, uncheckedClaims: 4 });
  });

  it('a keystore key sending x-user-tier cannot change its resolved tier', async () => {
    const k = getKeyStore().create('spoofer', ['scan']);
    capOverride.set('enterprise', 12); // were the spoof honoured, all 12 would be verified
    const res = await postScan(server, k.key, { text: TWELVE, provider: 'mock' }, 'enterprise');
    expect(res.statusCode).toBe(200);
    expect(verificationOf(res.json)).toMatchObject({ tier: 'personal', cap: 8, verifiedClaims: 8, uncheckedClaims: 4 });
  });

  it('the route applies the plan cap it resolves (override pro → 3)', async () => {
    capOverride.set('pro', 3);
    const res = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, 'pro');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json.verifications as Json)).toHaveLength(3);
    expect(verificationOf(res.json)).toMatchObject({ tier: 'pro', cap: 3, eligibleClaims: 12, verifiedClaims: 3, uncheckedClaims: 9 });
  });

  it('the cache never serves one cap\'s result to a plan with another cap', async () => {
    capOverride.set('pro', 3);
    const proFirst = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, 'pro');
    expect(proFirst.cache).toBe('MISS');
    expect(verificationOf(proFirst.json)).toMatchObject({ cap: 3, verifiedClaims: 3 });

    const enterprise = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, 'enterprise');
    expect(enterprise.cache).toBe('MISS');
    expect(verificationOf(enterprise.json)).toMatchObject({ tier: 'enterprise', cap: 8, verifiedClaims: 8 });

    const proAgain = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, 'pro');
    expect(proAgain.cache).toBe('HIT');
    expect(verificationOf(proAgain.json)).toMatchObject({ tier: 'pro', cap: 3, verifiedClaims: 3 });
  });

  it('a cache hit reports the tier of the request it serves, not the one that filled it', async () => {
    const first = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, 'enterprise');
    expect(first.cache).toBe('MISS');
    const second = await postScan(server, ADMIN_KEY, { text: TWELVE, provider: 'mock' }, 'free');
    expect(second.cache).toBe('HIT');
    expect(verificationOf(second.json)).toMatchObject({ tier: 'free', cap: 8, verifiedClaims: 8, uncheckedClaims: 4 });
  });

  it('POST /scan/stream: the complete event carries verification with tier and counts', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/stream',
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json', 'x-user-tier': 'personal' },
      payload: JSON.stringify({ text: TWELVE, provider: 'mock', verifyCap: 50 }),
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events.filter((e) => e.type === 'claim_verified')).toHaveLength(8);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.verification).toEqual({
      tier: 'personal', cap: 8, eligibleClaims: 12, verifiedClaims: 8, uncheckedClaims: 4, uncheckedClaimIds: UNCHECKED_AT_8,
    });
  });

  it('GET /scan/stream: a verifyCap query param is ignored; the plan cap applies', async () => {
    capOverride.set('free', 3);
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(TWELVE)}&provider=mock&verifyCap=50`,
      headers: { 'x-api-key': ADMIN_KEY, 'x-user-tier': 'free' },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events.filter((e) => e.type === 'claim_verified')).toHaveLength(3);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete!.verification).toMatchObject({ tier: 'free', cap: 3, verifiedClaims: 3, uncheckedClaims: 9 });
  });

  it('POST /scan/template/:id reports the tier and counts', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/templates',
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'verify-cap', provider: 'mock' }),
    });
    expect(created.statusCode).toBeLessThan(300);
    const templateId = (JSON.parse(created.body) as Json).id as string;
    expect(templateId).toBeTruthy();

    const res = await server.inject({
      method: 'POST',
      url: `/scan/template/${templateId}`,
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json', 'x-user-tier': 'pro' },
      payload: JSON.stringify({ text: TWELVE, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(verificationOf(JSON.parse(res.body) as Json)).toMatchObject({ tier: 'pro', cap: 8, verifiedClaims: 8, uncheckedClaims: 4 });
  });
});
