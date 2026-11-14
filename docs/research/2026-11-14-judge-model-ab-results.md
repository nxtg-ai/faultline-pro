# Judge model A/B on the G0 claims: results, 2026-11-14

Pre-registration: `2026-11-14-prereg-judge-model-ab-v1.md`, registered at commit `7867a1e` on 2026-11-14 00:24Z, before any paid call of this run. GoPMO 1.18.11.7.127.

**This run reports. It does not choose.** The choice of production model is made by the program owner from this table.

- **Engine:** main at `e501763`, on a local API, one process per arm, with the judge set by `FAULTLINE_GEMINI_MODEL`. Retrieve-then-judge (`grounding: parallel`, Parallel `advanced`). No production flag, secret or deploy was touched.
- **Claims:** the 200 G0 claims, `--sample 200 --seed 20261105`. Scored on the 193 with a binary gold label.
- **Shared sources:** arm A searched once per claim and wrote each reply to a local cache. Every other arm read it and made **zero** Parallel calls (the `parallelCalls` column of each row). The cache was deleted after scoring.
- **Run window:** 2026-11-14 01:11Z to 01:49Z.

## Verdicts (RQ1)

| Arm | Judge | BA [95% CI] | Minus arm A [paired 95% CI] | Non-inferior (lower ≥ -0.03) | Better (lower > +0.03) | Unverified | Not checkable | Cost per claim |
|---|---|---|---|---|---|---|---|---|
| A | `gemini-2.5-flash` | 0.751 [0.671, 0.827] | | | | 1.0% | 1.0% | 0.00983 USD |
| L | `gemini-3.5-flash-lite` | 0.702 [0.621, 0.779] | **-0.049 [-0.099, -0.003]** | no | no | 5.0% | 5.0% | 0.00739 USD |
| F | `gemini-3.8-flash` | 0.724 [0.643, 0.800] | -0.027 [-0.076, +0.019] | no | no | 4.0% | 2.0% | 0.00950 USD (0.01400 from 2027-01-01) |
| P | `gemini-3.1-pro-preview` | 0.782 [0.709, 0.851] | +0.031 [-0.011, +0.076] | **yes** | no | 1.5% | 1.0% | 0.01756 USD |
| A2 | `gemini-2.5-flash`, repeat | 0.770 [0.691, 0.843] | +0.019 [-0.007, +0.053] | (same judge) | | 1.0% | 0.5% | 0.00981 USD |

- **Cost per claim** is each row's input and output tokens at that model's list price (prereg section 5), plus 0.005 USD for the one shared Parallel search. Output tokens include thinking tokens. The scorer's own `mean_cost_usd_per_claim` in the summary file prices every Gemini call at the 2.5-flash rate, so it is wrong for arms L, F and P and is not used here.
- **Paired difference:** 2,000 resamples, seed 20260929, on the 193 binary claims (`scripts/accuracy-g0-score.py --arms ... --baseline judge-2.5-flash`).
- **Status agreement with arm A:** L 90.2%, F 88.6%, P 92.2%, A2 94.3%.

### Reading the table

1. **`gemini-3.5-flash-lite`, the model Google routes `gemini-2.5-flash` to from 2026-12-01, is worse.** Its paired CI lies wholly below zero, and its lower bound (-0.099) is far under the -0.03 margin. It also leaves five times as many claims unchecked (5.0% against 1.0%). It is about 25% cheaper per claim.
2. **`gemini-3.8-flash` is not shown non-inferior.** Its point estimate is -0.027, and the lower bound is -0.076. Its price doubles on 2027-01-01.
3. **`gemini-3.1-pro-preview` is the only arm shown non-inferior.** Its point estimate is +0.031, but the lower bound (-0.011) is not above +0.03, so the superiority reading is not met. It costs about 1.8 times arm A per claim.
4. **The same judge on the same sources moved +0.019 [-0.007, +0.053] between runs** (A2 minus A). Any difference about that size is within the judge's own run-to-run spread on this set.

## Extraction (RQ2)

The 66 `doc10` documents, one pass per model, through the same `extractClaims` call `/scan` makes:

| Model | Calls with errors | Mean claims out | Within 1 claim of 2.5-flash | Cost per document | Flag |
|---|---|---|---|---|---|
| `gemini-2.5-flash` | 0 / 66 | 10.30 | | 0.00430 USD | |
| `gemini-3.5-flash-lite` | 0 / 66 | 10.00 | 97% | 0.00309 USD | |
| `gemini-3.8-flash` | 0 / 66 | 10.03 | 97% | 0.00222 USD | |
| `gemini-3.1-pro-preview` | **46 / 66** | 10.00 (on 20) | 95% (on 20) | 0.01661 USD (on 20) | **flagged: errors** |

The 46 `gemini-3.1-pro-preview` errors are `rate_limited` (the engine's `ExtractionError` reason for a 429, `RESOURCE_EXHAUSTED`, quota or rate-limit reply from Google on our key). Three documents re-tried after the pass also returned `rate_limited`. That is our key's quota for the preview model, not the model's output, and it bears on using a preview model in production. The judge arm P met the same limit: 33 of its 200 claims needed two to four calls, and all of them returned a verdict within the runner's four-call ceiling.

## Validity (prereg section 7)

Every arm is **valid**:
- 193 of 193 binary claims returned a status in every arm, with 0 failures.
- Every row names its arm's judge model (`judgeModel`, checked by the runner's `--judge-model`).
- Arms L, F, P and A2 made 0 Parallel calls.

## Deviations, stated

- **A first attempt at arms L, F and P never reached their models.** The first run script stopped only the wrapper shell around arm A's API, so arm A's server, with judge `gemini-2.5-flash`, kept the port. The next three servers failed to bind, and each arm's first batch of 25 claims went to arm A's server. The runner's judge-model check stopped each arm at that first batch, before any row was written (exit 4, "judged by gemini-2.5-flash, not ..."). The script was fixed: each arm gets its own port and process group, and checks that its own server is the one answering. Arms L, F and P then ran from the start. No rule in sections 3 to 7 changed. Those three aborted batches cost 0.37 USD at the 2.5-flash rate. Their attempt and spend ledgers are kept with the run's working files, not committed, because they hold no scored row.
- **A2 ran second, not last.** It ran against arm A's leftover server, whose judge was `gemini-2.5-flash` (A2's own judge), and every one of its claims was a cache hit (0 Parallel calls). It therefore meets every section 7 rule. The pre-registered order (A, L, F, P, then A2) was not kept. All five arms ran inside one 38-minute window.

## Spend

| Part | List price |
|---|---|
| Arms A, L, F, P, A2 | 6.82 USD (A 1.97 including the 200 searches, L 0.48, F 0.90, P 2.51, A2 0.96) |
| Three aborted first batches | 0.37 USD |
| Extraction, four models | 0.97 USD |
| **Total** | **about 8.2 USD**, inside the 25 USD cap |

## Files

| File | Contents |
|---|---|
| `data/judge-ab-2026-11-14.<arm>.jsonl` | Per claim: id, gold label, status, sources count, tokens, Parallel calls, judge model, attempts. No claim, source or reply text |
| `data/judge-ab-2026-11-14.<arm>.spend.jsonl`, `.attempts.jsonl` | The runner's spend and attempt ledgers |
| `data/judge-ab-2026-11-14.summary.json` | The scorer's per-arm blocks and paired differences |
| `data/judge-ab-2026-11-14.extraction.<model>.jsonl` | Per document: range of gold lines, claims out, tokens, error name |
