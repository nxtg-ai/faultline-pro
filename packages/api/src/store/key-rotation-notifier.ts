/**
 * KeyRotationNotifier — dispatches key.rotation_due notifications.
 *
 * Called on the server's 1-minute tick. Checks all keys for overdue rotation
 * and fires at two thresholds: 90 days and 180 days. Each threshold fires at
 * most once per key per server lifetime (deduplication via in-memory Set).
 *
 * Rotation age is measured from lastRotatedAt if set, otherwise from createdAt.
 *
 * Skips: disabled keys, already-expired keys.
 */

import { getKeyStore } from './keys.js';
import { getNotificationStore } from './notifications.js';

const THRESHOLD_90D_MS  = 90  * 24 * 3_600_000;
const THRESHOLD_180D_MS = 180 * 24 * 3_600_000;

export class KeyRotationNotifier {
  /** Tracks which (keyId, threshold) pairs have already been dispatched. */
  private fired: Set<string> = new Set();

  check(): void {
    const now = Date.now();
    const store = getKeyStore();

    for (const entry of store.list()) {
      if (entry.disabled) continue;
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now) continue; // expired

      // Use lastRotatedAt if available, otherwise fall back to createdAt
      const referenceDate = entry.lastRotatedAt ?? entry.createdAt;
      const ageMs = now - new Date(referenceDate).getTime();

      // 90-day threshold — key rotation overdue
      if (ageMs >= THRESHOLD_90D_MS) {
        const key90d = `${entry.id}:90d`;
        if (!this.fired.has(key90d)) {
          this.fired.add(key90d);
          void getNotificationStore()
            .dispatch(
              'key.rotation_due',
              {
                keyId:             entry.id,
                keyName:           entry.name,
                lastRotatedAt:     entry.lastRotatedAt ?? null,
                daysSinceRotation: Math.floor(ageMs / 86_400_000),
                threshold:         '90d',
              },
              entry.id,
            )
            .catch(() => undefined);
        }
      }

      // 180-day threshold — critically overdue
      if (ageMs >= THRESHOLD_180D_MS) {
        const key180d = `${entry.id}:180d`;
        if (!this.fired.has(key180d)) {
          this.fired.add(key180d);
          void getNotificationStore()
            .dispatch(
              'key.rotation_due',
              {
                keyId:             entry.id,
                keyName:           entry.name,
                lastRotatedAt:     entry.lastRotatedAt ?? null,
                daysSinceRotation: Math.floor(ageMs / 86_400_000),
                threshold:         '180d',
              },
              entry.id,
            )
            .catch(() => undefined);
        }
      }
    }
  }

  /** Clear dedup state — used in tests to simulate a fresh server. */
  reset(): void {
    this.fired.clear();
  }
}

let instance: KeyRotationNotifier | null = null;

export function getKeyRotationNotifier(): KeyRotationNotifier {
  if (!instance) instance = new KeyRotationNotifier();
  return instance;
}

export function resetKeyRotationNotifier(): void {
  instance = new KeyRotationNotifier();
}
