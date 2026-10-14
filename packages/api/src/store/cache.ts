import { assertValidScanResult } from '@nxtg/faultline/lib/verdict-guard.js';
import { createHash } from 'node:crypto';
import { DEFAULT_VERIFY_CAP, resolveVerifyCap } from '@nxtg/faultline/cli/verify-cap.js';

type ScanResult = Record<string, unknown>; // opaque — cache stores whatever scan() returns

interface CacheEntry {
  result: ScanResult;
  cachedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The verify cap is part of the key: a result verified under one plan's cap
 * must never be served to a plan with a different cap. The cap is normalised
 * the way the engine normalises it, so 8 and an invalid value share an entry.
 */
function cacheKey(text: string, provider: string, verifyCap: number): string {
  return createHash('sha256')
    .update(`${text}\0${provider}\0cap=${resolveVerifyCap(verifyCap)}`)
    .digest('hex');
}

/**
 * True if a scan result contains any verification that never ran (apiError).
 * Mirrors packages/cli/services/verify-error.ts#hasUncheckedClaim — kept local
 * so this store module has no cross-package dependency. Keep the two in sync.
 */
function hasUncheckedClaim(result: ScanResult): boolean {
  if (!result || typeof result !== 'object') return false;
  const verifications = (result as { verifications?: Record<string, unknown> }).verifications;
  if (verifications && typeof verifications === 'object') {
    for (const v of Object.values(verifications)) {
      if (v && typeof v === 'object' && (v as { apiError?: unknown }).apiError === true) return true;
    }
  }
  const claims = (result as { claims?: Array<Record<string, unknown>> }).claims;
  if (Array.isArray(claims)) {
    for (const c of claims) {
      if (c && (c as { apiError?: unknown }).apiError === true) return true;
    }
  }
  return false;
}

class ScanCache {
  private store = new Map<string, CacheEntry>();
  private _hits = 0;
  private _misses = 0;
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** `verifyCap` defaults to the engine default, the cap a scan() without options runs at. */
  get(text: string, provider: string, verifyCap: number = DEFAULT_VERIFY_CAP): ScanResult | null {
    const key = cacheKey(text, provider, verifyCap);
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

  set(text: string, provider: string, result: ScanResult, verifyCap: number = DEFAULT_VERIFY_CAP): void {
    // Never cache a scan whose verification did not run (provider quota/auth/5xx).
    // A cached error report is a served defect that survives the key/config fix —
    // it re-serves the raw failure for the full TTL. Origin: 2026-07-13 prod
    // free-tier-gemini 429 report cached + re-served. `apiError:true` is the
    // deterministic "not checked" flag every provider sets on verify failure.
    if (hasUncheckedClaim(result)) return;
    assertValidScanResult(result);
    const key = cacheKey(text, provider, verifyCap);
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
