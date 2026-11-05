# Provider-Spend Cap — $100/mo, Ledgered (A-110 item 1)

> **Asif ruling 2026-10-01 (verbatim): "no spend cap.. if we are making money.. we can afford it".** The cap stays dormant (`FAULTLINE_PROVIDER_SPEND_CAP` unset). The ledger keeps recording, and the grounding-allowance alert (docs/grounding-allowance-alert.md) is the cost signal instead. Known limit: ledger and grounding counts reset on each deploy until a Fly volume is mounted.


**Status**: MECHANISM + LEDGER SHIPPED. **Enforcement DORMANT by default** — flipping the gate on is Asif's one-env-var call.
**Founder ruling**: A-110 REC position 1 adopted 2026-07-19 (Emma-PM routed) — *"$100/mo provider-spend cap, ledgered (geo-grader append-only pattern)."*
**Canon**: `~/.claude/rules/deterministic-grounded-autonomy.md` §GROUNDED — *provision/spend freely up to a standing per-scope cap, no per-item ask; log every transaction. Only crossing the cap escalates.*
**Tracking**: NEXUS N-230.
**Production state (2026-10-01)**: the ledger is recording and the gate is **dormant**. `GET /usage` with an admin key returned `providerBudget.enforced=false` on 2026-10-01 (observed by fp during the N-230 `/critique` deploy check; not re-probed while writing this doc, because no admin key is available in the doc-sweep session).

## Why this exists

The cap is not a restriction on the agent — it is the **enabler**. Faultline may run consensus scans (and the retrieval-cost spike, `DIRECTIVE-NXTG-20260704-01`) without a per-scan ask *precisely because* every dollar lands in an append-only ledger and the ceiling is mechanical rather than a matter of judgment. Measured economics: a consensus scan costs **$0.20–0.71** (`docs/unit-economics-MEASURED-2026-07-04.md`), ~88–91% of it web-search retrieval.

## Who the cap refuses: free and anonymous traffic only

Once the month's budget is spent and enforcement is on, the gate refuses **free** and **anonymous** callers with the 503 below. Every other tier (`personal`, `pro`, `enterprise`) passes this gate. Paid keys are bounded by their own per-key limits instead: the per-minute burst limiter and the monthly scan quota. The fleet budget protects runway from traffic that no plan pays for.

The tier is the **trusted** tier (`resolveSpendCapTier` in `packages/api/src/plugins/provider-spend-cap.ts`, built on `resolveEntitledTier`):

| Caller | Tier for this gate |
|---|---|
| No API key | `anon`. Every gated route checks the key first, so this case is defensive. |
| The server's own key (`FAULTLINE_API_KEY`) with `x-user-tier` | the forwarded plan. An unknown value counts as `free`, and so does `userkey`: there is no way to bring a provider key through the API, so such a scan spends Faultline's keys. |
| The server's own key, no `x-user-tier` (absent or empty) | `free` |
| A keystore key with the `pro` permission | `pro` |
| A keystore key with the `admin` permission | `enterprise` (an operator key) |
| Any other keystore key | `free`, the same tier the rate limiter and the monthly quota give it |
| The measurement key (`FAULTLINE_MEASUREMENT_KEY`) | `measurement`, which this gate never refuses. Its `x-user-tier` is ignored. See "The measurement key" below. |

A server-key request with no tier header is treated as free for this gate, because the caller cannot be told apart from free traffic; paid callers through the server key must send their tier.

`x-user-tier` from any key other than the server's own is ignored, so a free key that sends `x-user-tier: pro` is still refused. `resolveTierFromRequest` (in `store/costs.ts`) trusts that header from every caller and must never feed this gate.

### Routes that carry the gate

Every HTTP route whose handler can cause a model provider call runs `enforceProviderSpendCap` as a preHandler, after the key check and before any provider work:

