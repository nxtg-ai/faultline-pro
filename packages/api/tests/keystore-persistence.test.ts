/**
 * The keystore survives a restart and holds only hashes.
 *
 * Each test points FAULTLINE_KEYSTORE_FILE at its own temp file (the suite
 * default is `off`, memory only). `resetKeyStore()` builds a new KeyStore from
 * that file, which is what a deploy does.
 */
// NEXUS: durable hashed keystore (keys survive a deploy, stored only as SHA-256)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import {
  getKeyStore,
  resetKeyStore,
  keystoreFilePath,
  KeyStore,
  KEYSTORE_LOAD_FAILED_LOG,
  KEYSTORE_WRITE_FAILED_LOG,
  ROTATION_GRACE_HOURS,
} from '../src/store/keys.js';

const ADMIN = 'keystore-persistence-admin-key-0123456789';
const ENV_KEYS = ['FAULTLINE_API_KEY', 'FAULTLINE_KEYSTORE_FILE', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER', 'FAULTLINE_CUSTOMER_KEYS'];

let saved: Record<string, string | undefined>;
let dir: string;
let file: string;
let app: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const fileText = () => readFileSync(file, 'utf8');
const storedKeys = () => (JSON.parse(fileText()) as { keys: Array<Record<string, unknown>> }).keys;

/** A restart: a new KeyStore from the file, and a new server over it. */
async function restart(): Promise<void> {
  await app.close();
  resetKeyStore();
  app = buildServer();
  await app.ready();
}

async function createKey(body: Record<string, unknown> = { name: 'customer', permissions: ['scan'] }) {
  const res = await app.inject({ method: 'POST', url: '/keys', headers: { 'x-api-key': ADMIN }, payload: body });
  expect(res.statusCode).toBe(201);
  const json = res.json() as { id: string; key: string };
  expect(json.key).toMatch(/^[0-9a-f]{64}$/);
  return json;
}

/** 200 when `key` authenticates (GET /usage is owner access), 401 when it does not. */
async function authStatus(key: string): Promise<number> {
  return (await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': key } })).statusCode;
}

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(() => { vi.restoreAllMocks(); });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-keystore-'));
  file = join(dir, 'keystore.json');
  process.env.FAULTLINE_API_KEY = ADMIN;
  process.env.FAULTLINE_KEYSTORE_FILE = file;
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
  resetKeyStore();
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  resetKeyStore();
});

