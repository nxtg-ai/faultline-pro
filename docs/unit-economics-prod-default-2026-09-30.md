# Unit economics — prod default (non-consensus) scan, 2026-09-30

**Asked by:** wolf (al:44db9410676c7627) for the A-264 cap card. Consensus became Enterprise-only tonight (al:252ac668b119d9cf), so Free, Personal and Pro all run the prod default: provider `gemini`, `consensus:false`. Gemini verifies each claim with its own `googleSearch` tool.

**Why a new run:** the 07-04 "single-model" column (`docs/unit-economics-MEASURED-2026-07-04.md`) was `scan(text, 'openai', …, {consensus:false})`: OpenAI with **no grounding**. It is not the prod path. Its $0.0003–0.0009/scan is the wrong subject for this question.

## Status: DERIVED from measured calls, not a complete 18-scan run

`scripts/measure-consensus-cost.ts --paid --confirm-spend --prod-default` ran twice. The local `GEMINI_API_KEY` is rate-limited: 111/120 calls got 429 unthrottled, and 105/120 got 429 at one call every 7 s, so the key is out of daily quota. No scan completed end to end with every call succeeding. The first run was also mis-scored: the harness charged the grounding fee on failed calls. That is fixed, and failed calls are now unbilled and logged with `httpStatus`.

What IS measured: the **24 successful calls** (corrected 2026-10-01; this doc first said 15). The raw records are in `scripts/consensus-cost/prod-default-usage.jsonl` (240 rows). 24 rows carry token counts. 15 of them are from the throttled run and have `httpStatus: 200`. The other 9 are from the first, unthrottled run (scans `a87c92bb`, `adafc8ba`, `d075646c`), which did not log `httpStatus`. Those 9 are counted as successes because they report real token counts, and every one of the 105 rows with `httpStatus: 429` has 0 input and 0 output tokens. The remaining 216 rows are failed calls with 0 tokens. The call shape per scan is observed: 1 extraction + K grounded verifies (4 / 7 / 9 calls for K = 3 / 6 / 8).

| Call | n | input tok (median) | output tok incl. thinking (median / max) | $ tokens (median / max) |
|---|---|---|---|---|
| extraction (gemini-2.5-flash) | 8 | 216 | 608 / 1,023 | $0.0016 / $0.0026 |
| grounded verify (gemini-2.5-flash + googleSearch) | 16 | 869 | 486 / 1,926 | $0.0015 / $0.0051 |

Rates re-verified 2026-09-30 at https://ai.google.dev/gemini-api/docs/pricing (Gemini 2.5 Flash, paid tier): $0.30/M input, $2.50/M output including thinking. **Grounding with Google Search: 1,500 grounded prompts per day free (per project, shared with Flash-Lite), then $35 per 1,000 grounded prompts ($0.035 each).**

## Per-scan cost = extraction + K × (verify tokens + grounding fee)

| Doc | K | Beyond the free grounding allowance (median / max) | Inside the free allowance (median / max) |
|---|---|---|---|
| SMALL | 3 | $0.11 / $0.12 | $0.006 / $0.018 |
| MEDIUM | 6 | $0.22 / $0.24 | $0.010 / $0.033 |
| LARGE | 8 | $0.29 / $0.32 | $0.013 / $0.043 |

Over the same equal-weight 3-size matrix as 07-04, with paid grounding: **p50 ≈ $0.22, p90 ≈ $0.29, max ≈ $0.32 per scan.**

**The grounding fee is ~95% of a paid-grounding scan.** Tokens are about a cent; each claim's search is $0.035. The non-consensus path is not cheap. At paid grounding it costs about as much as a small consensus scan ($0.20–0.26).

## Break-even (paid grounding)

| Plan | Price | Break-even at p50 / p90 | Live monthly scan limit (https://faultline.nxtg.ai/pricing, read 2026-10-01) |
|---|---|---|---|
| Personal | $19 | 86 / 65 scans | 25 |
| Pro | $49 | 223 / 169 scans | 500 |

The free allowance is 1,500 grounded prompts/day per Google project, about 45,000/month across ALL users, which is about 5,600 LARGE scans a month. Below that volume, the marginal grounding cost is $0 and a scan costs about a cent. Above it, the table applies.

## Not checked (leads)
- Whether the prod key on Fly (`faultline-api`) is in a billing-enabled project and the same project as any other Gemini traffic that shares the 1,500/day allowance. flyctl is not authenticated on NXTG-AI, and Fly billing is overdue (deploys 403).
- Real claim-count distribution in prod (K). The matrix fixes K at 3/6/8; K is capped at 8 (`scan.ts:145`).
- A clean 18-scan end-to-end run needs a key with daily quota. Rerun: `npx tsx scripts/measure-consensus-cost.ts --paid --confirm-spend --prod-default --throttle-ms=7000`.

## Corrections log (2026-10-01)

- **Count:** the doc said 15 successful calls. Recounted from `prod-default-usage.jsonl`: 24 rows have token counts (15 with `httpStatus: 200`, 9 from the first unthrottled run with no `httpStatus`). Wolf's count of 24 is right.
- **Method:** each cost is `input × $0.30/M + output × $2.50/M`. The median column is the cost at the median input and median output tokens. The max column is the max single-call cost. Per scan, `extraction + K × (verify + $0.035)`. Run on the original 15 rows this reproduces every number in the old tables, so the method is the doc's own.
- **Tables that changed:** extraction n 5 to 8 and output median 621 to 608. Verify n 10 to 16, input median 877 to 869, output max 1,065 to 1,926 (one call), max cost $0.0029 to $0.0051. The per-scan max column moved: MEDIUM $0.23 to $0.24, LARGE $0.31 to $0.32. Free-allowance max moved: SMALL $0.011 to $0.018, MEDIUM $0.020 to $0.033, LARGE $0.026 to $0.043. Free-allowance medians were re-rounded to three decimals ($0.011 to $0.010, $0.014 to $0.013).
- **Unchanged:** the paid-grounding medians, p50 $0.22, p90 $0.29, and every break-even. Only the max moved, $0.31 to $0.32.
- **Break-even arithmetic:** the break-even counts use the rounded p50 and p90 prices ($0.22, $0.29), as the original did.
- **Plan limits:** the old table took Personal 100 from a local faultline-web `lib/tiers.ts` checkout (last commit 2026-09-18). The live pricing page on 2026-10-01 shows Personal 25 and Pro 500, so the table now cites that page. The current faultline-web main was not re-read.
