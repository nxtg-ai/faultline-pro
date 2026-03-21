import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';

export type Permission = 'scan' | 'report' | 'upload' | 'admin' | 'pro';

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

  create(name: string, permissions: Permission[] = ['scan'], expiresAt?: string): ApiKey {
    const entry: ApiKey = {
      id: randomUUID(),
      key: randomBytes(32).toString('hex'),
      name,
      permissions,
      createdAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
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
    for (const entry of this.keys) {
      if (entry.disabled) continue;
      if (entry.expiresAt && new Date(entry.expiresAt) <= now) continue;
      if (entry.key === key || (
        entry.previousKey === key &&
        entry.previousKeyExpiresAt &&
        new Date(entry.previousKeyExpiresAt) > now
      )) {
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

  update(id: string, patch: { name?: string; permissions?: Permission[]; expiresAt?: string | null }): ApiKey | null {
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
