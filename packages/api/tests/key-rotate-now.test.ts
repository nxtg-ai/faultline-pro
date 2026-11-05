/**
 * POST /keys/:id/rotate-now: rotate a key with no grace period.
 *
 * The old key stops authenticating on the very next request, the new key is
 * returned once, and the durable keystore holds only the new key's SHA-256 with
 * no previous-key grace entry. The graced POST /keys/:id/rotate is unchanged
 * (key-rotation.test.ts).
 *
 * Each test points FAULTLINE_KEYSTORE_FILE at its own temp file, so the
 * assertions read the same file a deploy would load.
 */
// Validates: N-1.18.11.7.39 (admin-only rotate-now: old key 401 at once, new key hash-only in the keystore, shown once, no grace entry)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

const ADMIN = 'rotate-now-admin-key-0123456789abcdef';
const ENV_KEYS = ['FAULTLINE_API_KEY', 'FAULTLINE_KEYSTORE_FILE', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER'];

let saved: Record<string, string | undefined>;
let dir: string;
let file: string;
let app: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const fileText = () => readFileSync(file, 'utf8');
const storedKeys = () => (JSON.parse(fileText()) as { keys: Array<Record<string, unknown>> }).keys;

/** 200 when `key` authenticates (GET /usage is owner access), 401 when it does not. */
async function authStatus(key: string): Promise<number> {
  return (await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': key } })).statusCode;
}

/** `key` null sends no x-api-key header. */
function rotateNow(id: string, key: string | null = ADMIN) {
  return app.inject({ method: 'POST', url: `/keys/${id}/rotate-now`, headers: key === null ? {} : { 'x-api-key': key } });
}

async function restart(): Promise<void> {
  await app.close();
  resetKeyStore();
  app = buildServer();
  await app.ready();
}

vi.setConfig({ testTimeout: 30_000 });

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(() => { vi.restoreAllMocks(); });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-rotate-now-'));
  file = join(dir, 'keystore.json');
  process.env.FAULTLINE_API_KEY = ADMIN;
  process.env.FAULTLINE_KEYSTORE_FILE = file;
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  resetKeyStore();
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  resetKeyStore();
});

