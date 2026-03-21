/**
 * N-83 — PATCH /keys/:id partial update (name and/or permissions)
 *
 * KU1–KU4   KeyStore.update() unit tests
 * KU5–KU14  HTTP: PATCH /keys/:id
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

const ADMIN_KEY = 'admin-key-update-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' };
}

// ── KeyStore.update unit tests ───────────────────────────────────────────────

describe('KeyStore.update()', () => {
  beforeEach(() => resetKeyStore());

  it('KU1: update name returns updated entry', () => {
    const entry = getKeyStore().create('Old Name');
    const result = getKeyStore().update(entry.id, { name: 'New Name' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('New Name');
    expect(result!.id).toBe(entry.id);
  });

  it('KU2: update permissions returns entry with new permissions', () => {
    const entry = getKeyStore().create('Key', ['scan']);
    const result = getKeyStore().update(entry.id, { permissions: ['scan', 'report'] });
    expect(result!.permissions).toEqual(['scan', 'report']);
  });

  it('KU3: update both name and permissions in one call', () => {
    const entry = getKeyStore().create('Original', ['scan']);
    const result = getKeyStore().update(entry.id, { name: 'Updated', permissions: ['admin'] });
    expect(result!.name).toBe('Updated');
    expect(result!.permissions).toEqual(['admin']);
  });

  it('KU4: update with unknown id returns null', () => {
    expect(getKeyStore().update('no-such-id', { name: 'X' })).toBeNull();
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('PATCH /keys/:id', () => {
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

  it('KU5: PATCH name only — returns 200 with updated name', async () => {
    const entry = getKeyStore().create('Original');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Renamed');
    expect(body.id).toBe(entry.id);
  });

  it('KU6: PATCH permissions only — returns 200 with updated permissions', async () => {
    const entry = getKeyStore().create('Key', ['scan']);

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ permissions: ['scan', 'report'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.permissions).toEqual(['scan', 'report']);
  });

  it('KU7: PATCH name and permissions together', async () => {
    const entry = getKeyStore().create('Old', ['scan']);

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'New', permissions: ['admin', 'scan'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('New');
    expect(body.permissions).toEqual(['admin', 'scan']);
  });

  it('KU8: response does not expose key secret', async () => {
    const entry = getKeyStore().create('Key');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'Renamed' }),
    });

    const body = JSON.parse(res.body);
    expect(body.key).toBeUndefined();
    expect(body.previousKey).toBeUndefined();
  });

  it('KU9: PATCH unknown id returns 404', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/keys/no-such-id',
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'X' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('KU10: PATCH without admin key returns 403', async () => {
    const entry = getKeyStore().create('Key');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'X' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('KU11: PATCH with invalid permission value returns 400', async () => {
    const entry = getKeyStore().create('Key');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ permissions: ['invalid-perm'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('KU12: PATCH with additional properties — unknown fields stripped, returns 200', async () => {
    const entry = getKeyStore().create('Key');

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'X', unknownField: true }),
    });
    // Fastify AJV strips additional properties rather than rejecting
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('X');
    expect(body.unknownField).toBeUndefined();
  });

  it('KU13: GET /keys reflects updated name after PATCH', async () => {
    const entry = getKeyStore().create('Before');
    await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'After' }),
    });

    const list = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: adminHeader(),
    });
    const keys = JSON.parse(list.body);
    const found = keys.find((k: { id: string }) => k.id === entry.id);
    expect(found.name).toBe('After');
  });

  it('KU14: PATCH preserves disabled state', async () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().disable(entry.id);

    const res = await server.inject({
      method: 'PATCH',
      url: `/keys/${entry.id}`,
      headers: adminHeader(),
      payload: JSON.stringify({ name: 'Renamed While Disabled' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Renamed While Disabled');
    expect(body.disabled).toBe(true);
  });
});
