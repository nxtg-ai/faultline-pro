# Grounding arms, 2026-11-05: Google grounding vs Parallel Advanced

Two arms on the same 200 claims, drawn from the G0 set (Factcheck-Bench) with seed 20261105, on engine 155132b, on one day.

- **A**: today's default, gemini-2.5-flash with the googleSearch tool.
- **P**: Parallel Search (advanced mode, 8 results, up to 1500 characters each), then gemini-2.5-flash judging the claim against those results, with no Google tool.

Runner: `node scripts/accuracy-g0.mjs --set full --arm both --sample 200 --seed 20261105`, through the hosted admin verify route. This is not the pre-registered G0 run, and its section 5 validity rules were not applied.

## Result against the bar stated before the run

| Criterion | A | P | Result |
|---|---|---|---|
| (1) Balanced accuracy of P at least A minus 0.05, and the lower bound of the paired bootstrap 95% CI of P minus A at or above -0.10 | 0.720 [0.642, 0.800] | 0.802 [0.729, 0.871] | PASS: P minus A is +0.082 [+0.018, +0.148] |
| (2) P's unverified rate no more than 10 points above A's | 9.5% | 2.0% | PASS |
| (3) P's measured cost under 0.01 USD per claim | 0.0386 | 0.01025 | **FAIL**, over by 0.00025 |
| (4) P makes 0 Google grounded calls | 204 | 0 | PASS |

- **Overall: 3 of 4 criteria PASS. Criterion (3) FAILS.** The default provider is not changed by this result. A change needs the founder's decision.
- **Scoring:** 193 of the 200 claims have a binary gold label. Bootstrap: 2000 paired resamples, seed 20260929.
- **Independent recompute:** a fresh seat recomputed the result from the per-claim rows and reproduced all four numbers and verdicts (`data/grounding-arms-2026-11-05.recompute.md`).
- **Where P's cost goes:** 0.005 USD is Parallel's per-search fee and the rest is Gemini tokens. The size of the excerpts is the lever.
- **Agreement:** the two arms agree on status for 83% of claims. They differ on 35 claims. On those 35, P matches gold where A does not on 20, and A matches gold where P does not on 5.
- **A's unverified verdicts:** 16 of A's 19 were Google grounding returning no sources at all. On a second run, most of those claims got sources and a definite verdict.

## Files

| File | Contents |
|---|---|
| `data/grounding-arms-2026-11-05.google.jsonl`, `.parallel.jsonl` | The scored run: per claim, the id, gold label, status, sources count, cost and Google grounded calls |
| `*.attempts.jsonl`, `*.spend.jsonl` | The runner's attempt and spend ledgers for each arm |
| `data/grounding-arms-2026-11-05.summary.json` | The runner's summary |
| `data/grounding-arms-2026-11-05.parallel-rerun.jsonl` | P's reasoning and source URLs for all 200 claims, from a **second, local run** on the same engine commit and model |

The hosted route returns no reasoning or sources by design, so this second run was needed to show them. Each row in the re-run file shows the scored status beside the re-run status. On P, the re-run matched the scored status on 188 of the 200 claims.

A's reasoning and sources are not in this repo. Google's grounding terms limit showing grounded results. A's re-run of the 35 disagreements plus 10 seeded agreements went into a single private file outside the repo for the decision. The local copy has been shredded. That private file is deleted once the decision is made.
