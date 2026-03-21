import { createHmac, randomBytes, randomUUID } from 'node:crypto';

export type WebhookEvent = 'scan.complete' | 'scan.failed' | 'job.complete' | 'job.failed' | 'claim.verdict_changed' | 'compliance.deadline_approaching';

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  tenantId: string | undefined;
  /** Max delivery attempts per event (1–5, default 3). */
  maxAttempts: number;
  /** Delay in ms between retry attempts (0–30 000, default 500). First attempt always immediate. */
  retryDelayMs: number;
  createdAt: string;
}

export type WebhookPublic = Omit<Webhook, 'secret'>;

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: unknown;
}

// ─── Sleep / backoff engine ────────────────────────────────────────────────

type SleepFn = (ms: number) => Promise<void>;
let _sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function _setSleepFn(fn: SleepFn): void { _sleep = fn; }

// ─── Per-webhook rate limiter ──────────────────────────────────────────────

const WINDOW_MS = 60_000; // 1-minute sliding window

export class WebhookRateLimiter {
  private windows: Map<string, { count: number; windowStart: number }> = new Map();
  readonly limitPerMinute: number;

  constructor(limitPerMinute?: number) {
    this.limitPerMinute = limitPerMinute
      ?? Math.max(1, parseInt(process.env.FAULTLINE_WEBHOOK_RATE_LIMIT ?? '60', 10) || 60);
  }

  /**
   * Returns true if this dispatch is within the rate limit for the given webhookId.
   * Advances the counter if allowed; does not advance if denied.
   */
  check(webhookId: string, nowMs = Date.now()): boolean {
    const entry = this.windows.get(webhookId);
    if (!entry || nowMs - entry.windowStart >= WINDOW_MS) {
      this.windows.set(webhookId, { count: 1, windowStart: nowMs });
      return true;
    }
    if (entry.count >= this.limitPerMinute) return false;
    entry.count++;
    return true;
  }

  /** Reset counters — optionally scoped to one webhook. */
  reset(webhookId?: string): void {
    if (webhookId) this.windows.delete(webhookId);
    else this.windows.clear();
  }

  /** Peek at current window count without advancing. */
  count(webhookId: string, nowMs = Date.now()): number {
    const entry = this.windows.get(webhookId);
    if (!entry || nowMs - entry.windowStart >= WINDOW_MS) return 0;
    return entry.count;
  }
}

let rateLimiterInstance: WebhookRateLimiter | null = null;
export function getWebhookRateLimiter(): WebhookRateLimiter {
  if (!rateLimiterInstance) rateLimiterInstance = new WebhookRateLimiter();
  return rateLimiterInstance;
}
export function resetWebhookRateLimiter(): void {
  rateLimiterInstance = new WebhookRateLimiter();
}

// ─── HMAC signing ──────────────────────────────────────────────────────────

function signPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ─── Circuit breaker ──────────────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS       = 60_000;

interface CircuitEntry {
  failures:  number;
  openedAt?: number; // Date.now() when circuit tripped
}

export class WebhookCircuitBreaker {
  private circuits: Map<string, CircuitEntry> = new Map();
  readonly failureThreshold: number;
  readonly cooldownMs:       number;

  constructor(failureThreshold?: number, cooldownMs?: number) {
    this.failureThreshold = failureThreshold
      ?? Math.max(1, parseInt(process.env.FAULTLINE_WEBHOOK_CIRCUIT_THRESHOLD ?? String(DEFAULT_FAILURE_THRESHOLD), 10) || DEFAULT_FAILURE_THRESHOLD);
    this.cooldownMs = cooldownMs
      ?? Math.max(1000, parseInt(process.env.FAULTLINE_WEBHOOK_CIRCUIT_COOLDOWN_MS ?? String(DEFAULT_COOLDOWN_MS), 10) || DEFAULT_COOLDOWN_MS);
  }

