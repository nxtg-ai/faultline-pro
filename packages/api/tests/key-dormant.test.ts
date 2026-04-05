/**
 * N-87 — Dormant key detection (GET /keys/dormant)
 *
 * KDo1–KDo7   KeyStore unit: getDormant() logic
 * KDo8–KDo15  HTTP: GET /keys/dormant with various ?days= values,
 *              secret redaction, disabled/expired inclusion, empty list
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

const ADMIN_KEY = 'admin-key-dormant-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

/** Backdate a key's lastUsedAt by N days */
function backdateUsed(id: string, days: number): void {
  // Access internal store field via the returned entry reference
  const entry = getKeyStore().validateById(id)!;
  entry.lastUsedAt = new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Backdate a key's createdAt by N days */
function backdateCreated(id: string, days: number): void {
  const entry = getKeyStore().validateById(id)!;
  entry.createdAt = new Date(Date.now() - days * 86_400_000).toISOString();
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — getDormant()', () => {
  beforeEach(() => resetKeyStore());

  it('KDo1: new key never used, created now — not dormant at 30 days', () => {
    getKeyStore().create('New Key');
    expect(getKeyStore().getDormant(30)).toHaveLength(0);
  });

  it('KDo2: key never used, created 31 days ago — dormant at 30 days', () => {
    const entry = getKeyStore().create('Old Key');
    backdateCreated(entry.id, 31);
    const dormant = getKeyStore().getDormant(30);
    expect(dormant).toHaveLength(1);
    expect(dormant[0].id).toBe(entry.id);
  });

  it('KDo3: key used 1 day ago — not dormant at 30 days', () => {
    const entry = getKeyStore().create('Active Key');
    backdateUsed(entry.id, 1);
    expect(getKeyStore().getDormant(30)).toHaveLength(0);
  });

  it('KDo4: key used 31 days ago — dormant at 30 days', () => {
    const entry = getKeyStore().create('Stale Key');
    backdateUsed(entry.id, 31);
    const dormant = getKeyStore().getDormant(30);
    expect(dormant).toHaveLength(1);
    expect(dormant[0].id).toBe(entry.id);
  });

  it('KDo5: disabled key unused 31 days — included in dormant list', () => {
    const entry = getKeyStore().create('Disabled Key');
    backdateCreated(entry.id, 31);
    getKeyStore().disable(entry.id);
    expect(getKeyStore().getDormant(30)).toHaveLength(1);
  });

  it('KDo6: expired key unused 31 days — included in dormant list', () => {
    const entry = getKeyStore().create('Expired Key', ['scan'], new Date(Date.now() - 1000).toISOString());
    backdateCreated(entry.id, 31);
    expect(getKeyStore().getDormant(30)).toHaveLength(1);
  });

  it('KDo7: mixed keys — only stale ones returned', () => {
    const stale = getKeyStore().create('Stale');
    backdateUsed(stale.id, 45);

    const active = getKeyStore().create('Active');
    backdateUsed(active.id, 5);

    const neverUsedOld = getKeyStore().create('Never Old');
    backdateCreated(neverUsedOld.id, 60);

    const neverUsedNew = getKeyStore().create('Never New');
    void neverUsedNew; // created just now — not dormant

    const dormant = getKeyStore().getDormant(30);
    expect(dormant).toHaveLength(2);
    const ids = dormant.map((k) => k.id);
    expect(ids).toContain(stale.id);
    expect(ids).toContain(neverUsedOld.id);
    expect(ids).not.toContain(active.id);
    expect(ids).not.toContain(neverUsedNew.id);
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('GET /keys/dormant — HTTP', () => {
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

  it('KDo8: empty list when all keys are fresh', async () => {
    getKeyStore().create('Fresh Key');

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.keys).toHaveLength(0);
    expect(body.days).toBe(30);
  });

  it('KDo9: returns stale key at default 30 days', async () => {
    const entry = getKeyStore().create('Stale Key');
    backdateCreated(entry.id, 35);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.keys[0].id).toBe(entry.id);
  });

  it('KDo10: ?days=7 uses 7-day threshold', async () => {
    const stale7 = getKeyStore().create('Stale 7d');
    backdateCreated(stale7.id, 8);

    const fresh7 = getKeyStore().create('Fresh 7d');
    backdateCreated(fresh7.id, 6);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant?days=7',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.days).toBe(7);
    expect(body.count).toBe(1);
    expect(body.keys[0].id).toBe(stale7.id);
  });

  it('KDo11: secrets (key, previousKey) are redacted', async () => {
    const entry = getKeyStore().create('Secret Key');
    backdateCreated(entry.id, 35);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant',
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.keys[0].key).toBeUndefined();
    expect(body.keys[0].previousKey).toBeUndefined();
    expect(body.keys[0].id).toBe(entry.id);
  });

  it('KDo12: returns 403 without admin key', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant',
    });

    expect(res.statusCode).toBe(403);
  });

  it('KDo13: response includes lastUsedAt when set', async () => {
    const entry = getKeyStore().create('Used Key');
    backdateUsed(entry.id, 40);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant',
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.keys[0].lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('KDo14: days clamped to 365 maximum', async () => {
    const entry = getKeyStore().create('Ancient Key');
    backdateCreated(entry.id, 366);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant?days=99999',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.days).toBe(365);
    expect(body.keys[0].id).toBe(entry.id);
  });

  it('KDo15: days clamped to 1 minimum', async () => {
    const entry = getKeyStore().create('One-Day Key');
    backdateCreated(entry.id, 2);

    const res = await server.inject({
      method: 'GET',
      url: '/keys/dormant?days=0',
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.days).toBe(1);
    expect(body.keys[0].id).toBe(entry.id);
  });
});