describe('POST /keys/:id/rotate-now', () => {
  it('the old key authenticates before the call and gets 401 on the very next request; the new key works', async () => {
    const { id, key: oldKey } = getKeyStore().create('customer', ['scan']);
    expect(await authStatus(oldKey)).toBe(200);

    const res = await rotateNow(id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.newKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.newKey).not.toBe(oldKey);
    expect(body.previousKey).toBe(oldKey.slice(0, 8));
    expect(body.gracePeriodHours).toBe(0);
    expect(body).not.toHaveProperty('previousKeyExpiresAt');

    expect(await authStatus(oldKey)).toBe(401);
    expect(await authStatus(body.newKey as string)).toBe(200);
  });

  it('the response carries the new key once and neither the old key nor any hash; no later read returns it', async () => {
    const { id, key: oldKey } = getKeyStore().create('customer', ['scan']);
    const res = await rotateNow(id);
    expect(res.statusCode).toBe(200);
    const { newKey } = res.json() as { newKey: string };
    expect(res.body).not.toContain(oldKey);
    expect(res.body).not.toContain(sha256(oldKey));
    expect(res.body).not.toContain(sha256(newKey));
    const reads = [`/keys/${id}`, '/keys', `/keys/${id}/rotation-status`];
    for (const url of reads) {
      const r = await app.inject({ method: 'GET', url, headers: { 'x-api-key': ADMIN } });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).not.toContain(newKey);
      expect(r.body, url).not.toContain(sha256(newKey));
    }
    expect(reads).toHaveLength(3);
  });

  it('a non-admin key gets 403 and nothing rotates', async () => {
    const target = getKeyStore().create('target', ['scan']);
    const caller = getKeyStore().create('caller', ['scan', 'pro']);
    const res = await rotateNow(target.id, caller.key);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/newKey/);
    expect(await authStatus(target.key)).toBe(200);
    expect(storedKeys().find((r) => r.id === target.id)!.keyHash).toBe(sha256(target.key));
  });

  it('no x-api-key gets 403, and a keystore admin key may call it', async () => {
    const target = getKeyStore().create('target', ['scan']);
    expect((await rotateNow(target.id, null)).statusCode).toBe(403);
    expect(await authStatus(target.key)).toBe(200);
    const admin = getKeyStore().create('ops', ['admin']);
    const res = await rotateNow(target.id, admin.key);
    expect(res.statusCode, res.body).toBe(200);
    expect(await authStatus(target.key)).toBe(401);
  });

  it('an unknown id answers 404', async () => {
    const res = await rotateNow('no-such-id');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Key not found.' });
  });

  it('the keystore file holds only the new key\'s SHA-256, never the new plaintext, and no grace entry', async () => {
    const { id, key: oldKey } = getKeyStore().create('customer', ['scan']);
    const res = await rotateNow(id);
    const { newKey } = res.json() as { newKey: string };
    const text = fileText();
    expect(text).not.toContain(newKey);
    expect(text).not.toContain(oldKey);
    expect(text).not.toContain(sha256(oldKey));
    const keys = storedKeys();
    expect(keys).toHaveLength(1);
    const rec = keys.find((r) => r.id === id)!;
    expect(rec.keyHash).toBe(sha256(newKey));
    expect(rec.keyPrefix).toBe(newKey.slice(0, 8));
    expect(rec).not.toHaveProperty('previousKeyHash');
    expect(rec).not.toHaveProperty('previousKeyExpiresAt');
    expect(rec.lastRotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const status = await app.inject({ method: 'GET', url: `/keys/${id}/rotation-status`, headers: { 'x-api-key': ADMIN } });
    expect(status.json().inGracePeriod).toBe(false);
  });

  it('after a graced rotate, rotate-now also drops the grace key: the original and the graced key both get 401', async () => {
    const { id, key: original } = getKeyStore().create('customer', ['scan']);
    const graced = await app.inject({ method: 'POST', url: `/keys/${id}/rotate`, headers: { 'x-api-key': ADMIN } });
    expect(graced.statusCode).toBe(200);
    const { newKey: gracedKey } = graced.json() as { newKey: string };
    expect(await authStatus(original)).toBe(200); // inside the 24h grace
    expect(storedKeys()[0].previousKeyHash).toBe(sha256(original));

    const res = await rotateNow(id);
    expect(res.statusCode).toBe(200);
    const { newKey } = res.json() as { newKey: string };
    expect(await authStatus(original)).toBe(401);
    expect(await authStatus(gracedKey)).toBe(401);
    expect(await authStatus(newKey)).toBe(200);
    const text = fileText();
    expect(text).not.toContain(sha256(original));
    expect(text).not.toContain(sha256(gracedKey));
    expect(storedKeys()[0]).not.toHaveProperty('previousKeyHash');
  });

  it('the revocation survives a restart: the old key stays 401, the new key stays 200', async () => {
    const { id, key: oldKey } = getKeyStore().create('customer', ['scan']);
    const { newKey } = (await rotateNow(id)).json() as { newKey: string };
    await restart();
    expect(await authStatus(oldKey)).toBe(401);
    expect(await authStatus(newKey)).toBe(200);
  });

  it('a second call with the same key id rotates again: 200, a fresh key, and the first new key gets 401 at once', async () => {
    const { id, key: oldKey } = getKeyStore().create('customer', ['scan']);
    const first = await rotateNow(id);
    expect(first.statusCode).toBe(200);
    const k1 = (first.json() as { newKey: string }).newKey;
    const second = await rotateNow(id);
    expect(second.statusCode).toBe(200);
    const body2 = second.json() as { id: string; newKey: string; previousKey: string };
    expect(body2.id).toBe(id);
    expect(body2.newKey).not.toBe(k1);
    expect(body2.previousKey).toBe(k1.slice(0, 8));
    expect(await authStatus(oldKey)).toBe(401);
    expect(await authStatus(k1)).toBe(401);
    expect(await authStatus(body2.newKey)).toBe(200);
    expect(getKeyStore().size).toBe(1);
  });

  it('the old key presented to rotate-now itself is refused (403, the admin gate) and changes nothing', async () => {
    const { id, key: oldKey } = getKeyStore().create('ops', ['admin']);
    const res = await rotateNow(id);
    const { newKey } = res.json() as { newKey: string };
    expect(res.statusCode).toBe(200);
    const again = await rotateNow(id, oldKey);
    expect(again.statusCode).toBe(403);
    expect(await authStatus(newKey)).toBe(200);
  });
});

describe('KeyStore.rotateNow', () => {
  it('returns null for an unknown id and writes nothing', () => {
    expect(getKeyStore().rotateNow('no-such-id')).toBeNull();
  });

  it('replaces the hash with no grace entry and returns the new key once', () => {
    const store = getKeyStore();
    const entry = store.create('k', ['scan']);
    const result = store.rotateNow(entry.id)!;
    expect(result.id).toBe(entry.id);
    expect(result.newKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.previousKey).toBe(entry.key.slice(0, 8));
    expect(store.validateKey(entry.key)).toBeNull();
    expect(store.validateKey(result.newKey)?.id).toBe(entry.id);
    expect(store.isInGracePeriod(entry.id)).toBe(false);
    expect(store.validateById(entry.id)?.previousKeyExpiresAt).toBeUndefined();
  });
});
