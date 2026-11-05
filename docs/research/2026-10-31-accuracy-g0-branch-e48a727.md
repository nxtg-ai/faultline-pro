# Accuracy G0 on branch e48a727 (no definite verdict without a source) before deploy

**Status (2026-10-31): MEASURED, NOT YET VERIFIED BY ANOTHER SEAT.** G0 branch mode (`accuracy-g0-harness.md`, engine `branch`) on pull request #91 before merge. The protocol, gold set, scorer and seed are the same as `2026-10-21-accuracy-g0-branch-62fec8a.md`.

- Engine: `e48a727`, served from the runner (`/health` commit matched the dispatched sha). Model: `gemini-2.5-flash`.
- Run: GitHub Actions run 41238219955, set `full`, 661 items, 0 failures, 1 item needed a retry. Dispatched 2026-10-31 20:17Z.
- Spend: $25.22 at list price on the branch engine's own ledger, under its USD 28 cap. 662 grounded prompts. This ledger is separate from production's.
- Comparison run: 41238219955 is compared with branch run 40713143916 (engine `ac13b230`, 2026-10-28), the last G0 run before this change. Between `ac13b230` and the base of this change, `packages/cli/services/geminiService.ts` (the Gemini verify prompt, model and settings) did not change; this change alters it only to drop grounding chunks with no web uri.
- Data: `data/accuracy-g0-full-41238219955.jsonl` (labels and flags only), with its `.score.json`, `.readout.txt` and `.jsonl.attempts.jsonl` files, and the engine's two ledgers `.branch-engine-grounding.jsonl` and `.branch-engine-provider-spend.jsonl`. No claim text.

## Headline

**Balanced accuracy 0.697, 95% CI [0.656, 0.738]** on the 631 binary claims, abstention counted as wrong (prereg). The comparison run scored 0.721 [0.679, 0.763]. The intervals overlap.

| Metric | ac13b230 (10-28, branch) | **e48a727 (10-31, branch)** |
|---|---|---|
| Balanced accuracy (headline) | 0.721 | **0.697** |
| Recall on true claims | 0.814 | 0.771 |
| False-claim flag rate | 0.755 | 0.698 |
| Selective accuracy | 0.896 | 0.884 |
| Coverage | 0.856 | 0.830 |
| Wrong definite verdicts (true shown contradicted + false shown supported) | 56 (28 + 28) | 61 (29 + 32) |
| `noSourceAbstain` | 13 (sourceless contradicted only) | 58 (any sourceless definite verdict) |

## Confusion matrix (e48a727)

| Gold \ verdict | supported | contradicted | mixed | unverified | failure |
|---|---|---|---|---|---|
| true (472) | 364 | 29 | 40 | 39 | 0 |
| false (159) | 32 | 99 | 12 | 16 | 0 |
| not enough evidence (30) | 13 | 12 | 1 | 4 | 0 |

## What the change did, separated from drift

The change only turns a supported, contradicted or mixed verdict with no openable source into `unverified`. It cannot create a definite verdict or change one definite verdict into another.

- **58 of 661 verdicts (8.8%) had no source a reader could open** and were returned as `unverified` with `noSourceAbstain: true`. By gold label: 39 true, 15 false, 4 not enough evidence.
- **On those 58 items, the comparison run gave** 34 right definite verdicts, 10 wrong definite verdicts, 2 definite verdicts on not-enough-evidence claims and 12 mixed or unverified. So on this set the rule withholds about 34 right verdicts and 10 wrong ones that had no source behind them. Under the headline scoring, where abstention counts as wrong, that costs balanced accuracy.
- **Estimated effect: about -0.05 balanced accuracy from the rule, about +0.03 from drift.** The run record keeps only the final status, not the verdict before the rule applied. Putting the comparison run's verdicts back on the 58 abstained items gives 0.750. This is an estimate that uses the other run's verdicts for those items; it is not a measurement.
- **The rise in wrong definite verdicts is drift, not the change.** On the 603 items the rule did not touch, wrong definite verdicts went from 46 to 61 between the two runs. On items neither run abstained or errored on, the two runs gave the same status on 520 of 592 (0.878), in line with earlier same-prompt G0 pairs (about 0.89).
- **Selective accuracy and coverage moved as expected.** Coverage fell from 0.856 to 0.830 because more claims are unverified. Selective accuracy (accuracy on definite verdicts) was 0.884 against 0.896, within run-to-run drift.

## What this means for the product

A reader no longer sees supported, contradicted or mixed unless the verdict carries at least one source they can open. On this gold set that applies to about 9% of Gemini verdicts. Those claims now read `unverified`, are not billed and are not counted toward the quota. The headline balanced accuracy is about 0.02 lower than the comparison run, with overlapping intervals, and the estimate above puts the rule's own cost at about 0.05.
