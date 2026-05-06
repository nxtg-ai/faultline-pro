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
//   gemini   → Gemini Flash   ($0.15 input / $0.60 output)
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
  gemini:     { inputPerM: 0.15,  outputPerM: 0.60,  groundingPerCall: 0.035 },
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

/** One managed-key scan cost event (emitted per scan, no PII). */
export interface ManagedScanCostEvent {
  scanId: string;
  ts: string;              // ISO-8601
  tier: 'enterprise' | 'pro' | 'personal';
  keyMode: 'managed';      // always 'managed' for API-path scans
  provider: string;
  inputTokens: number;
  outputTokens: number;
  groundingCalls: number;
  costUsd: number;
  latencyMs: number;
}

export interface CostPercentiles {
  p50: number;
  p90: number;
  p99: number;
  count: number;
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

  recordManaged(event: ManagedScanCostEvent): void {
    this.managedData.push(event);
  }

  getManagedEvents(days = 30): ManagedScanCostEvent[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.managedData.filter((e) => e.ts >= cutoff);
  }

  getPercentiles(days = 30): CostPercentiles {
    const events = this.getManagedEvents(days);
    const costs = events.map((e) => e.costUsd).sort((a, b) => a - b);
    return {
      p50: percentile(costs, 50),
      p90: percentile(costs, 90),
      p99: percentile(costs, 99),
      count: costs.length,
      windowDays: days,
    };
  }

  reset(): void {
    this.data = [];
    this.managedData = [];
  }
}

let instance: CostStore | null = null;

export function getCostStore(): CostStore {
  if (!instance) instance = new CostStore();
  return instance;
}

export function resetCostStore(): void {
  instance = new CostStore();
}
