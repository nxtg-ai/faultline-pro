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

class CostStore {
  private data: ScanCost[] = [];

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

  reset(): void {
    this.data = [];
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
