/**
 * N-82 — ApiKey soft-disable (disable / enable without deletion)
 *
 * Tests:
 *   KD1–KD4   KeyStore unit: disable/enable/validateKey/list
 *   KD5–KD12  HTTP: PATCH /keys/:id/disable, PATCH /keys/:id/enable
 *   KD13–KD16 Auth enforcement: disabled key is rejected by requireApiKey and requireAdmin
 *   KD17      mission-control: activeKeys count excludes disabled keys
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

const ADMIN_KEY = 'admin-key-disable-test';

function authHeaders(key = ADMIN_KEY): Record<string, string> {
  return { 'x-api-key': key, 'content-type': 'application/json' };
}

function adminHeader(key = ADMIN_KEY): Record<string, string> {
  return { 'x-api-key': key };
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — disable / enable', () => {
  beforeEach(() => {
    resetKeyStore();
  });

  it('KD1: disable() returns true for known id and sets disabled=true', () => {
    const entry = getKeyStore().create('Test Key');
    const ok = getKeyStore().disable(entry.id);
    expect(ok).toBe(true);
    const found = getKeyStore().validateById(entry.id);
    expect(found?.disabled).toBe(true);
  });

  it('KD2: disable() returns false for unknown id', () => {
    const ok = getKeyStore().disable('no-such-id');
    expect(ok).toBe(false);
  });

  it('KD3: enable() sets disabled=false after disable', () => {
    const entry = getKeyStore().create('Test Key');
    getKeyStore().disable(entry.id);
    const ok = getKeyStore().enable(entry.id);
    expect(ok).toBe(true);
    const found = getKeyStore().validateById(entry.id);
    expect(found?.disabled).toBe(false);
  });

  it('KD4: validateKey() returns null for disabled key, non-null for re-enabled key', () => {
    const entry = getKeyStore().create('Test Key');
    const rawKey = entry.key;

    // Before disable — should validate
    expect(getKeyStore().validateKey(rawKey)).not.toBeNull();

    // After disable — should reject
    getKeyStore().disable(entry.id);
    expect(getKeyStore().validateKey(rawKey)).toBeNull();

    // After re-enable — should validate again
    getKeyStore().enable(entry.id);
    expect(getKeyStore().validateKey(rawKey)).not.toBeNull();
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('PATCH /keys/:id/disable and /keys/:id/enable', () => {
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

  it('KD5: PATCH /keys/:id/disable returns 200 with disabled=true', async () => {
    const store = getKeyStore();
    const entry = store.create('My Key');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}/disable`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(entry.id);
    expect(body.name).toBe('My Key');
    expect(body.disabled).toBe(true);
  });

  it('KD6: PATCH /keys/:id/enable returns 200 with disabled=false', async () => {
    const store = getKeyStore();
    const entry = store.create('My Key');
    store.disable(entry.id);

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}/enable`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(entry.id);
    expect(body.disabled).toBe(false);
  });

  it('KD7: PATCH /keys/:id/disable returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/keys/no-such-id/disable',
      headers: adminHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('KD8: PATCH /keys/:id/enable returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/keys/no-such-id/enable',
      headers: adminHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('KD9: PATCH /keys/:id/disable requires admin — returns 403 without key', async () => {
    const store = getKeyStore();
    const entry = store.create('My Key');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}/disable`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('KD10: PATCH /keys/:id/enable requires admin — returns 403 without key', async () => {
    const store = getKeyStore();
    const entry = store.create('My Key');
    store.disable(entry.id);

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}/enable`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('KD11: GET /keys list shows disabled=true for a disabled key', async () => {
    const store = getKeyStore();
    const entry = store.create('Disabled Key');
    store.disable(entry.id);

    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const keys = JSON.parse(res.body);
    const found = keys.find((k: { id: string }) => k.id === entry.id);
    expect(found).toBeDefined();
    expect(found.disabled).toBe(true);
    // Secret key value must not be exposed
    expect(found.key).toBeUndefined();
  });

  it('KD12: disable then enable — GET /keys shows disabled=false', async () => {
    const store = getKeyStore();
    const entry = store.create('Toggle Key');
    store.disable(entry.id);
    store.enable(entry.id);

    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: authHeaders(),
    });

    const keys = JSON.parse(res.body);
    const found = keys.find((k: { id: string }) => k.id === entry.id);
    expect(found.disabled).toBe(false);
  });
});

// ── Auth enforcement ─────────────────────────────────────────────────────────

describe('Auth — disabled key is rejected', () => {
  let server: FastifyInstance;
  let rawKey: string;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    resetKeyStore();
    resetAuditLogger();
    resetAnalytics();
    resetScanHistory();
    resetCache();
    resetCircuitBreaker();
    const entry = getKeyStore().create('Scan Key', ['scan']);
    rawKey = entry.key;
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KD13: enabled key passes requireApiKey (POST /scan returns 200)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The Earth orbits the Sun.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('KD14: disabled key is rejected by requireApiKey — returns 401', async () => {
    // Disable via store directly (simulates admin action)
    const store = getKeyStore();
    const entry = store.list().find((k) => k.key === rawKey)!;
    store.disable(entry.id);

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The Earth orbits the Sun.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('KD15: re-enabled key passes requireApiKey again — returns 200', async () => {
    const store = getKeyStore();
    const entry = store.list().find((k) => k.key === rawKey)!;
    store.disable(entry.id);
    store.enable(entry.id);

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The Earth orbits the Sun.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('KD16: disabled key with admin permission is rejected by requireAdmin — returns 403', async () => {
    const store = getKeyStore();
    // Create a key with admin permission and disable it
    const adminEntry = store.create('Disabled Admin', ['admin', 'scan']);
    store.disable(adminEntry.id);

    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': adminEntry.key },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── Mission Control activeKeys count ─────────────────────────────────────────

describe('Mission Control — activeKeys excludes disabled keys', () => {
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

  it('KD17: GET /mission-control/status — activeKeys excludes disabled, total includes all', async () => {
    const store = getKeyStore();
    store.create('Key A');
    store.create('Key B');
    const c = store.create('Key C');
    store.disable(c.id);

    const res = await server.inject({
      method: 'GET',
      url: '/mission-control/status',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keys.total).toBe(3);
    expect(body.keys.active).toBe(2);
  });
});
