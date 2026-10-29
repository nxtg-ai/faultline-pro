# Monthly Usage Cap — Paid-Tier Margin Protection (COGS gate, item 1)

**Status**: MECHANISM SHIPPED, **DORMANT by default**. Activation + the cap NUMBER are Asif's pricing call.
**Status note (2026-10-01)**: the numbers in this doc are the placeholder defaults in `packages/api/src/store/entitlements.ts` (free 10, pro 25, admin unlimited), not the plan limits customers see. The live limits are on https://faultline.nxtg.ai/pricing (Free 5, Personal 25, Pro 500 scans per month; read 2026-10-01) and are enforced by faultline-web. This API-side gate is still dormant. Multi-model consensus is now Enterprise only (`packages/api/src/plugins/consensus-entitlement.ts`), so the consensus cost range below applies to Enterprise scans. Free, Personal and Pro run the non-consensus default, costed in `docs/unit-economics-prod-default-2026-09-30.md`.
**Tracking**: unblocks Wolf's A-104 Faultline paid-conversion push. NEXUS N-228.
**Why**: `docs/unit-economics-MEASURED-2026-07-04.md` — a consensus scan costs **$0.20–0.71** (~88–91% is web-search retrieval). A flat $19/mo tier goes **gross-margin-negative above ~27–95 scans/mo**. This cap bounds a paid user's monthly scans so the tier stays margin-positive.

## What shipped (reversible, no go-live, no spend)

| Piece | File |
|---|---|
| Monthly scan count | `packages/api/src/store/usage.ts` — `UsageMeter.getMonthlyCount(keyId, month?)` |
| Per-tier cap config (env-overridable, dormant flag) | `packages/api/src/store/entitlements.ts` |
| Enforcement prehandler (402 + quota headers) | `packages/api/src/plugins/usage-cap.ts` — `enforceMonthlyCap` (one scan), `admitMonthlyScans` (N scans) |
| Wired on every route that runs a scan in the request | see **Admission** below; `packages/api/tests/monthly-cap-route-coverage.test.ts` fails if a route that can reach a provider lacks the real `enforceMonthlyCap` (or its own named admission function) before any provider work and has no listed reason, or is checked but neither counts nor has a listed reason |
| Remaining-quota surface | `GET /usage` → `quota: { tier, enforced, limit, used, remaining, resetEpoch }` |
| Tests | `packages/api/tests/usage-cap.test.ts`, `scan-quota-billable.test.ts`, `full-scan-routes.test.ts`, `deep.test.ts`, `monthly-cap-route-coverage.test.ts` |

## Semantics

