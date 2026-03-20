/**
 * Rate Limit Alert Store — tracks approaching-limit events and delivers notifications.
 *
 * Alert threshold: 80% of limit consumed in the current minute window.
 *
 * Delivery:
 *   1. Always stored in memory (visible on /rate-limits dashboard).
 *   2. If FAULTLINE_ALERT_WEBHOOK is set, a JSON POST is sent to that URL.
 *      (Webhook can be a Slack incoming webhook, Zapier/Make.com trigger, or
 *       any HTTP endpoint including an email relay.)
 *   3. Console warning is always emitted.
 *
 * Deduplication: one alert per keyId per minute window. Repeated requests in
 * the same window that stay above the threshold do not re-fire the alert.
 */

export const ALERT_THRESHOLD_PCT = 80;
const MAX_ALERTS = 1_000;

export interface RateLimitAlert {
  keyId:        string;
  used:         number;
  limit:        number;
  pct:          number;
  timestamp:    string;
  windowKey:    string;    // YYYY-MM-DDTHH:mm — deduplication key
  delivered:    boolean;
  deliveryNote: string;    // 'webhook' | 'console-only' | 'error: ...'
}

class RateLimitAlertStore {
  private alerts: RateLimitAlert[] = [];
  /** keyId → last windowKey for which an alert was fired */
  private lastFired: Map<string, string> = new Map();

  private windowKey(): string {
    return new Date().toISOString().slice(0, 16);
  }

  shouldAlert(keyId: string, used: number, limit: number): boolean {
    if (limit <= 0) return false;
    const pct = (used / limit) * 100;
    if (pct < ALERT_THRESHOLD_PCT) return false;
    const wk = this.windowKey();
    return this.lastFired.get(keyId) !== wk;
  }

  async fire(keyId: string, used: number, limit: number): Promise<void> {
    const wk = this.windowKey();
    this.lastFired.set(keyId, wk);
    const pct = Math.round((used / limit) * 100);
    const alert: RateLimitAlert = {
      keyId,
      used,
      limit,
      pct,
      timestamp: new Date().toISOString(),
      windowKey: wk,
      delivered: false,
      deliveryNote: 'console-only',
    };

    console.warn(`[RateAlert] ${keyId} at ${pct}% of limit (${used}/${limit}) — window ${wk}`);

    const webhookUrl = process.env.FAULTLINE_ALERT_WEBHOOK;
    if (webhookUrl) {
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'rate_limit_warning',
            keyId,
            used,
            limit,
            pct,
            window: wk,
            message: `API key ${keyId} is at ${pct}% of its rate limit (${used}/${limit} requests in the current minute window).`,
          }),
        });
        alert.delivered = res.ok;
        alert.deliveryNote = res.ok ? 'webhook' : `error: HTTP ${res.status}`;
      } catch (err) {
        alert.deliveryNote = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.pop();
  }

  getAlerts(): RateLimitAlert[] {
    return this.alerts.slice();
  }

  reset(): void {
    this.alerts = [];
    this.lastFired = new Map();
  }
}

let instance: RateLimitAlertStore | null = null;

export function getRateLimitAlertStore(): RateLimitAlertStore {
  if (!instance) instance = new RateLimitAlertStore();
  return instance;
}

export function resetRateLimitAlertStore(): void {
  instance = new RateLimitAlertStore();
}

/** Convenience: check threshold and fire alert if needed. */
export async function checkAndAlert(keyId: string, used: number, limit: number): Promise<void> {
  const store = getRateLimitAlertStore();
  if (store.shouldAlert(keyId, used, limit)) {
    await store.fire(keyId, used, limit);
  }
}
