# Provider-Spend Cap — $100/mo, Ledgered (A-110 item 1)

**Status**: MECHANISM + LEDGER SHIPPED. **Enforcement DORMANT by default** — flipping the gate on is Asif's one-env-var call.
**Founder ruling**: A-110 REC position 1 adopted 2026-07-19 (Emma-PM routed) — *"$100/mo provider-spend cap, ledgered (geo-grader append-only pattern)."*
**Canon**: `~/.claude/rules/deterministic-grounded-autonomy.md` §GROUNDED — *provision/spend freely up to a standing per-scope cap, no per-item ask; log every transaction. Only crossing the cap escalates.*
**Tracking**: NEXUS N-230.

## Why this exists

The cap is not a restriction on the agent — it is the **enabler**. Faultline may run consensus scans (and the retrieval-cost spike, `DIRECTIVE-NXTG-20260704-01`) without a per-scan ask *precisely because* every dollar lands in an append-only ledger and the ceiling is mechanical rather than a matter of judgment. Measured economics: a consensus scan costs **$0.20–0.71** (`docs/unit-economics-MEASURED-2026-07-04.md`), ~88–91% of it web-search retrieval.

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
| Wired on all scan routes | `routes/scan.ts` (`/scan`, `/scan/template`), `routes/stream.ts` (`/scan/stream` GET+POST) |
| Spend recorded from the real composed cost | `recordProviderSpend(costEvent)` beside `emitScanCostEvent` / `appendScanCostLog` |
| Budget surface (ADMIN only) | `GET /usage` → `providerBudget: { month, enforced, capUsd, spentUsd, remainingUsd, exhausted }` |
| Tests (27) | `packages/api/tests/provider-spend-cap.test.ts` |

## Semantics

- **The ledger is the authority; memory is the index.** The in-process month total is lazily **hydrated by summing the ledger file**, so a restart/redeploy does not silently reset the budget to $0 — the known in-memory limitation `docs/usage-cap.md` flags for `UsageMeter`. Hydration runs once per month-key per process and always precedes the first in-process increment, so a row is never double-counted.
- **Append-only, synchronous, guarded.** A spend row is money: read-after-write must hold within a process, so the write is `appendFileSync`. It is wrapped — **a failed ledger write never fails a scan**; the in-memory total still moves (the cap still holds) and `getWriteFailures()` surfaces the drift instead of hiding it.
- **Single source of cost.** The ledger records the `ManagedScanCostEvent` the BLG-005 cost path already composes (real provider-reported usage, priced per real model). No second estimate, so no third-parallel-table drift.
- **No per-request exemption — every API scan is our spend.** Provider credentials come only from server env (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`); **there is no BYOK path through this API**, so nothing a caller can say exempts a scan from the ledger or the cap. In particular the `userkey` tier label does **not**: `x-user-tier` is a caller-supplied header (FW forwards it for telemetry classification) and `userkey` is a valid value, so keying a money decision off it would let any authenticated caller opt out of the budget for the price of one header — and leave real spend unledgered, which is exactly what the A-110 ruling forbids. `tier` is ledgered as a **label** for analytics and never read as a spend decision. Regression-tested: a spoofed `x-user-tier` still gets 503, and a `userkey`-labelled cost event is still ledgered.
- **Zero-cost scans are not ledgered.** Cache hits, `mock`, and all-error scans compose to $0; a non-finite or negative cost is rejected rather than poisoning the total.
- **No PII.** A row is `{ ts, scanId, month, tier, provider, modelId, costUsd }` — no keyId, no text.
- **Deny-path headers only.** `/scan/stream` hijacks the reply for SSE, which drops every `reply.header()` (see `reference_fastify_hijack_drops_headers`), so allow-path budget headers would be a lie on the streaming routes. Read the position from `GET /usage` instead.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `FAULTLINE_PROVIDER_SPEND_CAP` | *(off)* | `on`/`1`/`true`/`enabled` activates the **gate**. Dormant = ledger only. |
| `FAULTLINE_PROVIDER_SPEND_CAP_USD` | `100` | The monthly ceiling. Garbage/negative falls back to `100` — never to unlimited. |
| `FAULTLINE_PROVIDER_SPEND_LEDGER` | `/var/log/faultline/provider-spend.jsonl` | Ledger path. |

## Activation checklist (Asif's flip)

1. Confirm the ledger is recording: `GET /usage` with an admin key → `providerBudget.spentUsd` advancing.
2. (Optional) set `FAULTLINE_PROVIDER_SPEND_CAP_USD` if the ceiling changes from the ruled $100.
3. Set `FAULTLINE_PROVIDER_SPEND_CAP=on` on the Fly app.
4. Verify: `providerBudget.enforced: true`; an over-budget scan returns **503** with `X-Provider-Spend-Cap` / `X-Provider-Spend-Used` / `Retry-After`.

## Known limitations

- **Ledger durability follows the Fly filesystem.** `/var/log/faultline` is not a mounted volume today, so a machine replacement loses history and hydration restarts from an empty file (the cap then re-opens for that month). Same durable-store gap as N-226/D1; the ledger path is env-pointable at a volume the moment one exists.
- **Per-process, not per-fleet.** Multiple API machines each hydrate the same ledger path but only see their own in-flight rows until the next hydration, so a multi-machine fleet can overshoot the cap by up to the concurrent in-flight spend. Single-machine today; a shared-store rollup closes it.
- **Managed API path only.** CLI scans run on the user's own key and are out of scope by construction.