| Route | File |
|---|---|
| `POST /scan`, `POST /scan/template/:id` | `routes/scan.ts` |
| `GET /scan/stream`, `POST /scan/stream` | `routes/stream.ts` |
| `POST /scan/full/estimate`, `POST /scan/full` | `routes/full-scan.ts` |
| `POST /scan/deep` | `routes/deep.ts` |
| `POST /scan/diff` | `routes/diff.ts` |
| `POST /scan/batch` | `routes/batch.ts` |
| `POST /scan/bulk` | `routes/bulk.ts` |
| `POST /scan/upload` | `routes/upload.ts` |
| `POST /scan/report` | `routes/report.ts` |
| `POST /scan/eu-report` | `routes/eu-report.ts` |
| `POST /scan/compliance/:template` | `routes/compliance.ts` |
| `POST /scan/compliance-gate` | `routes/compliance-gate.ts` |
| `POST /critique` | `routes/critique.ts` |
| `POST /admin/verify-claims` | `routes/admin-verify.ts` |
| `POST /queue/scans` (queues a scan) | `routes/queue.ts` |
| `POST /jobs` (creates a recurring scan) | `routes/jobs.ts` |
| `POST /schedules` (creates a recurring scan), `POST /schedules/:id/trigger` (runs one now) | `routes/schedules.ts` |

GraphQL (`/graphql`, on only with `FAULTLINE_GRAPHQL=on`) serves reads and key administration too, so the route itself is not gated. Its `scan` query and `scanBatch` mutation run the same check before the scan, with the tier read from the request, and answer a GraphQL error with `extensions.reason: "provider_budget_exhausted"`.

`packages/api/tests/provider-spend-cap-coverage.test.ts` keeps this list honest. It builds the app, collects every registered route, and fails if a route is neither gated nor on its commented list of routes that never call a provider (health, usage, keys, compare of supplied results, stored-scan reads and so on). A new route that is on neither list fails the test by name.

### Background runs: the queue worker, scheduled jobs, schedules, bulk files and queued full scans

These run with no request, so the route gate cannot see them at run time. The rule:

1. When the work is queued or created (`POST /queue/scans`, `POST /jobs`, `POST /schedules`, `POST /scan/bulk`, `POST /scan/full`), the gate tier from `resolveSpendCapTier` is stored with it, in a private store or field that no response carries. The creating route also runs the gate, so a capped caller cannot queue new work once the budget is spent. A full-scan job also stores a `tier` for cost logging, from `resolveEntitledTier`; it reads a server-key call with no header as enterprise, so it is never used for this decision.
2. When the work runs, before any provider call (and, for a URL schedule, before the URL fetch): if enforcement is on, the stored tier is one the gate refuses, and the month's budget is spent, the run is skipped and marked failed with the reason `provider_budget_exhausted`. No provider is called.
   - Queue item: `status: "failed"`, `error: "provider_budget_exhausted"`.
   - Scheduled job: `lastError: "provider_budget_exhausted"`, the next run time moves on, `runCount` does not change, and a `job.failed` webhook event carries the same reason.
   - Schedule: a history entry with `error: "provider_budget_exhausted"`, a `scan.failed` notification, and the skipped run does not count toward `maxRuns`.
   - Bulk ZIP (`POST /scan/bulk`): the check runs before each file. Once it refuses, that file and every remaining one get `status: "failed"`, `error: "provider_budget_exhausted"`, and the job completes. Files already scanned keep their results.
   - Queued full scan (`POST /scan/full`): at most `FAULTLINE_FULL_MAX_RUNNING` jobs run (default 4) and the rest wait. The check runs when a waiting job would start. A refused job ends `failed` without a provider call, fully refunded, with every claim unserved under reason `provider_budget_exhausted`; admin `GET /usage` counts it in `fullScanRefunds.reasons`.
3. An entry created before tiers were stored has none. It counts as capped, so it is skipped while the budget is spent.
4. Paid tiers run as before, and nothing is skipped while enforcement is off.

The shared check is `providerBudgetRefuses(tier)` in `plugins/provider-spend-cap.ts`.

`GET /usage` (admin) reports the scope as `providerBudget.appliesTo: ["free", "anon"]`.

