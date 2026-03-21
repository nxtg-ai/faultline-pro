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

  create(name: string, permissions: Permission[] = ['scan']): ApiKey {
    const entry: ApiKey = {
      id: randomUUID(),
      key: randomBytes(32).toString('hex'),
      name,
      permissions,
      createdAt: new Date().toISOString(),
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
   * Validates a raw key string.
   * Accepts both the current key and the previous key within the 24-hour grace window.
   * Returns null if the key is unknown or the grace period has expired.
   */
  validateKey(key: string): ApiKey | null {
    const now = new Date();
    for (const entry of this.keys) {
      if (entry.disabled) continue;
      if (entry.key === key) return entry;
      if (
        entry.previousKey === key &&
        entry.previousKeyExpiresAt &&
        new Date(entry.previousKeyExpiresAt) > now
      ) {
        return entry;
      }
    }
    return null;
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
