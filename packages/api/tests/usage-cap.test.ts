/**
 * Monthly usage-cap gate (COGS gate item 1) — the margin-protecting per-tier
 * scan quota. Distinct from rate-limit (per-minute burst). Ships DORMANT by
 * default; the cap NUMBER + go-live are Asif's pricing call.
 *
 * Validates: N-228 (Faultline paid-tier margin protection).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { getUsageMeter, resetUsageMeter } from '../src/store/usage.js';
import { getMonthlyCap, isUsageCapEnabled } from '../src/store/entitlements.js';
import { nextMonthResetEpoch } from '../src/plugins/usage-cap.js';

// ---- env helpers: cap gate is driven entirely by process.env ----
const CAP_ENV_KEYS = ['FAULTLINE_USAGE_CAP', 'FAULTLINE_CAP_PRO', 'FAULTLINE_CAP_FREE', 'FAULTLINE_CAP_ADMIN'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of CAP_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of CAP_ENV_KEYS) delete process.env[k];
  resetUsageMeter();
  resetKeyStore();
});
afterEach(() => {
  for (const k of CAP_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// =========================================================================
// entitlements config
// =========================================================================
describe('entitlements — getMonthlyCap / isUsageCapEnabled', () => {
  it('returns conservative placeholder defaults when no env is set', () => {
    expect(getMonthlyCap('pro')).toBe(25);
    expect(getMonthlyCap('free')).toBe(10);
    expect(getMonthlyCap('admin')).toBeNull();
  });

  it('honors a per-tier env override', () => {
    process.env.FAULTLINE_CAP_PRO = '50';
    expect(getMonthlyCap('pro')).toBe(50);
  });

  it('treats "unlimited" / "off" / "null" env as no cap', () => {
    process.env.FAULTLINE_CAP_PRO = 'unlimited';
    expect(getMonthlyCap('pro')).toBeNull();
    process.env.FAULTLINE_CAP_FREE = 'off';
    expect(getMonthlyCap('free')).toBeNull();
  });

  it('falls back to the default on a garbage or negative env value', () => {
    process.env.FAULTLINE_CAP_PRO = 'banana';
    expect(getMonthlyCap('pro')).toBe(25);
    process.env.FAULTLINE_CAP_PRO = '-5';
    expect(getMonthlyCap('pro')).toBe(25);
  });

  it('accepts a zero cap (blocks all scans)', () => {
    process.env.FAULTLINE_CAP_PRO = '0';
    expect(getMonthlyCap('pro')).toBe(0);
  });

  it('is dormant by default and enables only on explicit truthy flags', () => {
    expect(isUsageCapEnabled()).toBe(false);
    for (const v of ['on', '1', 'true', 'enabled']) {
      process.env.FAULTLINE_USAGE_CAP = v;
      expect(isUsageCapEnabled()).toBe(true);
    }
    process.env.FAULTLINE_USAGE_CAP = 'off';
    expect(isUsageCapEnabled()).toBe(false);
  });
});

// =========================================================================
// UsageMeter.getMonthlyCount
// =========================================================================
describe('UsageMeter.getMonthlyCount', () => {
  it('returns 0 for an unknown key', () => {
    expect(getUsageMeter().getMonthlyCount('nope')).toBe(0);
  });

  it('counts scans incremented this month', () => {
    const meter = getUsageMeter();
    meter.increment('k1');
    meter.increment('k1');
    meter.increment('k1');
    expect(meter.getMonthlyCount('k1')).toBe(3);
  });

  it('sums only the requested month prefix', () => {
    const meter = getUsageMeter();
    // reach into today's bucket via increment, then assert a foreign month is 0
    meter.increment('k2');
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(meter.getMonthlyCount('k2', currentMonth)).toBe(1);
    expect(meter.getMonthlyCount('k2', '1999-01')).toBe(0);
  });
});

// =========================================================================
// nextMonthResetEpoch
// =========================================================================
describe('nextMonthResetEpoch', () => {
  it('returns the first instant of the following month (UTC)', () => {
    expect(nextMonthResetEpoch(new Date('2026-07-27T12:00:00Z'))).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000));
  });

  it('rolls the year over from December', () => {
    expect(nextMonthResetEpoch(new Date('2026-12-15T00:00:00Z'))).toBe(Math.floor(Date.UTC(2027, 0, 1) / 1000));
  });
});

// =========================================================================
// integration — the real prehandler on the real /scan route
// =========================================================================
describe('enforceMonthlyCap — integration through /scan', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('is a no-op when the gate is DORMANT — a scan passes even over the placeholder cap', async () => {
    // gate off (default); seed usage far above the pro cap
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    for (let i = 0; i < 100; i++) getUsageMeter().increment(created.id);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).not.toBe(402); // dormant gate never blocks
  });

  it('returns 402 with quota headers once the monthly cap is reached', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '3';
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    for (let i = 0; i < 3; i++) getUsageMeter().increment(created.id); // at cap

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.headers['x-usage-limit']).toBe('3');
    expect(res.headers['x-usage-remaining']).toBe('0');
    const body = res.json();
    expect(body.error).toContain('quota exceeded');
    expect(body.limit).toBe(3);
    expect(body.remaining).toBe(0);
    expect(body.upgrade).toContain('pricing');
  });

  it('allows a scan below the cap and sets remaining headers', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '10';
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    getUsageMeter().increment(created.id); // 1 of 10 used

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).not.toBe(402);
    // header set on the allowed request (before this scan's own increment)
    expect(res.headers['x-usage-limit']).toBe('10');
    expect(res.headers['x-usage-remaining']).toBe('9');
  });

  it('a successful mock scan increments the monthly count (increment wiring)', async () => {
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    expect(getUsageMeter().getMonthlyCount(created.id)).toBe(0);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    expect(getUsageMeter().getMonthlyCount(created.id)).toBe(1);
  });

  it('never caps an admin (unlimited) key even when the gate is on', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    // an admin-permission key resolves to the admin tier (cap null); seed high usage
    const admin = getKeyStore().create('Admin', ['admin', 'scan']);
    for (let i = 0; i < 100; i++) getUsageMeter().increment(admin.id);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': admin.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).not.toBe(402);
  });
});

// =========================================================================
// /usage quota surface
// =========================================================================
describe('GET /usage — quota surface', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('reports the tier cap, monthly used, and remaining', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_PRO = '25';
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    getUsageMeter().increment(created.id);
    getUsageMeter().increment(created.id);

    const res = await server.inject({
      method: 'GET',
      url: '/usage',
      headers: { 'x-api-key': created.key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.tier).toBe('pro');
    expect(body.quota.enforced).toBe(true);
    expect(body.quota.limit).toBe(25);
    expect(body.quota.used).toBe(2);
    expect(body.quota.remaining).toBe(23);
    expect(typeof body.quota.resetEpoch).toBe('number');
  });

  it('reports enforced:false and unlimited remaining for an admin key', async () => {
    const admin = getKeyStore().create('Admin', ['admin']);
    const res = await server.inject({
      method: 'GET',
      url: '/usage',
      headers: { 'x-api-key': admin.key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.enforced).toBe(false); // dormant by default
    expect(body.quota.limit).toBeNull(); // admin unlimited
    expect(body.quota.remaining).toBeNull();
  });
});
