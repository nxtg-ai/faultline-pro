# Asif Pricing Decision Card — Faultline v0.9.0 (MEASURED)

**For**: Asif | **From**: fp | **Date**: 2026-07-04 | **Status**: decision-ready. Measured + Wolf-verified (recomputed exact from raw usage). Full table: `docs/unit-economics-MEASURED-2026-07-04.md`.

## The one thing that changed
Your pricing anchor was **~$0.03 per CALL** (old Gemini-Flash app). v0.9.0 consensus is **$0.20–$0.71 per SCAN** — because a scan is now **13–33 real LLM calls** (multi-model consensus at the verify stage). **The unit itself moved: per-call → per-scan.** And the deployed cost telemetry reported ~$0.00002/scan — an **11,000–16,000× undercount** — which is why this went unseen until measured.

## What actually drives the cost (the surprise)
**~88–90% of the cost is the gpt-4o web_search RETRIEVAL leg** (reading full web-search content — 886k real tokens across the matrix). The multi-model *voting* you flagged — the Opus consensus leg — is only **~11%**. **This is a retrieval-cost problem, not a consensus problem.** Killing consensus voters saves ~11%; optimizing retrieval (cheaper retrieval model, cap/trim search results, cache repeat queries) attacks ~90%.

## The pricing math (measured)
- **$19/mo subscription** → break-even **27–95 scans/user/mo** (by doc size). A moderately heavy user goes gross-margin-negative.
- **$19 one-time** → margin flips **negative** for a power-user on large docs (50 scans × high band = −$16.50). **Volume-fragile.**

## Decisions for you (teed)
1. **Price now, or fund the retrieval fix first?** The retrieval lever could cut ~90% of COGS → make either $19 model comfortably profitable. Recommendation: **fund a short retrieval-cost spike before locking price** — it changes the whole equation.
2. **If pricing now** — one-time unconstrained is volume-fragile (measured). Safer: **$19/mo with a scan cap**, or **usage-based above a floor**. Avoid unconstrained one-time.
3. **Interim guardrail** — cap scans/tier to bound the downside until retrieval is optimized.

## Follow-ups already queued (not your call, just FYI)
- Telemetry fix-spec **BLG-CLX9-20260703-005** (owner fp) — makes the cost telemetry actually measure (capture usage + sum fan-out + correct model rates). Harness here is the reference impl.
- **Key rotation**: the 3 provider keys used for this measurement rotate on your one-click (Emma's disclosure — a file diff touched one transcript; full-auto-then-rotate).
