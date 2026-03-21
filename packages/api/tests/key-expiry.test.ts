/**
 * N-86 — ApiKey expiry (expiresAt field)
 *
 * KE1–KE6   KeyStore unit: isExpired(), validateKey() rejects expired keys
 * KE7–KE15  HTTP: POST /keys with expiresAt, PATCH /keys/:id to set/clear,
 *            auth rejection for expired keys, GET responses include expiresAt
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

const ADMIN_KEY = 'admin-key-expiry-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

function jsonHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' };
}

/** ISO datetime N milliseconds from now */
function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** ISO datetime N milliseconds in the past */
function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — expiresAt / isExpired()', () => {
  beforeEach(() => resetKeyStore());

  it('KE1: new key with no expiresAt is not expired', () => {
    const entry = getKeyStore().create('Key');
    expect(getKeyStore().isExpired(entry.id)).toBe(false);
  });

  it('KE2: key with future expiresAt is not expired', () => {
    const entry = getKeyStore().create('Key', ['scan'], inMs(60_000));
    expect(getKeyStore().isExpired(entry.id)).toBe(false);
  });

  it('KE3: key with past expiresAt is expired', () => {
    const entry = getKeyStore().create('Key', ['scan'], agoMs(1000));
    expect(getKeyStore().isExpired(entry.id)).toBe(true);
  });

  it('KE4: validateKey() returns entry for unexpired key', () => {
    const entry = getKeyStore().create('Key', ['scan'], inMs(60_000));
    expect(getKeyStore().validateKey(entry.key)).not.toBeNull();
  });

  it('KE5: validateKey() returns null for expired key', () => {
    const entry = getKeyStore().create('Key', ['scan'], agoMs(1000));
    expect(getKeyStore().validateKey(entry.key)).toBeNull();
  });

  it('KE6: update() can clear expiresAt by passing null', () => {
    const entry = getKeyStore().create('Key', ['scan'], agoMs(1000));
    expect(getKeyStore().isExpired(entry.id)).toBe(true);
    getKeyStore().update(entry.id, { expiresAt: null });
    expect(getKeyStore().isExpired(entry.id)).toBe(false);
    // Key now validates again
    expect(getKeyStore().validateKey(entry.key)).not.toBeNull();
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('Key expiry — HTTP', () => {
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

  it('KE7: POST /keys with expiresAt creates key with expiry field', async () => {
    const expiresAt = inMs(3_600_000); // 1 hour from now

    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: jsonHeader(),
      payload: JSON.stringify({ name: 'Expiring Key', expiresAt }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.expiresAt).toBe(expiresAt);
    expect(body.name).toBe('Expiring Key');
  });

  it('KE8: unexpired key can authenticate — POST /scan returns 200', async () => {
    const entry = getKeyStore().create('Key', ['scan'], inMs(60_000));

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': entry.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The moon orbits Earth.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(200);
  });

  it('KE9: expired key is rejected by requireApiKey — returns 401', async () => {
    const entry = getKeyStore().create('Key', ['scan'], agoMs(1000));

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': entry.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('KE10: expired admin key is rejected by requireAdmin — returns 403', async () => {
    const entry = getKeyStore().create('Admin', ['admin'], agoMs(1000));

    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': entry.key },
    });

    expect(res.statusCode).toBe(403);
  });

  it('KE11: PATCH /keys/:id sets expiresAt on existing key', async () => {
    const entry = getKeyStore().create('Key');
    const expiresAt = inMs(3_600_000);

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: jsonHeader(),
      payload: JSON.stringify({ expiresAt }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).expiresAt).toBe(expiresAt);
  });

  it('KE12: PATCH /keys/:id with expiresAt=null clears the expiry', async () => {
    const entry = getKeyStore().create('Key', ['scan'], agoMs(1000));

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: jsonHeader(),
      payload: JSON.stringify({ expiresAt: null }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.expiresAt).toBeUndefined();
  });

  it('KE13: GET /keys/:id includes expiresAt when set', async () => {
    const expiresAt = inMs(3_600_000);
    const entry = getKeyStore().create('Key', ['scan'], expiresAt);

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).expiresAt).toBe(expiresAt);
  });

  it('KE14: GET /keys list includes expiresAt for keys that have it', async () => {
    const expiresAt = inMs(3_600_000);
    const entry = getKeyStore().create('Expiring', ['scan'], expiresAt);
    getKeyStore().create('Permanent');

    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: adminHeader(),
    });

    const keys = JSON.parse(res.body);
    const expiring = keys.find((k: { id: string; expiresAt?: string }) => k.id === entry.id);
    const permanent = keys.find((k: { name: string; expiresAt?: string }) => k.name === 'Permanent');

    expect(expiring.expiresAt).toBe(expiresAt);
    expect(permanent.expiresAt).toBeUndefined();
  });

  it('KE15: expired key is still visible via GET /keys/:id (admin can see/manage it)', async () => {
    const entry = getKeyStore().create('Key', ['scan'], agoMs(1000));

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.expiresAt).toBeDefined();
    // Admin can see the expired key — they need to manage/delete it
  });
});
