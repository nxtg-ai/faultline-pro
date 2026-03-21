/**
 * Notification Store — configurable per-API-key event notifications.
 *
 * Event types:
 *   scan.failed          — a scan request returned an error (all providers failed)
 *   weekly.summary       — weekly usage digest (sent every Sunday 09:00 UTC)
 *   provider.available   — a previously-unavailable provider comes back online
 *   provider.unavailable — a provider circuit-breaker opens
 *   subscription.changed — API key tier/permissions updated
 *   rate_limit.warning   — key reaches 80% of rate limit (integrates with rate-alerts)
 *   key.expiring_soon   — key expiresAt within 7 days (threshold=7d) or 1 day (threshold=1d)
 *
 * Delivery:
 *   webhook — POST JSON to a URL (same pattern as jobs/rate-alerts)
 *   No built-in SMTP: users connect a webhook to an email relay
 *     (Resend, SendGrid, Postmark, Zapier, Make.com, etc.)
 *
 * Per-key configuration: each API key can opt into any subset of events
 * and provide their own delivery URL.  A global fallback (FAULTLINE_NOTIFY_WEBHOOK)
 * is used when no per-key config exists for a subscribed event.
 */

import { randomUUID } from 'node:crypto';
import { getTenantStore } from './tenants.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type NotificationEventType =
  | 'scan.failed'
  | 'weekly.summary'
  | 'provider.available'
  | 'provider.unavailable'
  | 'subscription.changed'
  | 'rate_limit.warning'
  | 'key.expiring_soon'
  | 'key.rotation_due';

export const ALL_EVENT_TYPES: NotificationEventType[] = [
  'scan.failed',
  'weekly.summary',
  'provider.available',
  'provider.unavailable',
  'subscription.changed',
  'rate_limit.warning',
  'key.expiring_soon',
  'key.rotation_due',
];

/** Human-readable metadata for each event type. Authoritative single source of truth. */
export const EVENT_CATALOGUE: Record<NotificationEventType, { description: string; example: Record<string, unknown> }> = {
  'scan.failed':          { description: 'Fired when a scan request fails across all providers.',                                  example: { error: 'Rate limit exceeded', provider: 'gemini' } },
  'weekly.summary':       { description: 'Sent every Sunday at 09:00 UTC with a usage digest.',                                    example: { scanCount: 42, errorCount: 1, topProvider: 'gemini' } },
  'provider.available':   { description: 'Fired when a circuit-broken provider comes back online.',                                example: { provider: 'openai', available: true } },
  'provider.unavailable': { description: 'Fired when a provider circuit-breaker opens.',                                           example: { provider: 'openai', available: false } },
  'subscription.changed': { description: "Fired when an API key's tier or permissions are updated.",                               example: { change: 'tier_upgrade', oldTier: 'free', newTier: 'pro' } },
  'rate_limit.warning':   { description: 'Fired when an API key reaches 80% of its per-minute rate limit.',                       example: { used: 8, limit: 10, pct: 80 } },
  'key.expiring_soon':    { description: "Fired when a key's expiresAt is within 7 days (threshold=7d) or 1 day (threshold=1d).", example: { keyId: 'abc', keyName: 'My Key', hoursRemaining: 24, threshold: '1d' } },
  'key.rotation_due':     { description: "Fired when a key has not been rotated in 90 days (threshold=90d) or 180 days (threshold=180d). Uses lastRotatedAt if available, otherwise createdAt.", example: { keyId: 'abc', keyName: 'My Key', daysSinceRotation: 95, threshold: '90d' } },
};

export interface NotificationPrefs {
  keyId:       string;
  events:      NotificationEventType[];
  webhookUrl:  string | null;
  email:       string | null;  // informational only — stored for display
  updatedAt:   string;
}

export interface NotificationRecord {
  id:          string;
  keyId:       string;
  tenantId:    string | undefined;
  eventType:   NotificationEventType;
  payload:     Record<string, unknown>;
  timestamp:   string;
  delivered:   boolean;
  deliveryUrl: string | null;
  error:       string | null;
}

// ── Store ──────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 5_000;

class NotificationStore {
  private prefs: Map<string, NotificationPrefs> = new Map();
  private history: NotificationRecord[] = [];

  // ── Prefs CRUD ───────────────────────────────────────────────────────────────

  getPrefs(keyId: string): NotificationPrefs | undefined {
    return this.prefs.get(keyId);
  }

  setPrefs(keyId: string, events: NotificationEventType[], webhookUrl: string | null, email: string | null): NotificationPrefs {
    const prefs: NotificationPrefs = {
      keyId,
      events,
      webhookUrl,
      email,
      updatedAt: new Date().toISOString(),
    };
    this.prefs.set(keyId, prefs);
    return prefs;
  }

  deletePrefs(keyId: string): boolean {
    return this.prefs.delete(keyId);
  }

