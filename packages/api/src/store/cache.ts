import { createHash } from 'node:crypto';

type ScanResult = Record<string, unknown>; // opaque — cache stores whatever scan() returns

interface CacheEntry {
  result: ScanResult;
  cachedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(text: string, provider: string): string {
  return createHash('sha256').update(`${text}\0${provider}`).digest('hex');
}

class ScanCache {
  private store = new Map<string, CacheEntry>();
  private _hits = 0;
  private _misses = 0;
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(text: string, provider: string): ScanResult | null {
    const key = cacheKey(text, provider);
    const entry = this.store.get(key);
    if (!entry) { this._misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this._misses++;
      return null;
    }
    this._hits++;
    return entry.result;
  }

  set(text: string, provider: string, result: ScanResult): void {
    const key = cacheKey(text, provider);
    const now = Date.now();
    this.store.set(key, { result, cachedAt: now, expiresAt: now + this.ttlMs });
  }

  flush(): void {
    this.store.clear();
    // preserve counters — flush does NOT reset stats
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this._hits + this._misses;
    return {
      size: this.store.size,
      hits: this._hits,
      misses: this._misses,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  reset(): void {
    this.store.clear();
    this._hits = 0;
    this._misses = 0;
  }
}

let instance: ScanCache | null = null;

export function getScanCache(): ScanCache {
  if (!instance) {
    const ttlMs = process.env.FAULTLINE_CACHE_TTL_MS
      ? Number(process.env.FAULTLINE_CACHE_TTL_MS)
      : DEFAULT_TTL_MS;
    instance = new ScanCache(ttlMs);
  }
  return instance;
}

export function resetCache(): void {
  instance = new ScanCache(
    process.env.FAULTLINE_CACHE_TTL_MS
      ? Number(process.env.FAULTLINE_CACHE_TTL_MS)
      : DEFAULT_TTL_MS
  );
}