- **Dormant by default.** `FAULTLINE_USAGE_CAP` off → the gate is a **no-op**; deploys safely before the number/go-live is set. Turning it on is a one-env-var change, no code change.
- **Distinct from rate-limit.** `rateLimitScan` = per-**minute** burst throttle (abuse). This = per-**month** scan quota (margin). Both run.
- **Only a billable scan counts** (full scan aside, below). A scan counts toward the monthly quota only when the result it delivered holds at least one billable verdict: `supported`, `contradicted` or `mixed`, with at least one source, and not an API error (`billableVerdictCount` in `packages/cli/lib/verdict-guard.ts`, the same rule as the spend ledger's `verifiedCount` and full-scan served units). A scan that answered 200 but where every claim was an API error, came back `unverified`, or had no source does not count; nor does a scan that failed (any non-200), or a consensus scan refused with `consensus_unavailable`. This applies to every counter:
  - `POST /scan` and `POST /scan/upload`: counted once, by the `server.ts` onResponse hook, from the billable count the handler recorded for the result it sent (`packages/api/src/lib/scan-quota.ts`). The hook matches the route pattern, so a query string (`POST /scan?x=1`) cannot skip the count. A cache hit counts when the cached result it delivers holds a billable verdict.
  - `GET` and `POST /scan/stream`, `POST /scan/template/:id`: counted in the handler with the same rule.
  - `POST /scan/batch`: each text whose result holds a billable verdict counts one scan.
  - `POST /scan/deep`: counted once in the handler, when the result it serves holds a billable verdict. A cache hit counts the same way, like a `POST /scan` cache hit. (A Gemini-grounded result is never cached, so with the default provider every deep scan runs fresh.)
  - `POST /scan/diff`, `/scan/report`, `/scan/eu-report`, `/scan/compliance/:template`, `/scan/compliance-gate`: counted once in the handler when the result it serves holds a billable verdict. A diff counts once for its two texts. A compliance gate that fails (`422`) still served its scan and counts the same way. A failed scan, or a report whose PDF failed, counts nothing.
  - Full scan (`POST /scan/full`): **counts one scan when the job is admitted**, including if it later fails, is stopped, or serves no billable verdict. An idempotent replay of an existing job counts nothing. Counting only the work a job served waits for a later build that reserves the allowance at admission and settles it on delivery; without that reservation, counting at the end would leave a running job's slot free for another request.
  - `POST /scan/bulk`, `/queue/scans` and `/schedules/:id/trigger` check the cap (below) but do not count toward it: their work runs in a background runner, and counting it lands with the reservation build.
- **Admission.** Every route that runs a scan in the request checks the cap before any provider call, and refuses with 402 when the scans it would run take the key past its cap (`used + scans > cap`):
  - One scan: `POST /scan`, `POST /scan/upload`, `GET`/`POST /scan/stream`, `POST /scan/template/:id`, `POST /scan/deep`, `POST /scan/diff`, `POST /scan/report`, `POST /scan/eu-report`, `POST /scan/compliance/:template`, `POST /scan/compliance-gate`. On `POST /scan/upload` it runs before the file is read, so a key at its cap gets 402 without any text extraction (OCR) or provider call.
  - `POST /scan/batch`: one scan per text. When `used + texts > cap` the whole batch is refused with the same 402 body; a batch is never part-served.
  - Full scan: `POST /scan/full/estimate` (a paid extraction) and a new job on `POST /scan/full`, checked before the job is queued, and checked again in the same synchronous step that counts it. An idempotent replay of a job that already exists runs nothing and is neither checked nor counted.
  - `POST /scan/bulk`, `POST /queue/scans` and `POST /schedules/:id/trigger` check that the key is not at its cap when the request arrives. They do not reserve one scan per document or per run.
  - Not reserved: the check reads the count when the request arrives and does not hold the allowance, so two requests admitted at the same time (two batches, or two deep scans) can both be served and together go past the cap. The reservation build fixes that.
  - Not checked: `POST /jobs` and `POST /schedules` create recurring scans that a background runner runs later, and that runner has no monthly-cap check or count yet. `POST /graphql` (off unless `FAULTLINE_GRAPHQL=on`) has no check on its scan resolver. `POST /critique` is not a scan. `POST /admin/verify-claims` is admin only, and the admin tier has no cap.
- **402 on cap.** `X-Usage-Limit / X-Usage-Remaining / X-Usage-Reset` headers + a JSON body (`error`, `tier`, `limit`, `used`, `remaining`, `resetEpoch`, `upgrade`). `remaining` is what is left before the cap: 0 for a key at its cap, more for a batch larger than what is left. `null` cap (admin) = unlimited.

## The cap NUMBER — options for Asif (NOT decided here)

Present, don't decide (same pattern as the $39/user decision). Grounded in the measured $0.20–0.71/scan:

| Option | Cap | Rationale | Trade-off |
|---|---|---|---|
| **A — Conservative count cap** | Pro **25 scans/mo** @ $19 | Break-even even at worst-case $0.71/scan (19/0.71≈26); positive at typical cost | Simplest; power users may hit it |
| **B — Included + metered overage** | Pro **50 included**, then ~**$0.75/scan** overage | Protects margin while letting heavy users continue (pay-as-you-go) | Needs billing metering wiring (Stripe usage records) |
| **C — Cost-budget cap** | Pro **≤ $6 COGS/user/mo** | Caps on measured USD COGS (uses the BLG-005 real-cost surface) not scan count — most precise margin control | Variable scan count per user; needs the cost telemetry read in the gate |

Set via env once chosen: `FAULTLINE_CAP_PRO=<n>`, `FAULTLINE_CAP_FREE=<n>`, then `FAULTLINE_USAGE_CAP=on`.

## Activation checklist (when Asif picks a number)

1. Set `FAULTLINE_CAP_PRO` / `FAULTLINE_CAP_FREE` on the Fly app.
2. Set `FAULTLINE_USAGE_CAP=on`.
3. (Option B/C only) wire the metering/cost-budget path.
4. Verify: `GET /usage` shows `enforced:true` and the chosen limit; a key at cap gets 402.

## Known limitation

`UsageMeter` is **in-memory** (like the rest of the store layer) — counts reset on API restart/redeploy. For an airtight monthly cap that survives restarts, the meter needs durable backing (the D1/metrics-pipeline path, N-226). This is a cross-cutting store-layer gap, not specific to the cap; flagged for the durable-store follow-up.
