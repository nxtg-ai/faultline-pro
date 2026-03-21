/**
 * N-94 — Key usage analytics (GET /keys/usage)
 *
 * KUA1–KUA5   KeyStore unit: getUsageStats() derived fields
 * KUA6–KUA15  HTTP: GET /keys/usage summary + query params + guards
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetScanHistory } from '../src/store/scan-history.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

const ADMIN_KEY = 'admin-key-usage-analytics-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — getUsageStats()', () => {
  beforeEach(() => resetKeyStore());

  it('KUA1: new key — daysSinceCreation >= 0, lastUsedAt null, not dormant by 30d', () => {
    getKeyStore().create('Fresh');
    const stats = getKeyStore().getUsageStats();
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.daysSinceCreation).toBeGreaterThanOrEqual(0);
    expect(s.lastUsedAt).toBeNull();
    expect(s.daysSinceLastUse).toBeNull();
    expect(s.isDormant).toBe(false); // just created
  });

  it('KUA2: key used recently — daysSinceLastUse is 0, not dormant', () => {
    const entry = getKeyStore().create('Active');
    // Simulate recent use
    (getKeyStore().validateById(entry.id) as { lastUsedAt: string }).lastUsedAt = new Date().toISOString();
    const [s] = getKeyStore().getUsageStats();
    expect(s.daysSinceLastUse).toBe(0);
    expect(s.isDormant).toBe(false);
  });

  it('KUA3: key with lastUsedAt 31 days ago — isDormant true at 30d threshold', () => {
    const entry = getKeyStore().create('Old');
    (getKeyStore().validateById(entry.id) as { lastUsedAt: string }).lastUsedAt = daysAgo(31);
    const [s] = getKeyStore().getUsageStats(30);
    expect(s.isDormant).toBe(true);
    expect(s.daysSinceLastUse).toBeGreaterThanOrEqual(31);
  });

  it('KUA4: key expiring in 5 days — isExpiringSoon true at default 7d threshold', () => {
    getKeyStore().create('Soon', ['scan'], daysFromNow(5));
    const [s] = getKeyStore().getUsageStats();
    expect(s.isExpiringSoon).toBe(true);
    expect(s.isExpired).toBe(false);
    expect(s.expiresAt).not.toBeNull();
  });

  it('KUA5: expired key — isExpired true, isExpiringSoon false', () => {
    getKeyStore().create('Expired', ['scan'], daysAgo(1));
    const [s] = getKeyStore().getUsageStats();
    expect(s.isExpired).toBe(true);
    expect(s.isExpiringSoon).toBe(false);
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('GET /keys/usage — HTTP', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    resetKeyStore();
    resetAuditLogger();
    resetAnalytics();
    resetScanHistory();
    resetCache();
    resetCircuitBreaker();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KUA6: empty keystore → 200 with total:0 and empty keys array', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.keys).toHaveLength(0);
  });

  it('KUA7: summary counts — total, dormantCount, expiredCount, disabledCount, expiringSoonCount present', async () => {
    getKeyStore().create('Normal');
    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body).toHaveProperty('dormantCount');
    expect(body).toHaveProperty('expiredCount');
    expect(body).toHaveProperty('disabledCount');
    expect(body).toHaveProperty('expiringSoonCount');
  });

  it('KUA8: secrets (key, previousKey) not present in response', async () => {
    getKeyStore().create('Secure');
    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    const body = JSON.parse(res.body);
    for (const k of body.keys) {
      expect(k.key).toBeUndefined();
      expect(k.previousKey).toBeUndefined();
    }
  });

  it('KUA9: disabled key — disabled:true in response and counted in disabledCount', async () => {
    const entry = getKeyStore().create('ToDisable');
    getKeyStore().disable(entry.id);

    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.disabledCount).toBe(1);
    expect(body.keys[0].disabled).toBe(true);
  });

  it('KUA10: ?dormantDays=14 — uses 14-day threshold for dormant flag', async () => {
    const entry = getKeyStore().create('Old');
    // 15 days ago — dormant at 14d, not at 30d
    (getKeyStore().validateById(entry.id) as { createdAt: string }).createdAt = daysAgo(15);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/usage?dormantDays=14',
      headers: adminHeader(),
    });
    const body = JSON.parse(res.body);
    expect(body.dormantCount).toBe(1);
    expect(body.keys[0].isDormant).toBe(true);
  });

  it('KUA11: ?expiringSoonDays=3 — uses 3-day threshold for expiringSoon flag', async () => {
    getKeyStore().create('Soon2d', ['scan'], daysFromNow(2));  // inside 3d
    getKeyStore().create('Far10d', ['scan'], daysFromNow(10)); // outside 3d

    const res = await server.inject({
      method: 'GET',
      url: '/keys/usage?expiringSoonDays=3',
      headers: adminHeader(),
    });
    const body = JSON.parse(res.body);
    expect(body.expiringSoonCount).toBe(1);
    const soon = body.keys.find((k: { name: string }) => k.name === 'Soon2d');
    expect(soon.isExpiringSoon).toBe(true);
  });

  it('KUA12: expired key — isExpired:true and counted in expiredCount', async () => {
    getKeyStore().create('Expired', ['scan'], daysAgo(1));

    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.expiredCount).toBe(1);
    expect(body.keys[0].isExpired).toBe(true);
  });

  it('KUA13: 403 without admin key', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage' });
    expect(res.statusCode).toBe(403);
  });

  it('KUA14: rotated key — daysSinceLastRotation present', async () => {
    const entry = getKeyStore().create('Rotatable');
    getKeyStore().rotate(entry.id);

    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.keys[0].daysSinceLastRotation).toBe(0);
    expect(body.keys[0].lastRotatedAt).not.toBeNull();
  });

  it('KUA15: mixed keys — summary counts accurate', async () => {
    const dormant = getKeyStore().create('Dormant');
    (getKeyStore().validateById(dormant.id) as { createdAt: string }).createdAt = daysAgo(31);

    getKeyStore().create('ExpiringSoon', ['scan'], daysFromNow(3));
    getKeyStore().create('Expired', ['scan'], daysAgo(1));

    const disabled = getKeyStore().create('Disabled');
    getKeyStore().disable(disabled.id);

    getKeyStore().create('Healthy'); // no issues

    const res = await server.inject({ method: 'GET', url: '/keys/usage', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(5);
    expect(body.dormantCount).toBeGreaterThanOrEqual(1);
    expect(body.expiringSoonCount).toBe(1);
    expect(body.expiredCount).toBe(1);
    expect(body.disabledCount).toBe(1);
  });
});
