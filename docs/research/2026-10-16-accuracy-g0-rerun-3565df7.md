# Accuracy G0 re-run on engine 3565df7 (abstention fix)

**Status (2026-10-16): MEASURED, NOT YET VERIFIED BY ANOTHER LANE.** Same pre-registered protocol, gold set, scorer and seed as the first run (`docs/research/2026-10-05-accuracy-g0-results.md`, engine `47b72f0`). Ruling Dx3 d8f5c369: run on the fixed engine right after deploy and publish the new balanced accuracy with the sha, up or down.

- Engine: `3565df7` (verify prompts define `unverified`; a grounded Gemini `contradicted` with no grounding source is reported `unverified`, flag `noSourceAbstain`). Model `gemini-2.5-flash`.
- Run: GitHub Actions run 38927786856, set `full`, 661 items, 0 failures, 0 parse fallbacks, 3 items needed a retry.
- Spend: $23.51 at list price on the provider-spend ledger ($36.21 before, $59.72 after), under the $30 cap of the ruling.
- Data: `data/accuracy-g0-full-38927786856.jsonl` (labels and flags only, no grounded text), `.score.json`, `.readout.txt`, `.jsonl.attempts.jsonl`.

## Headline

**Balanced accuracy 0.691, 95% CI [0.648, 0.734]** on the 631 binary claims, abstention counted as wrong (prereg). The first run measured 0.763 [0.722, 0.802] on `47b72f0`. The two intervals overlap only between 0.722 and 0.734, and both runs scored the same 661 items, so the drop of 0.072 is a change in the engine, not sampling of different items (item-level agreement below).

| Metric | 47b72f0 (2026-10-05) | 3565df7 (2026-10-16) |
|---|---|---|
| Balanced accuracy (headline) | 0.763 | **0.691** [0.648, 0.734] |
| Recall on true claims | 0.835 | 0.848 |
| False-claim flag rate (false claims marked contradicted) | 0.805 | **0.598** |
| Selective accuracy (when a verdict is given) | 0.884 | 0.885 |
| Coverage | 0.903 | 0.869 |
| NEE items left unverified or mixed (n=30) | 0.133 | 0.267 |

## Confusion matrix

| Gold \ verdict | supported | contradicted | mixed | unverified |
|---|---|---|---|---|
| true (472) | 400 (394) | **23 (36)** | 32 (42) | 17 (0) |
| false (159) | **40 (30)** | **85 (110)** | 10 (18) | 24 (1) |
| not enough evidence (30) | 14 (13) | 8 (13) | 0 (4) | 8 (0) |

First-run counts in brackets.

## What the numbers say

- **Wrong definite verdicts barely moved: 66 → 63.** True claims shown as contradicted fell 36 → 23 (the EP4 failure class). False claims passed as supported rose 30 → 40.
- **Caught false claims fell 110 → 85.** 21 of the 25 lost catches moved to `unverified`, 3 to `supported`, 4 to `mixed` (with 3 recovered from `mixed`).
- **The backstop fired 22 times: 11 on false claims, 10 on true, 1 on NEE.** Each firing on a false claim turned a correct refutation into an abstention; each firing on a true claim removed a false refutation. On its own it neither adds a wrong verdict nor improves the headline.
- **The prompt change accounts for the rest.** 10 false claims moved from `contradicted` to `unverified` without the backstop, and false claims moved from `mixed` to `supported` (7). Item-level agreement with the first run is 553 of 661 (0.84), below the 0.92 the verify-subsample re-run showed for an unchanged engine, so this is a behaviour change, not run-to-run noise.
- **For a product whose job is catching false claims, this engine is worse at it.** It is more honest on true claims and less useful on false ones.

## Not shown by this run

- The EP4 c4 mechanism (no search results, then `contradicted`) is a single production observation; this run records statuses and flags, not explanations.
- Whether the backstop alone (first-run prompts plus backstop) would keep the true-claim gain without the false-claim loss. The item counts above suggest it would trade about 11 correct refutations for about 10 removed false ones, but that is a projection, not a measurement.

## Verification owed

A lane that did not run it re-scores the committed outputs (`python3 scripts/accuracy-g0-score.py docs/research/data/accuracy-g0-full-38927786856.jsonl`) and confirms every number on this page.
