# FR-2 — Cache Metadata in API Responses

**Priority**: MEDIUM  
**Filed**: 2026-04-17  
**Filed by**: faultline-web team (DIRECTIVE-NXTG-20260416-01)  
**Status**: PENDING

---

## Problem

The FP in-memory ScanCache (SHA-256, 24h TTL) is invisible to the caller. The only signal is the `X-Cache: HIT` response header on `POST /scan`. No timestamp, no age, no per-claim cache granularity. This means:

- faultline-web can show "result from cache" but can't show how old it is
- No confidence decay indicator (a 23h-old cache hit deserves less trust than a 1h-old one)
- Per-claim grounding freshness is invisible for the Dx3 registry
- No "N of M claims from cache" stats that reinforce trust in fast results

## Request

### 1. `POST /scan` JSON response body additions

```ts
interface ScanResponse {
  // ... existing fields ...
  cached?: boolean;       // true if result came entirely from cache
  cachedAt?: string;      // ISO-8601 timestamp of original scan
  cacheAge?: number;      // seconds since original scan
}
```

### 2. `POST /scan/stream` (FR-1) — optional cached event

Emit before `start` when the entire result is served from cache:

```
data: {"type":"cached","cachedAt":"2026-04-17T10:00:00Z","cacheAge":3600}

data: {"type":"start","claimCount":N}
...
```

### 3. Per-claim cache flag in `claim_verified` events

```ts
interface ClaimVerifiedEvent {
  type: 'claim_verified';
  claim: Claim;
  verdict: VerificationResult;
  cached?: boolean;  // true if this claim's verification was served from cache
}
```

## faultline-web Impact

With FR-2:

- `↑ result from cache (23h ago)` — age-aware cache indicator in results footer
- Per-claim `↑` badge on ClaimCards that were cache hits
- Confidence decay: cards from stale cache could show a subtle amber tint at cacheAge > 20h
- Registry stats: "7 of 9 claims from Dx3 registry" when running the same document through successive scans

Current faultline-web code (`app/api/scan/route.ts`) already reads `X-Cache: HIT` and injects `cacheHit: boolean` into the SSE stream. Extending to `cachedAt`/`cacheAge` requires only parsing the new response fields.

## Acceptance Criteria

- `POST /scan` response includes `cached`, `cachedAt`, `cacheAge` when result is from cache
- Fields are absent (not null) on cache misses
- `cacheAge` is accurate to within ±5 seconds
- Per-claim `cached` flag in `claim_verified` events reflects individual claim cache state (partial cache hits possible when only some claims are cached)
- `X-Cache: HIT` header continues to be emitted (backward compat)
