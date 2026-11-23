# Pre-registration: G0 accuracy for the attribution change, and a hosted re-measure (2026-11-23)

Committed before any of these runs. Two questions, one sample:

1. **Re-measure:** what is the hosted engine's balanced accuracy on its current judge? The only dated hosted figure, 0.755, is from 2026-11-06 with judge `gemini-2.5-flash`; the production judge changed on 2026-11-14.
2. **Harm check:** does the judge change on the fix branch (the attribution rule and `supportBasis`) lower accuracy? A verify-prompt or verdict-logic change is measured on G0 on a branch before deploy. The extraction change on the same branch is not on this route (claims go to the judge directly), so G0 cannot see it, for better or worse.

## Sample, labels, scoring

The same 200 claims as the 2026-11-05, 11-06 and 11-14 runs: `--set full --sample 200 --seed 20261105`; the 193 with a binary gold label are scored. Balanced accuracy with abstentions and failures counted wrong, 95% bootstrap CI and paired differences from `scripts/accuracy-g0-score.py` (2,000 resamples, seed 20260929). Grounding `parallel`, Parallel mode `advanced`.

## Arms

| Arm | Engine | Judge | Searches |
|---|---|---|---|
| H | hosted API, 0.12.3, commit 88c4350 | `gemini-3.1-pro-preview` as production runs it, its rate-limit fallback included | its own |
| M | local API, `origin/main` 6b2f410 | `gemini-3.1-pro-preview`, no fallback model set | makes one search per claim and writes the local search cache |
| X | local API, the fix branch (commit recorded in every row) | `gemini-3.1-pro-preview`, no fallback model set | reads M's cache; must make zero searches |

M and X run with `--judge-model gemini-3.1-pro-preview`, so a row judged by any other model stops the arm. H runs without it, because customers get the fallback too; its fallback share is reported.

The search cache is on only through a local environment variable production does not set. It lives outside the repository, readable by the owner only, and is deleted after scoring. Committed rows hold ids, labels, statuses, counts, tokens and costs, no claim, source or reply text.

## Pacing

All three arms run `scripts/accuracy-g0.mjs` from the fix branch, which adds `--batch-size` and `--pause-ms` and changes nothing else in the runner.

H shares the production judge model's per-minute limit with customer scans: `--batch-size 5 --pause-ms 30000`, about 8 judge calls a minute. M and X use a local Gemini key that may bill the same Google project, so they are paced the same way, and the three arms run one after another, never at once.

## Validity (from the 2026-11-14 plan)

An arm is valid when at least 190 of the 193 binary claims returned a status after the runner's retries. X is valid only if it made zero searches. An invalid arm is reported as invalid, with its descriptive numbers, and is not read against the rules below.

## Reading rules (fixed now)

- **Re-measure (H):** reported as the hosted balanced accuracy on 2026-11-23 with its CI, judge and fallback share, beside the 2026-11-06 figure and its different judge. It is a new dated figure, not a test.
- **Harm check (X minus M, paired):** **FAIL** if the point estimate is below -0.02, or if the 95% CI lies entirely below 0. Otherwise **no measured harm**. The unverified rate of each arm is reported, since the change turns some supported verdicts into unverified ones and an abstention counts as wrong.
- **M against H** is reported to show how far the local setup is from production. It is not a test.

## Cost guard

`--price-in 2 --price-out 12 --cap-usd 4` per arm (list price of `gemini-3.1-pro-preview`, input / output per million tokens, as read 2026-11-14, plus the 0.005 USD search fee). All three arms together: at most 12 USD.

Results are published in `RESULTS.md` whatever they show.
