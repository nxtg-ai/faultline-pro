# Full scan ("deep scan" in product copy): API contract, v1

GoPMO 1.18.11.3.12 (owner fp). Consumers: faultline-web (fw, 1.18.11.3.6 copy and UI, 1.18.11.3.13 packs) and the #74 meter (faultline-web PR 74, `refundScan`, `markScanServed`, Idempotency-Key). Rulings in force: 1.18.11.3.8 (K=8 quick scan on every tier; deep mode checks every fact claim; charge `ceil(fact claims / 8)` units shown up front) as amended by emma-soul al:c747e63f2fc26683 (refund rule, section 4).

Status: **v1, agreed with fw** (fw answers al:1ec20db80705d4b2; user-ref and persistence agreed al:30b31c2bc51d9a40). v0 differences: poll only (no SSE); one active job per user, not per key; terminal jobs persisted; a stop route; reason codes per unchecked claim.

## 1. Names

`POST /scan/deep` already exists (URL evidence validation and scoring, `packages/api/src/routes/deep.ts`) and is not this. The new routes are `/scan/full/*`. Product copy can keep saying "deep scan".

## 2. Engine (packages/cli)

- `scan(..., options)` takes `mode: 'quick' | 'full'` (default `quick`, the per-tier cap from 1.18.11.3.5). `ScanOptions` is built by the server, never read from a request body.
- `full` verifies **every claim of type `fact`, any importance**, in extraction order, and ignores the cap.
- Claims of type `opinion` and `interpretation` are not verified. They are returned as **not checkable** (`verification.notCheckableClaimIds`).
- `extractForFullScan(text)` runs extraction plus the per-sentence guarantee only and returns `{ claims, factClaims, notCheckable, units: ceil(factClaims / 8) }`. This is the estimate; it costs one extraction call and no grounding.
- `verifyFullScan(claims, opts)` verifies a given claim list, so the run checks exactly the claims the estimate priced (no second extraction). It takes an `AbortSignal` (stop) and a per-job `concurrency` (4 for API jobs).
- Each claim's outcome is one of: a verdict; `apiError` with a reason code after the engine's own bounded retry (3 attempts, jittered backoff); or not attempted (job stopped).

## 3. API routes

Both POSTs sit behind `requireApiKey`, `rateLimitScan` and the provider spend cap. GET is behind `requireApiKey` only and makes no provider call.

