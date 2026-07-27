# Monthly Usage Cap — Paid-Tier Margin Protection (COGS gate, item 1)

**Status**: MECHANISM SHIPPED, **DORMANT by default**. Activation + the cap NUMBER are Asif's pricing call.
**Tracking**: unblocks Wolf's A-104 Faultline paid-conversion push. NEXUS N-228.
**Why**: `docs/unit-economics-MEASURED-2026-07-04.md` — a consensus scan costs **$0.20–0.71** (~88–91% is web-search retrieval). A flat $19/mo tier goes **gross-margin-negative above ~27–95 scans/mo**. This cap bounds a paid user's monthly scans so the tier stays margin-positive.

## What shipped (reversible, no go-live, no spend)

| Piece | File |
|---|---|
| Monthly scan count | `packages/api/src/store/usage.ts` — `UsageMeter.getMonthlyCount(keyId, month?)` |
| Per-tier cap config (env-overridable, dormant flag) | `packages/api/src/store/entitlements.ts` |
| Enforcement prehandler (402 + quota headers) | `packages/api/src/plugins/usage-cap.ts` — `enforceMonthlyCap` |
| Wired on all scan routes | `routes/scan.ts` (`/scan`, `/scan/template`), `routes/stream.ts` (`/scan/stream` GET+POST) |
| Remaining-quota surface | `GET /usage` → `quota: { tier, enforced, limit, used, remaining, resetEpoch }` |
| Tests (18) | `packages/api/tests/usage-cap.test.ts` |

## Semantics

- **Dormant by default.** `FAULTLINE_USAGE_CAP` off → the gate is a **no-op**; deploys safely before the number/go-live is set. Turning it on is a one-env-var change, no code change.
- **Distinct from rate-limit.** `rateLimitScan` = per-**minute** burst throttle (abuse). This = per-**month** scan quota (margin). Both run.
- **Fail-safe counting.** Usage is incremented on a **successful** scan (the `server.ts` onResponse hook for `POST /scan`; local increments on stream/template which the hook doesn't cover). Failed scans and cache hits (free) don't burn quota.
- **402 on cap.** `X-Usage-Limit / X-Usage-Remaining / X-Usage-Reset` headers + a JSON body with an upgrade link. `null` cap (admin) = unlimited.

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
