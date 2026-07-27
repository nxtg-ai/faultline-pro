class UsageMeter {
  private data: Map<string, Map<string, number>> = new Map();

  increment(keyId: string): void {
    const today = new Date().toISOString().split('T')[0];
    if (!this.data.has(keyId)) {
      this.data.set(keyId, new Map());
    }
    const byDay = this.data.get(keyId)!;
    byDay.set(today, (byDay.get(today) ?? 0) + 1);
  }

  getUsage(keyId: string): Record<string, number> {
    const byDay = this.data.get(keyId);
    if (!byDay) return {};
    return Object.fromEntries(byDay.entries());
  }

  /**
   * Total scans recorded for a key within a calendar month (default: current
   * month, UTC). `month` is a 'YYYY-MM' prefix; days are stored as 'YYYY-MM-DD'
   * so a prefix match sums the month. Used by the monthly usage-cap gate.
   */
  getMonthlyCount(keyId: string, month?: string): number {
    const byDay = this.data.get(keyId);
    if (!byDay) return 0;
    const prefix = month ?? new Date().toISOString().slice(0, 7);
    let total = 0;
    for (const [day, count] of byDay.entries()) {
      if (day.startsWith(prefix)) total += count;
    }
    return total;
  }

  deleteKey(keyId: string): boolean {
    return this.data.delete(keyId);
  }

  reset(): void {
    this.data = new Map();
  }
}

let instance: UsageMeter | null = null;

export function getUsageMeter(): UsageMeter {
  if (!instance) instance = new UsageMeter();
  return instance;
}

export function resetUsageMeter(): void {
  instance = new UsageMeter();
}
