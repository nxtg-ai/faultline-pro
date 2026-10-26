# Accuracy G0 on engine 6af8cef (measured prompts, no-source backstop)

**Status (2026-10-17): MEASURED, NOT YET VERIFIED BY ANOTHER LANE.** Same pre-registered protocol, gold set, scorer and seed as `2026-10-05-accuracy-g0-results.md` (engine `47b72f0`) and `2026-10-16-accuracy-g0-rerun-3565df7.md`. Ruling Dx3 67cd2d8b: verify prompts back to the `47b72f0` wording, keep the grounded Gemini no-source backstop and `provider_unparseable`, then one full G0.

- Engine: `6af8cef`, the deployed engine. Model `gemini-2.5-flash`.
- Run: GitHub Actions run 39012525881, set `full`, 661 items, 0 failures, 0 parse fallbacks, 19 items needed a retry. Dispatched 2026-10-17 07:05Z, after the Pacific grounding-day reset, with 0 grounded prompts used that day.
- Spend: $24.10 at list price on the provider-spend ledger ($59.72 before), under the $30 cap.
- Data: `data/accuracy-g0-full-39012525881.jsonl` (labels and flags only), `.score.json`, `.readout.txt`, `.jsonl.attempts.jsonl`.

## Headline

**Balanced accuracy 0.706, 95% CI [0.665, 0.750]** on the 631 binary claims, abstention counted as wrong (prereg).

| Metric | 47b72f0 (10-05) | 3565df7 (10-16) | **6af8cef (10-17, live)** |
|---|---|---|---|
| Balanced accuracy (headline) | 0.763 | 0.691 | **0.706** |
| Recall on true claims | 0.835 | 0.848 | 0.845 |
| False-claim flag rate | 0.805 | 0.598 | 0.692 |
| Selective accuracy (when a verdict is given) | 0.884 | 0.885 | **0.899** |
| Coverage | 0.903 | 0.869 | 0.862 |
| Wrong definite verdicts (true shown contradicted + false shown supported) | 66 (36 + 30) | 63 (23 + 40) | **55 (22 + 33)** |
| NEE items where the engine took a side (of 30) | 26 | 22 | 22 |
| Backstop fired (`noSourceAbstain`) | — | 22 | 32 |

## Confusion matrix (6af8cef)

| Gold \ verdict | supported | contradicted | mixed | unverified |
|---|---|---|---|---|
| true (472) | 399 | 22 | 35 | 16 |
| false (159) | 33 | 90 | 20 | 16 |
| not enough evidence (30) | 13 | 9 | 4 | 4 |

## What the numbers say

- **The backstop is most of the drop from 0.763.** It fired 32 times: 14 true claims spared a false `contradicted`, 14 correct refutations turned into `unverified`, 4 NEE items. The prereg counts an abstention as wrong, so each firing on a false claim lowers the headline and each firing on a true claim does not raise it. Counting the 32 back as `contradicted` gives 0.750, close to the first run. That is arithmetic on this run, not a second measurement.
- **The live engine shows the fewest wrong verdicts of the three:** 55, against 66 and 63. Selective accuracy is the highest: 0.899.
- **Day-to-day drift is larger than the first verify-subsample showed.** With the same prompts, 6af8cef agrees with 47b72f0 on 559 of the 629 items where the backstop did not fire (0.889). The 2026-10-05 subsample re-run agreed 0.92 on 100 items the same week.

## Correction to the 3565df7 page

`2026-10-16-accuracy-g0-rerun-3565df7.md` said the prompt text "accounts for the rest" of that drop and that 0.84 agreement against 0.92 meant "the engine, not noise". This run shows that is overstated. Part of the disagreement is the backstop by construction. Without the backstop items, 3565df7 agreed with 47b72f0 at 0.865 and 6af8cef at 0.889, so drift between days explains a share of the rest. The prompt rule's own effect (false claims passed as supported: 40 on 3565df7, 33 here) is within what this design can separate from drift. The revert stands as ruled; its measured effect on balanced accuracy is 0.691 to 0.706, inside both intervals.

## Verification owed

A lane that did not run it re-scores the committed outputs (`python3 scripts/accuracy-g0-score.py docs/research/data/accuracy-g0-full-39012525881.jsonl`) and confirms every number on this page.
