# Unit economics — prod default (non-consensus) scan, 2026-09-30

**Asked by:** wolf (al:44db9410676c7627) for the A-264 cap card. Consensus became Enterprise-only tonight (al:252ac668b119d9cf), so Free, Personal and Pro all run the prod default: provider `gemini`, `consensus:false`. Gemini verifies each claim with its own `googleSearch` tool.

**Why a new run:** the 07-04 "single-model" column (`docs/unit-economics-MEASURED-2026-07-04.md`) was `scan(text, 'openai', …, {consensus:false})`: OpenAI with **no grounding**. It is not the prod path. Its $0.0003–0.0009/scan is the wrong subject for this question.

## Status: DERIVED from measured calls, not a complete 18-scan run

`scripts/measure-consensus-cost.ts --paid --confirm-spend --prod-default` ran twice. The local `GEMINI_API_KEY` is rate-limited: 111/120 calls got 429 unthrottled, and 105/120 got 429 at one call every 7 s, so the key is out of daily quota. No scan completed end to end with every call succeeding. The first run was also mis-scored: the harness charged the grounding fee on failed calls. That is fixed, and failed calls are now unbilled and logged with `httpStatus`.

What IS measured: the **15 successful calls** (raw records in `scripts/consensus-cost/prod-default-usage.jsonl`, `httpStatus: 200`; the run without throttling lacks `httpStatus`). The call shape per scan is observed: 1 extraction + K grounded verifies (4 / 7 / 9 calls for K = 3 / 6 / 8).

| Call | n | input tok (median) | output tok incl. thinking (median / max) | $ tokens (median / max) |
|---|---|---|---|---|
| extraction (gemini-2.5-flash) | 5 | 216 | 621 / 1,023 | $0.0016 / $0.0026 |
| grounded verify (gemini-2.5-flash + googleSearch) | 10 | 877 | 486 / 1,065 | $0.0015 / $0.0029 |

Rates re-verified 2026-09-30 at https://ai.google.dev/gemini-api/docs/pricing (Gemini 2.5 Flash, paid tier): $0.30/M input, $2.50/M output including thinking. **Grounding with Google Search: 1,500 grounded prompts per day free (per project, shared with Flash-Lite), then $35 per 1,000 grounded prompts ($0.035 each).**

## Per-scan cost = extraction + K × (verify tokens + grounding fee)

| Doc | K | Beyond the free grounding allowance (median / max) | Inside the free allowance (median / max) |
|---|---|---|---|
| SMALL | 3 | $0.11 / $0.12 | $0.006 / $0.011 |
| MEDIUM | 6 | $0.22 / $0.23 | $0.011 / $0.020 |
| LARGE | 8 | $0.29 / $0.31 | $0.014 / $0.026 |

Over the same equal-weight 3-size matrix as 07-04, with paid grounding: **p50 ≈ $0.22, p90 ≈ $0.29, max ≈ $0.31 per scan.**

**The grounding fee is ~95% of a paid-grounding scan.** Tokens are about a cent; each claim's search is $0.035. The non-consensus path is not cheap. At paid grounding it costs about as much as a small consensus scan ($0.20–0.26).

## Break-even (paid grounding)

| Plan | Price | Break-even at p50 / p90 | Cap in code (faultline-web `lib/tiers.ts`) | A-264 ruling |
|---|---|---|---|---|
| Personal | $19 | 86 / 65 scans | 100 | 25 |
| Pro | $49 | 223 / 169 scans | 500 | — |

The free allowance is 1,500 grounded prompts/day per Google project, about 45,000/month across ALL users, which is about 5,600 LARGE scans a month. Below that volume, the marginal grounding cost is $0 and a scan costs about a cent. Above it, the table applies.

## Not checked (leads)
- Whether the prod key on Fly (`faultline-api`) is in a billing-enabled project and the same project as any other Gemini traffic that shares the 1,500/day allowance. flyctl is not authenticated on NXTG-AI, and Fly billing is overdue (deploys 403).
- Real claim-count distribution in prod (K). The matrix fixes K at 3/6/8; K is capped at 8 (`scan.ts:145`).
- A clean 18-scan end-to-end run needs a key with daily quota. Rerun: `npx tsx scripts/measure-consensus-cost.ts --paid --confirm-spend --prod-default --throttle-ms=7000`.
