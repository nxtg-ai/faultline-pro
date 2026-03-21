/**
 * N-89 — Bulk key deletion (POST /keys/bulk-delete)
 *
 * KBD1–KBD5   KeyStore unit: bulkDelete() — deletes found, skips unknown,
 *              returns deleted IDs, empty input → empty result
 * KBD6–KBD15  HTTP: POST /keys/bulk-delete with ids[], days, combined,
 *              unknown IDs, empty body, 403, response shape
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

const ADMIN_KEY = 'admin-key-bulk-delete-test';

function jsonHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' };
}

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

/** Backdate a key's createdAt by N days */
function backdateCreated(id: string, days: number): void {
  getKeyStore().validateById(id)!.createdAt = new Date(Date.now() - days * 86_400_000).toISOString();
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — bulkDelete()', () => {
  beforeEach(() => resetKeyStore());

  it('KBD1: deletes all provided IDs that exist', () => {
    const a = getKeyStore().create('A');
    const b = getKeyStore().create('B');
    const deleted = getKeyStore().bulkDelete([a.id, b.id]);
    expect(deleted).toHaveLength(2);
    expect(deleted).toContain(a.id);
    expect(deleted).toContain(b.id);
    expect(getKeyStore().list()).toHaveLength(0);
  });

  it('KBD2: skips unknown IDs — no error, returns only found', () => {
    const a = getKeyStore().create('A');
    const deleted = getKeyStore().bulkDelete([a.id, 'does-not-exist']);
    expect(deleted).toEqual([a.id]);
  });

  it('KBD3: empty input returns empty array', () => {
    getKeyStore().create('A');
    const deleted = getKeyStore().bulkDelete([]);
    expect(deleted).toHaveLength(0);
    expect(getKeyStore().list()).toHaveLength(1); // key untouched
  });

  it('KBD4: all-unknown input returns empty array', () => {
    const deleted = getKeyStore().bulkDelete(['x', 'y', 'z']);
    expect(deleted).toHaveLength(0);
  });

  it('KBD5: partial match — only existing keys deleted', () => {
    const a = getKeyStore().create('A');
    getKeyStore().create('B');
    getKeyStore().bulkDelete([a.id, 'ghost-id']);
    expect(getKeyStore().list()).toHaveLength(1);
    expect(getKeyStore().list()[0].name).toBe('B');
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('POST /keys/bulk-delete — HTTP', () => {
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

  it('KBD6: delete by explicit ids[] — returns 200 with deleted count and IDs', async () => {
    const a = getKeyStore().create('A');
    const b = getKeyStore().create('B');
    getKeyStore().create('C'); // not in list — preserved

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ ids: [a.id, b.id] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toBe(2);
    expect(body.ids).toContain(a.id);
    expect(body.ids).toContain(b.id);
    expect(getKeyStore().list()).toHaveLength(1); // C preserved
  });

  it('KBD7: delete by days — removes dormant keys', async () => {
    const stale = getKeyStore().create('Stale');
    backdateCreated(stale.id, 35);
    getKeyStore().create('Fresh'); // created now — not dormant

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ days: 30 }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toBe(1);
    expect(body.ids).toContain(stale.id);
    expect(getKeyStore().list()).toHaveLength(1); // Fresh preserved
  });

  it('KBD8: combined ids + days — union of both sets', async () => {
    const stale = getKeyStore().create('Stale');
    backdateCreated(stale.id, 35);
    const explicit = getKeyStore().create('Explicit');
    getKeyStore().create('Fresh');

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ ids: [explicit.id], days: 30 }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toBe(2);
    expect(body.ids).toContain(stale.id);
    expect(body.ids).toContain(explicit.id);
  });

  it('KBD9: empty body — returns 200 with deleted:0', async () => {
    getKeyStore().create('A');

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(0);
    expect(getKeyStore().list()).toHaveLength(1); // untouched
  });

  it('KBD10: unknown IDs in ids[] — only existing ones counted', async () => {
    const a = getKeyStore().create('A');

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ ids: [a.id, 'ghost-id'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toBe(1);
    expect(body.ids).toEqual([a.id]);
  });

  it('KBD11: 403 without admin key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ids: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('KBD12: days:7 deletes keys unused 8 days', async () => {
    const stale = getKeyStore().create('Stale7');
    backdateCreated(stale.id, 8);
    const fresh = getKeyStore().create('Fresh7');
    backdateCreated(fresh.id, 6);

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ days: 7 }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toBe(1);
    expect(body.ids[0]).toBe(stale.id);
  });

  it('KBD13: deduplication — ID in both ids[] and dormant list deleted once', async () => {
    const key = getKeyStore().create('Stale');
    backdateCreated(key.id, 35);

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ ids: [key.id], days: 30 }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(1); // not 2
  });

  it('KBD14: response shape has deleted (number) and ids (array)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({}),
    });

    const body = JSON.parse(res.body);
    expect(typeof body.deleted).toBe('number');
    expect(Array.isArray(body.ids)).toBe(true);
  });

  it('KBD15: GET /keys after bulk-delete reflects removal', async () => {
    const a = getKeyStore().create('A');
    getKeyStore().create('B');

    await server.inject({
      method: 'POST',
      url: '/keys/bulk-delete',
      headers: jsonHeader(),
      payload: JSON.stringify({ ids: [a.id] }),
    });

    const res = await server.inject({ method: 'GET', url: '/keys', headers: adminHeader() });
    const keys = JSON.parse(res.body);
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe('B');
  });
});
