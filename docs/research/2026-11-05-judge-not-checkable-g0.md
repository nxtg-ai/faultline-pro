# Judge-side not-checkable: G0 before and after, 2026-11-05

Measures the verify-prompt change in PR #116 (`sourcesAddressClaim` key, `notCheckable` flag) on the parallel grounding arm.

- **Set:** 200 claims sampled from the G0 set (Factcheck-Bench) with seed 20261105, the same claims as `2026-11-05-grounding-arms-results.md`.
- **Engines:** before is main at 0a2adb5; after is the PR at 61aa917. Each ran on its own local API server in parallel mode, on the same day with the same keys, and one runner script scored both.
- **Scope:** this is not the pre-registered run, and its section 5 validity rules were not applied.
- **Bootstrap:** 2000 paired resamples, seed 20260929, over the 193 claims with a binary gold label.

| | Before (0a2adb5) | After (61aa917) |
|---|---|---|
| Balanced accuracy | 0.759 [0.681, 0.834] | 0.774 [0.698, 0.849] |
| After minus before | | +0.015 [-0.038, +0.065] |
| Unverified rate | 1.5% | 1.0% |
| Not checkable | 0 | 2 of 200 (1.0%) |
| Mean cost per claim | 0.0100 USD | 0.0102 USD |
| Google grounded calls | 0 | 0 |

The interval on the difference contains zero, so this run detects no change in accuracy.

The two not-checkable claims:
- **Claim 76** (gold: not enough evidence) was contradicted before.
- **Claim 122** (gold: true) was already unverified before.

So neither one lost a correct verdict. Status changed on 15 of 200 claims, which is within the run-to-run variation of a repeated G0 run.

Rows: `data/judge-not-checkable-2026-11-05.{before,after}.jsonl`, with each run's summary beside it. The rows hold ids, gold labels, statuses, source counts and costs only.

The 2026-11-05 two-arm run (`2026-11-05-grounding-arms-results.md`) scored Parallel Advanced at 0.802 on the same claims, through the hosted route on engine 155132b. This run's before engine gives 0.759 on the same claims. The before engine was a different deployment and Gemini key, with intervening commits that do not touch the verify prompt.