  /**
   * Returns true when the circuit is OPEN (dispatches should be suppressed).
   * Auto-recovers to CLOSED after the cooldown window passes.
   */
  isOpen(webhookId: string, nowMs = Date.now()): boolean {
    const entry = this.circuits.get(webhookId);
    if (!entry?.openedAt) return false;
    if (nowMs - entry.openedAt >= this.cooldownMs) {
      // Cooldown elapsed — auto-recover
      entry.failures  = 0;
      entry.openedAt  = undefined;
      return false;
    }
    return true;
  }

  /** Call after every failed delivery attempt (all retries exhausted). */
  recordFailure(webhookId: string, nowMs = Date.now()): void {
    const entry = this.circuits.get(webhookId) ?? { failures: 0 };
    entry.failures++;
    if (entry.failures >= this.failureThreshold && !entry.openedAt) {
      entry.openedAt = nowMs;
    }
    this.circuits.set(webhookId, entry);
  }

  /** Call after a successful delivery. Resets the failure counter. */
  recordSuccess(webhookId: string): void {
    this.circuits.delete(webhookId);
  }

  /** Returns the current consecutive failure count (0 if no entry). */
  failureCount(webhookId: string): number {
    return this.circuits.get(webhookId)?.failures ?? 0;
  }

  /** Clear circuit state — optionally scoped to one webhook. */
  reset(webhookId?: string): void {
    if (webhookId) this.circuits.delete(webhookId);
    else this.circuits.clear();
  }
}

let circuitBreakerInstance: WebhookCircuitBreaker | null = null;
export function getWebhookCircuitBreaker(): WebhookCircuitBreaker {
  if (!circuitBreakerInstance) circuitBreakerInstance = new WebhookCircuitBreaker();
  return circuitBreakerInstance;
}
export function resetWebhookCircuitBreaker(): void {
  circuitBreakerInstance = new WebhookCircuitBreaker();
}

// ─── WebhookStore ──────────────────────────────────────────────────────────

class WebhookStore {
  private webhooks: Webhook[] = [];

  create(url: string, events: WebhookEvent[], secret?: string, tenantId?: string, maxAttempts = 3, retryDelayMs = 500): Webhook {
    const entry: Webhook = {
      id: randomUUID(),
      url,
      events,
      secret: secret ?? randomBytes(32).toString('hex'),
      tenantId,
      maxAttempts,
      retryDelayMs,
      createdAt: new Date().toISOString(),
    };
    this.webhooks.push(entry);
    return entry;
  }

  list(tenantId?: string): WebhookPublic[] {
    const all = tenantId
      ? this.webhooks.filter((w) => w.tenantId === tenantId)
      : this.webhooks;
    return all.map(({ secret: _secret, ...rest }) => rest);
  }

  delete(id: string): boolean {
    const idx = this.webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    this.webhooks.splice(idx, 1);
    return true;
  }

  /** Deletes all webhooks belonging to a specific tenant. Returns count deleted. */
  deleteTenant(tenantId: string): number {
    const before = this.webhooks.length;
    this.webhooks = this.webhooks.filter((w) => w.tenantId !== tenantId);
    return before - this.webhooks.length;
  }

  getByEvent(event: WebhookEvent): Webhook[] {
    return this.webhooks.filter((w) => w.events.includes(event));
  }

  getById(id: string): Webhook | undefined {
    return this.webhooks.find(w => w.id === id);
  }
}

let instance: WebhookStore | null = null;

export function getWebhookStore(): WebhookStore {
  if (!instance) instance = new WebhookStore();
  return instance;
}