The alert at 90% and 100% of the budget is in `scripts/grounding-allowance-check.mjs` (see `docs/grounding-allowance-alert.md`). A `GET /usage` response with no `providerBudget` object is a probe failure there (exit 2, a `PROBE_FAIL` row), not a silent skip, because the budget alert would otherwise be blind.

## Not the same thing as the usage cap

Three gates now run in front of a scan. They answer different questions and all three can be active:

| Gate | Scope | Protects | Code |
|---|---|---|---|
| `rateLimitScan` | per-key, per-**minute** burst | abuse | 429 |
| `enforceMonthlyCap` (N-228) | per-**customer** monthly **scan quota** | gross margin on the $19 tier | 402 |
| `enforceProviderSpendCap` (this) | **fleet** monthly **USD at providers** | runway | 503 |

**503, not 402.** The budget is Faultline's, not the caller's. The customer did nothing wrong and there is nothing for them to buy; capacity is temporarily gone and returns at the month boundary, so `Retry-After` points there.

## What shipped (reversible — ledger only, no enforcement, no spend)

| Piece | File |
|---|---|
| Append-only USD ledger + monthly rollup + cap config | `packages/api/src/store/provider-spend.ts` |
| Enforcement prehandler (503 + budget headers) | `packages/api/src/plugins/provider-spend-cap.ts` — `enforceProviderSpendCap` |
| Wired on every provider-calling route | see "Routes that carry the gate" above |
| Background runs check the stored tier | `store/scan-queue.ts`, `store/jobs.ts`, `store/schedules.ts`, `routes/bulk.ts`, `store/full-scan-jobs.ts`, `graphql/resolvers.ts` |
| Wired on `POST /critique` (b33acff) | `routes/critique.ts`: `preHandler: [requireApiKey, rateLimitScan, enforceProviderSpendCap]`, and the call's real usage is priced and ledgered |
| Spend recorded from the real composed cost | `recordProviderSpend(costEvent)` beside `emitScanCostEvent` / `appendScanCostLog` |
| Budget surface (ADMIN only) | `GET /usage` → `providerBudget: { month, enforced, capUsd, spentUsd, remainingUsd, exhausted, appliesTo, ledgerWriteFailures }` |
| Tests | `packages/api/tests/provider-spend-cap.test.ts`, `packages/api/tests/critique-spend-cap.test.ts`, `packages/api/tests/provider-spend-cap-tiers.test.ts` (who is refused, per route), `packages/api/tests/provider-spend-cap-coverage.test.ts` (every route is gated or listed as provider-free; each gated route refuses a free key with no provider call), `packages/api/tests/provider-spend-cap-background.test.ts` (queue, jobs, schedules, GraphQL), `packages/api/tests/provider-spend-cap-rechecks.test.ts` (bulk files, queued full scans, `userkey`, no tier in any response), `packages/api/tests/grounding-allowance-check.test.ts` (the 90% and 100% alert) |

## `POST /critique` is covered (b33acff, N-230)

`/critique` makes a paid LLM call on our provider keys. Before b33acff it sat behind the API key only, so the cap could neither see nor stop its spend.

- It runs the same per-minute burst limiter (`rateLimitScan`, shared bucket with scans) and `enforceProviderSpendCap` as a scan. With enforcement on and the budget exhausted it returns 503 to free and anonymous callers and never calls the provider.
- The call's reported usage is priced and appended to the ledger through `recordProviderSpend`, so critique spend counts toward the monthly total even while the gate is dormant.
- A request with no failed claims makes no LLM call and writes no ledger row.
- It does **not** run `enforceMonthlyCap`. A critique is not a scan, so it does not use up a customer's monthly scan quota.
- `provider` is limited to the `/scan` allowlist (`gemini`, `openai`, `claude`, `perplexity`, `mock`). An unknown name returns 400, not 500. The default when omitted is `openai`.

## Semantics

