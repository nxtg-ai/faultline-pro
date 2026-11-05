import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { FAULTLINE_API_VERSION } from '../version.js';
import { fetchOutbound, OutboundUrlBlockedError } from '../lib/outbound-url.js';
import { resolveRequestTenantId } from '../plugins/auth.js';
import { getKeyStore } from './keys.js';
import { isGroundedScanResult } from './cache.js';
import { isGroundingRedirect } from '@nxtg/faultline/evidence/grounding.js';

export type WebhookEvent = 'scan.complete' | 'scan.failed' | 'job.complete' | 'job.failed' | 'claim.verdict_changed' | 'compliance.deadline_approaching' | 'compliance.gate_failed';

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  tenantId: string | undefined;
  /**
   * The API key that registered the webhook, and its caller (cacheCaller:
   * key plus, behind the server key, the faultline-web user). Null caller:
   * registered by the server key with no valid user ref. Both undefined:
   * created without an owner, so it receives only public events.
   */
  ownerKeyId?: string;
  ownerCaller?: string | null;
  /** Max delivery attempts per event (1–5, default 3). */
  maxAttempts: number;
  /** Delay in ms between retry attempts (0–30 000, default 500). First attempt always immediate. */
  retryDelayMs: number;
  createdAt: string;
}

export type WebhookPublic = Omit<Webhook, 'secret' | 'ownerCaller' | 'ownerKeyId'>;

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

  create(
    url: string, events: WebhookEvent[], secret?: string, tenantId?: string, maxAttempts = 3, retryDelayMs = 500,
    owner?: { keyId: string; caller: string | null },
  ): Webhook {
    const entry: Webhook = {
      id: randomUUID(),
      url,
      events,
      secret: secret ?? randomBytes(32).toString('hex'),
      tenantId,
      ...(owner ? { ownerKeyId: owner.keyId, ownerCaller: owner.caller } : {}),
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
    return all.map(({ secret: _secret, ownerCaller: _caller, ownerKeyId: _key, ...rest }) => rest);
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
  owner: WebhookEventOwner,
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
    // Ownership is re-read before every attempt: a key can leave the tenant,
    // or be deleted or disabled, while a retry waits (codex seat, 859a348).
    // A webhook deleted while a retry waits gets nothing more.
    if (getWebhookStore().getById(webhook.id) === undefined || !webhookMayReceive(webhook, owner)) {
      getWebhookDeliveryLog().push({
        id: randomUUID(), webhookId: webhook.id, event, url: webhook.url,
        timestamp: new Date().toISOString(), attempt: attempt + 1, statusCode: null,
        delivered: false, latencyMs: 0, error: 'owner no longer matches',
      });
      return;
    }
    const start = Date.now();
    let statusCode: number | null = null;
    let delivered = false;
    let error: string | null = null;
    let blocked = false;

    try {
      // Guarded per attempt: DNS can change between registration and each retry.
      const res = await fetchOutbound(webhook.url, {
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
      blocked = err instanceof OutboundUrlBlockedError;
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
    if (blocked) break; // a blocked target stays blocked; retrying only repeats the refusal
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
  /** Always null. The target's body is never returned to the caller (SSRF read-back, CodeQL #5). */
  responseBody: null;
  /** Always empty, for the same reason as responseBody. Kept for response-shape compatibility. */
  responseHeaders: Record<string, never>;
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': `Faultline-Pro/${FAULTLINE_API_VERSION}` };
    if (sig) headers['X-Faultline-Signature'] = sig;

    const res = await fetchOutbound(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    result.latencyMs = Date.now() - start;
    result.statusCode = res.status;
    result.statusText = res.statusText;
    result.delivered  = res.ok;
    await res.body?.cancel(); // status only: the body and headers stay server-side
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

/**
 * Who an event belongs to.
 * - `{ keyId, caller }`: the API key behind the scan and its caller (cacheCaller).
 * - `'public'`: the payload holds no caller data (the fixed regulatory calendar).
 * - `null`: no owner can be named (the shared claim index): delivered to no one.
 */
export type WebhookEventOwner = { keyId: string; caller: string | null } | 'public' | null;

/**
 * True when `webhook` may receive an event owned by `owner`, decided at send
 * time, not at registration (emma-soul al:3dd437daabb68ad9 item 1).
 *
 * Rule: a webhook receives an event when its owner and the event's owner are in
 * the same tenant (both defined and equal, each re-read now from its key), or
 * are the same caller (both non-null and equal). Nothing else matches: the
 * server key without a user ref, a key outside any tenant, a webhook with no
 * owner and an owner key that no longer exists all match nothing.
 */
/**
 * True when `keyId` can still authenticate: the server key while it is
 * configured, or a keystore key that exists, is not disabled and has not expired.
 */
export function keyIsLive(keyId: string): boolean {
  if (keyId === 'admin') return Boolean(process.env.FAULTLINE_API_KEY);
  const key = getKeyStore().validateById(keyId);
  if (!key || key.disabled) return false;
  return !(key.expiresAt && new Date(key.expiresAt) <= new Date());
}

export function webhookMayReceive(webhook: Webhook, owner: WebhookEventOwner): boolean {
  // Public events still need a live owner key when one was recorded.
  if (owner === 'public') return webhook.ownerKeyId === undefined || keyIsLive(webhook.ownerKeyId);
  if (owner === null) return false;
  const ownerKeyId = webhook.ownerKeyId;
  if (ownerKeyId === undefined) return false;
  // Both keys must still be live: a deleted, disabled or expired key neither
  // receives nor emits (Opus and codex seats, 859a348).
  if (!keyIsLive(ownerKeyId) || !keyIsLive(owner.keyId)) return false;
  const webhookTenant = resolveRequestTenantId(ownerKeyId);
  const eventTenant = resolveRequestTenantId(owner.keyId);
  if (webhookTenant !== undefined && webhookTenant === eventTenant) return true;
  const webhookCaller = webhook.ownerCaller ?? null;
  return webhookCaller !== null && webhookCaller === owner.caller;
}

/** The scan result inside an event's data: the data itself, or `data.result` (job.complete). */
function scanResultIn(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if ('verifications' in d || 'claims' in d) return d;
  const inner = d.result;
  if (inner && typeof inner === 'object' && ('verifications' in inner || 'claims' in inner)) return inner as Record<string, unknown>;
  return null;
}

/**
 * The payload a webhook may carry. A result that holds Gemini Grounded Results
 * goes to no webhook, the owner's included: Google's terms let it be shown only
 * to the end user who submitted the prompt (emma-soul al:3dd437daabb68ad9 item 2).
 * The webhook gets a minimal event instead: the scan or job id, a status and
 * counts; no claim text, verdict, explanation or source.
 */
export function webhookSafeData(event: WebhookEvent, data: unknown): unknown {
  const result = scanResultIn(data);
  if (!result || !isGroundedScanResult(result)) return sanitizeErrorField(data);
  const claims = Array.isArray(result.claims) ? result.claims : [];
  const verifications = result.verifications && typeof result.verifications === 'object'
    ? Object.keys(result.verifications as object).length : 0;
  const d = data as Record<string, unknown>;
  const scanId = typeof result.scanId === 'string' ? result.scanId : typeof result.id === 'string' ? result.id : null;
  return {
    ...(typeof d.jobId === 'string' ? { jobId: d.jobId } : {}),
    scanId,
    status: event.endsWith('.failed') ? 'failed' : 'complete',
    grounded: true,
    claimCount: claims.length,
    checkedCount: verifications,
    note: 'Gemini grounded results are shown only to the user who ran the scan; read them from the scan response.',
  };
}

const ERROR_TEXT_MAX = 200;
/** Error texts written by Faultline itself, which quote no provider output. */
const OWN_ERROR_PREFIXES = ['All providers', 'No API key found for', 'Outbound URL blocked', 'test-event', 'Scan failed'];
export const GENERIC_SCAN_ERROR = 'Scan failed (provider error).';

/**
 * The error text a caller's URL may receive. A provider's own error message can
 * quote its output, Gemini Grounded Results included, so only messages Faultline
 * writes itself pass (capped); anything else becomes a fixed generic message
 * (codex seats on 859a348 and 84cf8c8).
 */
export function sanitizeErrorText(text: string): string {
  if (!OWN_ERROR_PREFIXES.some((p) => text.startsWith(p))) return GENERIC_SCAN_ERROR;
  const stripped = text.replace(/https?:\/\/\S+/gi, (u) => (isGroundingRedirect(u.replace(/[)"'.,;]+$/, '')) ? '[link removed]' : u));
  return stripped.length > ERROR_TEXT_MAX ? `${stripped.slice(0, ERROR_TEXT_MAX)}…` : stripped;
}

function sanitizeErrorField(data: unknown): unknown {
  if (!data || typeof data !== 'object' || typeof (data as { error?: unknown }).error !== 'string') return data;
  return { ...(data as Record<string, unknown>), error: sanitizeErrorText((data as { error: string }).error) };
}

/**
 * The result with a `scanId`, so a webhook's minimal event (and the caller's
 * response) can name the scan. Keeps an id the result already has. A copy;
 * the input (possibly a cached object) is never changed.
 */
export function withScanId<T extends object>(result: T, scanId?: string): T & { scanId: string } {
  const existing = (result as { scanId?: unknown }).scanId;
  return { ...result, scanId: typeof existing === 'string' ? existing : scanId ?? `scan-${randomUUID()}` };
}

export function fireWebhookEvent(event: WebhookEvent, data: unknown, owner: WebhookEventOwner): void {
  const targets = getWebhookStore().getByEvent(event).filter((w) => webhookMayReceive(w, owner));
  if (targets.length === 0) return;
  const timestamp = new Date().toISOString();
  const payload = webhookSafeData(event, data);
  for (const webhook of targets) {
    void dispatchWebhook(webhook, event, payload, owner, timestamp);
  }
}