1. `POST /scan/full/estimate` `{ text, provider? }` -> `200 { estimateId, factClaims, notCheckable, units, expiresAt, claims: [{ claimId, text }] }`, where `claims` lists the fact claims being priced, in extraction order (fw ask al:a655424881780798: the user sees what they pay to check, and fw keeps the text for the unchecked list after a restart). The extracted claims are held in memory under `estimateId` for 30 minutes (at most 1,000 estimates and 10M characters held, oldest evicted first). An estimate belongs to the key and user-ref that made it. Text is capped at 50,000 characters (fw also enforces this at its edge). Rate limited per key and per user-ref (`FAULTLINE_FULL_ESTIMATE_PER_MIN`, default 10). An extraction failure is `502 extraction_failed` with no provider text.
2. `POST /scan/full` `{ estimateId }` with header `Idempotency-Key` (required; the key fw's meter used for the charge) -> `202 { jobId, units, factClaims }`. `units` is the estimate's figure, never recomputed; fw aborts with a full refund if it differs from what it reserved.
   - A missing Idempotency-Key is `400 idempotency_key_required`; one that is not 8 to 128 characters of `[A-Za-z0-9_-]` (fw's own rule) is `400 idempotency_key_invalid`. So the key written to the ledger can never carry a URL or free text (codex F12-2).
   - A reused Idempotency-Key returns the same job, never a second run, including after a restart for a job that finished (the key is kept in the ledger row). The same key with a different `estimateId` is `409 idempotency_conflict`.
   - The job is counted once on the usage meter, when accepted.
   - An unknown or expired `estimateId` is `410 estimate_expired` (nothing charged; fw re-estimates).
   - An estimate already started under another Idempotency-Key is `409 estimate_used`.
   - A user with a queued or running job gets `409 job_running`.
   - When the API cannot write its job ledger, a new job is refused with `503 ledger_unavailable` before any spend (fw refunds the reservation), so no job starts whose finished accounting could not survive a restart.
3. `GET /scan/full/:jobId` -> `{ jobId, status: queued|running|done|stopped|failed, factClaims, checked, failed, progress: [{ claimId, status: pending|served|unserved, verdict? }], unserved: [{ claimId, reason }], units: { charged, served, refund }, resultAvailable, durable, result? }`. Verdicts appear in `progress` as they land, so the results page fills in while fw polls (about every 2 s). `checked` is the served count; `failed` counts claims that ran and failed (not `not_attempted`). `result` is present at `done` or `stopped` while the job is in memory. `durable` is true once the job is terminal and its record is on the ledger, so a restart keeps it; it is false while the job runs and for a terminal job whose ledger write failed (after one retry). **fw settles on a terminal answer when it sees one** and never waits for a later read, because a non-durable job answers `404 job_lost` after a restart (codex F12-1). `failed` status means the run could not start or the provider threw outright: served 0, so the refund is every charged unit.
4. `POST /scan/full/:jobId/stop` -> stops the job. A queued job stops at once; a running job starts no new claim and becomes `stopped` when the claims in flight finish. Claims never started are unserved (`not_attempted`).

Job lookup answers:

| Answer | Meaning | fw does |
|---|---|---|
| `200` | the job, any status | poll, or settle once terminal |
| `404 job_not_found` | not an id this API issued, or another key's job | nothing |
| `404 job_lost` | issued under 24 h ago, not in memory or the ledger: no terminal record survived a restart. Normally the job was running at the restart; rarely it finished but its ledger write failed (see residual below) | refund all charged units |
| `410 job_expired` | issued over 24 h ago | nothing (settled long before) |

**Residual (codex F12-1, ruling requested from emma-soul):** a job that finishes while the ledger disk is failing, then a restart before fw reads its terminal status, answers `job_lost` and is refunded in full although it was served. It needs two faults at once: the disk failing after the job started (the start guard refuses new jobs while it fails), and a restart before fw's next poll (about 2 s with the tab open; fw's cron otherwise). The error is in the customer's favour (a refund for delivered work, never a charge for undelivered work), the hourly check alerts fp on any write failure, and the exposure is bounded by the running jobs at that moment (at most `FAULTLINE_FULL_MAX_RUNNING`, default 4).

Anomalies (a `404 job_not_found` for an id fw got a 202 for, or `410 job_expired` for a job fw has not settled): fw settles on what it observed, `served = ceil(verdicts fw stored / 8)` (agreed al:a655424881780798).

## 4. Units and refunds (emma-soul al:c747e63f2fc26683)

- `charged = ceil(factClaims / 8)`, fixed at the estimate.
- `served = ceil(claims with a verdict / 8)`; `refund = charged - served`. Example: 31 fact claims -> 4 units; 29 with a verdict -> served 4, refund 0; 20 with a verdict -> served 3, refund 1.
- Condition 1: a verdict includes "unverified / not enough evidence" when the check ran. Only a check that failed to run is unserved, so a model abstention never refunds.
- Condition 2: the engine retries inside the job first (bounded, same backoff as the quick scan); only the final no-verdict is unserved.
- Unserved reason codes: `rate_limited` (429), `provider_unavailable` (503), `timeout`, `provider_error` (any other), `not_attempted` (job stopped or failed before the claim started).
- Condition 3 (fw's results page): "20 of 31 factual claims checked; 11 not checked (provider error); 1 unit refunded", with the unchecked claims listed. "Every factual claim checked" only when served = all. Copy goes to CE.
- The API reports `units`; **faultline-web's meter performs the refund** (one idempotent `refundScan` with op key `full-final` when the job is terminal or lost, then `markScanServed`; a cron finalizer settles abandoned jobs). The API never touches the meter.
- Condition 4: every terminal job is logged (section 5) with job id, claims charged, verdict counts and reason codes. Admin `GET /usage` returns `fullScanRefunds` over the trailing 7 days with `alert: true` when refunded units exceed 10% of charged units; fp then reports the cause to emma-soul.

## 5. Durability and data kept

- One Fly machine. Estimates and active jobs live in memory; a deploy or crash loses them (lost estimate: `410 estimate_expired`; lost running job: `404 job_lost`).
- Terminal jobs (`done`, `stopped`, `failed`) are appended to a JSONL ledger on the `faultline_ledgers` volume and reloaded on boot, so a deploy between a job finishing and fw settling it does not turn a served job into `job_lost`. Rows from the last 7 days are reloaded (the refund-rate window in section 4), but any job id older than 24 h answers `410 job_expired`; the file itself is append-only like the other ledgers. A job reloaded from the ledger returns `progress: []`.
- A ledger row holds: job id, API key id, Idempotency-Key, estimate id, finish time, fact-claim count, units, served count, verdict counts, and unchecked claim ids with reason codes. **No scan result, claim text, input text or source URL is written to disk** (user content, and Google's grounding terms forbid caching grounded output). The full result stays in memory for 24 h while the process lives; a GET for a job reloaded from the ledger after a restart returns status, units and unchecked claims with `resultAvailable: false`, so fw shows the result it already polled.
- A failed ledger write never changes a job's accounting. It is retried once, then counted (`fullScanRefunds.ledgerWriteFailures` on admin `GET /usage`); the hourly check alerts fp on any failure, and on a refund rate above 10%.
- **The user-ref is never written to disk.** It is held in memory only while the job is queued or running, to enforce one active job per user, and dropped when the job ends.

## 6. User identity: `x-faultline-user-ref`

All web traffic arrives on fw's one server key, so per-key limits cannot separate users. fw sends `x-faultline-user-ref` = hex HMAC-SHA256(server secret, `'user-ref:' + Clerk userId`), never a bare hash. It is honoured only from the server's own key (the same trust check as `x-user-tier`); from any other key it is ignored and the key counts as one user. Accepted form: 8 to 128 characters of `[A-Za-z0-9_-]`.

## 7. Cost and limits

- Each estimate's extraction and each job's verify run is logged to the scan-cost log with `kind: 'full-scan'`, so `/costs/percentiles` (quick scans only) stays comparable, and to the provider-spend ledger. Grounded Gemini prompts count toward the daily allowance alert (1,200 of 1,500) through the shared usage sink, like every other scan.
- Per-claim cost at list price is $0.0354 (2026-10-13, 25 claims, docs/research/data/verify-cost-9962558-*.json); inside Google's free 1,500 grounded prompts a day it is about $0.0027.
- The extraction-M run (docs/research/data/extraction-m/) saw up to 204 checkable claims in a 10,166-character page, so one full scan can be about 26 units; the estimate shows it before any charge.
- Concurrency 4 claims per job; one active job per user; a process-wide ceiling on running jobs (`FAULTLINE_FULL_MAX_RUNNING`, default 4), queued beyond it. So one user cannot spend the daily grounding allowance in minutes.
