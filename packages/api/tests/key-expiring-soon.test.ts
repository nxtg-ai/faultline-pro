/**
 * N-91 — Expiring-soon key list (GET /keys/expiring-soon)
 *
 * KES1–KES7   KeyStore unit: getExpiringSoon() threshold logic
 * KES8–KES15  HTTP: GET /keys/expiring-soon with various ?days=,
 *              secret redaction, 403 guard, already-expired excluded
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

const ADMIN_KEY = 'admin-key-expiring-soon-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const DAY_MS = 24 * 3_600_000;

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — getExpiringSoon()', () => {
  beforeEach(() => resetKeyStore());

  it('KES1: key with no expiresAt — excluded (permanent)', () => {
    getKeyStore().create('Permanent');
    expect(getKeyStore().getExpiringSoon(7)).toHaveLength(0);
  });

  it('KES2: key expiring in 5 days — included at 7d threshold', () => {
    const entry = getKeyStore().create('Soon', ['scan'], inMs(5 * DAY_MS));
    const result = getKeyStore().getExpiringSoon(7);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(entry.id);
  });

  it('KES3: key expiring in 10 days — excluded at 7d threshold', () => {
    getKeyStore().create('Far', ['scan'], inMs(10 * DAY_MS));
    expect(getKeyStore().getExpiringSoon(7)).toHaveLength(0);
  });

  it('KES4: already-expired key — excluded', () => {
    getKeyStore().create('Expired', ['scan'], agoMs(1000));
    expect(getKeyStore().getExpiringSoon(7)).toHaveLength(0);
  });

  it('KES5: key expiring in 20 hours — included at 7d threshold', () => {
    const entry = getKeyStore().create('Urgent', ['scan'], inMs(20 * 3_600_000));
    expect(getKeyStore().getExpiringSoon(7)).toHaveLength(1);
    expect(getKeyStore().getExpiringSoon(7)[0].id).toBe(entry.id);
  });

  it('KES6: key expiring in 30 days — included at 30d threshold', () => {
    const entry = getKeyStore().create('Month', ['scan'], inMs(29 * DAY_MS));
    expect(getKeyStore().getExpiringSoon(30)).toHaveLength(1);
    expect(getKeyStore().getExpiringSoon(30)[0].id).toBe(entry.id);
  });

  it('KES7: mixed keys — only those within threshold returned', () => {
    const soon = getKeyStore().create('Soon', ['scan'], inMs(3 * DAY_MS));
    getKeyStore().create('Far', ['scan'], inMs(10 * DAY_MS));      // outside 7d
    getKeyStore().create('Expired', ['scan'], agoMs(1000));         // already gone
    getKeyStore().create('Permanent');                               // no expiry
    const result = getKeyStore().getExpiringSoon(7);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(soon.id);
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('GET /keys/expiring-soon — HTTP', () => {
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

  it('KES8: empty list when no keys have expiry', async () => {
    getKeyStore().create('Permanent');

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.keys).toHaveLength(0);
    expect(body.days).toBe(7); // default
  });

  it('KES9: returns key expiring in 5 days at default threshold', async () => {
    const entry = getKeyStore().create('Soon', ['scan'], inMs(5 * DAY_MS));

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.keys[0].id).toBe(entry.id);
  });

  it('KES10: ?days=30 uses 30-day threshold', async () => {
    getKeyStore().create('Near', ['scan'], inMs(20 * DAY_MS)); // 20d — inside 30d
    getKeyStore().create('Far', ['scan'], inMs(40 * DAY_MS));  // 40d — outside 30d

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon?days=30',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.days).toBe(30);
    expect(body.count).toBe(1);
    expect(body.keys[0].name).toBe('Near');
  });

  it('KES11: already-expired keys excluded', async () => {
    getKeyStore().create('Expired', ['scan'], agoMs(1000));

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).count).toBe(0);
  });

  it('KES12: secrets (key, previousKey) are redacted', async () => {
    const entry = getKeyStore().create('Expiring', ['scan'], inMs(3 * DAY_MS));

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon',
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.keys[0].key).toBeUndefined();
    expect(body.keys[0].previousKey).toBeUndefined();
    expect(body.keys[0].id).toBe(entry.id);
  });

  it('KES13: 403 without admin key', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon',
    });
    expect(res.statusCode).toBe(403);
  });

  it('KES14: days clamped to 365 maximum', async () => {
    getKeyStore().create('Ancient', ['scan'], inMs(300 * DAY_MS));

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon?days=99999',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).days).toBe(365);
  });

  it('KES15: response includes expiresAt field on returned keys', async () => {
    const expiresAt = inMs(5 * DAY_MS);
    getKeyStore().create('Check', ['scan'], expiresAt);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/expiring-soon',
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.keys[0].expiresAt).toBe(expiresAt);
  });
});