- **The ledger is the authority; memory is the index.** The in-process month total is lazily **hydrated by summing the ledger file**, so a restart/redeploy does not silently reset the budget to $0 — the known in-memory limitation `docs/usage-cap.md` flags for `UsageMeter`. Hydration runs once per month-key per process and always precedes the first in-process increment, so a row is never double-counted.
- **Append-only, synchronous, guarded.** A spend row is money: read-after-write must hold within a process, so the write is `appendFileSync`. It is wrapped — **a failed ledger write never fails a scan**; the in-memory total still moves (the cap still holds) and `getWriteFailures()` surfaces the drift instead of hiding it.
- **Single source of cost.** The ledger records the `ManagedScanCostEvent` the BLG-005 cost path already composes (real provider-reported usage, priced per real model). No second estimate, so no third-parallel-table drift.
- **No caller-supplied exemption — every API scan is our spend.** The gate's scope is set by the trusted tier (see "Who the cap refuses"), never by anything the caller sends. Provider credentials come only from server env (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`); **there is no BYOK path through this API**, so nothing a caller can say exempts a scan from the ledger or the cap. In particular the `userkey` tier label does **not**: `x-user-tier` is a caller-supplied header (FW forwards it for telemetry classification) and `userkey` is a valid value, so keying a money decision off it would let any authenticated caller opt out of the budget for the price of one header — and leave real spend unledgered, which is exactly what the A-110 ruling forbids. `tier` is ledgered as a **label** for analytics and never read as a spend decision. Regression-tested: a free key with a spoofed `x-user-tier` still gets 503, and a `userkey`-labelled cost event is still ledgered.
- **Zero-cost scans are not ledgered.** Cache hits, `mock`, and all-error scans compose to $0; a non-finite or negative cost is rejected rather than poisoning the total.
- **No PII.** A row is `{ ts, scanId, month, tier, keyClass, provider, modelId, costUsd, claimCount, verifiedCount }`, plus `stage: "extraction"` on a full-scan estimate's row — no keyId, no text.
- **Key class on every row.** `keyClass` says who the money was spent for, decided from the authenticated key where the row is built (`classifyKeyId` in `plugins/auth.ts`): `measurement` for the measurement key; `internal` for the server key (`FAULTLINE_API_KEY`, which faultline-web holds) and keystore keys with the `admin` permission; `customer` for every other keystore key (a deleted key's id still reads as customer); `anonymous` for a request or background run with no key. It is a class, never the key's id. Every writer sets it: every route and runner that goes through `scanWithSpend` (scan, template scan, stream, deep, diff, batch, report, EU report, compliance, compliance gate, upload, bulk, the queue, schedules, jobs, GraphQL), the full-scan estimate (extraction) and job, `POST /critique` and `POST /admin/verify-claims`. `recordProviderSpend` requires it, so a new writer cannot leave it out. Rows written before the field existed have none and read as `unlabelled` in `GET /admin/cost-summary`. Like `tier`, it is a label only: the cap, hydration and the monthly total never read it.
- **`stage: "extraction"`** marks a full-scan estimate's row: that call only extracts, and its claims are counted again by the job that verifies them, so `GET /admin/cost-summary` counts its cost but not its `claimCount`.
- **Claim counts on every row.** `claimCount` is how many claims the call handled (extracted by a scan or a full-scan estimate, submitted to admin verify-claims, verified by a full-scan job); `verifiedCount` is how many of those got a billable verdict (`isBillableVerdict` in `packages/cli/lib/verdict-guard.ts`). A claim is billable only when its sources were retrieved by the engine, so all four must hold: the verdict is supported, contradicted or mixed; `sources` has at least one entry; `provenance.retriever` is a non-empty string; and it is not an `apiError` claim. The engine alone sets `provenance.retriever`: the verify runner sets it from its own table of retrievers by the provider id it resolved (today only `gemini`, as `gemini-grounding`), and the consensus engine sets its own retriever's name. A retriever a provider writes on its own verdict is dropped, on a scan and on `POST /admin/verify-claims` alike. So `unverified`, a zero-source verdict, and a single-provider verdict from `mock`, `openai`, `claude` or `perplexity` (none has an engine retriever) are never billable. Cost per claim is `costUsd / claimCount` or `costUsd / verifiedCount`, read straight off the row. Critique handles no claims and writes `0` and `0`. Both are `null` only on a row whose cost event carried no counts; rows written before the fields existed have neither key. Neither field is read by hydration, so the monthly total is unchanged by them and old rows still count toward it.
- **Deny-path headers only.** `/scan/stream` hijacks the reply for SSE, which drops every `reply.header()` (see `reference_fastify_hijack_drops_headers`), so allow-path budget headers would be a lie on the streaming routes. Read the position from `GET /usage` instead.

## The measurement key

Internal measurement runs (the Accuracy G0 workflow, `scripts/accuracy-g0.mjs`, and `scripts/measure-cost-per-claim.mjs`) call the hosted API with their own key, `FAULTLINE_MEASUREMENT_KEY`, not with the server key `FAULTLINE_API_KEY` that faultline-web uses. Two services then never share one credential, and measurement spend can be read apart from web traffic.

- **Who it is.** A constant-time match on `x-api-key` sets `keyId` `measurement` (`packages/api/src/plugins/auth.ts`). An empty or unset value never matches. A value equal to `FAULTLINE_API_KEY` is refused as a measurement key: the API logs one fixed warning at startup (never the value) and that key stays the server key only.
- **What it may call.** Only `POST /admin/verify-claims` and `GET /usage` (`MEASUREMENT_ROUTES` in `auth.ts`, one allowlist). Every other route answers it with 403: the other admin routes, every scan and data route, the public routes and unmatched URLs. A server-wide `onRequest` hook enforces this before any other check, and `requireApiKey` and `requireAdmin` check the same list. `packages/api/tests/measurement-key.test.ts` enumerates every registered route and proves it.
- **Not the server key, not admin.** `isServerKeyId('measurement')` and `isAdminKeyId('measurement')` are false, so `x-user-tier` from it is ignored by every tier resolver, and it reads nothing fleet-wide beyond the budget below. No caller can forward `x-user-tier: measurement`: it is not a plan.
- **Labelled spend.** Every tier resolver gives it the tier `measurement`. Its rows in the provider-spend ledger (`tier`), the scan-cost log (`user_tier`) and the cost store carry `measurement`, where the admin key's rows carry `enterprise`.
- **Budget reads.** `GET /usage` shows it `providerBudget` and `groundingAllowance`, as it does the admin key, since both runners stop themselves on them. `fullScanRefunds` stays admin only.
- **This gate never refuses it.** The runners keep their own client-side spend caps (`measure-cost-per-claim.mjs --cap-usd`, default 40) and the daily grounded-prompt guard. Accuracy G0 in branch mode does not use the measurement key at all: its branch engine stops the run with this gate set to USD 28, which an exempt key would bypass, so the branch engine and the branch runner step get only the admin key.
- **`GET /health` is read without a key.** It is public, and the measurement key gets 403 there, so both runners send that one read with no key header.
- **Burst limit.** 600 requests per minute (`store/ratelimit.ts`, tier `measurement`), so back-to-back single-claim requests are not throttled. Its monthly scan quota is unlimited; it cannot call a scan route anyway.

How it is set:

1. Make a fresh random value (for example `openssl rand -hex 32`); never reuse the server key.
2. Store it as the repo secret `FAULTLINE_MEASUREMENT_KEY` (GitHub repo settings, or `gh secret set FAULTLINE_MEASUREMENT_KEY`).
3. Copy it to the app: `gh workflow run fly-ops.yml -f action=measurement-key-set`. The action reads the secret through env, fails and changes nothing if it is empty, and never echoes it. Setting a secret restarts the machine. `-f action=measurement-key-unset` removes it. Dispatch no measurement run between steps 2 and 3: the runners would send a key production does not know yet and get 401.
4. For a local run of `scripts/measure-cost-per-claim.mjs`, export `FAULTLINE_MEASUREMENT_KEY` or put a `FAULTLINE_MEASUREMENT_KEY=` line in `~/.config/faultline/measurement-key.env`.

When no measurement key is set, both runners fall back to the admin key and print a warning that the run is not labelled; its spend rows then read `enterprise`, like any other admin-key call.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `FAULTLINE_PROVIDER_SPEND_CAP` | *(off)* | `on`/`1`/`true`/`enabled` activates the **gate**. Dormant = ledger only. |
| `FAULTLINE_PROVIDER_SPEND_CAP_USD` | `100` | The monthly ceiling. Only a finite number from 0 to 1000 inclusive is accepted. Anything else (not a number, trailing text, negative, above 1000, or set but empty) falls back to `100` and logs one warning that does not repeat the value. Unset is silent. |
| `FAULTLINE_PROVIDER_SPEND_LEDGER` | `/var/log/faultline/provider-spend.jsonl` | Ledger path. |
| `FAULTLINE_MEASUREMENT_KEY` | *(unset)* | The measurement key (above). Unset or empty: no measurement key. |

## Activation checklist (Asif's flip)

1. Confirm the ledger is recording: `GET /usage` with an admin key → `providerBudget.spentUsd` advancing.
2. Turn it on through `.github/workflows/fly-ops.yml` (there is no flyctl login outside GitHub Actions): `gh workflow run fly-ops.yml -f action=spend-cap-on -f spend_cap_usd=100`. The `spend_cap_usd` input is the monthly ceiling, a whole number from 1 to 1000 (default `100`, the ruled ceiling); any other value fails the run and changes nothing. The action sets `FAULTLINE_PROVIDER_SPEND_CAP=on` and `FAULTLINE_PROVIDER_SPEND_CAP_USD` in one `flyctl secrets set`, so it is one release (the machine restarts once). Once the month's budget is spent, the gate refuses **free and anonymous traffic only**; `personal`, `pro` and `enterprise` keep scanning.
3. To turn it off: `gh workflow run fly-ops.yml -f action=spend-cap-off`. It unsets both secrets, which returns the gate to dormant (ledger only) and the ceiling to the default $100.
4. Verify: `providerBudget.enforced: true`; an over-budget scan from a free or anonymous caller returns **503** with `X-Provider-Spend-Cap` / `X-Provider-Spend-Used` / `Retry-After`. Paid callers keep scanning.
5. Paid traffic is bounded only by its per-key limits. The monthly scan quota (`FAULTLINE_USAGE_CAP`) is a separate switch and is dormant by default, and `POST /critique`, `POST /scan/full/estimate`, `POST /scan/full` and `POST /admin/verify-claims` do not run it. Decide whether to switch the quota on at the same time.

## Known limitations

- **Ledger durability follows the Fly filesystem.** `/var/log/faultline` is not a mounted volume today, so a machine replacement loses history and hydration restarts from an empty file (the cap then re-opens for that month). Same durable-store gap as N-226/D1; the ledger path is env-pointable at a volume the moment one exists.
  - **Correction (2026-10-01, N-230 grounding work):** this ledger does **not** survive a redeploy either. A Fly deploy replaces the machine's root filesystem, so the "a redeploy cannot reset the budget" claim above holds only for a process restart on the same machine. Worse, the image ran as the non-root `faultline` user and never created `/var/log/faultline`, so writes most likely failed and the budget lived in memory only. The Dockerfile now creates the directory, and `GET /usage` → `providerBudget.ledgerWriteFailures` shows whether writes succeed. A Fly volume is the real fix; see `docs/grounding-allowance-alert.md`, Durability.
- **Per-process, not per-fleet.** Multiple API machines each hydrate the same ledger path but only see their own in-flight rows until the next hydration, so a multi-machine fleet can overshoot the cap by up to the concurrent in-flight spend. Single-machine today; a shared-store rollup closes it.
- **Managed API path only.** CLI scans run on the user's own key and are out of scope by construction.
