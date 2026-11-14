# Judge model A/B v2 on the G0 claims: the Gemini 4 arms, results, 2026-11-14

Pre-registration: amendment A1 in `2026-11-14-prereg-judge-model-ab-v1.md`, section 10. It was registered at commit `dc76ea5` on 2026-11-14 03:47:11Z, before any paid call of v2. GoPMO 1.18.11.7.127.

**This run reports. It does not choose.** The choice of production model is made by the program owner, from this table and under the choice rule fixed in amendment A1.

- **Engine:** `dc76ea5`, the registered commit, on a local API, one process per arm, with the judge set by `FAULTLINE_GEMINI_MODEL`.
  - The rate-limit fallback was unset.
  - Retrieve-then-judge (`grounding: parallel`, Parallel `advanced`).
  - The runner ran from `1603656`, which fixes a runner check (see Deviations). Nothing under `packages/` differs between the two commits except one runner test.
- **Claims:** the 200 G0 claims, `--sample 200 --seed 20261105`. Scored on the 193 with a binary gold label.
- **Shared sources:** arm A' searched once per claim and wrote each reply to a new local cache (200 entries). Every other arm read it and made **zero** Parallel calls. The v1 cache had been deleted after v1, so these are new sources. This cache is deleted after scoring.
- **Run window:** 2026-11-14 03:47Z to 08:17Z, all arms within 24 hours of A'.
- **Request storage:** Google's storage of Generate Content requests was off for our project throughout. The AI Studio Logs and Datasets page still showed logging Disabled and no stored logs at 08:18Z, after every arm had run.

## Verdicts

| Arm | Judge | GA? | BA [95% CI] | Minus A' [paired 95% CI] | Non-inferior (lower ≥ -0.03) | Better (lower > +0.03) | Unverified | Status agreement with A' | Cost per claim from 2026-12-01 |
|---|---|---|---|---|---|---|---|---|---|
| A' | `gemini-2.5-flash` | retires 2026-12-01 | 0.786 [0.711, 0.855] | | | | 1.5% | | 0.0095 USD (today's price) |
| H | `gemini-4-hydrogen` | yes | 0.709 [0.633, 0.784] | **-0.076 [-0.142, -0.017]** | no | no | 3.0% | 80.0% | 0.0157 USD |
| AR | `gemini-4-argon` | yes | 0.795 [0.720, 0.862] | +0.009 [-0.034, +0.048] | no | no | 1.0% | 90.0% | 0.0192 USD |
| C | `gemini-4-carbon` | yes | 0.745 [0.669, 0.815] | -0.041 [-0.080, +0.001] | no | no | 1.0% | 83.5% | 0.0273 USD |
| P' | `gemini-3.1-pro-preview` | preview | **INVALID** (179 of 193 returned a status; section 7 needs 190) | descriptive only: -0.047 [-0.104, +0.006] | not read | not read | 8.0% | 81.0% | 0.0159 USD (answered claims) |

- **Cost per claim** is each arm's recorded input and output tokens at that model's price from 2026-12-01 (amendment A1), plus 0.005 USD for the one shared Parallel search.
  - Output tokens include thinking tokens.
  - `gemini-4-argon` and `gemini-4-carbon` cost half that through 2026-11-30.
  - `gemini-2.5-flash` has no December price: Google retires it on 2026-12-01.
  - The scorer's own `mean_cost_usd_per_claim` prices every Gemini call at the 2.5-flash rate, so it is not used here.
- **Paired difference:** 2,000 resamples, seed 20260929, on the 193 binary claims (`scripts/accuracy-g0-score.py --arms ... --baseline v2-judge-2.5-flash`).
- **Mean output tokens per claim, thinking included:** A' 1,442; H 811; AR 84; C 495.

### Reading the table

1. **No generally available Gemini 4 arm is shown non-inferior to `gemini-2.5-flash`.**
   - `gemini-4-argon` comes closest: its point estimate is +0.009, but its lower bound (-0.034) misses the -0.03 margin by 0.004.
   - `gemini-4-carbon`'s lower bound is -0.080.
   - `gemini-4-hydrogen` is worse: its whole CI lies below zero.