  /** Deletes notification prefs for a set of keyIds (e.g. all keys in a tenant). Returns count deleted. */
  deletePrefsForKeys(keyIds: string[]): number {
    let count = 0;
    for (const keyId of keyIds) {
      if (this.prefs.delete(keyId)) count++;
    }
    return count;
  }

  listPrefs(): NotificationPrefs[] {
    return Array.from(this.prefs.values());
  }

  // ── History ──────────────────────────────────────────────────────────────────

  getHistory(keyId?: string, limit = 100, tenantId?: string): NotificationRecord[] {
    let all = keyId ? this.history.filter(r => r.keyId === keyId) : this.history.slice();
    if (tenantId) all = all.filter(r => r.tenantId === tenantId);
    return all.slice(0, limit);
  }

  /** Deletes all notification history entries for a specific tenant. Returns count deleted. */
  deleteTenantHistory(tenantId: string): number {
    const before = this.history.length;
    this.history = this.history.filter((r) => r.tenantId !== tenantId);
    return before - this.history.length;
  }

  private pushRecord(record: NotificationRecord): void {
    this.history.unshift(record);
    if (this.history.length > MAX_HISTORY) this.history.pop();
  }

  // ── Delivery ─────────────────────────────────────────────────────────────────

  /**
   * Deliver an event to all subscribers.
   * keyId = '*' means broadcast to all keys subscribed to this event type.
   * keyId = a specific key ID means deliver only to that key.
   */
  async dispatch(
    eventType: NotificationEventType,
    payload: Record<string, unknown>,
    targetKeyId?: string,
  ): Promise<void> {
    const targets = targetKeyId
      ? (this.prefs.get(targetKeyId) ? [this.prefs.get(targetKeyId)!] : [])
      : Array.from(this.prefs.values()).filter(p => p.events.includes(eventType));

    // Also include global fallback (FAULTLINE_NOTIFY_WEBHOOK) for broadcast events
    const globalWebhook = process.env.FAULTLINE_NOTIFY_WEBHOOK;
    const hasFallback = !targetKeyId && !!globalWebhook && targets.length === 0;

    if (hasFallback) {
      // Fire to global webhook with a synthetic '*' keyId
      await this._deliver('*', eventType, payload, globalWebhook);
      return;
    }

    for (const pref of targets) {
      if (!pref.events.includes(eventType)) continue;
      const url = pref.webhookUrl ?? globalWebhook ?? null;
      await this._deliver(pref.keyId, eventType, payload, url);
    }
  }

  private async _deliver(
    keyId: string,
    eventType: NotificationEventType,
    payload: Record<string, unknown>,
    webhookUrl: string | null,
  ): Promise<void> {
    const tenantId = keyId !== '*' ? getTenantStore().findByKeyId(keyId)?.id : undefined;
    const record: NotificationRecord = {
      id:          randomUUID(),
      keyId,
      tenantId,
      eventType,
      payload,
      timestamp:   new Date().toISOString(),
      delivered:   false,
      deliveryUrl: webhookUrl,
      error:       null,
    };

    if (webhookUrl) {
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: eventType, keyId, ...payload }),
        });
        record.delivered = res.ok;
        if (!res.ok) record.error = `HTTP ${res.status}`;
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
      }
    } else {
      record.error = 'no-webhook-configured';
    }

    this.pushRecord(record);
  }

  reset(): void {
    this.prefs = new Map();
    this.history = [];
  }
}

let instance: NotificationStore | null = null;

export function getNotificationStore(): NotificationStore {
  if (!instance) instance = new NotificationStore();
  return instance;
}

export function resetNotificationStore(): void {
  instance = new NotificationStore();
}

// ── Convenience dispatchers ───────────────────────────────────────────────────

export async function notifyScanFailed(keyId: string, error: string, provider: string): Promise<void> {
  await getNotificationStore().dispatch('scan.failed', { keyId, error, provider }, keyId).catch(() => undefined);
}

export async function notifyProviderStatus(provider: string, available: boolean): Promise<void> {
  const eventType: NotificationEventType = available ? 'provider.available' : 'provider.unavailable';
  await getNotificationStore().dispatch(eventType, { provider, available, timestamp: new Date().toISOString() }).catch(() => undefined);
}

export async function notifySubscriptionChanged(keyId: string, change: Record<string, unknown>): Promise<void> {
  await getNotificationStore().dispatch('subscription.changed', { keyId, ...change }, keyId).catch(() => undefined);
}

export async function notifyWeeklySummary(summaries: Array<{ keyId: string; scanCount: number; errorCount: number; topProvider: string }>): Promise<void> {
  for (const summary of summaries) {
    await getNotificationStore().dispatch('weekly.summary', { ...summary, week: new Date().toISOString().slice(0, 10) }, summary.keyId).catch(() => undefined);
  }
}
