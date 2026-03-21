/**
 * N-93 — Bulk disable / enable keys
 *
 * KBS1–KBS5   KeyStore unit: bulkDisable / bulkEnable
 * KBS6–KBS15  HTTP: POST /keys/bulk-disable and POST /keys/bulk-enable
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

const ADMIN_KEY = 'admin-key-bulk-disable-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' };
}

// ── KeyStore unit tests ──────────────────────────────────────────────────────

describe('KeyStore — bulkDisable / bulkEnable', () => {
  beforeEach(() => resetKeyStore());

  it('KBS1: bulkDisable — known IDs → returns those IDs, keys become disabled', () => {
    const a = getKeyStore().create('Alpha');
    const b = getKeyStore().create('Beta');
    const result = getKeyStore().bulkDisable([a.id, b.id]);
    expect(result).toHaveLength(2);
    expect(result).toContain(a.id);
    expect(result).toContain(b.id);
    expect(getKeyStore().validateById(a.id)!.disabled).toBe(true);
    expect(getKeyStore().validateById(b.id)!.disabled).toBe(true);
  });

  it('KBS2: bulkDisable — unknown IDs → skipped, returns []', () => {
    const result = getKeyStore().bulkDisable(['does-not-exist']);
    expect(result).toHaveLength(0);
  });

  it('KBS3: bulkDisable — already-disabled key → skipped (idempotent)', () => {
    const a = getKeyStore().create('Alpha');
    getKeyStore().disable(a.id);
    const result = getKeyStore().bulkDisable([a.id]);
    // Already disabled — not counted as a new change
    expect(result).toHaveLength(0);
  });

  it('KBS4: bulkEnable — disabled keys → returns those IDs, keys become enabled', () => {
    const a = getKeyStore().create('Alpha');
    const b = getKeyStore().create('Beta');
    getKeyStore().disable(a.id);
    getKeyStore().disable(b.id);
    const result = getKeyStore().bulkEnable([a.id, b.id]);
    expect(result).toHaveLength(2);
    expect(getKeyStore().validateById(a.id)!.disabled).toBe(false);
    expect(getKeyStore().validateById(b.id)!.disabled).toBe(false);
  });

  it('KBS5: bulkEnable — already-enabled key → skipped (idempotent)', () => {
    const a = getKeyStore().create('Alpha');
    const result = getKeyStore().bulkEnable([a.id]);
    expect(result).toHaveLength(0);
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('POST /keys/bulk-disable and /keys/bulk-enable — HTTP', () => {
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

  it('KBS6: POST /keys/bulk-disable with ids[] → 200, returns disabled count and IDs', async () => {
    const a = getKeyStore().create('Alpha');
    const b = getKeyStore().create('Beta');

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-disable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: [a.id, b.id] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.disabled).toBe(2);
    expect(body.ids).toContain(a.id);
    expect(body.ids).toContain(b.id);
    expect(getKeyStore().validateById(a.id)!.disabled).toBe(true);
  });

  it('KBS7: POST /keys/bulk-disable with empty body → 200 disabled:0', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-disable',
      headers: adminHeader(),
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).disabled).toBe(0);
  });

  it('KBS8: POST /keys/bulk-disable with days → disables dormant keys', async () => {
    // Create a key in the past (dormant)
    const dormant = getKeyStore().create('Dormant');
    // Manually set createdAt to 31 days ago to make it dormant
    const entry = getKeyStore().validateById(dormant.id)!;
    (entry as { createdAt: string }).createdAt = new Date(Date.now() - 31 * 86_400_000).toISOString();

    getKeyStore().create('Fresh'); // not dormant

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-disable',
      headers: adminHeader(),
      payload: JSON.stringify({ days: 30 }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.disabled).toBe(1);
    expect(body.ids).toContain(dormant.id);
  });

  it('KBS9: POST /keys/bulk-disable with ids+days → union deduped, disabled once', async () => {
    const a = getKeyStore().create('Alpha');
    // Make it dormant
    const entry = getKeyStore().validateById(a.id)!;
    (entry as { createdAt: string }).createdAt = new Date(Date.now() - 31 * 86_400_000).toISOString();

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-disable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: [a.id], days: 30 }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Key appears in both ids[] and dormant list → disabled exactly once
    expect(body.disabled).toBe(1);
  });

  it('KBS10: POST /keys/bulk-disable 403 without admin key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-disable',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ids: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('KBS11: POST /keys/bulk-enable with ids[] → 200, returns enabled count and IDs', async () => {
    const a = getKeyStore().create('Alpha');
    const b = getKeyStore().create('Beta');
    getKeyStore().disable(a.id);
    getKeyStore().disable(b.id);

    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-enable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: [a.id, b.id] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.enabled).toBe(2);
    expect(body.ids).toContain(a.id);
    expect(body.ids).toContain(b.id);
    expect(getKeyStore().validateById(a.id)!.disabled).toBe(false);
  });

  it('KBS12: POST /keys/bulk-enable with empty ids → 200 enabled:0', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-enable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: [] }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(0);
  });

  it('KBS13: POST /keys/bulk-enable with unknown IDs → skipped, enabled:0', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys/bulk-enable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: ['no-such-id-1', 'no-such-id-2'] }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(0);
  });

  it('KBS14: disabled keys rejected at auth after bulk-disable', async () => {
    const entry = getKeyStore().create('ToDisable');
    const rawKey = entry.key;

    // Confirm key works before
    const before = getKeyStore().validateKey(rawKey);
    expect(before).not.toBeNull();

    await server.inject({
      method: 'POST',
      url: '/keys/bulk-disable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: [entry.id] }),
    });

    // Now the key should be rejected
    const after = getKeyStore().validateKey(rawKey);
    expect(after).toBeNull();
  });

  it('KBS15: re-enabled keys accepted at auth after bulk-enable', async () => {
    const entry = getKeyStore().create('ToEnable');
    const rawKey = entry.key;
    getKeyStore().disable(entry.id);

    // Confirm key is rejected while disabled
    expect(getKeyStore().validateKey(rawKey)).toBeNull();

    await server.inject({
      method: 'POST',
      url: '/keys/bulk-enable',
      headers: adminHeader(),
      payload: JSON.stringify({ ids: [entry.id] }),
    });

    // Now the key should be accepted
    expect(getKeyStore().validateKey(rawKey)).not.toBeNull();
  });
});
