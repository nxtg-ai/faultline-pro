export type Tier = 'admin' | 'pro' | 'free';

const TIER_LIMITS: Record<Tier, number> = {
  admin: 10000,
  pro: 100,
  free: 10,
};

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetEpoch: number; // Unix seconds of next window boundary
}

export interface KeyRateLimitStats {
  keyId:         string;
  tier:          Tier;
  limit:         number;
  used:          number;
  remaining:     number;
  usedPct:       number;
  throttleCount: number;
  resetEpoch:    number;
  windowKey:     string;
}

interface RateLimitEntry {
  count: number;
  windowKey: string; // YYYY-MM-DDTHH:mm
}

class RateLimiter {
  private counters: Map<string, RateLimitEntry> = new Map();
  private customLimits: Map<string, number> = new Map();
  private throttleCounts: Map<string, number> = new Map();
  private tierCache: Map<string, Tier> = new Map();

  private windowKey(): string {
    return new Date().toISOString().slice(0, 16);
  }

  private nextWindowEpoch(): number {
    const d = new Date();
    d.setSeconds(60, 0); // advance to next minute
    return Math.floor(d.getTime() / 1000);
  }

  getLimit(keyId: string, tier: Tier): number {
    return this.customLimits.get(keyId) ?? TIER_LIMITS[tier];
  }

  private getEntry(keyId: string): RateLimitEntry {
    const window = this.windowKey();
    const existing = this.counters.get(keyId);
    if (!existing || existing.windowKey !== window) {
      const fresh: RateLimitEntry = { count: 0, windowKey: window };
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
      info: { limit, remaining: allowed ? remaining - 1 : 0, resetEpoch: this.nextWindowEpoch() },
    };
  }

  increment(keyId: string): void {
    const entry = this.getEntry(keyId);
    entry.count += 1;
  }

  recordThrottle(keyId: string): void {
    this.throttleCounts.set(keyId, (this.throttleCounts.get(keyId) ?? 0) + 1);
  }

  setTierCache(keyId: string, tier: Tier): void {
    this.tierCache.set(keyId, tier);
  }

  getInfo(keyId: string, tier: Tier): RateLimitInfo {
    const limit = this.getLimit(keyId, tier);
    const entry = this.getEntry(keyId);
    return {
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetEpoch: this.nextWindowEpoch(),
    };
  }

  setCustomLimit(keyId: string, limit: number): void {
    this.customLimits.set(keyId, limit);
  }

  /** Returns stats for every key that has been seen this session. */
  getAllStats(): KeyRateLimitStats[] {
    const results: KeyRateLimitStats[] = [];
    const allKeys = new Set([
      ...this.counters.keys(),
      ...this.throttleCounts.keys(),
    ]);
    for (const keyId of allKeys) {
      const tier: Tier = this.tierCache.get(keyId) ?? 'free';
      const limit = this.getLimit(keyId, tier);
      const entry = this.getEntry(keyId);
      const used = entry.count;
      const remaining = Math.max(0, limit - used);
      results.push({
        keyId,
        tier,
        limit,
        used,
        remaining,
        usedPct: limit > 0 ? Math.round((used / limit) * 100) : 0,
        throttleCount: this.throttleCounts.get(keyId) ?? 0,
        resetEpoch: this.nextWindowEpoch(),
        windowKey: entry.windowKey,
      });
    }
    return results.sort((a, b) => b.usedPct - a.usedPct);
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
