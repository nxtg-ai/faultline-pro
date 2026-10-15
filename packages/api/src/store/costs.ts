import { appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getKeyStore } from '../store/keys.js';
import { summarizeScanUsage, type UsageLeg } from './consensus-cost.js';

const TELEMETRY_WORKER = 'https://faultline-telemetry.nxtg-ai.workers.dev';

/** Default model ID per provider family (auditable — rates tied to these models). */
export const PROVIDER_MODEL_IDS: Record<string, string> = {
  gemini:     'gemini-2.5-flash',
  claude:     'claude-haiku-4-5-20251001',
  openai:     'gpt-4o-mini',
  perplexity: 'llama-3.1-sonar-small-128k-online',
  mock:       'mock',
};

export interface ScanCost {
  keyId: string;
  tenantId?: string;
  provider: string;
  date: string; // YYYY-MM-DD
  estimatedTokens: number;
  estimatedCostUsd: number;
}

const PROVIDER_RATES: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  gemini:     { inputPer1k: 0.000125, outputPer1k: 0.000375 },
  openai:     { inputPer1k: 0.005,    outputPer1k: 0.015 },
  claude:     { inputPer1k: 0.003,    outputPer1k: 0.015 },
  perplexity: { inputPer1k: 0.001,    outputPer1k: 0.001 },
  mock:       { inputPer1k: 0,        outputPer1k: 0 },
};

// ── Managed-key scan cost telemetry ──────────────────────────────────────────
// Rates per 1M tokens (directive-specified). Provider family → model assumed:
//   gemini   → Gemini 2.5 Flash ($0.30 input / $2.50 output incl. thinking; paid tier,
//              https://ai.google.dev/gemini-api/docs/pricing, re-read 2026-09-30; was
//              $0.15/$0.60, the 2.0 Flash rate, flagged by product-oracle 2026-10-11)
//   claude   → Claude Haiku   ($0.80 input / $4.00 output)
//   openai   → GPT-4o mini    ($0.15 input / $0.60 output)
//   perplexity → Perplexity sonar ($1.00 input / $1.00 output, no grounding surcharge)
//   mock     → $0 (test/demo)
// Grounding (web search per claim): $0.035/call (Gemini; $0 for others — no grounding API).
const MANAGED_PROVIDER_RATES: Record<string, {
  inputPerM: number;
  outputPerM: number;
  groundingPerCall: number;
}> = {
  gemini:     { inputPerM: 0.30,  outputPerM: 2.50,  groundingPerCall: 0.035 },
  claude:     { inputPerM: 0.80,  outputPerM: 4.00,  groundingPerCall: 0 },
  openai:     { inputPerM: 0.15,  outputPerM: 0.60,  groundingPerCall: 0 },
  perplexity: { inputPerM: 1.00,  outputPerM: 1.00,  groundingPerCall: 0 },
  mock:       { inputPerM: 0,     outputPerM: 0,     groundingPerCall: 0 },
};

/**
 * Compute estimated scan cost in USD for a managed-key scan.
 * Note: token counts are estimates derived from text length (scan() does not
 * expose LLM-reported token counts). Treat cost_usd as an estimate, not a
 * measured billing value, until provider token reporting is wired up.
 */
export function computeScanCost(
  inputTokens: number,
  outputTokens: number,
  groundingCalls: number,
  provider: string,
): number {
  const rates = MANAGED_PROVIDER_RATES[provider] ?? { inputPerM: 0, outputPerM: 0, groundingPerCall: 0 };
  return (
    (inputTokens / 1_000_000) * rates.inputPerM +
    (outputTokens / 1_000_000) * rates.outputPerM +
    groundingCalls * rates.groundingPerCall
  );
}

/**
 * Build the managed-key cost event from a scan's captured usage legs
 * (BLG-CLX9-20260703-005). Uses REAL provider-reported usage composed across the
 * fan-out (defects 1+2) priced at each leg's real model (defect 3). Falls back
 * to the legacy text-length estimate ONLY when nothing was captured (mock /
 * offline / cache / an all-error scan) so a real scan never silently emits $0.
 */
