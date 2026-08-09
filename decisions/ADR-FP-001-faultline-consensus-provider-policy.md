# ADR-FP-001 — Faultline Consensus Provider Policy

**Status**: **DRAFT — awaiting Asif ratification.** Nothing in this ADR is in force until ratified; the mechanisms it describes ship dormant.
**Date drafted**: 2026-08-09
**Author**: fp (Faultline team)
**Asked for by**: A-110 item 4 — *"Draft `decisions/ADR-xxx-faultline-consensus-provider-policy.md` → Asif ratify (default models, $100 cap, model-currency ownership, quarterly review, provider set)."*
**Numbering note**: scoped `ADR-FP-001` deliberately. `~/ASIF/decisions/` is at ADR-070 and fp does not own that sequence; a project-local ADR claiming a global number would collide. If Asif wants this in the portfolio registry it becomes ADR-071 on ratification.

## Context

Faultline's v0.9.0+ verdict engine is a multi-model **consensus fan-out**: 1 extraction + K claims × (1 retrieval + N grounded voters). Cost is therefore not a single provider bill but a composed one, and the retrieval leg dominates it — **88–91% of scan cost**, measured (`DIRECTIVE-NXTG-20260704-01`; $0.20–0.71/scan, `docs/unit-economics-MEASURED-2026-07-04.md`).

Three things were undecided and each has bitten:

1. **Who may spend, and how much, without asking.** Un-ledgered provider spend on an autonomous scan path is an open-ended liability against runway.
2. **Who owns model currency.** Model SKUs turn over fast. The repo's pinned rate table dated 2026-07-03; by 2026-08-09 a named target model's search path had been **shut down** (2026-07-23) and a competitor SKU had introduced a **time-boxed** introductory price expiring 2026-08-31. Stale defaults are not a documentation problem — they are a cost and correctness problem.
3. **Which providers are in the consensus set at all**, and on what basis one is added or dropped.

Founder REC positions on all four were adopted 2026-07-19 (A-110, Emma-PM routed). This ADR records them as policy for ratification.

## Decision

### 1. Provider spend is capped at $100/month and every transaction is ledgered

Faultline may provision and spend at providers **up to $100/month without a per-item ask**. Every spend event lands in an **append-only ledger**. Only *crossing* the cap escalates.

This follows `~/.claude/rules/deterministic-grounded-autonomy.md` §GROUNDED: the cap is an **enabler**, not a restriction. Autonomous scanning is legitimate precisely because the ceiling is mechanical and the record is complete.

- Implementation: `packages/api/src/store/provider-spend.ts` + `plugins/provider-spend-cap.ts` (shipped `ddd7bd6`).
- The **ledger is the authority**; the in-process total is hydrated from it, so a redeploy cannot silently reset the budget.
- **Enforcement ships DORMANT** (`FAULTLINE_PROVIDER_SPEND_CAP=on`). Ledgering is reversible and always on; *refusing production scans* is new outward behavior and is Asif's flip.
- BYOK (`userkey`) scans spend the customer's key and are outside this budget.
- Raising the cap is Asif's decision, not the team's. Docs: `docs/provider-spend-cap.md`.

### 2. fp owns implementation and model currency

The Faultline team owns the consensus implementation **and** the currency of its model defaults and rate tables. Concretely, fp is accountable for:

- the model IDs the engine calls (`packages/cli/providers/*`);
- `CONSENSUS_MODEL_RATES` in `packages/api/src/store/consensus-cost.ts` agreeing with published vendor pricing;
- the replay gate that keeps that table and the harness's `LIVE_RATES` from silently re-diverging.

Ownership is of the **proposal and the maintenance**, not of the decision: a model-default change that moves cost or verdict quality is proposed with primary-source pricing and flipped by Asif.

### 3. Quarterly model-currency review

Every quarter, fp re-verifies against **primary vendor pricing pages** (never memory, never the repo's own pins) and reports:

- each engine default vs. the current-generation equivalent;
- every rate in `CONSENSUS_MODEL_RATES` vs. published rates, with drift called out;
- deprecations, shutdown dates, and **expiring introductory prices** (a rate with an end date is a scheduled cost increase);
- the resulting proposal, if any, as an options table for Asif.

Next review due: **2026-11-09**. Any dated vendor change lands out-of-cycle — the 2026-08-31 Sonnet 5 introductory expiry is already logged in `docs/asif-consensus-sku-proposal-2026-08-09.md`.

Rationale for a fixed cadence: the 2026-08-09 probe found a live default (`gpt-4o`) one generation stale and a directive's own target model's search path already retired. Nobody was negligent — there was no cadence.

### 4. Provider set

In the consensus set today: **OpenAI** (retrieval via the Responses `web_search` tool + a grounded voter), **Google Gemini** (extraction + a voter), **Anthropic Claude** (a voter). Perplexity exists as an adapter but is **not a default voter** and is **not** in `CONSENSUS_MODEL_RATES` — so its spend would land unpriced. Either price it or leave it non-default; do not quietly promote it.

Admission criteria for adding a provider to the default set:
1. an adapter that reports **real token usage** into the ALS usage sink (an unmeasurable provider cannot be ledgered, and defeats decision 1);
2. an entry in `CONSENSUS_MODEL_RATES` with a primary-source citation;
3. a measured cost/scan and a verdict-quality check from the harness — not a vendor benchmark.

### 5. Cost changes are measured, and the generator does not grade itself

Any model-default or retrieval change claiming a cost improvement re-runs `scripts/measure-consensus-cost.ts` and commits the **raw provider-usage records** alongside the result, so a non-author (Wolf or kestrel) can independently recompute it. Projected savings are a lead; a recomputed measurement is the fact.

## Consequences

- **Runway is bounded and auditable** — spend has a ceiling and a complete record, and the retrieval-cost spike can run inside it without a per-scan ask.
- **A cheaper default is a documented proposal, never a silent commit.** Cost pressure cannot quietly degrade verdict quality, which is the product.
- **The team carries real recurring work** (quarterly review + rate-table maintenance) as the price of moving fast between reviews.
- **Cost claims cost more to make** — measurement plus independent recompute is slower than asserting a ratio. That is the intended trade; the "~16× lever" that did not survive arithmetic is why.

## Open items for Asif

1. **Ratify or amend** this ADR (and say whether it should take a portfolio ADR-071 slot).
2. **Enforcement flip**: `FAULTLINE_PROVIDER_SPEND_CAP=on` — yes/no, and confirm the $100 ceiling.
3. **Retrieval SKU**: options table in `docs/asif-consensus-sku-proposal-2026-08-09.md` (recommendation: `gpt-4.1-mini`, 3.3× on the dominant leg). Flip is one click after a per-candidate live probe.
4. **Voter model**: flagged only — a Haiku 4.5 / Sonnet 5 voter is 5× / 2.5× cheaper than Opus 4.8 but changes verdict quality; needs the spike's quality check before it is even a proposal.

## References

- A-110 founder REC (adopted 2026-07-19, Emma-PM routed) — `.asif/NEXUS.md`
- `DIRECTIVE-NXTG-20260704-01` — retrieval-cost spike, fund-before-price-lock
- `docs/provider-spend-cap.md` · `docs/asif-consensus-sku-proposal-2026-08-09.md`
- `docs/unit-economics-MEASURED-2026-07-04.md` · `packages/api/src/store/consensus-cost.ts`
- `~/.claude/rules/deterministic-grounded-autonomy.md` §GROUNDED (spend cap + ledger)
