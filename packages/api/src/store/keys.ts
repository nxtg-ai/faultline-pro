import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type Permission = 'scan' | 'report' | 'upload' | 'admin' | 'pro';

/** Scopes a key may hold. Admin keys pass every scope without holding any. */
export const KEY_SCOPES = ['usage:read', 'keys:write'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Longest accepted `Idempotency-Key` header on POST /keys. */
export const MAX_KEY_IDEMPOTENCY_KEY_LENGTH = 200;

const DEFAULT_IDEMPOTENCY_LEDGER_PATH = '/var/log/faultline/key-idempotency.jsonl';

/**
 * Where the POST /keys Idempotency-Key map is kept. `FAULTLINE_KEY_IDEMPOTENCY_LEDGER`
 * overrides. The keystore itself lives in memory; this file sits on the ledger
 * volume so a deploy does not forget which header values already minted a key.
 * It holds a SHA-256 of each header value and the key id, never key material.
 */
export function keyIdempotencyLedgerPath(): string {
  const raw = (process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_IDEMPOTENCY_LEDGER_PATH : raw;
}

const hashIdempotencyKey = (value: string): string => createHash('sha256').update(value).digest('hex');

export const ROTATION_GRACE_HOURS = 24;

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  permissions: Permission[];
  createdAt: string;
  /** When true, key is rejected at auth time without deletion */
  disabled?: boolean;
  /** Previous key value — still accepted until previousKeyExpiresAt */
  previousKey?: string;
  /** ISO datetime when previousKey stops being accepted */
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
  newKey:               string;
  previousKey:          string;
  previousKeyExpiresAt: string;
  gracePeriodHours:     number;
}

class KeyStore {
  private keys: ApiKey[] = [];
  /** Ids of metered keys that were deleted, so background work they queued is refused, not run free. */
  private revokedMetered = new Set<string>();
  /** SHA-256 of a POST /keys Idempotency-Key value -> the key id it minted. */
  private idempotency = new Map<string, string>();
  private idempotencyWriteFailures = 0;

  constructor() {
    this.hydrateIdempotency();
  }

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

  /** True when `id` was a metered key that has since been deleted. */
  wasRevokedMetered(id: string): boolean {
    return this.revokedMetered.has(id);
  }

  create(name: string, permissions: Permission[] = ['scan'], expiresAt?: string, billing: KeyBillingFields = {}): ApiKey {
    const entry: ApiKey = {
      id: randomUUID(),
      key: randomBytes(32).toString('hex'),
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
    return entry;
  }

  list(): ApiKey[] {
    return this.keys.slice();
  }

  delete(id: string): boolean {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx === -1) return false;
    if (this.keys[idx].metered === true) this.revokedMetered.add(id);
    this.keys.splice(idx, 1);
    return true;
  }

  /**
   * Delete multiple keys by ID in one operation.
   * Returns the IDs that were actually deleted (skips unknown IDs).
   */
  bulkDelete(ids: string[]): string[] {
    const deleted: string[] = [];
    for (const id of ids) {
      if (this.delete(id)) deleted.push(id);
    }
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
    return changed;
  }

  /**
   * Validates a raw key string.
   * Accepts both the current key and the previous key within the 24-hour grace window.
   * Returns null if the key is unknown or the grace period has expired.
   */
  validateKey(key: string): ApiKey | null {
    const now = new Date();
    const keyBuf = Buffer.from(key);
    for (const entry of this.keys) {
      if (entry.disabled) continue;
      if (entry.expiresAt && new Date(entry.expiresAt) <= now) continue;

      const currentBuf = Buffer.from(entry.key);
      const currentMatch = keyBuf.length === currentBuf.length && timingSafeEqual(keyBuf, currentBuf);

      let previousMatch = false;
      if (entry.previousKey && entry.previousKeyExpiresAt && new Date(entry.previousKeyExpiresAt) > now) {
        const prevBuf = Buffer.from(entry.previousKey);
        previousMatch = keyBuf.length === prevBuf.length && timingSafeEqual(keyBuf, prevBuf);
      }

      if (currentMatch || previousMatch) {
        entry.lastUsedAt = now.toISOString();
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
   * No secrets (key, previousKey) are included.
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
    return entry;
  }

  disable(id: string): boolean {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) return false;
    entry.disabled = true;
    return true;
  }

  enable(id: string): boolean {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) return false;
    entry.disabled = false;
    return true;
  }

  validateById(id: string): ApiKey | null {
    return this.keys.find((k) => k.id === id) ?? null;
  }

  /**
   * Rotate the key for the given id.
   * Generates a new key, stores the old key as previousKey with a 24-hour expiry.
   * Returns the rotation result (newKey shown once — caller must relay to user).
   * Returns null if id not found.
   */
  rotate(id: string): RotationResult | null {
    const entry = this.keys.find((k) => k.id === id);
    if (!entry) return null;

    const oldKey = entry.key;
    const newKey = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ROTATION_GRACE_HOURS * 3_600_000).toISOString();

    entry.key = newKey;
    entry.previousKey = oldKey;
    entry.previousKeyExpiresAt = expiresAt;
    entry.lastRotatedAt = new Date().toISOString();

    return {
      id,
      newKey,
      previousKey:          oldKey,
      previousKeyExpiresAt: expiresAt,
      gracePeriodHours:     ROTATION_GRACE_HOURS,
    };
  }

  /** Remove expired previousKey entries. Returns count of entries cleaned. */
  cleanExpiredRotations(): number {
    const now = new Date();
    let cleaned = 0;
    for (const entry of this.keys) {
      if (entry.previousKeyExpiresAt && new Date(entry.previousKeyExpiresAt) <= now) {
        delete entry.previousKey;
        delete entry.previousKeyExpiresAt;
        cleaned++;
      }
    }
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

export function resetKeyStore(): void {
  instance = new KeyStore();
}
