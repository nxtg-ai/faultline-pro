# Parallel fast vs advanced, 2026-11-06

Measures the cost lever named in `2026-11-05-grounding-arms-results.md`: Parallel's `fast` search mode (0.001 USD a request) against today's `advanced` mode (0.005 USD a request), both with the same Gemini 2.5 Flash judge and no Google tool.

- **Set:** the same 200 G0 claims (Factcheck-Bench, seed 20261105) as the two-arm run; 193 have a binary gold label.
- **Engine:** production, commit ba11345, through the hosted admin verify route, both arms on the same day (13:2xZ to 13:4xZ). Advanced ran first, then fast.
- **Runner:** `node scripts/accuracy-g0.mjs --set full --arm parallel|parallel-fast --sample 200 --seed 20261105 --engine-sha ba11345...`.
- **Scope:** this is not the pre-registered run, and its section 5 validity rules were not applied.
- **Bootstrap:** 2000 paired resamples, seed 20260929, from `scripts/accuracy-g0-score.py` (`paired_difference`, fast minus advanced).

| | Advanced | Fast |
|---|---|---|
| Balanced accuracy | 0.755 [0.678, 0.829] | 0.719 [0.641, 0.799] |
| Fast minus advanced | | -0.036 [-0.095, +0.023] |
| Unverified rate | 1.0% | 2.5% |
| Not checkable | 0.5% | 2.0% |
| Mean cost per claim | 0.00988 USD | 0.00572 USD |
| Mean sources per claim | 7.96 | 7.84 |
| Google grounded calls | 0 | 0 |

## Against the bar stated before the run

The bar, from the FP04 plan: adopt fast mode only if its balanced accuracy is within 0.05 of advanced and the lower bound of the paired 95% CI of the difference is at or above -0.10.

- Within 0.05: -0.036. **Met.**
- Lower bound at or above -0.10: -0.095. **Met, by 0.005.**

Both conditions are met. The bar is a necessary condition, not an order to switch.

## What else the run shows

- Status agreement between the arms: 86% of binary claims.
- Claims one arm got right and the other wrong: advanced 12, fast 6.
- Fast leaves more claims unchecked: 2.5% unverified against 1.0%.
- Cost: fast is 42% cheaper per claim, and under the 0.01 USD bar that advanced misses (advanced read 0.00988 on this run and 0.01025 on the two-arm run).
- The advanced arm scored 0.755 here and 0.802 on the two-arm run, on the same claims. That spread is run-to-run variation of one setup and is about the size of the difference measured here, so this run alone cannot show which mode is more accurate.

## Recommendation

Keep `advanced` in production for now. The saving is about 0.004 USD a claim, a few cents a day at today's volume, while the point estimate and the one-sided disagreement count both favour advanced on the product's central claim. Revisit when volume makes the saving material, with a second paired run to separate the difference from run-to-run spread. The production mode is `FAULTLINE_PARALLEL_MODE`; it is unchanged by this run.

## Files

| File | Contents |
|---|---|
| `data/parallel-fast-2026-11-06.parallel.jsonl`, `.parallel-fast.jsonl` | Per claim: id, gold label, status, sources count, cost and Google grounded calls. No claim text, no source text |
| `*.attempts.jsonl`, `*.spend.jsonl` | The runner's attempt and spend ledgers for each arm |
| `data/parallel-fast-2026-11-06.*summary.json` | The scorer's per-arm and two-arm summaries |
| `data/parallel-fast-2026-11-06.fast-minus-advanced.json` | The paired difference |

Spend: 3.12 USD (advanced 1.98, fast 1.14), inside the 10 USD test cap.