export function buildManagedCostEvent(
  legs: UsageLeg[],
  opts: {
    text: string;
    provider: string;
    claimCount: number;
    tier: ManagedScanCostEvent['tier'];
    latencyMs: number;
    cacheHit?: boolean;
    kind?: ManagedScanCostEvent['kind'];
    /** Per-call claim counts, so cost per claim can be read from the log. */
    claims?: { extracted: number; verified: number };
  },
): ManagedScanCostEvent {
  const usage = summarizeScanUsage(legs);
  // Gate on real COMPOSED COST, not leg presence (Wolf BLG-005 Phase-2 fold 1).
  // Legs whose provider omitted usage (?? 0 → 0-token) still count as legs but
  // compose to $0 — gating on legs.length there would bypass the fallback and
  // silently emit $0 for a REAL scan. costUsd>0 iff we captured real, priced
  // usage; otherwise fall back to the estimate. (mock/offline compose to $0 and
  // correctly take the estimate path, which prices mock at $0 anyway.)
  const hasRealUsage = usage.costUsd > 0;
  const estInput = Math.ceil(opts.text.length / 4);
  const inputTokens = hasRealUsage ? usage.inputTokens : estInput;
  const outputTokens = hasRealUsage ? usage.outputTokens : Math.ceil(estInput * 0.3);
  const groundingCalls = hasRealUsage ? usage.groundingCalls : opts.claimCount;
  const costUsd = hasRealUsage
    ? usage.costUsd
    : computeScanCost(inputTokens, outputTokens, groundingCalls, opts.provider);
  const modelId = (hasRealUsage && usage.primaryModel)
    ? usage.primaryModel
    : (PROVIDER_MODEL_IDS[opts.provider] ?? opts.provider);
  return {
    scanId: randomUUID(),
    ts: new Date().toISOString(),
    tier: opts.tier,
    keyMode: 'managed',
    provider: opts.provider,
    modelId,
    inputTokens,
    outputTokens,
    groundingCalls,
    costUsd,
    latencyMs: opts.latencyMs,
    cacheHit: opts.cacheHit ?? false,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.claims ? { claimsExtracted: opts.claims.extracted, claimsVerified: opts.claims.verified } : {}),
  };
}

/** One managed-key scan cost event (emitted per scan, no PII). */
export interface ManagedScanCostEvent {
  scanId: string;
  ts: string;              // ISO-8601
  tier: 'enterprise' | 'pro' | 'personal' | 'free' | 'anon' | 'userkey';
  keyMode: 'managed';      // always 'managed' for API-path scans
  provider: string;
  modelId?: string;        // actual model used (PROVIDER_MODEL_IDS lookup)
  inputTokens: number;
  outputTokens: number;
  groundingCalls: number;
  costUsd: number;
  latencyMs: number;
  cacheHit?: boolean;      // true when result served from cache (cost = 0 effective)
  /**
   * What produced the cost: a customer scan, an admin benchmark batch of up to 25
   * claims, or one full-scan step (an estimate's extraction or a job's verify run,
   * which can be 200+ claims). Absent = 'scan'. Per-scan percentiles count 'scan' only.
   */
  kind?: 'scan' | 'admin-verify' | 'full-scan';
  /** Claims extracted (or submitted) in this call; absent on events logged before counts existed. */
  claimsExtracted?: number;
  /** Claims that got a provider verdict, `unverified` included (isBillableVerdict); absent on old events. */
  claimsVerified?: number;
  /**
   * The API key that ran the scan, kept in memory only (not in the scan-cost log), so
   * /costs/percentiles can show a key its own scans. Events without it (hydrated from
   * the log, or written before owners were recorded) count for admin only.
   */
  ownerKeyId?: string;
}

const VALID_TIERS = new Set<ManagedScanCostEvent['tier']>(['enterprise', 'pro', 'personal', 'free', 'anon', 'userkey']);

/** Derive subscription tier from keyId. No PII — permission metadata only. */
export function resolveTier(keyId: string): ManagedScanCostEvent['tier'] {
  if (keyId === 'admin') return 'enterprise';
  const key = getKeyStore().validateById(keyId);
  if (key?.permissions.includes('pro')) return 'pro';
  return 'personal';
}

/**
 * Resolve tier from x-user-tier header (FW authoritative source) with fallback to keyId inference.
 * FW forwards x-user-tier (Clerk-authenticated, server-side) on every /scan/stream call.
 * Direct service-to-service calls (no header) fall back to resolveTier(keyId).
 */
export function resolveTierFromRequest(keyId: string, headerTier?: string | string[]): ManagedScanCostEvent['tier'] {
  const raw = Array.isArray(headerTier) ? headerTier[0] : headerTier;
  if (raw && VALID_TIERS.has(raw as ManagedScanCostEvent['tier'])) {
    return raw as ManagedScanCostEvent['tier'];
  }
  return resolveTier(keyId);
}

/**
 * Emit a scan_cost event to the CF Worker telemetry endpoint.
 * Fire-and-forget: errors are swallowed so scan responses are never delayed.
 * No PII: no keyId, no text content, no user identity.
 * Suppressed in test environments to avoid polluting mocked fetch expectations.
 */
