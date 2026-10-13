# Full scan ("deep scan" in product copy): API contract, v0 draft

GoPMO 1.18.11.3.12 (owner fp). Consumers: faultline-web (fw, 1.18.11.3.6 copy and UI, 1.18.11.3.13 packs) and the #74 meter (faultline-web PR 74, `refundScan`, `markScanServed`, Idempotency-Key). Ruling in force: 1.18.11.3.8 (K=8 quick scan on every tier; deep mode checks every fact claim; charge `ceil(fact claims / 8)` units shown up front; refund units lost to 429 or 503).

Status: **DRAFT for fw's agreement before the API routes are built.** The engine half (section 2) does not depend on the route shape and is built first.

## 1. Names

`POST /scan/deep` already exists (URL evidence validation and scoring, `packages/api/src/routes/deep.ts`) and is not this. The new routes are `/scan/full/*`. Product copy can keep saying "deep scan".

## 2. Engine (packages/cli, built now)

- `scan(..., options)` gains `mode: 'quick' | 'full'` (default `quick`, today's path with the per-tier cap from 1.18.11.3.5).
- `full` verifies **every claim of type `fact`, any importance**, in extraction order. It ignores the cap.
- Claims of type `opinion` and `interpretation` are not verified. They are returned as **not checkable**: `verification.notCheckableClaimIds`, and the report says "N of N factual claims checked; M not checkable (opinion or interpretation)".
- `extractForFullScan(text)` runs extraction plus the per-sentence guarantee only and returns `{ claims, factClaims, notCheckable, units: ceil(factClaims / 8) }`. This is the estimate; it costs tokens, no grounding.
- `verifyFullScan(claims, onClaim)` verifies a given claim list, so the run checks exactly the claims the estimate showed (no second extraction that could change the count after the user saw the price).
- Each claim's outcome is one of: a verdict, `apiError` with the provider status (429, 503, other), or not attempted (job stopped).

## 3. API routes (proposed; fw to confirm)

All behind `requireApiKey`, `rateLimitScan` and the provider spend cap. The tier comes from `resolveEntitledTier` (server key only).

1. `POST /scan/full/estimate` `{ text, provider? }` -> `200 { estimateId, factClaims, notCheckable, units, expiresAt }`. The extracted claims are held server-side under `estimateId` for 30 minutes. Cost: one extraction call.
2. `POST /scan/full` `{ estimateId }` with header `Idempotency-Key` (the same key faultline-web's meter used for the charge) -> `202 { jobId, units, factClaims }`. A reused key returns the existing job, never a second run. An unknown or expired `estimateId` is `410 estimate_expired` (no spend).
3. `GET /scan/full/:jobId` -> `{ status: queued|running|done|stopped, factClaims, checked, failed, progress: [{ claimId, status }], units: { charged, served, refund }, result? }`. `result` is present when `status` is `done` or `stopped`.
4. Optional, if fw wants push instead of poll: `GET /scan/full/:jobId/stream` (SSE, one event per claim, then `complete`).

## 4. Units and refunds

- `charged = ceil(factClaims / 8)`, fixed at the estimate.
- A claim is **served** when it got a verdict. A claim that ended in a 429 or 503 after the engine's own retry is **unserved**.
- `served = ceil(servedClaims / 8)`; `refund = charged - served`. Example: 31 fact claims -> 4 units; 29 served, 2 lost to 429 -> served 4, refund 0; 20 served, 11 lost -> served 3, refund 1.
- The API reports `units`; **faultline-web's meter performs the refund** (`refundScan(requestId, refund)`) and then `markScanServed`. The API never touches the meter. Proposed: fw calls refund once, when `status` becomes `done` or `stopped`.
- Other provider errors (not 429 or 503) count as unserved too? **Open question for fw and emma-soul**; the ruling names 429 and 503 only. Draft: any claim without a verdict is unserved, because the user did not get the check they paid for.

## 5. Durability (v0)

The API runs on one Fly machine with an in-memory job store, like `scan-queue.ts`. A deploy or crash loses running jobs. Then `GET /scan/full/:jobId` returns `404 job_lost`, and faultline-web refunds **all** charged units for that request. Jobs and estimates are not persisted in v0; a persisted queue on the `faultline_ledgers` volume is a follow-up if job loss is seen.

## 6. Cost and limits

- Cost per full scan is logged to the scan-cost log with `kind: 'full-scan'` and the fact-claim count, so `/costs/percentiles` (scans only) stays comparable. Per-claim cost at list price is $0.0354 (2026-10-13, 25 claims, docs/research/data/verify-cost-9962558-*.json); inside Google's free 1,500 grounded prompts a day it is about $0.0027.
- Input stays capped at 50,000 characters. The extraction-M run (docs/research/data/extraction-m/) saw up to 204 checkable claims in a 10,166-character page, so a full scan can be about 26 units; the estimate shows it before any charge.
- Concurrency per job 4, one job per key at a time (a second start is `409 job_running`), so one user cannot exhaust the daily grounding allowance in minutes.