export function resetWebhookStore(): void {
  instance = new WebhookStore();
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

export async function dispatchWebhook(
  webhook: Webhook,
  event: WebhookEvent,
  data: unknown,
  timestamp?: string,
): Promise<void> {
  // Circuit-breaker check — bail out if circuit is open
  if (getWebhookCircuitBreaker().isOpen(webhook.id)) {
    getWebhookDeliveryLog().push({
      id:         randomUUID(),
      webhookId:  webhook.id,
      event,
      url:        webhook.url,
      timestamp:  new Date().toISOString(),
      attempt:    1,
      statusCode: null,
      delivered:  false,
      latencyMs:  0,
      error:      'circuit open',
    });
    return;
  }

  // Rate-limit check — bail out before fetch if over limit
  if (!getWebhookRateLimiter().check(webhook.id)) {
    getWebhookDeliveryLog().push({
      id:        randomUUID(),
      webhookId: webhook.id,
      event,
      url:       webhook.url,
      timestamp: new Date().toISOString(),
      attempt:   1,
      statusCode: null,
      delivered:  false,
      latencyMs:  0,
      error:     'rate limited',
    });
    return;
  }

  const payload: WebhookPayload = {
    event,
    timestamp: timestamp ?? new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);

  let succeeded = false;
  const maxAttempts  = webhook.maxAttempts;
  const retryDelayMs = webhook.retryDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await _sleep(attempt === 0 ? 0 : retryDelayMs);
    const start = Date.now();
    let statusCode: number | null = null;
    let delivered = false;
    let error: string | null = null;

    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Faultline-Signature': signature,
        },
        body,
      });
      statusCode = res.status;
      delivered  = res.ok;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - start;

    // Log this attempt
    getWebhookDeliveryLog().push({
      id:         randomUUID(),
      webhookId:  webhook.id,
      event,
      url:        webhook.url,
      timestamp:  new Date().toISOString(),
      attempt:    attempt + 1,
      statusCode,
      delivered,
      latencyMs,
      error,
    });

    if (delivered) { succeeded = true; break; }
  }

  // Update circuit breaker with outcome
  if (succeeded) {
    getWebhookCircuitBreaker().recordSuccess(webhook.id);
  } else {
    getWebhookCircuitBreaker().recordFailure(webhook.id);
  }
}

// ─── Test tool ────────────────────────────────────────────────────────────

export interface WebhookTestResult {
  id:          string;
  url:         string;
  event:       string;
  sentAt:      string;
  latencyMs:   number;
  statusCode:  number | null;
  statusText:  string | null;
  responseBody: string | null;
  responseHeaders: Record<string, string>;
  delivered:   boolean;
  error:       string | null;
  signatureHeader: string | null;
}

