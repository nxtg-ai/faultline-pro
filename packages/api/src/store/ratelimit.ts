export type Tier = 'admin' | 'pro' | 'free';

const TIER_LIMITS: Record<Tier, number> = {
  admin: 10000,
  pro: 1000,
  free: 10,
};

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetEpoch: number; // Unix seconds of next midnight UTC
}

interface RateLimitEntry {
  count: number;
  dateKey: string; // YYYY-MM-DD
}

class RateLimiter {
  private counters: Map<string, RateLimitEntry> = new Map();
  private customLimits: Map<string, number> = new Map();

  private todayKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  private nextMidnightEpoch(): number {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  getLimit(keyId: string, tier: Tier): number {
    return this.customLimits.get(keyId) ?? TIER_LIMITS[tier];
  }

  private getEntry(keyId: string): RateLimitEntry {
    const today = this.todayKey();
    const existing = this.counters.get(keyId);
    if (!existing || existing.dateKey !== today) {
      const fresh: RateLimitEntry = { count: 0, dateKey: today };
      this.counters.set(keyId, fresh);
      return fresh;
    }
    return existing;
  }

  check(keyId: string, tier: Tier): { allowed: boolean; info: RateLimitInfo } {
    const limit = this.getLimit(keyId, tier);
    const entry = this.getEntry(keyId);
    const remaining = Math.max(0, limit - entry.count);
    const allowed = entry.count < limit;
    return {
      allowed,
      info: { limit, remaining: allowed ? remaining - 1 : 0, resetEpoch: this.nextMidnightEpoch() },
    };
  }

  increment(keyId: string): void {
    const entry = this.getEntry(keyId);
    entry.count += 1;
  }

  getInfo(keyId: string, tier: Tier): RateLimitInfo {
    const limit = this.getLimit(keyId, tier);
    const entry = this.getEntry(keyId);
    return {
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetEpoch: this.nextMidnightEpoch(),
    };
  }

  setCustomLimit(keyId: string, limit: number): void {
    this.customLimits.set(keyId, limit);
  }
}

let instance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!instance) instance = new RateLimiter();
  return instance;
}

export function resetRateLimiter(): void {
  instance = new RateLimiter();
}

export function setCustomLimit(keyId: string, limit: number): void {
  getRateLimiter().setCustomLimit(keyId, limit);
}