export function emitScanCostEvent(event: ManagedScanCostEvent): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const payload = {
    event:          'scan_cost',
    ts:             event.ts,
    scan_id:        event.scanId,
    tier:           event.tier,
    key_mode:       event.keyMode,
    provider:       event.provider,
    model_id:       event.modelId ?? PROVIDER_MODEL_IDS[event.provider] ?? event.provider,
    input_tokens:   event.inputTokens,
    output_tokens:  event.outputTokens,
    grounding_calls: event.groundingCalls,
    cost_usd:       event.costUsd,
    latency_ms:     event.latencyMs,
    cache_hit:      event.cacheHit ?? false,
    kind:           event.kind ?? 'scan',
  };
  fetch(`${TELEMETRY_WORKER}/scan-costs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* fire-and-forget */ });
}

/**
 * Append a scan cost event as NDJSON to the structured log on Fly.
 * Fire-and-forget: a failed write MUST NOT fail the scan.
 * Suppressed in test environments.
 */
export const SCAN_COST_LOG_PATH = '/var/log/faultline/scan-cost.jsonl';

/** One scan-cost log row (snake_case, as the log has always been written). */
export function scanCostLogRow(event: ManagedScanCostEvent): string {
  return JSON.stringify({
    ts:             event.ts,
    scan_id:        event.scanId,
    user_tier:      event.tier,
    key_mode:       event.keyMode,
    provider:       event.provider,
    model_id:       event.modelId ?? PROVIDER_MODEL_IDS[event.provider] ?? event.provider,
    input_tokens:   event.inputTokens,
    output_tokens:  event.outputTokens,
    tool_call_count: event.groundingCalls,
    wall_ms:        event.latencyMs,
    usd_estimate:   event.costUsd,
    cache_hit:      event.cacheHit ?? false,
    kind:           event.kind ?? 'scan',
    claim_count:    event.claimsExtracted ?? null,
    verified_count: event.claimsVerified ?? null,
  });
}

export function appendScanCostLog(event: ManagedScanCostEvent, logPath = SCAN_COST_LOG_PATH): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const row = scanCostLogRow(event);
  appendFile(logPath, row + '\n').catch(() => { /* fire-and-forget */ });
}

export interface CostPercentiles {
  p50: number;
  p90: number;
  p99: number;
  count: number;
  /** Wall-clock scan latency over the same events, in ms. */
  latencyMs: { p50: number; p90: number; p99: number };
  /** Set when the result is filtered to one tier. */
  tier?: ManagedScanCostEvent['tier'];
  windowDays: number;
}

export interface CostFilter {
  keyId?: string;
  tenantId?: string;
  provider?: string;
  from?: string; // YYYY-MM-DD inclusive
  to?: string;   // YYYY-MM-DD inclusive
}

export interface CostAggregate {
  totalTokens: number;
  totalCostUsd: number;
  byProvider: Record<string, { tokens: number; costUsd: number }>;
  byDate: Record<string, { tokens: number; costUsd: number }>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

class CostStore {
  private data: ScanCost[] = [];
  private managedData: ManagedScanCostEvent[] = [];

  record(keyId: string, provider: string, inputText: string, tenantId?: string): void {
    const date = new Date().toISOString().split('T')[0];
    const inputTokens = Math.ceil(inputText.length / 4);
    const outputTokens = inputTokens * 2;
    const totalTokens = inputTokens + outputTokens;

    const rates = PROVIDER_RATES[provider] ?? { inputPer1k: 0, outputPer1k: 0 };
    const estimatedCostUsd =
      (inputTokens / 1000) * rates.inputPer1k +
      (outputTokens / 1000) * rates.outputPer1k;

    this.data.push({ keyId, tenantId, provider, date, estimatedTokens: totalTokens, estimatedCostUsd });
  }

  getCosts(filter?: CostFilter): ScanCost[] {
    return this.data.filter((entry) => {
      if (filter?.keyId && entry.keyId !== filter.keyId) return false;
      if (filter?.tenantId && entry.tenantId !== filter.tenantId) return false;
      if (filter?.provider && entry.provider !== filter.provider) return false;
      if (filter?.from && entry.date < filter.from) return false;
      if (filter?.to && entry.date > filter.to) return false;
      return true;
    });
  }

  /** Deletes all cost entries for a specific tenant. Returns count of deleted entries. */
  deleteTenantCosts(tenantId: string): number {
    const before = this.data.length;
    this.data = this.data.filter((e) => e.tenantId !== tenantId);
    return before - this.data.length;
  }

  getAggregate(filter?: CostFilter): CostAggregate {
    const costs = this.getCosts(filter);

    const byProvider: Record<string, { tokens: number; costUsd: number }> = {};
    const byDate: Record<string, { tokens: number; costUsd: number }> = {};
    let totalTokens = 0;
    let totalCostUsd = 0;

    for (const entry of costs) {
      totalTokens += entry.estimatedTokens;
      totalCostUsd += entry.estimatedCostUsd;

      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = { tokens: 0, costUsd: 0 };
      }
      byProvider[entry.provider].tokens += entry.estimatedTokens;
      byProvider[entry.provider].costUsd += entry.estimatedCostUsd;

      if (!byDate[entry.date]) {
        byDate[entry.date] = { tokens: 0, costUsd: 0 };
      }
      byDate[entry.date].tokens += entry.estimatedTokens;
      byDate[entry.date].costUsd += entry.estimatedCostUsd;
    }

    return { totalTokens, totalCostUsd, byProvider, byDate };
  }

  recordManaged(event: ManagedScanCostEvent, ownerKeyId?: string): void {
    this.managedData.push(ownerKeyId ? { ...event, ownerKeyId } : event);
  }

  getManagedEvents(days = 30): ManagedScanCostEvent[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.managedData.filter((e) => e.ts >= cutoff);
  }

  /** `keyId` undefined = every key's scans (admin); a string = only that key's scans. */
  getPercentiles(days = 30, tier?: ManagedScanCostEvent['tier'], keyId?: string): CostPercentiles {
    // Per-scan percentiles describe scans only: an admin-verify batch is up to 25 claims, not one scan.
    // Legacy admin batches logged before `kind` existed carry no kind, still read as scans here,
    // and age out of the 30-day window.
    const events = this.getManagedEvents(days)
      .filter((e) => (e.kind ?? 'scan') === 'scan')
      .filter((e) => !tier || e.tier === tier)
      .filter((e) => keyId === undefined || e.ownerKeyId === keyId);
    const costs = events.map((e) => e.costUsd).sort((a, b) => a - b);
    const walls = events.map((e) => e.latencyMs).sort((a, b) => a - b);
    return {
      p50: percentile(costs, 50),
      p90: percentile(costs, 90),
      p99: percentile(costs, 99),
      count: costs.length,
      latencyMs: { p50: percentile(walls, 50), p90: percentile(walls, 90), p99: percentile(walls, 99) },
      ...(tier ? { tier } : {}),
      windowDays: days,
    };
  }

  /** Load events written by appendScanCostLog before this process started. */
  hydrate(events: ManagedScanCostEvent[]): void {
    this.managedData.unshift(...events);
  }

  reset(): void {
    this.data = [];
    this.managedData = [];
  }
}

let instance: CostStore | null = null;

/**
 * Read the scan-cost NDJSON log back into events. The in-memory store starts empty
 * on every process start, so without this /costs/percentiles forgot every scan at
 * each Fly deploy (product-oracle read the 2026-10-02..10 history off the volume by
 * hand instead). Malformed rows are skipped; a missing or unreadable file gives [].
 */
export function loadScanCostLog(logPath = SCAN_COST_LOG_PATH): ManagedScanCostEvent[] {
  let raw: string;
  try {
    if (!existsSync(logPath)) return [];
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const events: ManagedScanCostEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const tier = r.user_tier as ManagedScanCostEvent['tier'];
      if (typeof r.ts !== 'string' || !VALID_TIERS.has(tier)) continue;
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      events.push({
        scanId: String(r.scan_id ?? ''),
        ts: r.ts,
        tier,
        keyMode: 'managed',
        provider: String(r.provider ?? ''),
        modelId: typeof r.model_id === 'string' ? r.model_id : undefined,
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        groundingCalls: num(r.tool_call_count),
        costUsd: num(r.usd_estimate),
        latencyMs: num(r.wall_ms),
        cacheHit: r.cache_hit === true,
        kind: r.kind === 'admin-verify' || r.kind === 'full-scan' ? r.kind : 'scan',
        ...(typeof r.claim_count === 'number' ? { claimsExtracted: r.claim_count } : {}),
        ...(typeof r.verified_count === 'number' ? { claimsVerified: r.verified_count } : {}),
      });
    } catch {
      /* skip a malformed row */
    }
  }
  return events;
}

export function getCostStore(): CostStore {
  if (!instance) {
    instance = new CostStore();
    // Same guard as appendScanCostLog: tests never read the production log.
    if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
      instance.hydrate(loadScanCostLog(process.env.FAULTLINE_SCAN_COST_LOG ?? SCAN_COST_LOG_PATH));
    }
  }
  return instance;
}

export function resetCostStore(): void {
  instance = null; // the next getCostStore() builds a fresh store (and hydrates, outside tests)
}