/** Sample payloads for each event type. */
export const SAMPLE_PAYLOADS: Record<string, unknown> = {
  'scan.complete': {
    input: 'The Eiffel Tower is 330 metres tall and was built in 1889.',
    provider: 'gemini',
    overallRisk: 'low',
    claims: [
      { id: 'c1', text: 'The Eiffel Tower is 330 metres tall', type: 'fact', importance: 4 },
      { id: 'c2', text: 'The Eiffel Tower was built in 1889', type: 'fact', importance: 4 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Multiple sources confirm height of 330m (antenna included).', sources: [{ title: 'Eiffel Tower official', uri: 'https://toureiffel.paris' }] },
      c2: { claimId: 'c2', status: 'supported', explanation: 'Construction completed 1889 for World\'s Fair.', sources: [] },
    },
  },
  'scan.failed': { error: 'All providers rate-limited. Retry after 60 seconds.', provider: 'gemini' },
  'job.complete': { jobId: 'job-test-123', text: 'sample text', provider: 'gemini', result: { overallRisk: 'low' } },
  'job.failed': { jobId: 'job-test-123', error: 'Provider timeout after 30s' },
  'claim.verdict_changed': { claimId: 'c1', oldStatus: 'unverified', newStatus: 'supported', provider: 'openai' },
  'compliance.deadline_approaching': { regulation: 'EU AI Act', daysUntilDeadline: 30, requirement: 'High-risk AI system registration' },
};

const MAX_TEST_HISTORY = 500;

class WebhookTestHistory {
  private records: WebhookTestResult[] = [];

  push(record: WebhookTestResult): void {
    this.records.unshift(record);
    if (this.records.length > MAX_TEST_HISTORY) this.records.pop();
  }

  list(webhookId?: string): WebhookTestResult[] {
    if (webhookId) return this.records.filter(r => r.id.startsWith(webhookId + ':'));
    return this.records.slice();
  }

  reset(): void { this.records = []; }
}

let testHistoryInstance: WebhookTestHistory | null = null;
export function getWebhookTestHistory(): WebhookTestHistory {
  if (!testHistoryInstance) testHistoryInstance = new WebhookTestHistory();
  return testHistoryInstance;
}
export function resetWebhookTestHistory(): void {
  testHistoryInstance = new WebhookTestHistory();
}

export async function sendTestWebhook(
  url: string,
  event: string,
  secret: string | null,
  webhookId?: string,
): Promise<WebhookTestResult> {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    test: true,
    data: SAMPLE_PAYLOADS[event] ?? { message: 'Test payload from Faultline Pro.' },
  };
  const body = JSON.stringify(payload);
  const sig = secret ? ('sha256=' + createHmac('sha256', secret).update(body).digest('hex')) : null;

  const result: WebhookTestResult = {
    id:              (webhookId ? webhookId + ':' : '') + randomUUID(),
    url,
    event,
    sentAt:          new Date().toISOString(),
    latencyMs:       0,
    statusCode:      null,
    statusText:      null,
    responseBody:    null,
    responseHeaders: {},
    delivered:       false,
    error:           null,
    signatureHeader: sig,
  };

  const start = Date.now();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Faultline-Pro/0.2.0' };
    if (sig) headers['X-Faultline-Signature'] = sig;

    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    result.latencyMs = Date.now() - start;
    result.statusCode = res.status;
    result.statusText = res.statusText;
    result.delivered  = res.ok;
    result.responseBody = (await res.text()).slice(0, 4096); // cap at 4KB
    for (const [k, v] of res.headers.entries()) {
      result.responseHeaders[k] = v;
    }
  } catch (err) {
    result.latencyMs = Date.now() - start;
    result.error = err instanceof Error ? err.message : String(err);
  }

  getWebhookTestHistory().push(result);
  return result;
}

// ─── Delivery log ─────────────────────────────────────────────────────────

export interface WebhookDeliveryRecord {
  id:            string;
  webhookId:     string;
  event:         WebhookEvent;
  url:           string;
  timestamp:     string;
  attempt:       number;   // 1-indexed attempt number that succeeded or was final
  statusCode:    number | null;
  delivered:     boolean;
  latencyMs:     number;
  error:         string | null;
}

const MAX_DELIVERY_LOG = 1_000;

class WebhookDeliveryLog {
  private records: WebhookDeliveryRecord[] = [];

  push(record: WebhookDeliveryRecord): void {
    this.records.unshift(record);
    if (this.records.length > MAX_DELIVERY_LOG) this.records.pop();
  }

  list(webhookId?: string, limit = 100): WebhookDeliveryRecord[] {
    const all = webhookId
      ? this.records.filter((r) => r.webhookId === webhookId)
      : this.records.slice();
    return all.slice(0, limit);
  }

  reset(): void { this.records = []; }
}

let deliveryLogInstance: WebhookDeliveryLog | null = null;
export function getWebhookDeliveryLog(): WebhookDeliveryLog {
  if (!deliveryLogInstance) deliveryLogInstance = new WebhookDeliveryLog();
  return deliveryLogInstance;
}
export function resetWebhookDeliveryLog(): void {
  deliveryLogInstance = new WebhookDeliveryLog();
}

export function fireWebhookEvent(event: WebhookEvent, data: unknown): void {
  const targets = getWebhookStore().getByEvent(event);
  if (targets.length === 0) return;
  const timestamp = new Date().toISOString();
  for (const webhook of targets) {
    void dispatchWebhook(webhook, event, data, timestamp);
  }
}
