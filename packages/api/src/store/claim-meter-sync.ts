import { getKeyStore } from './keys.js';
import { getClaimMeter, type ClaimMeter, type ClaimMeterRow } from './claim-meter.js';

/**
 * claim-meter-sync.ts — report committed claims to Stripe Billing meters
 * (node 1.18.11.7.6). Stripe holds the meter and the price; this module only
 * binds ledger rows to meter events.
 *
 * One ledger row is one meter event: `event_name` from
 * FAULTLINE_STRIPE_METER_EVENT, `payload[stripe_customer_id]` from the key,
 * `payload[value]=1`, `identifier` = the ledger identifier (`scanId:claimId`),
 * `timestamp` = when the claim was committed. Stripe dedupes events by
 * `identifier`, and every request also carries an Idempotency-Key derived from
 * it, so a retry after a lost response never double-reports.
 *
 * A row is marked sent (claim-meter-sync.jsonl) only after Stripe answers 2xx.
 * Network errors, 429 and 5xx are retried with exponential backoff; a pass
 * stops at the first row that still fails, so an outage does not hammer Stripe.
 * A 4xx rejection leaves that row unsent and moves on. Rows of keys with no
 * `stripeCustomerId` wait. With STRIPE_SECRET_KEY or the event name unset the
 * sink is off and every row waits. Stripe accepts only recent timestamps, so
 * admin GET /usage shows how many rows wait and how old the oldest is.
 */

export const STRIPE_METER_EVENTS_URL = 'https://api.stripe.com/v1/billing/meter_events';
export const METER_EVENT_NAME_ENV = 'FAULTLINE_STRIPE_METER_EVENT';

const SYNC_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_BATCH_SIZE = 500;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface StripeMeterSinkOptions {
  fetch?: FetchLike;
  secretKey?: string | null;
  eventName?: string | null;
  meter?: ClaimMeter;
  customerIdFor?: (keyId: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  batchSize?: number;
  now?: () => Date;
}

export interface FlushReport {
  sent: number;
  rejected: number;
  /** Rows left for a later pass: unmapped keys, a pass stopped by an outage, or the batch limit. */
  waiting: number;
  stoppedOnError: boolean;
}

export interface MeterSinkStatus {
  enabled: boolean;
  eventName: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  sentTotal: number;
  rejectedTotal: number;
}

const envValue = (name: string): string | null => {
  const raw = (process.env[name] ?? '').trim();
  return raw === '' ? null : raw;
};

/** The meter event's form body for one ledger row. */
export function meterEventForm(row: ClaimMeterRow, customerId: string, eventName: string): URLSearchParams {
  const form = new URLSearchParams();
  form.set('event_name', eventName);
  form.set('timestamp', String(Math.floor(Date.parse(row.ts) / 1000)));
  form.set('identifier', row.identifier);
  form.set('payload[stripe_customer_id]', customerId);
  form.set('payload[value]', '1');
  return form;
}

const defaultCustomerIdFor = (keyId: string): string | undefined => getKeyStore().validateById(keyId)?.stripeCustomerId;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (status: number): boolean => status === 429 || status >= 500;

type SendOutcome = 'sent' | 'rejected' | 'failed';

export class StripeMeterSink {
  private readonly fetchFn: FetchLike | undefined;
  private readonly secretKey: string | null;
  private readonly eventName: string | null;
  private readonly meter: ClaimMeter;
  private readonly customerIdFor: (keyId: string) => string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private flushing: Promise<FlushReport> | null = null;
  private status: Omit<MeterSinkStatus, 'enabled' | 'eventName'> = {
    lastSyncAt: null, lastError: null, sentTotal: 0, rejectedTotal: 0,
  };

  constructor(options: StripeMeterSinkOptions = {}) {
    this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    this.secretKey = options.secretKey !== undefined ? options.secretKey : envValue('STRIPE_SECRET_KEY');
    this.eventName = options.eventName !== undefined ? options.eventName : envValue(METER_EVENT_NAME_ENV);
    this.meter = options.meter ?? getClaimMeter();
    this.customerIdFor = options.customerIdFor ?? defaultCustomerIdFor;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.now = options.now ?? (() => new Date());
  }

  /** True when the secret, the event name and a fetch are all present. */
  enabled(): boolean {
    return this.secretKey !== null && this.eventName !== null && typeof this.fetchFn === 'function';
  }

  getStatus(): MeterSinkStatus {
    return { enabled: this.enabled(), eventName: this.eventName, ...this.status };
  }

  /** Send waiting rows. Overlapping calls share one pass. Off: sends nothing. */
  flush(): Promise<FlushReport> {
    if (!this.flushing) this.flushing = this.runPass().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async runPass(): Promise<FlushReport> {
    const rows = this.meter.unsentRows();
    const report: FlushReport = { sent: 0, rejected: 0, waiting: rows.length, stoppedOnError: false };
    if (!this.enabled()) return report;
    let attempted = 0;
    for (const row of rows) {
      if (attempted >= this.batchSize) break;
      const customerId = this.customerIdFor(row.keyId);
      if (!customerId) continue;
      attempted += 1;
      const outcome = await this.send(row, customerId);
      if (outcome === 'failed') { report.stoppedOnError = true; break; }
      if (outcome === 'sent') report.sent += 1;
      else report.rejected += 1;
    }
    report.waiting = rows.length - report.sent;
    this.status.lastSyncAt = this.now().toISOString();
    this.status.sentTotal += report.sent;
    this.status.rejectedTotal += report.rejected;
    return report;
  }

  /** POST one event, retrying network errors, 429 and 5xx with backoff. */
  private async send(row: ClaimMeterRow, customerId: string): Promise<SendOutcome> {
    const body = meterEventForm(row, customerId, this.eventName as string).toString();
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      let status: number;
      try {
        const res = await (this.fetchFn as FetchLike)(STRIPE_METER_EVENTS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': `claim-meter-${row.identifier}`,
          },
          body,
        });
        status = res.status;
        if (status >= 200 && status < 300) {
          this.meter.markSent(row.identifier, this.now());
          return 'sent';
        }
        this.status.lastError = `stripe ${status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      } catch (err) {
        // Never log the request: it carries the secret in a header only, but keep the message short.
        this.status.lastError = `network: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
        continue;
      }
      if (!isRetryable(status)) return 'rejected';
    }
    return 'failed';
  }
}

let sink: StripeMeterSink | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function getStripeMeterSink(): StripeMeterSink {
  if (!sink) sink = new StripeMeterSink();
  return sink;
}

/** Drop the sink (tests, env changes). */
export function resetStripeMeterSink(): void {
  stopClaimMeterSync();
  sink = null;
}

/** Flush every SYNC_INTERVAL_MS while the sink is enabled. A no-op when it is off. */
export function startClaimMeterSync(): void {
  if (timer || !getStripeMeterSink().enabled()) return;
  timer = setInterval(() => { void getStripeMeterSink().flush().catch(() => undefined); }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopClaimMeterSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
