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