describe('keystore file path', () => {
  it('defaults to keystore.json beside the Idempotency-Key ledger', () => {
    delete process.env.FAULTLINE_KEYSTORE_FILE;
    process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = '/var/log/faultline/key-idempotency.jsonl';
    expect(keystoreFilePath()).toBe('/var/log/faultline/keystore.json');
    process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'sub', 'idem.jsonl');
    expect(keystoreFilePath()).toBe(join(dir, 'sub', 'keystore.json'));
  });

  it('FAULTLINE_KEYSTORE_FILE overrides, and "off" keeps the store in memory', () => {
    expect(keystoreFilePath()).toBe(file);
    process.env.FAULTLINE_KEYSTORE_FILE = 'off';
    expect(keystoreFilePath()).toBeNull();
    const store = new KeyStore();
    store.create('memory only');
    expect(store.size).toBe(1);
    expect(store.isPersisted()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

describe('a key survives a restart', () => {
  it('a new KeyStore loaded from the same file authenticates the original plaintext', () => {
    const store = new KeyStore({ path: file });
    const issued = store.create('direct', ['scan']);
    const reloaded = new KeyStore({ path: file });
    expect(reloaded.size).toBe(1);
    expect(reloaded.validateKey(issued.key)?.id).toBe(issued.id);
    expect(reloaded.validateKey('0'.repeat(64))).toBeNull();
  });

  it('a key made with POST /keys authenticates after a restart', async () => {
    const { id, key } = await createKey();
    expect(await authStatus(key)).toBe(200);
    await restart();
    expect(getKeyStore().size).toBe(1);
    expect(await authStatus(key)).toBe(200);
    expect(getKeyStore().validateKey(key)?.id).toBe(id);
  });

  it('every field a key has is the same after a restart, claim cap and meter included', async () => {
    const { id, key } = await createKey({
      name: 'acme-prod', permissions: ['scan', 'report'], metered: true, claimCap: 5000,
      stripeCustomerId: 'cus_ABC123', scopes: ['usage:read'], expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(await authStatus(key)).toBe(200); // sets lastUsedAt
    getKeyStore().rotate(id);
    const before = structuredClone(getKeyStore().validateById(id));
    expect(before?.lastUsedAt).toBeDefined();
    await restart();
    expect(getKeyStore().validateById(id)).toEqual(before);
    expect(before).toMatchObject({ metered: true, claimCap: 5000, stripeCustomerId: 'cus_ABC123', scopes: ['usage:read'] });
  });
});

describe('only hashes at rest', () => {
  it('the file holds the key hash and prefix, never the plaintext', async () => {
    const { id, key } = await createKey();
    const text = fileText();
    expect(text).not.toContain(key);
    const rec = storedKeys().find((r) => r.id === id)!;
    expect(rec.keyHash).toBe(sha256(key));
    expect(rec.keyPrefix).toBe(key.slice(0, 8));
    expect(rec).not.toHaveProperty('key');
  });

  it('after a rotation the file holds neither the new nor the old plaintext', async () => {
    const { id, key: oldKey } = await createKey();
    const res = await app.inject({ method: 'POST', url: `/keys/${id}/rotate`, headers: { 'x-api-key': ADMIN } });
    const { newKey, previousKey } = res.json() as { newKey: string; previousKey: string };
    expect(previousKey).toBe(oldKey.slice(0, 8));
    const text = fileText();
    expect(text).not.toContain(oldKey);
    expect(text).not.toContain(newKey);
    const rec = storedKeys().find((r) => r.id === id)!;
    expect(rec.keyHash).toBe(sha256(newKey));
    expect(rec.previousKeyHash).toBe(sha256(oldKey));
  });

  it('no API response after creation carries the plaintext or a hash', async () => {
    const { id, key } = await createKey({ name: 'leak-check', permissions: ['scan'], expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    await authStatus(key);
    const hash = sha256(key);
    const admin = { 'x-api-key': ADMIN };
    const calls: Array<{ method: 'GET' | 'PATCH' | 'POST'; url: string; payload?: Record<string, unknown>; headers?: Record<string, string> }> = [
      { method: 'GET', url: '/keys' },
      { method: 'GET', url: `/keys/${id}` },
      { method: 'GET', url: '/keys/usage' },
      { method: 'GET', url: '/keys/dormant?days=1' },
      { method: 'GET', url: '/keys/expiring-soon?days=7' },
      { method: 'GET', url: `/keys/${id}/rotation-status` },
      { method: 'PATCH', url: `/keys/${id}`, payload: { name: 'renamed' } },
      { method: 'PATCH', url: `/keys/${id}/disable` },
      { method: 'PATCH', url: `/keys/${id}/enable` },
      { method: 'GET', url: '/usage' },
      { method: 'GET', url: '/usage', headers: { 'x-api-key': key } },
      { method: 'POST', url: '/graphql', payload: { query: '{ keys { id name permissions createdAt } }' } },
    ];
    let checked = 0;
    for (const c of calls) {
      const res = await app.inject({ method: c.method, url: c.url, headers: c.headers ?? admin, ...(c.payload ? { payload: c.payload } : {}) });
      expect(res.statusCode, `${c.method} ${c.url}`).toBeLessThan(500);
      expect(res.body, `${c.method} ${c.url}`).not.toContain(key);
      expect(res.body, `${c.method} ${c.url}`).not.toContain(hash);
      checked += 1;
    }
    expect(checked).toBe(calls.length);
    // The rotation response carries the new key once, and neither the old key nor any hash.
    const rot = await app.inject({ method: 'POST', url: `/keys/${id}/rotate`, headers: admin });
    expect(rot.statusCode).toBe(200);
    expect(rot.body).not.toContain(key);
    expect(rot.body).not.toContain(hash);
    const { newKey } = rot.json() as { newKey: string };
    const after = await app.inject({ method: 'GET', url: `/keys/${id}`, headers: admin });
    expect(after.body).not.toContain(newKey);
    expect(after.body).not.toContain(sha256(newKey));
  });

  it('an Idempotency-Key replay returns key null and the file still has no plaintext', async () => {
    const headers = { 'x-api-key': ADMIN, 'idempotency-key': 'acme-0001' };
    const first = await app.inject({ method: 'POST', url: '/keys', headers, payload: { name: 'idem', permissions: ['scan'] } });
    expect(first.statusCode).toBe(201);
    const { key } = first.json() as { key: string };
    await restart();
    const replay = await app.inject({ method: 'POST', url: '/keys', headers, payload: { name: 'idem', permissions: ['scan'] } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().key).toBeNull();
    expect(replay.body).not.toContain(key);
    expect(replay.body).not.toContain(sha256(key));
    expect(await authStatus(key)).toBe(200);
  });
});

describe('rotation across a restart', () => {
  it('new key works; old key works until grace expiry, then fails, also after reloads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    const { id, key: oldKey } = await createKey();
    const rot = await app.inject({ method: 'POST', url: `/keys/${id}/rotate`, headers: { 'x-api-key': ADMIN } });
    const { newKey } = rot.json() as { newKey: string };
    expect(await authStatus(newKey)).toBe(200);
    expect(await authStatus(oldKey)).toBe(200);

    await restart();
    expect(await authStatus(newKey)).toBe(200);
    expect(await authStatus(oldKey)).toBe(200);
    expect(getKeyStore().isInGracePeriod(id)).toBe(true);

    vi.setSystemTime(new Date(Date.parse('2026-11-01T10:00:00Z') + ROTATION_GRACE_HOURS * 3_600_000 + 60_000));
    expect(await authStatus(oldKey)).toBe(401);
    expect(await authStatus(newKey)).toBe(200);

    await restart();
    expect(await authStatus(oldKey)).toBe(401);
    expect(await authStatus(newKey)).toBe(200);

    // Cleaning the expired grace hash is written too.
    expect(getKeyStore().cleanExpiredRotations()).toBe(1);
    expect(storedKeys()[0]).not.toHaveProperty('previousKeyHash');
    await restart();
    expect(getKeyStore().validateById(id)?.previousKeyExpiresAt).toBeUndefined();
    expect(await authStatus(oldKey)).toBe(401);
  });
});

describe('changes survive a restart', () => {
  it('disable and enable', async () => {
    const { id, key } = await createKey();
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}/disable`, headers: { 'x-api-key': ADMIN } })).statusCode).toBe(200);
    await restart();
    expect(getKeyStore().validateById(id)?.disabled).toBe(true);
    expect(await authStatus(key)).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: `/keys/${id}/enable`, headers: { 'x-api-key': ADMIN } })).statusCode).toBe(200);
    await restart();
    expect(getKeyStore().validateById(id)?.disabled).toBe(false);
    expect(await authStatus(key)).toBe(200);
  });

  it('delete', async () => {
    const a = await createKey({ name: 'a', permissions: ['scan'] });
    const b = await createKey({ name: 'b', permissions: ['scan'] });
    expect((await app.inject({ method: 'DELETE', url: `/keys/${a.id}`, headers: { 'x-api-key': ADMIN } })).statusCode).toBe(204);
    await restart();
    expect(getKeyStore().size).toBe(1);
    expect(getKeyStore().validateById(a.id)).toBeNull();
    expect(await authStatus(a.key)).toBe(401);
    expect(await authStatus(b.key)).toBe(200);
  });

  it('PATCH of permissions, claimCap and metered', async () => {
    const { id } = await createKey({ name: 'p', permissions: ['scan'] });
    expect(getKeyStore().validateById(id)).toMatchObject({ metered: true, claimCap: 1000 });
    const res = await app.inject({
      method: 'PATCH', url: `/keys/${id}`, headers: { 'x-api-key': ADMIN },
      payload: { permissions: ['scan', 'pro'], claimCap: 2500, metered: false },
    });
    expect(res.statusCode).toBe(200);
    await restart();
    expect(getKeyStore().validateById(id)).toMatchObject({ permissions: ['scan', 'pro'], claimCap: 2500, metered: false });
  });

  it('bulk disable and bulk delete', async () => {
    const a = await createKey({ name: 'a', permissions: ['scan'] });
    const b = await createKey({ name: 'b', permissions: ['scan'] });
    expect(getKeyStore().bulkDisable([a.id, b.id])).toHaveLength(2);
    await restart();
    expect(await authStatus(a.key)).toBe(401);
    expect(getKeyStore().bulkDelete([a.id])).toEqual([a.id]);
    await restart();
    expect(getKeyStore().list().map((k) => k.id)).toEqual([b.id]);
  });
});

describe('failure handling', () => {
  it('a corrupt file gives zero keys, no crash, and a counted load failure', async () => {
    const { key } = await createKey();
    writeFileSync(file, '{"version":1,"keys":[{"id":"x"'); // truncated JSON
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await restart();
    expect(getKeyStore().size).toBe(0);
    expect(getKeyStore().getLoadFailures()).toBe(1);
    expect(await authStatus(key)).toBe(401);
    expect(warn).toHaveBeenCalledWith(KEYSTORE_LOAD_FAILED_LOG);
    // The bad file is moved aside, not overwritten by the next write.
    expect(readdirSync(dir).some((n) => n.startsWith('keystore.json.unreadable-'))).toBe(true);
    const usage = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': ADMIN } });
    expect(usage.json().keystore).toMatchObject({ keys: 0, persisted: true, loadFailures: 1, writeFailures: 0 });
    // The server keeps working: a new key is issued, written and authenticates.
    const fresh = await createKey();
    expect(await authStatus(fresh.key)).toBe(200);
    expect(storedKeys()).toHaveLength(1);
  });

  it('a record out of shape fails the whole file closed', async () => {
    const { key } = await createKey();
    await createKey({ name: 'second', permissions: ['scan'] });
    const doc = JSON.parse(fileText()) as { keys: Array<Record<string, unknown>> };
    doc.keys[1].keyHash = 'not-a-hash';
    writeFileSync(file, JSON.stringify(doc));
    await restart();
    expect(getKeyStore().size).toBe(0);
    expect(getKeyStore().getLoadFailures()).toBe(1);
    expect(await authStatus(key)).toBe(401);
  });

  it('an unreadable path (a directory where the file should be) gives zero keys and is counted', async () => {
    mkdirSync(file);
    await restart();
    expect(getKeyStore().size).toBe(0);
    expect(getKeyStore().getLoadFailures()).toBe(1);
  });

  it('a failed write is counted, logged with a fixed line, and memory still serves', async () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    process.env.FAULTLINE_KEYSTORE_FILE = join(blocker, 'keystore.json'); // parent is a file: every write fails
    await restart();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const { id, key } = await createKey();
    expect(getKeyStore().getWriteFailures()).toBe(1);
    expect(warn).toHaveBeenCalledWith(KEYSTORE_WRITE_FAILED_LOG);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(key);
    expect(await authStatus(key)).toBe(200);
    expect(getKeyStore().validateById(id)).not.toBeNull();
    const usage = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': ADMIN } });
    expect(usage.json().keystore).toMatchObject({ keys: 1, writeFailures: 1, loadFailures: 0 });
  });

  it('the keystore block on GET /usage is admin only', async () => {
    const { key } = await createKey();
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': key } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('keystore');
  });

  it('env keys are not in the keystore', async () => {
    await createKey();
    expect(await authStatus(ADMIN)).toBe(200);
    expect(fileText()).not.toContain(ADMIN);
    expect(storedKeys()).toHaveLength(1);
  });
});

describe('file mode and atomic write', () => {
  it('the keystore file is mode 0600', async () => {
    await createKey();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('no temp file is left behind after writes', async () => {
    await createKey();
    await createKey({ name: 'b', permissions: ['scan'] });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toContain('keystore.json');
  });

  it('lastUsedAt is written, at most once per interval', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    const { id, key } = await createKey();
    expect(storedKeys()[0].lastUsedAt).toBeUndefined();
    // First use within the interval after the create's write: deferred.
    expect(getKeyStore().validateKey(key)?.id).toBe(id);
    expect(storedKeys()[0].lastUsedAt).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(storedKeys()[0].lastUsedAt).toBe('2026-11-01T10:00:00.000Z');
    // After the interval a use is written at once.
    vi.setSystemTime(new Date('2026-11-01T10:05:00Z'));
    getKeyStore().validateKey(key);
    expect(storedKeys()[0].lastUsedAt).toBe('2026-11-01T10:05:00.000Z');
  });
});
