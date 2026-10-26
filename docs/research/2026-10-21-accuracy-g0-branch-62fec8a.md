# Accuracy G0 on branch 62fec8a (cost ceilings, PR A) before deploy

**Status (2026-10-21): MEASURED, NOT YET VERIFIED BY ANOTHER LANE.** First run of G0 branch mode (`accuracy-g0-harness.md`, engine `branch`). It measures PR A (`feat/cost-ceilings-a`, GoPMO 1.18.11.7.18 item A) before it is merged, per ruling Dx3 67cd2d8b. The protocol, gold set, scorer and seed are the same as `2026-10-17-accuracy-g0-6af8cef.md`.

- Engine: `62fec8a`, served from the runner (`/health` commit matched the dispatched sha). Model: `gemini-2.5-flash`.
- Run: GitHub Actions run 39559583517, set `full`, 661 items, 1 failure (`provider_unparseable` after 4 calls), 51 items needed a retry. Dispatched 2026-10-21 07:05Z, after the Pacific grounding-day reset, with 0 production grounded prompts used that day.
- Spend: $27.60 at list price on the branch engine's own ledger, which the USD 28 branch cap allows. 732 grounded prompts.
- Data:
  - `data/accuracy-g0-full-39559583517.jsonl` (labels and flags only), with its `.score.json`, `.readout.txt` and `.jsonl.attempts.jsonl` files.
  - The engine's two ledgers: `.branch-engine-grounding.jsonl` and `.branch-engine-provider-spend.jsonl`.
  - `.retried-replay.jsonl`: one row per replayed item, with the HTTP status, finish reason, token counts, grounding chunk count, reply length, verdict status and any error reason. No claim text.

## Headline

**Balanced accuracy 0.722, 95% CI [0.680, 0.765]** on the 631 binary claims, abstention counted as wrong (prereg).

| Metric | 6af8cef (10-17, live) | **62fec8a (10-21, branch)** |
|---|---|---|
| Balanced accuracy (headline) | 0.706 | **0.722** |
| Recall on true claims | 0.845 | 0.828 |
| False-claim flag rate | 0.692 | 0.717 |
| Selective accuracy | 0.899 | 0.888 |
| Coverage | 0.862 | 0.873 |
| Wrong definite verdicts (true shown contradicted + false shown supported) | 55 (22 + 33) | 62 (28 + 34) |
| Backstop fired (`noSourceAbstain`) | 32 | 18 |
| `output_truncated` on a final row | — | **0** |

## Confusion matrix (62fec8a)

| Gold \ verdict | supported | contradicted | mixed | unverified | failure |
|---|---|---|---|---|---|
| true (472) | 391 | 28 | 47 | 5 | 1 |
| false (159) | 34 | 98 | 16 | 11 | 0 |
| not enough evidence (30) | 12 | 10 | 4 | 4 | 0 |

## What the ceilings did, separated from drift

- **No claim was cut off at its ceiling in the scored output.** 0 rows carry `output_truncated`. The one failure is `provider_unparseable`.
- **The retried items were replayed once each on the branch engine and none were cut off.** 51 of 51 ended with `STOP` and returned a verdict. The largest thinking count was 3,638 of the 4,096 budget, and the largest visible reply was 381 tokens.
- **The retries cluster in time, not by claim.** 45 of the 51 retried items were in the first seven batches, 07:06Z to 07:13Z, with up to 16 of 25 items failing in a batch. The other 23 batches had 0 to 2 retries each, 6 in all. Each failed attempt was a grounded reply that came back and was counted (732 grounded prompts for 732 calls), so these were unreadable or cut-off replies, not network errors.
  - **The runner does not record why an attempt failed.** Only the final row's reason is kept.
  - **The spend ledger shows the failed attempts were short replies, not ceiling cuts.** The branch engine's spend ledger has one row per batch, priced from the provider's own token counts (gemini-2.5-flash: $0.30 per million input tokens, $2.50 per million output tokens, $0.035 per grounded prompt).
    - A reply cut at the verify ceiling bills at least about 4,600 output tokens, against about 800 for a normal reply. That is at least $0.0095 more per cut call.
    - So the batch with 16 failures (ids 3..47) would cost at least $0.15 more than a clean batch.
    - It cost $0.0371 per call, against a mean of $0.0377 for the 24 batches with fewer than 3 retries. Across the 6 batches with 3 or more retries, the mean was $0.0375 per call.
    - The cheaper cost fits short, unreadable replies, which the live engine also retries (19 items on 10-17).
  - **Stated residual:** production does not retry. A burst of long replies from the provider would be cut at the ceiling, and that claim returns `apiError` (unbilled) instead of a verdict.
  - **Watch item:** the largest thinking count is near the budget in both samples, 3,423 of 4,096 on 2026-10-21 before the ceilings and 3,638 in this replay. A live probe after deploy counts `output_truncated` on real scans.
- **Agreement with 6af8cef is at the day-to-day level.** On the 612 items where neither run's backstop fired and neither failed, the verdicts agree on 546 (0.892). The same comparison gave 0.889 between 6af8cef and 47b72f0, which have the same prompts on different days.
- **The rise in wrong definite verdicts is the backstop, not the ceilings.** On items neither run backstopped, wrong definite verdicts are 53 then 52. The backstop fired 18 times, against 32 (2 items in both). Of the 30 items it caught on 6af8cef and not here, 10 true claims are now shown contradicted and 13 false claims are now correctly contradicted. The backstop fires when grounding returns no source, which varies by day; one run cannot tell whether the explicit thinking budget changes how often that happens.
- **Spend per grounded prompt went from $0.0354 to $0.0377.** The difference is the usage fix in the same PR (0da7fd1): thinking and tool-use tokens are now counted. On 10-17 those tokens were spent but not recorded.

## Before the next branch run

- **The USD 28 branch cap is now too tight.** This run used $27.60 with 71 extra calls, so a slightly worse provider episode would stop it on the cap (exit 5). At the corrected $0.0377 per prompt, USD 35 covers 928 calls, which is this run's 71 extra calls three times over.
- **The runner should write each failed attempt's `apiErrorReason` to the attempt ledger.** Then a retry burst can be attributed from the run alone.

## Verification owed

A lane that did not run it re-scores the committed outputs (`python3 scripts/accuracy-g0-score.py docs/research/data/accuracy-g0-full-39559583517.jsonl`) and confirms every number on this page.
