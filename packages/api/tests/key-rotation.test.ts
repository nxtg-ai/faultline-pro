import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getKeyStore,
  resetKeyStore,
  ROTATION_GRACE_HOURS,
} from '../src/store/keys.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetKeyStore();
  resetNotificationStore();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

// ── KeyStore.rotate ───────────────────────────────────────────────────────────

describe('KeyStore.rotate', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; vi.useRealTimers(); });

  it('returns null for unknown id', () => {
    expect(getKeyStore().rotate('no-such-id')).toBeNull();
  });

  it('returns rotation result with required fields', () => {
    const entry = getKeyStore().create('Test Key');
    const originalKey = entry.key; // capture before rotation mutates the entry in-place
    const result = getKeyStore().rotate(entry.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(entry.id);
    expect(typeof result?.newKey).toBe('string');
    expect(result?.newKey).toHaveLength(64); // 32 bytes hex
    expect(typeof result?.previousKey).toBe('string');
    expect(result?.previousKey).toBe(originalKey);
    expect(result?.gracePeriodHours).toBe(ROTATION_GRACE_HOURS);
  });

  it('previousKeyExpiresAt is ~24h from now', () => {
    const entry = getKeyStore().create('Test Key');
    const before = Date.now();
    const result = getKeyStore().rotate(entry.id);
    const after = Date.now();
    const expMs = new Date(result!.previousKeyExpiresAt).getTime();
    expect(expMs).toBeGreaterThanOrEqual(before + ROTATION_GRACE_HOURS * 3_600_000 - 100);
    expect(expMs).toBeLessThanOrEqual(after  + ROTATION_GRACE_HOURS * 3_600_000 + 100);
  });

  it('newKey differs from the original key', () => {
    const entry = getKeyStore().create('Test Key');
    const original = entry.key;
    const result = getKeyStore().rotate(entry.id);
    expect(result?.newKey).not.toBe(original);
  });

  it('entry.key updated to newKey after rotation', () => {
    const entry = getKeyStore().create('Test Key');
    const result = getKeyStore().rotate(entry.id);
    const updated = getKeyStore().validateById(entry.id);
    expect(updated?.key).toBe(result?.newKey);
  });

  it('entry.lastRotatedAt set after rotation', () => {
    const entry = getKeyStore().create('Test Key');
    getKeyStore().rotate(entry.id);
    const updated = getKeyStore().validateById(entry.id);
    expect(updated?.lastRotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('second rotation replaces previousKey (no stacking)', () => {
    const entry = getKeyStore().create('Test Key');
    const r1 = getKeyStore().rotate(entry.id)!;
    const r2 = getKeyStore().rotate(entry.id)!;
    const updated = getKeyStore().validateById(entry.id);
    // previousKey after second rotation should be r1.newKey
    expect(updated?.previousKey).toBe(r1.newKey);
    expect(r2.previousKey).toBe(r1.newKey);
  });
});

// ── KeyStore.validateKey — grace period ───────────────────────────────────────

describe('KeyStore.validateKey — grace period', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; vi.useRealTimers(); });

  it('new key is valid immediately after rotation', () => {
    const entry = getKeyStore().create('Test Key');
    const result = getKeyStore().rotate(entry.id)!;
    expect(getKeyStore().validateKey(result.newKey)).not.toBeNull();
  });

  it('previous key is valid during grace period', () => {
    const entry = getKeyStore().create('Test Key');
    const oldKey = entry.key;
    getKeyStore().rotate(entry.id);
    expect(getKeyStore().validateKey(oldKey)).not.toBeNull();
  });

  it('previous key identifies the same entry', () => {
    const entry = getKeyStore().create('Test Key');
    const oldKey = entry.key;
    getKeyStore().rotate(entry.id);
    const found = getKeyStore().validateKey(oldKey);
    expect(found?.id).toBe(entry.id);
  });

  it('previous key is invalid after grace period expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    const entry = getKeyStore().create('Test Key');
    const oldKey = entry.key;
    getKeyStore().rotate(entry.id);

    // Advance past 24h expiry
    vi.setSystemTime(new Date('2026-03-21T10:01:00Z'));
    expect(getKeyStore().validateKey(oldKey)).toBeNull();
  });

  it('new key remains valid after grace period expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    const entry = getKeyStore().create('Test Key');
    const result = getKeyStore().rotate(entry.id)!;
    vi.setSystemTime(new Date('2026-03-21T10:01:00Z'));
    expect(getKeyStore().validateKey(result.newKey)).not.toBeNull();
  });

  it('completely unknown key still returns null', () => {
    getKeyStore().create('Test Key');
    expect(getKeyStore().validateKey('not-a-real-key')).toBeNull();
  });
});

// ── KeyStore.cleanExpiredRotations ────────────────────────────────────────────

describe('KeyStore.cleanExpiredRotations', () => {
  beforeEach(setup);
  afterEach(() => { vi.useRealTimers(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 0 when no rotations exist', () => {
    getKeyStore().create('Key');
    expect(getKeyStore().cleanExpiredRotations()).toBe(0);
  });

  it('returns 0 when grace period has not expired', () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().rotate(entry.id);
    expect(getKeyStore().cleanExpiredRotations()).toBe(0);
  });

  it('clears expired previousKey fields and returns count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    const entry = getKeyStore().create('Key');
    getKeyStore().rotate(entry.id);
    vi.setSystemTime(new Date('2026-03-21T10:01:00Z'));
    expect(getKeyStore().cleanExpiredRotations()).toBe(1);
    expect(getKeyStore().validateById(entry.id)?.previousKey).toBeUndefined();
  });
});

