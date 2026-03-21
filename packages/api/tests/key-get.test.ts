/**
 * N-84 — GET /keys/:id (single key lookup by ID)
 *
 * KG1–KG3  KeyStore unit: validateById covers found/not-found
 * KG4–KG10 HTTP: GET /keys/:id
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

const ADMIN_KEY = 'admin-key-get-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

// ── KeyStore.validateById unit tests ─────────────────────────────────────────

describe('KeyStore.validateById()', () => {
  beforeEach(() => resetKeyStore());

  it('KG1: returns entry for known id', () => {
    const entry = getKeyStore().create('My Key');
    const found = getKeyStore().validateById(entry.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(entry.id);
    expect(found!.name).toBe('My Key');
  });

  it('KG2: returns null for unknown id', () => {
    expect(getKeyStore().validateById('no-such-id')).toBeNull();
  });

  it('KG3: returns disabled keys (validateById does not filter disabled)', () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().disable(entry.id);
    const found = getKeyStore().validateById(entry.id);
    expect(found).not.toBeNull();
    expect(found!.disabled).toBe(true);
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('GET /keys/:id', () => {
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

  it('KG4: returns 200 with key metadata for known id', async () => {
    const entry = getKeyStore().create('Test Key', ['scan', 'report']);

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(entry.id);
    expect(body.name).toBe('Test Key');
    expect(body.permissions).toEqual(['scan', 'report']);
    expect(typeof body.createdAt).toBe('string');
  });

  it('KG5: response does not expose key secret or previousKey', async () => {
    const entry = getKeyStore().create('Secret Key');

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.key).toBeUndefined();
    expect(body.previousKey).toBeUndefined();
  });

  it('KG6: returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/keys/no-such-id',
      headers: adminHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain('not found');
  });

  it('KG7: returns 403 without admin key', async () => {
    const entry = getKeyStore().create('Key');

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('KG8: returns disabled=true for a disabled key', async () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().disable(entry.id);

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.disabled).toBe(true);
  });

  it('KG9: reflects name update from PATCH /keys/:id', async () => {
    const entry = getKeyStore().create('Before');
    getKeyStore().update(entry.id, { name: 'After' });

    const res = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('After');
  });

  it('KG10: GET /keys/:id and GET /keys return consistent data for same key', async () => {
    const entry = getKeyStore().create('Consistency Key', ['scan']);

    const single = await server.inject({
      method: 'GET',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
    });
    const list = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: adminHeader(),
    });

    const singleBody = JSON.parse(single.body);
    const listKeys = JSON.parse(list.body);
    const fromList = listKeys.find((k: { id: string }) => k.id === entry.id);

    expect(singleBody.id).toBe(fromList.id);
    expect(singleBody.name).toBe(fromList.name);
    expect(singleBody.permissions).toEqual(fromList.permissions);
    expect(singleBody.createdAt).toBe(fromList.createdAt);
  });
});
