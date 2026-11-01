import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type Permission = 'scan' | 'report' | 'upload' | 'admin' | 'pro';

/** Scopes a key may hold. Admin keys pass every scope without holding any. */
export const KEY_SCOPES = ['usage:read', 'keys:write'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Longest accepted `Idempotency-Key` header on POST /keys. */
export const MAX_KEY_IDEMPOTENCY_KEY_LENGTH = 200;

const DEFAULT_IDEMPOTENCY_LEDGER_PATH = '/var/log/faultline/key-idempotency.jsonl';

/**
 * Where the POST /keys Idempotency-Key map is kept. `FAULTLINE_KEY_IDEMPOTENCY_LEDGER`
 * overrides. The file sits on the ledger volume so a deploy does not forget
 * which header values already minted a key. It holds a SHA-256 of each header
 * value and the key id, never key material.
 */
export function keyIdempotencyLedgerPath(): string {
  const raw = (process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_IDEMPOTENCY_LEDGER_PATH : raw;
}

/** `FAULTLINE_KEYSTORE_FILE=off` keeps the keystore in memory only (the test suite sets it). */
export const KEYSTORE_FILE_OFF = 'off';

/**
 * Where the keystore is kept: `keystore.json` in the same directory as the
 * Idempotency-Key ledger (the ledger volume), unless `FAULTLINE_KEYSTORE_FILE`
 * names another file. Null when that variable is `off`.
 */
export function keystoreFilePath(): string | null {
  const raw = (process.env.FAULTLINE_KEYSTORE_FILE ?? '').trim();
  if (raw === KEYSTORE_FILE_OFF) return null;
  return raw === '' ? join(dirname(keyIdempotencyLedgerPath()), 'keystore.json') : raw;
}

const hashIdempotencyKey = (value: string): string => createHash('sha256').update(value).digest('hex');

/** SHA-256 hex of a key. The keystore keeps only this, never the key itself. */
export const hashApiKey = (plaintext: string): string => createHash('sha256').update(plaintext).digest('hex');

/** Characters of a key kept in the clear as `keyPrefix`, so an operator can tell keys apart. */
export const KEY_PREFIX_LENGTH = 8;

/**
 * A successful authentication changes only `lastUsedAt`. That change is written
 * at most once per this interval (a timer writes the latest value when the
 * interval ends), so a busy key does not cost one file write per request.
 * Every other change is written at once.
 */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Fixed log lines. They never carry key material. */
export const KEYSTORE_LOAD_FAILED_LOG = '[keystore] keystore file could not be read; starting with no keystore keys, which will not authenticate.';
export const KEYSTORE_WRITE_FAILED_LOG = '[keystore] keystore file write failed; keys are served from memory and changes since the last good write are lost on restart.';

export const ROTATION_GRACE_HOURS = 24;

/**
 * A keystore key as the rest of the API sees it. It holds no secret: the key's
 * hash, and the previous key's hash during rotation grace, are kept apart by the
 * store, so spreading an entry into a response cannot leak them.
 */
export interface ApiKey {
  id: string;
  /** First KEY_PREFIX_LENGTH characters of the current key. Not enough to authenticate. */
  keyPrefix: string;
  name: string;
  permissions: Permission[];
  createdAt: string;
  /** When true, key is rejected at auth time without deletion */
  disabled?: boolean;
  /** ISO datetime when the previous key (rotation grace) stops being accepted */
  previousKeyExpiresAt?: string;
  /** ISO datetime of the most recent rotation */
  lastRotatedAt?: string;
  /** ISO datetime of the most recent successful authentication */
  lastUsedAt?: string;
  /** ISO datetime after which the key is automatically rejected */
  expiresAt?: string;
  /** Claims this key may have verified per calendar month (UTC). A metered key without one is refused. */
  claimCap?: number;
  /** Stripe customer copied onto each usage row when it is committed. */
  stripeCustomerId?: string;
  /** True: the claim meter counts this key's claims (only while FAULTLINE_CLAIM_METER is on). */
  metered?: boolean;
  /** Scopes this key holds (see KEY_SCOPES). */
  scopes?: KeyScope[];
}

/** What `create()` returns: the new entry plus its plaintext `key`, shown once. */
export type IssuedApiKey = ApiKey & { key: string };

/** The secret side of an entry: hashes only. */
interface KeyHashes {
  keyHash: string;
  previousKeyHash?: string;
}

/** One key as written to the keystore file. */
type StoredKey = ApiKey & KeyHashes;

const KEYSTORE_FILE_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PERMISSIONS: readonly Permission[] = ['scan', 'report', 'upload', 'admin', 'pro'];

const isString = (v: unknown): v is string => typeof v === 'string';
const optional = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || check(v);

/**
 * Parse the keystore file. Throws on anything out of shape: one bad record
 * fails the whole file, so the store starts with no keys rather than a partial set.
 */
function parseKeystoreFile(raw: string): StoredKey[] {
  const doc = JSON.parse(raw) as { version?: unknown; keys?: unknown };
  if (doc === null || typeof doc !== 'object' || doc.version !== KEYSTORE_FILE_VERSION || !Array.isArray(doc.keys)) {
    throw new Error('keystore file out of shape');
  }
  const seen = new Set<string>();
  return doc.keys.map((r: unknown): StoredKey => {
    const k = r as Record<string, unknown>;
    const ok = k !== null && typeof k === 'object'
      && isString(k.id) && k.id !== '' && !seen.has(k.id)
      && isString(k.keyHash) && SHA256_HEX.test(k.keyHash)
      && optional(k.previousKeyHash, (v) => isString(v) && SHA256_HEX.test(v))
      && isString(k.keyPrefix) && k.keyPrefix.length <= KEY_PREFIX_LENGTH
      && isString(k.name)
      && Array.isArray(k.permissions) && k.permissions.every((p) => PERMISSIONS.includes(p as Permission))
      && isString(k.createdAt)
      && optional(k.disabled, (v) => typeof v === 'boolean')
      && optional(k.previousKeyExpiresAt, isString)
      && optional(k.lastRotatedAt, isString)
      && optional(k.lastUsedAt, isString)
      && optional(k.expiresAt, isString)
      && optional(k.claimCap, (v) => typeof v === 'number' && Number.isFinite(v))
      && optional(k.stripeCustomerId, isString)
      && optional(k.metered, (v) => typeof v === 'boolean')
      && optional(k.scopes, (v) => Array.isArray(v) && v.every((s) => (KEY_SCOPES as readonly unknown[]).includes(s)));
    if (!ok) throw new Error('keystore record out of shape');
    seen.add(k.id as string);
    // Copy known fields only, in a fixed order.
    const out: Record<string, unknown> = {};
    for (const f of STORED_FIELDS) if (k[f] !== undefined) out[f] = k[f];
    return out as unknown as StoredKey;
  });
}

/** Every field a stored key has. The file holds these and nothing else. */
const STORED_FIELDS = [
  'id', 'keyHash', 'previousKeyHash', 'keyPrefix', 'name', 'permissions', 'createdAt', 'disabled',
  'previousKeyExpiresAt', 'lastRotatedAt', 'lastUsedAt', 'expiresAt', 'claimCap', 'stripeCustomerId',
  'metered', 'scopes',
] as const;

/** Billing fields set at issuance or with PATCH /keys/:id. */
export interface KeyBillingFields {
  claimCap?: number;
  stripeCustomerId?: string;
  metered?: boolean;
  scopes?: KeyScope[];
}

export interface KeyUsageStat {
  id: string;
  name: string;
  permissions: Permission[];
  disabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  lastRotatedAt: string | null;
  expiresAt: string | null;
  daysSinceCreation: number;
  daysSinceLastUse: number | null;
  daysSinceLastRotation: number | null;
  isDormant: boolean;
  isExpiringSoon: boolean;
  isExpired: boolean;
}

export interface RotationResult {
  id:                   string;
  /** The new key, in plaintext. Shown once. */
  newKey:               string;
  /** The replaced key's keyPrefix, so the caller knows which key to replace. Never the key itself. */
  previousKey:          string;
  previousKeyExpiresAt: string;
  gracePeriodHours:     number;
}

export interface KeyStoreOptions {
  /** Keystore file. Defaults to keystoreFilePath(); null keeps the store in memory only. */
  path?: string | null;
}

export class KeyStore {
  private keys: ApiKey[] = [];
  /** Key id -> the key's hash and, during rotation grace, the previous key's hash. */
  private hashes = new Map<string, KeyHashes>();
  /** Ids of metered keys that were deleted, so background work they queued is refused, not run free. */
  private revokedMetered = new Set<string>();
  /** SHA-256 of a POST /keys Idempotency-Key value -> the key id it minted. */
  private idempotency = new Map<string, string>();
  private idempotencyWriteFailures = 0;
  private readonly path: string | null;
  private loadFailures = 0;
  private writeFailures = 0;
  /** When a keystore write was last attempted (ms epoch), for lastUsedAt coalescing. */
  private lastWriteAt = 0;
  private lastUsedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: KeyStoreOptions = {}) {
    this.path = options.path !== undefined ? options.path : keystoreFilePath();
    this.hydrateIdempotency();
    this.load();
  }

  // ── Keystore file ─────────────────────────────────────────────────────────

  /**
   * Load the keystore file. No file: an empty store. A file that cannot be read
   * or parsed: an empty store (fail closed), counted and logged with one fixed
   * line. The bad file is moved aside (best effort) so the next write does not
   * overwrite what an operator may still recover.
   */
  private load(): void {
    const path = this.path;
    if (path === null || !existsSync(path)) return;
    let records: StoredKey[];
    try {
      records = parseKeystoreFile(readFileSync(path, 'utf8'));
    } catch {
      this.loadFailures += 1;
      console.warn(KEYSTORE_LOAD_FAILED_LOG);
      try {
        renameSync(path, `${path}.unreadable-${Date.now()}`);
      } catch {
        // Left in place; the next good write replaces it.
      }
      return;
    }
    for (const r of records) {
      const { keyHash, previousKeyHash, ...entry } = r;
      this.keys.push(entry);
      this.hashes.set(entry.id, previousKeyHash !== undefined ? { keyHash, previousKeyHash } : { keyHash });
    }
  }

  /** The whole keystore as the file holds it: hashes, never a key. */
  private serialize(): string {
    const keys = this.keys.map((entry) => {
      const merged: Record<string, unknown> = { ...entry, ...this.hashes.get(entry.id) };
      const out: Record<string, unknown> = {};
      for (const f of STORED_FIELDS) if (merged[f] !== undefined) out[f] = merged[f];
      return out;
    });
    return JSON.stringify({ version: KEYSTORE_FILE_VERSION, keys }, null, 2) + '\n';
  }

  /**
   * Write the whole keystore atomically: a temp file in the same directory,
   * mode 0600, fsync, then rename over the old file. A failure leaves the old
   * file as it was, keeps serving from memory, and is counted.
   */
  private persist(): void {
    const path = this.path;
    if (path === null) return;
    if (this.lastUsedTimer) {
      clearTimeout(this.lastUsedTimer);
      this.lastUsedTimer = null;
    }
    // Set before the attempt, so a failing disk is retried for lastUsedAt at most once per interval.
    this.lastWriteAt = Date.now();
    const dir = dirname(path);
    const tmp = join(dir, `.keystore-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      fd = openSync(tmp, 'wx', 0o600);
      fchmodSync(fd, 0o600);
      const buf = Buffer.from(this.serialize(), 'utf8');
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already failing */ }
      }
      try { unlinkSync(tmp); } catch { /* never created */ }
      this.writeFailures += 1;
      console.warn(KEYSTORE_WRITE_FAILED_LOG);
      return;
    }
    // Make the rename itself durable. Best effort: not every platform can fsync a directory.
    try {
      const dfd = openSync(dir, 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch {
      // The file is complete either way.
    }
  }

  /** A lastUsedAt-only change: write now if the last write is older than the interval, else once it ends. */
  private persistLastUsed(): void {
    if (this.path === null || this.lastUsedTimer) return;
    const wait = this.lastWriteAt + LAST_USED_WRITE_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.persist();
      return;
    }
    this.lastUsedTimer = setTimeout(() => {
      this.lastUsedTimer = null;
      this.persist();
    }, wait);
    this.lastUsedTimer.unref?.();
  }

  /** Stop a pending lastUsedAt write. Called when this instance is replaced. */
  dispose(): void {
    if (this.lastUsedTimer) {
      clearTimeout(this.lastUsedTimer);
      this.lastUsedTimer = null;
    }
  }

  /** True when this store writes to a keystore file (false: memory only). */
  isPersisted(): boolean {
    return this.path !== null;
  }

  /** Keystore files that existed but could not be read or parsed (this process). */
  getLoadFailures(): number {
    return this.loadFailures;
  }

  /** Keystore file writes that failed (this process). */
  getWriteFailures(): number {
    return this.writeFailures;
  }

  // ── Idempotency-Key ledger ────────────────────────────────────────────────

  private hydrateIdempotency(): void {
    const path = keyIdempotencyLedgerPath();
    let raw: string;
    try {
      if (!existsSync(path) || !statSync(path).isFile()) return;
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as { hash?: unknown; keyId?: unknown };
        if (typeof row.hash === 'string' && typeof row.keyId === 'string' && !this.idempotency.has(row.hash)) {
          this.idempotency.set(row.hash, row.keyId);
        }
      } catch {
        continue;
      }
    }
  }

  /** The key id an Idempotency-Key value already minted, or undefined. */
  keyIdForIdempotencyKey(value: string): string | undefined {
    return this.idempotency.get(hashIdempotencyKey(value));
  }

  /**
   * Remember that `value` minted `keyId`, in memory and on the ledger volume. A
   * failed write keeps the entry in memory (counted), so this process still
   * never mints twice for one value.
   */
  rememberIdempotencyKey(value: string, keyId: string): void {
    const hash = hashIdempotencyKey(value);
    if (this.idempotency.has(hash)) return;
    this.idempotency.set(hash, keyId);
    const path = keyIdempotencyLedgerPath();
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(path, JSON.stringify({ hash, keyId, ts: new Date().toISOString() }) + '\n');
    } catch {
      this.idempotencyWriteFailures += 1;
    }
  }

  getIdempotencyWriteFailures(): number {
    return this.idempotencyWriteFailures;
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /** True when `id` was a metered key that has since been deleted. */
  wasRevokedMetered(id: string): boolean {
    return this.revokedMetered.has(id);
  }

  /**
   * Issue a key. The returned object carries the plaintext `key`; the store
   * keeps only its hash and prefix, so this is the only time it is available.
   */
  create(name: string, permissions: Permission[] = ['scan'], expiresAt?: string, billing: KeyBillingFields = {}): IssuedApiKey {
    const key = randomBytes(32).toString('hex');
    const entry: ApiKey = {
      id: randomUUID(),
      keyPrefix: key.slice(0, KEY_PREFIX_LENGTH),
      name,
      permissions,
      createdAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(billing.claimCap !== undefined ? { claimCap: billing.claimCap } : {}),
      ...(billing.stripeCustomerId !== undefined ? { stripeCustomerId: billing.stripeCustomerId } : {}),
      ...(billing.metered !== undefined ? { metered: billing.metered } : {}),
      ...(billing.scopes !== undefined ? { scopes: billing.scopes } : {}),
    };
    this.keys.push(entry);
    this.hashes.set(entry.id, { keyHash: hashApiKey(key) });
    this.persist();
    return { ...entry, key };
  }

  list(): ApiKey[] {
    return this.keys.slice();
  }

  /** Remove without writing; callers write once. */
  private remove(id: string): boolean {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx === -1) return false;
    if (this.keys[idx].metered === true) this.revokedMetered.add(id);
    this.keys.splice(idx, 1);
    this.hashes.delete(id);
    return true;
  }

  delete(id: string): boolean {
    if (!this.remove(id)) return false;
    this.persist();
    return true;
  }

  /**
   * Delete multiple keys by ID in one operation.
   * Returns the IDs that were actually deleted (skips unknown IDs).
   */
  bulkDelete(ids: string[]): string[] {
    const deleted: string[] = [];
    for (const id of ids) {
      if (this.remove(id)) deleted.push(id);
    }
    if (deleted.length > 0) this.persist();
    return deleted;
  }

  /**
   * Disable multiple keys by ID.
   * Returns the IDs that were actually changed (already-disabled keys skipped).
   */
  bulkDisable(ids: string[]): string[] {
    const changed: string[] = [];
    for (const id of ids) {
      const entry = this.keys.find((k) => k.id === id);
      if (entry && !entry.disabled) {
        entry.disabled = true;
        changed.push(id);
      }
    }
    if (changed.length > 0) this.persist();
    return changed;
  }

  /**
   * Re-enable multiple keys by ID.
   * Returns the IDs that were actually changed (already-enabled keys skipped).
   */
  bulkEnable(ids: string[]): string[] {
    const changed: string[] = [];
    for (const id of ids) {
      const entry = this.keys.find((k) => k.id === id);
      if (entry && entry.disabled) {
        entry.disabled = false;
        changed.push(id);
      }
    }
    if (changed.length > 0) this.persist();
    return changed;
  }

  /**
   * Validates a raw key string by its SHA-256, compared in constant time.
   * Accepts both the current key and the previous key within the 24-hour grace window.
   * Returns null if the key is unknown or the grace period has expired.
   */
  validateKey(key: string): ApiKey | null {
    const now = new Date();
    const presented = Buffer.from(hashApiKey(key), 'hex');
    for (const entry of this.keys) {
      if (entry.disabled) continue;
      if (entry.expiresAt && new Date(entry.expiresAt) <= now) continue;
      const hashes = this.hashes.get(entry.id);
      if (!hashes) continue;

      const currentMatch = timingSafeEqual(presented, Buffer.from(hashes.keyHash, 'hex'));

      let previousMatch = false;
      if (hashes.previousKeyHash && entry.previousKeyExpiresAt && new Date(entry.previousKeyExpiresAt) > now) {
        previousMatch = timingSafeEqual(presented, Buffer.from(hashes.previousKeyHash, 'hex'));
      }

      if (currentMatch || previousMatch) {
        entry.lastUsedAt = now.toISOString();
        this.persistLastUsed();
        return entry;
      }
    }
    return null;
  }

  /**
   * Returns keys whose expiresAt falls within the next `days` days.
   * Excludes keys with no expiresAt (permanent) and already-expired keys.
   */
  getExpiringSoon(days: number): ApiKey[] {
    const now = new Date();
    const cutoff = new Date(Date.now() + days * 86_400_000);
    return this.keys.filter((k) => {
      if (!k.expiresAt) return false;
      const exp = new Date(k.expiresAt);
      return exp > now && exp <= cutoff;
    });
  }

  /**
   * Returns all keys that have not been used within the last `days` days.
   * A key is dormant when:
   *   - lastUsedAt is older than `days` days ago, OR
   *   - lastUsedAt is absent AND createdAt is older than `days` days ago.
   */
  getDormant(days: number): ApiKey[] {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    return this.keys.filter((k) => {
      const reference = k.lastUsedAt ?? k.createdAt;
      return new Date(reference) < cutoff;
    });
  }

  /**
   * Returns per-key usage statistics with derived hygiene flags.
   * No secrets are included (entries hold none).
   */
  getUsageStats(dormantDays = 30, expiringSoonDays = 7): KeyUsageStat[] {
    const now = Date.now();
    const msPerDay = 86_400_000;
    const daysSince = (iso: string) => Math.floor((now - new Date(iso).getTime()) / msPerDay);

    return this.keys.map((k) => {
      const isExpired = k.expiresAt ? new Date(k.expiresAt) <= new Date() : false;
      const isDormant = new Date(k.lastUsedAt ?? k.createdAt) < new Date(now - dormantDays * msPerDay);
      const isExpiringSoon = k.expiresAt
        ? !isExpired && new Date(k.expiresAt) <= new Date(now + expiringSoonDays * msPerDay)
        : false;

      return {
        id:                    k.id,
        name:                  k.name,
        permissions:           k.permissions,
        disabled:              k.disabled ?? false,
        createdAt:             k.createdAt,
        lastUsedAt:            k.lastUsedAt ?? null,
        lastRotatedAt:         k.lastRotatedAt ?? null,
        expiresAt:             k.expiresAt ?? null,
        daysSinceCreation:     daysSince(k.createdAt),
        daysSinceLastUse:      k.lastUsedAt ? daysSince(k.lastUsedAt) : null,
        daysSinceLastRotation: k.lastRotatedAt ? daysSince(k.lastRotatedAt) : null,
        isDormant,
        isExpiringSoon,
        isExpired,
      };
    });
  }

  /** True if the key has passed its expiresAt date. */
  isExpired(id: string): boolean {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry?.expiresAt) return false;
    return new Date(entry.expiresAt) <= new Date();
  }

  update(id: string, patch: {
    name?: string;
    permissions?: Permission[];
    expiresAt?: string | null;
    claimCap?: number | null;
    stripeCustomerId?: string | null;
    metered?: boolean;
    scopes?: KeyScope[];
  }): ApiKey | null {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) return null;
    if (patch.name !== undefined) entry.name = patch.name;
    if (patch.permissions !== undefined) entry.permissions = patch.permissions;
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt === null) {
        delete entry.expiresAt;
      } else {
        entry.expiresAt = patch.expiresAt;
      }
    }
    // null clears a billing field; a metered key with no claimCap is refused (claim_cap_unset).
    if (patch.claimCap === null) delete entry.claimCap;
    else if (patch.claimCap !== undefined) entry.claimCap = patch.claimCap;
    // A new customer id applies to rows committed from now on; past rows keep theirs.
    if (patch.stripeCustomerId === null) delete entry.stripeCustomerId;
    else if (patch.stripeCustomerId !== undefined) entry.stripeCustomerId = patch.stripeCustomerId;
    if (patch.metered !== undefined) entry.metered = patch.metered;
    if (patch.scopes !== undefined) entry.scopes = patch.scopes;
    this.persist();
    return entry;
  }

  disable(id: string): boolean {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) return false;
    entry.disabled = true;
    this.persist();
    return true;
  }

  enable(id: string): boolean {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) return false;
    entry.disabled = false;
    this.persist();
    return true;
  }

  validateById(id: string): ApiKey | null {
    return this.keys.find((k) => k.id === id) ?? null;
  }

  /**
   * Rotate the key for the given id.
   * Generates a new key; the old key's hash stays accepted for 24 hours.
   * Returns the rotation result (newKey shown once — caller must relay to user;
   * previousKey is the old key's prefix only). Returns null if id not found.
   */
  rotate(id: string): RotationResult | null {
    const entry = this.keys.find((k) => k.id === id);
    const hashes = this.hashes.get(id);
    if (!entry || !hashes) return null;

    const oldPrefix = entry.keyPrefix;
    const newKey = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ROTATION_GRACE_HOURS * 3_600_000).toISOString();

    this.hashes.set(id, { keyHash: hashApiKey(newKey), previousKeyHash: hashes.keyHash });
    entry.keyPrefix = newKey.slice(0, KEY_PREFIX_LENGTH);
    entry.previousKeyExpiresAt = expiresAt;
    entry.lastRotatedAt = new Date().toISOString();
    this.persist();

    return {
      id,
      newKey,
      previousKey:          oldPrefix,
      previousKeyExpiresAt: expiresAt,
      gracePeriodHours:     ROTATION_GRACE_HOURS,
    };
  }

  /** Remove expired previous-key hashes. Returns count of entries cleaned. */
  cleanExpiredRotations(): number {
    const now = new Date();
    let cleaned = 0;
    for (const entry of this.keys) {
      if (entry.previousKeyExpiresAt && new Date(entry.previousKeyExpiresAt) <= now) {
        const hashes = this.hashes.get(entry.id);
        if (hashes) delete hashes.previousKeyHash;
        delete entry.previousKeyExpiresAt;
        cleaned++;
      }
    }
    if (cleaned > 0) this.persist();
    return cleaned;
  }

  /** True if the key id currently has an active grace-period key. */
  isInGracePeriod(id: string): boolean {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry?.previousKeyExpiresAt) return false;
    return new Date(entry.previousKeyExpiresAt) > new Date();
  }

  get size(): number {
    return this.keys.length;
  }
}

let instance: KeyStore | null = null;

export function getKeyStore(): KeyStore {
  if (!instance) instance = new KeyStore();
  return instance;
}

/** Replace the store with a new one loaded from the keystore file, as a restart does. */
export function resetKeyStore(): void {
  instance?.dispose();
  instance = new KeyStore();
}