2. **The pre-registered choice rule therefore gives the third case:** "If no GA arm is non-inferior, `gemini-3.1-pro-preview` stands as the choice." That rests on v1, where `gemini-3.1-pro-preview` was the only arm shown non-inferior: +0.031 [-0.011, +0.076].
3. **The v2 anchor arm P' is invalid because of a per-minute rate limit.** `gemini-3.1-pro-preview` allows 25 requests a minute and 250 a day on our tier (AI Studio rate-limit page).
   - The runner sent its batches concurrently, up to 100 judge calls in one minute: 418 calls between 08:05Z and 08:16Z, with 115 of 200 claims needing retries.
   - 14 claims, all binary, still had no verdict after four calls: 9 provider errors and 5 unreadable replies.
   - The daily limit was not used up. A call to the model at 08:42Z the same Pacific day returned 200, and the page's daily peak stayed at 226 of 250.
   - Its descriptive numbers count those 14 as wrong. They are shown, and not read.
   - **Correction, 2026-11-14:** the first version of this file said the arm failed on the 250-a-day limit. That was wrong: it was the 25-a-minute limit.
4. **Run-to-run spread.** v1 measured the same judge on the same sources moving +0.019 [-0.007, +0.053] between runs. A' on the new sources scored 0.786, against arm A's 0.751 in v1 on the v1 sources. Differences of a few points are within what the sources and the judge's own spread can move.

## Validity (section 7)

| Arm | Binary claims with a status | Rows naming the arm's judge | Parallel calls | Valid |
|---|---|---|---|---|
| A' | 193 of 193 | 200 of 200 | 200 (the shared searches) | yes |
| H | 193 of 193 | 200 of 200 | 0 | yes |
| AR | 193 of 193 | 200 of 200 | 0 | yes |
| C | 193 of 193 | 200 of 200 | 0 | yes |
| P' | 179 of 193 | 186 of 200 (the 14 failures name none) | 0 | **no: under 190** |

P' is reported as invalid with its reason. It was not re-run (section 7).

## Not an arm

`gemini-decision-1` lists only `createDecision` in `models.list` on our key. The engine's judge calls `generateContent`, so testing it needs a new judge path in the engine.

## Deviations, stated

- **A first attempt at v2 never finished.** It ran 03:48Z to 04:16Z.
  - **Why the baseline stopped:** A' stopped itself at 148 of 200 claims with an INVALID from the runner's engine-model check. On two retried claims, attempt 1 had searched and written the cache, and the judge call failed. Attempt 2 read its own cached search, so the engine logged no search leg, and the row's `model` field, the first leg logged, named the judge instead of the retriever. Both rows were judged by `gemini-2.5-flash` on Parallel sources with no Google grounding, so the engine model did not change.
  - **What followed:** the run script did not stop on that exit. So H and AR ran on a 148-entry cache, and each failed the 52 claims missing from it. C was stopped before it wrote a row.
  - **The fix:** the check was fixed in `1603656` (with `--judge-model` set, a row whose `model` is its own judge is not an engine-model change; a change of the search leg still stops the run). The run script now stops on any failed arm and checks that A' has 200 rows before the read arms start.
  - **The re-run:** A' then resumed its remaining 52 claims on the same cache and the same engine commit, and H, AR and C ran again from the start.
  - **Spend and files:** the first H and AR attempts cost 2.60 USD and are kept with the run's working files, not committed, because they hold no scored row. No rule in sections 3 to 7 changed.
- **The engine ran from a worktree at `dc76ea5`, the runner from `1603656`.** The runner refuses to resume an arm across an engine commit, so the local API stayed on the registered commit. Every row records `engineSha` `dc76ea5`.

## Spend

| Part | Price billed during the run |
|---|---|
| A' (200 searches and 200 judge calls) | 1.90 USD |
| H | 2.14 USD |
| AR | 1.42 USD |
| C | 2.23 USD |
| P' (418 calls) | 2.18 USD |
| First attempt, aborted H and AR | 2.60 USD |
| **Total** | **about 12.5 USD**, inside the 15 USD cap |

## Files

| File | Contents |
|---|---|
| `data/judge-ab-v2-2026-11-14.<arm>.jsonl` | Per claim: id, gold label, status, sources count, tokens, Parallel calls, judge model, attempts, engine commit. No claim, source or reply text |
| `data/judge-ab-v2-2026-11-14.<arm>.spend.jsonl`, `.attempts.jsonl` | The runner's spend and attempt ledgers |
| `data/judge-ab-v2-2026-11-14.summary.json` | The scorer's per-arm blocks and paired differences |
