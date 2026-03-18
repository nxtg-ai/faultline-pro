import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter, setCustomLimit, getRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'claim text',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'claim', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] } as any,
    ruleFindings: [],
  }),
}));

function setup() {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
}

async function scan(server: FastifyInstance, key: string) {
  return server.inject({
    method: 'POST',
    url: '/scan',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Some claim text.' }),
  });
}

// ─── Group A: Free tier ───────────────────────────────────────────────────

describe('Rate limiting — free tier', () => {
  let server: FastifyInstance;
  let freeKey: string;
  let freeKeyId: string;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
    const k = getKeyStore().create('Free Key', ['scan']);
    freeKey = k.key;
    freeKeyId = k.id;
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('R1. free key: first request → 200, X-RateLimit-Limit = 10', async () => {
    const res = await scan(server, freeKey);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
  });

  it('R2. free key: X-RateLimit-Remaining = 9 after first request', async () => {
    const res = await scan(server, freeKey);
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
  });

  it('R3. free key: X-RateLimit-Reset is a unix epoch integer > now', async () => {
    const res = await scan(server, freeKey);
    const reset = Number(res.headers['x-ratelimit-reset']);
    expect(Number.isInteger(reset)).toBe(true);
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('R4. free key with limit=3: 3rd request → 200 (limit not yet exceeded)', async () => {
    setCustomLimit(freeKeyId, 3);
    await scan(server, freeKey);
    await scan(server, freeKey);
    const res = await scan(server, freeKey);
    expect(res.statusCode).toBe(200);
  });

  it('R5. free key with limit=3: 4th request → 429', async () => {
    setCustomLimit(freeKeyId, 3);
    await scan(server, freeKey);
    await scan(server, freeKey);
    await scan(server, freeKey);
    const res = await scan(server, freeKey);
    expect(res.statusCode).toBe(429);
  });

  it('R6. 429 response body contains error, limit, remaining: 0, resetEpoch', async () => {
    setCustomLimit(freeKeyId, 1);
    await scan(server, freeKey);
    const res = await scan(server, freeKey);
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Rate limit');
    expect(body.limit).toBe(1);
    expect(body.remaining).toBe(0);
    expect(typeof body.resetEpoch).toBe('number');
  });

  it('R7. 429 does NOT increment counter (remaining stays 0, not negative)', async () => {
    setCustomLimit(freeKeyId, 1);
    await scan(server, freeKey); // uses the 1 allowed request
    await scan(server, freeKey); // 429 — should not increment
    const res = await scan(server, freeKey); // still 429
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.remaining).toBe(0);
  });

  it('R8. different free keys have independent counters', async () => {
    const k2 = getKeyStore().create('Free Key 2', ['scan']);
    setCustomLimit(freeKeyId, 1);
    setCustomLimit(k2.id, 1);
    const res1 = await scan(server, freeKey);
    const res2 = await scan(server, k2.key);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
  });

  it('R9. setCustomLimit(keyId, 3): exactly 3 succeed, 4th is 429', async () => {
    setCustomLimit(freeKeyId, 3);
    const results = await Promise.all([
      scan(server, freeKey),
      scan(server, freeKey),
      scan(server, freeKey),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const last = await scan(server, freeKey);
    expect(last.statusCode).toBe(429);
  });

  it('R10. X-RateLimit-Remaining decrements correctly (3→2→1→0→429)', async () => {
    setCustomLimit(freeKeyId, 3);
    const r1 = await scan(server, freeKey);
    const r2 = await scan(server, freeKey);
    const r3 = await scan(server, freeKey);
    const r4 = await scan(server, freeKey);
    expect(r1.headers['x-ratelimit-remaining']).toBe('2');
    expect(r2.headers['x-ratelimit-remaining']).toBe('1');
    expect(r3.headers['x-ratelimit-remaining']).toBe('0');
    expect(r4.statusCode).toBe(429);
    expect(r4.headers['x-ratelimit-remaining']).toBe('0');
  });
});

// ─── Group B: Pro tier ────────────────────────────────────────────────────

describe('Rate limiting — pro tier', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('R11. key with pro permission → X-RateLimit-Limit = 1000', async () => {
    const k = getKeyStore().create('Pro Key', ['scan', 'pro']);
    const res = await scan(server, k.key);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('1000');
  });

  it('R12. pro key: X-RateLimit-Remaining = 999 after first request', async () => {
    const k = getKeyStore().create('Pro Key', ['scan', 'pro']);
    const res = await scan(server, k.key);
    expect(res.headers['x-ratelimit-remaining']).toBe('999');
  });

  it('R13. pro key with setCustomLimit → custom limit respected', async () => {
    const k = getKeyStore().create('Pro Key', ['scan', 'pro']);
    setCustomLimit(k.id, 5);
    const res = await scan(server, k.key);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
  });

  it('R14. free key (no pro permission) → limit = 10, not 1000', async () => {
    const k = getKeyStore().create('Free Key', ['scan']);
    const res = await scan(server, k.key);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
  });
});

// ─── Group C: Admin tier ──────────────────────────────────────────────────

describe('Rate limiting — admin tier', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('R15. env-var admin key → X-RateLimit-Limit = 10000', async () => {
    const res = await scan(server, 'admin-secret');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10000');
  });

  it('R16. admin key: X-RateLimit-Remaining = 9999 after first request', async () => {
    const res = await scan(server, 'admin-secret');
    expect(res.headers['x-ratelimit-remaining']).toBe('9999');
  });

  it('R17. keystore key with admin permission → limit = 10000', async () => {
    const k = getKeyStore().create('Admin Key', ['admin']);
    const res = await scan(server, k.key);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10000');
  });

  it('R18. admin key with setCustomLimit → custom limit respected', async () => {
    setCustomLimit('admin', 5);
    const res = await scan(server, 'admin-secret');
    expect(res.headers['x-ratelimit-limit']).toBe('5');
  });
});

// ─── Group D: Reset + isolation ───────────────────────────────────────────

describe('Rate limiting — reset + isolation', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.useRealTimers();
  });

  it('R19. resetRateLimiter clears counters — key at limit can request again', async () => {
    const k = getKeyStore().create('Key', ['scan']);
    setCustomLimit(k.id, 1);
    await scan(server, k.key);
    const blocked = await scan(server, k.key);
    expect(blocked.statusCode).toBe(429);
    resetRateLimiter();
    // Re-apply custom limit after reset
    setCustomLimit(k.id, 1);
    const res = await scan(server, k.key);
    expect(res.statusCode).toBe(200);
  });

  it('R20. day rollover: counter resets when date changes (unit-level)', () => {
    // Use fake timers at unit level (no Fastify I/O) to test day rollover
    vi.useFakeTimers();
    const today = new Date('2026-03-18T10:00:00Z');
    vi.setSystemTime(today);

    const limiter = getRateLimiter();
    setCustomLimit('rollover-key', 1);
    limiter.increment('rollover-key');

    // Verify counter is at limit
    const { allowed: blockedBefore } = limiter.check('rollover-key', 'free');
    expect(blockedBefore).toBe(false);

    // Advance to tomorrow
    vi.setSystemTime(new Date('2026-03-19T10:00:00Z'));

    // Counter should reset — allowed again
    const { allowed: allowedAfter } = limiter.check('rollover-key', 'free');
    expect(allowedAfter).toBe(true);
  });

  it('R21. /scan/upload also gets rate-limited (429 after limit=1 is reached)', async () => {
    const k = getKeyStore().create('Key', ['scan']);
    setCustomLimit(k.id, 1);
    await scan(server, k.key); // exhaust limit on /scan

    // Now try /scan/upload — shares same rate limit counter
    const uploadRes = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: { 'x-api-key': k.key },
      payload: '',
    });
    expect(uploadRes.statusCode).toBe(429);
  });

  it('R22. rate limit preHandler does not run on GET /health (no X-RateLimit-* headers)', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });
});
