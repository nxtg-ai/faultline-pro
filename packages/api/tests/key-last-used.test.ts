/**
 * N-85 — ApiKey lastUsedAt tracking
 *
 * KL1–KL5  KeyStore unit: lastUsedAt set on validateKey(), not on validateById()
 * KL6–KL12 HTTP: lastUsedAt visible in GET /keys/:id and GET /keys after auth
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

const ADMIN_KEY = 'admin-key-lastused-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — lastUsedAt', () => {
  beforeEach(() => resetKeyStore());

  it('KL1: new key has no lastUsedAt', () => {
    const entry = getKeyStore().create('Key');
    expect(entry.lastUsedAt).toBeUndefined();
  });

  it('KL2: validateKey() sets lastUsedAt to an ISO string', () => {
    const before = new Date();
    const entry = getKeyStore().create('Key');
    getKeyStore().validateKey(entry.key);
    const found = getKeyStore().validateById(entry.id)!;
    expect(typeof found.lastUsedAt).toBe('string');
    expect(new Date(found.lastUsedAt!).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('KL3: validateKey() updates lastUsedAt on each call', async () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().validateKey(entry.key);
    const first = getKeyStore().validateById(entry.id)!.lastUsedAt;

    // Small delay to ensure timestamps differ
    await new Promise((r) => setTimeout(r, 2));
    getKeyStore().validateKey(entry.key);
    const second = getKeyStore().validateById(entry.id)!.lastUsedAt;

    expect(second).not.toBe(first);
    expect(new Date(second!).getTime()).toBeGreaterThan(new Date(first!).getTime());
  });

  it('KL4: validateById() does NOT set lastUsedAt (admin read path)', () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().validateById(entry.id);
    expect(getKeyStore().validateById(entry.id)!.lastUsedAt).toBeUndefined();
  });

  it('KL5: disabled key validateKey() returns null and does not set lastUsedAt', () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().disable(entry.id);
    const result = getKeyStore().validateKey(entry.key);
    expect(result).toBeNull();
    expect(getKeyStore().validateById(entry.id)!.lastUsedAt).toBeUndefined();
  });
});

// ── HTTP integration tests ───────────────────────────────────────────────────

describe('lastUsedAt visible via API after authentication', () => {
  let server: FastifyInstance;
  let rawKey: string;
  let keyId: string;

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
    keyId = entry.id;
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KL6: GET /keys/:id shows lastUsedAt=undefined before first use', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/keys/${keyId}`,
      headers: adminHeader(),
    });
    const body = JSON.parse(res.body);
    expect(body.lastUsedAt).toBeUndefined();
  });

  it('KL7: after POST /scan with key, GET /keys/:id shows lastUsedAt', async () => {
    const before = new Date().toISOString();

    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The Earth orbits the Sun.', provider: 'mock' }),
    });

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${keyId}`,
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(typeof body.lastUsedAt).toBe('string');
    expect(body.lastUsedAt >= before).toBe(true);
  });

  it('KL8: GET /keys list also includes lastUsedAt after use', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test claim.', provider: 'mock' }),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: adminHeader(),
    });

    const keys = JSON.parse(res.body);
    const found = keys.find((k: { id: string }) => k.id === keyId);
    expect(typeof found.lastUsedAt).toBe('string');
  });

  it('KL9: lastUsedAt is not set by admin read operations (GET /keys/:id)', async () => {
    // Admins reading a key via x-api-key env var go through the env-var path,
    // not validateKey — so admin reads must not pollute lastUsedAt.
    await server.inject({ method: 'GET', url: `/keys/${keyId}`, headers: adminHeader() });
    await server.inject({ method: 'GET', url: `/keys/${keyId}`, headers: adminHeader() });

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${keyId}`,
      headers: adminHeader(),
    });
    const body = JSON.parse(res.body);
    // Still no lastUsedAt — admin reads use env-var path, not validateKey
    expect(body.lastUsedAt).toBeUndefined();
  });

  it('KL10: lastUsedAt updates on each subsequent scan', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'First scan.', provider: 'mock' }),
    });

    const after1 = JSON.parse((await server.inject({
      method: 'GET', url: `/keys/${keyId}`, headers: adminHeader(),
    })).body).lastUsedAt;

    await new Promise((r) => setTimeout(r, 2));

    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Second scan.', provider: 'mock' }),
    });

    const after2 = JSON.parse((await server.inject({
      method: 'GET', url: `/keys/${keyId}`, headers: adminHeader(),
    })).body).lastUsedAt;

    expect(new Date(after2).getTime()).toBeGreaterThan(new Date(after1).getTime());
  });

  it('KL11: 401 scan attempt with wrong key does not set lastUsedAt', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'wrong-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.', provider: 'mock' }),
    });

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${keyId}`,
      headers: adminHeader(),
    });
    expect(JSON.parse(res.body).lastUsedAt).toBeUndefined();
  });

  it('KL12: lastUsedAt not exposed in key secret (key value still absent)', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.', provider: 'mock' }),
    });

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${keyId}`,
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.key).toBeUndefined();
    expect(body.previousKey).toBeUndefined();
    expect(typeof body.lastUsedAt).toBe('string'); // present
  });
});
