import { assertValidScanResult } from '@nxtg/faultline/lib/verdict-guard.js';
import { createHash } from 'node:crypto';
import { isGroundingRedirect } from '@nxtg/faultline/evidence/grounding.js';
import { DEFAULT_VERIFY_CAP, resolveVerifyCap } from '@nxtg/faultline/cli/verify-cap.js';

type ScanResult = Record<string, unknown>; // opaque — cache stores whatever scan() returns

interface CacheEntry {
  result: ScanResult;
  cachedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The caller is part of the key: a result is served back only to the caller
 * that paid for it, never to another key or another user behind faultline-web's
 * server key (EP4 Amendment 2 item 7, emma-soul al:193832a732e0b82e).
 * The verify cap is part of the key: a result verified under one plan's cap
 * must never be served to a plan with a different cap. The cap is normalised
 * the way the engine normalises it, so 8 and an invalid value share an entry.
 */
function cacheKey(caller: string, text: string, provider: string, verifyCap: number): string {
  return createHash('sha256')
    .update(`${caller}\0${text}\0${provider}\0cap=${resolveVerifyCap(verifyCap)}`)
    .digest('hex');
}

/**
 * True when a result holds Gemini Grounded Results: a verdict whose retriever
 * is gemini-grounding, or a source that is a Google grounding Link. Google's
 * terms say "will not ... cache ... Grounded Results" and show them only "to
 * the end user who submitted the prompt", so such a result is never cached,
 * not even for its own caller.
 */
export function holdsGroundedResults(result: ScanResult): boolean {
  const verifications = (result as { verifications?: Record<string, unknown> }).verifications;
  if (!verifications || typeof verifications !== 'object') return false;
  for (const v of Object.values(verifications)) {
    if (!v || typeof v !== 'object') continue;
    const prov = (v as { provenance?: { retriever?: unknown; provider?: unknown } }).provenance;
    if (prov?.retriever === 'gemini-grounding' || prov?.provider === 'gemini') return true;
    const sources = (v as { sources?: Array<{ uri?: unknown }> }).sources;
    if (Array.isArray(sources) && sources.some((s) => typeof s?.uri === 'string' && isGroundingRedirect(s.uri))) return true;
  }
  return false;
}

/** A cache hit: the result as it was stored, and when it was checked. */
export interface CacheHit {
  result: ScanResult;
  /** When the cached scan ran (ISO). Shown in the response so a hit never reads as fresh. */
  checkedAt: string;
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
  get(caller: string, text: string, provider: string, verifyCap: number = DEFAULT_VERIFY_CAP): CacheHit | null {
    const key = cacheKey(caller, text, provider, verifyCap);
    const entry = this.store.get(key);
    if (!entry) { this._misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this._misses++;
      return null;
    }
    this._hits++;
    return { result: entry.result, checkedAt: new Date(entry.cachedAt).toISOString() };
  }

  /** Store a result for `caller`. Returns false when the result may not be cached. */
  set(caller: string, text: string, provider: string, result: ScanResult, verifyCap: number = DEFAULT_VERIFY_CAP): boolean {
    // Never cache a scan whose verification did not run (provider quota/auth/5xx).
    // A cached error report is a served defect that survives the key/config fix —
    // it re-serves the raw failure for the full TTL. Origin: 2026-07-13 prod
    // free-tier-gemini 429 report cached + re-served. `apiError:true` is the
    // deterministic "not checked" flag every provider sets on verify failure.
    if (hasUncheckedClaim(result)) return false;
    assertValidScanResult(result);
    if (holdsGroundedResults(result)) return false;
    const key = cacheKey(caller, text, provider, verifyCap);
    const now = Date.now();
    this.store.set(key, { result, cachedAt: now, expiresAt: now + this.ttlMs });
    return true;
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
