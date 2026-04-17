# FR-1 — POST /scan/stream

**Priority**: HIGH  
**Filed**: 2026-04-17  
**Filed by**: faultline-web team (DIRECTIVE-NXTG-20260416-01)  
**Status**: PENDING

---

## Problem

`GET /scan/stream` delivers per-claim progressive SSE but has a hard URL-length ceiling (~2KB query string). Long texts — contracts, research papers, whitepapers, regulatory filings — exceed this limit silently or with a 414. `POST /scan` returns JSON (no streaming). True progressive per-claim delivery is blocked for any non-trivial input.

## Request

Add `POST /scan/stream` that accepts the same body as `POST /scan`:

```json
{ "text": "string", "provider": "string?" }
```

Emits the same SSE event sequence as `GET /scan/stream`:

```
data: {"type":"start","claimCount":N}

data: {"type":"claim_verified","claim":{...},"verdict":{...}}
... (one per claim, in order)

data: {"type":"complete","overallRisk":"low|medium|high|critical","trustScore":N,...}
```

On error:

```
data: {"type":"error","message":"..."}
```

No change to the existing `GET /scan/stream` or `POST /scan` — purely additive.

## faultline-web Impact

The SSE translation layer (`lib/fp-proxy.ts` — `translateFPStreamEvents()`) is already written and sitting dormant. When FR-1 ships, `app/api/scan/route.ts` switches from `fpFetch('/scan', ...)` to `fpFetch('/scan/stream', ...)` with a one-line change.

```ts
// Before (JSON → SSE conversion):
const fpResponse = await fpFetch('/scan', { text, provider: providerName }, userApiKey);

// After (native SSE proxy):
const fpResponse = await fpFetch('/scan/stream', { text, provider: providerName }, userApiKey);
// then: return new Response(translateFPStreamEvents(fpResponse, userId), { ... })
```

## Expected Behavior

| Input size | Before FR-1 | After FR-1 |
|---|---|---|
| < 2KB | GET /scan/stream works | POST /scan/stream works |
| 2KB–100KB | POST /scan (JSON, no stream) | POST /scan/stream (SSE, progressive) |
| > 100KB | Blocked by faultline-web 100KB limit | Same limit applies |

## Acceptance Criteria

- `POST /scan/stream` accepts `Content-Type: application/json` body
- Emits `start` → N × `claim_verified` → `complete` as SSE
- Each event on its own `data:` line followed by `\n\n`
- On extraction/verification error: emits `{"type":"error","message":"..."}` and closes
- Existing `GET /scan/stream` and `POST /scan` behavior unchanged