// ── KeyStore.isInGracePeriod ──────────────────────────────────────────────────

describe('KeyStore.isInGracePeriod', () => {
  beforeEach(setup);
  afterEach(() => { vi.useRealTimers(); delete process.env.FAULTLINE_API_KEY; });

  it('false before any rotation', () => {
    const entry = getKeyStore().create('Key');
    expect(getKeyStore().isInGracePeriod(entry.id)).toBe(false);
  });

  it('true immediately after rotation', () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().rotate(entry.id);
    expect(getKeyStore().isInGracePeriod(entry.id)).toBe(true);
  });

  it('false after grace period expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    const entry = getKeyStore().create('Key');
    getKeyStore().rotate(entry.id);
    vi.setSystemTime(new Date('2026-03-21T10:01:00Z'));
    expect(getKeyStore().isInGracePeriod(entry.id)).toBe(false);
  });
});

// ── HTTP: POST /keys/:id/rotate ───────────────────────────────────────────────

describe('POST /keys/:id/rotate', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 403 without auth', async () => {
    const entry = getKeyStore().create('Key');
    const res = await server.inject({ method: 'POST', url: `/keys/${entry.id}/rotate` });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for unknown key id', async () => {
    const res = await server.inject({
      method: 'POST', url: '/keys/no-such-id/rotate',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with rotation fields', async () => {
    const entry = getKeyStore().create('Key');
    const res = await server.inject({
      method: 'POST', url: `/keys/${entry.id}/rotate`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('newKey');
    expect(body).toHaveProperty('previousKey');
    expect(body).toHaveProperty('previousKeyExpiresAt');
    expect(body).toHaveProperty('gracePeriodHours');
    expect(body.gracePeriodHours).toBe(ROTATION_GRACE_HOURS);
  });

  it('newKey is 64 hex chars', async () => {
    const entry = getKeyStore().create('Key');
    const res = await server.inject({
      method: 'POST', url: `/keys/${entry.id}/rotate`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(res.body).newKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('previousKey matches the original key', async () => {
    const entry = getKeyStore().create('Key');
    const original = entry.key;
    const res = await server.inject({
      method: 'POST', url: `/keys/${entry.id}/rotate`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(res.body).previousKey).toBe(original);
  });

  it('response includes human-readable message', async () => {
    const entry = getKeyStore().create('Key');
    const res = await server.inject({
      method: 'POST', url: `/keys/${entry.id}/rotate`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(res.body).message).toContain('24 hours');
  });

  it('old key still authenticates requests during grace period', async () => {
    const entry = getKeyStore().create('Key');
    const oldKey = entry.key;
    // Rotate via HTTP
    await server.inject({
      method: 'POST', url: `/keys/${entry.id}/rotate`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    // Old key should still work on a key-authenticated endpoint
    const statusRes = await server.inject({
      method: 'GET', url: '/telemetry/status',
    });
    // /telemetry/status is public so we test /keys list which requires auth
    const keysRes = await server.inject({
      method: 'GET', url: '/keys',
      headers: { 'x-api-key': oldKey },
    });
    // oldKey is not admin, so will get 403 — but it should NOT be 401 (unknown key)
    expect(keysRes.statusCode).toBe(403); // key is recognized, just not admin
  });

  it('new key authenticates requests after rotation', async () => {
    const entry = getKeyStore().create('Key');
    const rotateRes = await server.inject({
      method: 'POST', url: `/keys/${entry.id}/rotate`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    const { newKey } = JSON.parse(rotateRes.body);
    // newKey should be recognized (403 not 401 on admin-only endpoint)
    const keysRes = await server.inject({
      method: 'GET', url: '/keys',
      headers: { 'x-api-key': newKey },
    });
    expect(keysRes.statusCode).toBe(403); // recognized but not admin
  });
});

// ── HTTP: GET /keys/:id/rotation-status ──────────────────────────────────────

describe('GET /keys/:id/rotation-status', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/no-id/rotation-status', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(404);
  });

  it('returns inGracePeriod=false before rotation', async () => {
    const entry = getKeyStore().create('Key');
    const res = await server.inject({ method: 'GET', url: `/keys/${entry.id}/rotation-status`, headers: { 'x-api-key': 'admin-secret' } });
    const body = JSON.parse(res.body);
    expect(body.inGracePeriod).toBe(false);
    expect(body.lastRotatedAt).toBeNull();
  });

  it('returns inGracePeriod=true after rotation', async () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().rotate(entry.id);
    const res = await server.inject({ method: 'GET', url: `/keys/${entry.id}/rotation-status`, headers: { 'x-api-key': 'admin-secret' } });
    const body = JSON.parse(res.body);
    expect(body.inGracePeriod).toBe(true);
    expect(body.previousKeyExpiresAt).not.toBeNull();
    expect(body.lastRotatedAt).not.toBeNull();
  });

  it('GET /keys list redacts key and previousKey', async () => {
    const entry = getKeyStore().create('Key');
    getKeyStore().rotate(entry.id);
    const res = await server.inject({ method: 'GET', url: '/keys', headers: { 'x-api-key': 'admin-secret' } });
    const keys = JSON.parse(res.body);
    const found = keys.find((k: { id: string }) => k.id === entry.id);
    expect(found).toBeDefined();
    expect(found.key).toBeUndefined();
    expect(found.previousKey).toBeUndefined();
  });
});
