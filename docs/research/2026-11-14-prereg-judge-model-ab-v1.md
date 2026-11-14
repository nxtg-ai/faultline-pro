# Judge model A/B on the G0 claims: pre-registration v1

**GoPMO:** 1.18.11.7.127 · **Owner:** fp · **Status:** v1 RUN 2026-11-14 (results file linked in section 10). Amendment A1 (v2) REGISTERED, NOT RUN.
**Registered:** 2026-11-14. The commit that lands this file on `origin/main` is the registration timestamp. No paid call of this run may happen before that commit. Sections 3 to 7 may not change once the first paid arm call has been made. A change made before that point is an amendment in section 10, with its reason.

## 0. Why this run exists

Faultline's hosted verdict is judged by `gemini-2.5-flash`: the default in `packages/cli/services/geminiService.ts`, with no `FAULTLINE_GEMINI_MODEL` set in production. Google's deprecations page (read 2026-11-10) says that from 2026-12-01 every API request to `gemini-2.5-flash` routes automatically to `gemini-3.5-flash-lite`. If nothing is measured before then, the production judge changes to a model whose accuracy on our claims is unknown.

This run measures the candidate judges on the same claims, with the same retrieved sources, so that the production model can be chosen on a measured number.

**This run reports. It does not choose.** Section 6 names two readings and both are reported. The choice of production model is made by the program owner from the table, outside this document.

## 1. Question

**RQ1 (verdict):** On the G0 binary claims, with the same Parallel search results per claim, how does each candidate judge's balanced accuracy compare with `gemini-2.5-flash`?

**RQ2 (extraction):** Does each candidate model, used as the extraction model, split the same documents into about the same number of claims as `gemini-2.5-flash`, without errors?

## 2. Arms

All arms run the hosted engine's retrieve-then-judge path (`grounding: parallel`, Parallel mode `advanced`, the production setting), on a local API at one fixed engine commit, recorded in every row. The judge model is set per arm by `FAULTLINE_GEMINI_MODEL` on that local API. No production flag, secret or deploy is touched.

| Arm | Judge model | Role |
|---|---|---|
| A | `gemini-2.5-flash` | baseline, today's production judge |
| A2 | `gemini-2.5-flash` | the same arm a second time, on the same sources: the judge's own run-to-run spread |
| L | `gemini-3.5-flash-lite` | the automatic 2026-12-01 replacement |
| F | `gemini-3.8-flash` | the replacement Google names for `gemini-2.5-pro` |
| P | `gemini-3.1-pro-preview` | the strongest current Gemini judge |

**Model ids.** Before the first paid call the runner lists the models on our Gemini key (`models.list`, which costs nothing). If any id above is missing, that arm does not run, and the table says so. Each verify response names the judge model that ran it. A row whose named model differs from its arm's model is a failure for that row.

**Order.** A, then L, F, P, then A2, all within one 24-hour window.

## 3. Claims and gold labels

- **Set:** Factcheck-Bench subtask 4 (`docs/research/data/`, the file and sha256 fixed in `2026-10-02-prereg-verdict-accuracy-g0-v1.md` section 2).
- **Sample:** the same 200 claims as the 2026-11-05 and 2026-11-06 grounding runs: `--sample 200 --seed 20261105`. 193 of them have a binary gold label (`true` or `false`). Only those 193 are scored for RQ1.
- Nothing is excluded after the run.

## 4. Shared sources

Retrieval is held fixed so that the arms differ only in the judge.

- Arm A makes one Parallel search per claim, as production does. The engine writes each claim's search result to a local cache keyed by the claim text.
- Arms L, F, P and A2 read the search result from that cache and make no Parallel call.
- A claim whose arm A search failed has no cached result. It is retried in arm A within the runner's retry rules; if it still has none, every arm reports it as a failure, scored as wrong.
- The cache is turned on only by a local environment variable that production does not set. It lives outside the repository, readable by the owner only, and is deleted once scoring is done. No search result, source text or claim text is committed; the committed rows hold ids, labels, statuses, counts, token counts and costs only.

## 5. Scoring (fixed now)

Labels map as in the G0 v1 pre-registration, section 3:

| Status | Scored as |
|---|---|
| `supported` | predicts `true` |
| `contradicted` | predicts `false` |
| `mixed`, `unverified`, any failure | predicts nothing, so it counts as wrong |

- **Headline per arm:** balanced accuracy on the 193 binary claims, with its 95% bootstrap CI (2000 resamples, seed 20260929, `scripts/accuracy-g0-score.py`).
- **Paired difference:** each arm minus arm A, on the claims both arms scored, paired bootstrap with the same resamples and seed (`paired_difference`).
- **Also per arm:** unverified rate, the not-checkable share, status agreement with arm A, and failures.
- **Cost per claim, at each model's own list price.** The API's cost field prices every Gemini call at the `gemini-2.5-flash` rate, so it is wrong for the other arms. The table instead uses each row's recorded input and output tokens, multiplied by that arm's list price, plus the Parallel search fee (0.005 USD a claim, the same for every arm since the search is shared). List prices per million tokens, input / output, read 2026-11-10:

| Model | Input | Output |
|---|---|---|
| `gemini-2.5-flash` | 0.30 | 2.50 |
| `gemini-3.5-flash-lite` | 0.30 | 2.50 |
| `gemini-3.8-flash` | 0.75 (1.50 from 2027-01-01) | 3.75 (7.50 from 2027-01-01) |
| `gemini-3.1-pro-preview` | 2.00 | 12.00 |

The table shows 3.8-flash at both prices. Output tokens include any thinking tokens the model reports.

## 6. The two readings (both reported)

1. **Non-inferiority.** An arm is non-inferior to `gemini-2.5-flash` when the lower bound of its paired 95% CI against arm A is at or above -0.03.
2. **Superiority.** An arm is better than `gemini-2.5-flash` when that lower bound is above +0.03.

Each arm is listed with its reading, its balanced accuracy and its cost per claim. Arm A2 gives the spread of the same judge on the same sources. A difference the size of A2 minus A is not evidence of a better or worse judge, and the table states it beside the readings.

## 7. Validity rules (fixed now)

- An arm is **valid** when at least 190 of the 193 binary claims returned a status (not a transport failure) after the runner's retries, and every row names the arm's own judge model.
- Arms L, F, P and A2 are valid only if they made **zero** Parallel calls (the shared-sources rule), read from each row's usage.
- An invalid arm is reported as invalid with its reason. It is not re-run under a new rule.
- Arm A runs once. A2 is its pre-planned repeat, not a re-try.

## 8. RQ2, the extraction check

- **Inputs:** the 66 `doc10` documents of `2026-11-05-extraction-cost.md` (10 consecutive gold claims joined into one text, claims 0 to 659), through the same `extractClaims` call `/scan` makes (`scripts/measure-extraction-cost.mts`).
- **Models:** all four in section 2, one pass each.
- **Reported per model:** calls with errors, mean claims out per document, the share of documents within one claim of the `gemini-2.5-flash` count, and mean cost per document at that model's list price.
- **Flag (descriptive):** a model is flagged when more than 2% of its calls fail, or when its mean claims out differs from `gemini-2.5-flash` by more than 20%. A flag is reported. It is not a ruling.

## 9. Spend

- **Hard cap:** 25 USD for the whole run at list price, counted from tokens at each arm's own price (section 5), not from the API's cost field.
- **Estimate, before the run:** search 193 × 0.005 ≈ 1 USD once; judges about 1 to 2 USD for each flash arm and 3 to 6 USD for the pro arm, more if thinking tokens are large; extraction under 2 USD for all four models. Total about 10 to 14 USD.
- **Guard:** after the first 25 claims of each arm, the runner projects that arm's cost from its tokens. If the projected total for the run would pass 25 USD, the arm stops, and the table reports it as stopped on cost.
- The spend goes through the local API's provider-spend ledger, and the run's spend ledger is committed with the rows.

## 10. Amendments

### A1, 2026-11-14: run v2, the Gemini 4 arms

Registered by the commit that lands this amendment on `origin/main`, before any paid call of v2. The v1 run (sections 2 to 9) is finished and stays as reported. Its results: `2026-11-14-judge-model-ab-results.md`.

**Reason.** Three Gemini 4 models were generally available before v1 was registered, and v1 had no arm for any of them: `gemini-4-argon` (GA 2026-10-13), `gemini-4-carbon` (GA 2026-11-10) and `gemini-4-hydrogen` (GA 2026-11-12). Source: Google's Gemini API release notes and pricing page, read 2026-11-14. The program owner ruled a second run before any production change (GoPMO 1.18.11.7.127).

**What v2 keeps from v1:** the 193 binary claims and labels (section 3), the scoring (section 5), the two readings (section 6), the validity rules (section 7), the runner and the scorer.

**Arms.**

| Arm | Judge model | Role |
|---|---|---|
| A' | `gemini-2.5-flash` | baseline; makes the searches and writes the shared cache |
| H | `gemini-4-hydrogen` | GA |
| AR | `gemini-4-argon` | GA |
| C | `gemini-4-carbon` | GA |
| P' | `gemini-3.1-pro-preview` | preview; the v1 choice, re-run on the same engine and sources as the anchor |

- **Why the baseline runs again.** Section 4 deleted the v1 search cache after scoring, so the v1 sources cannot be reused. Every v2 arm is compared with A' on the same new sources: A' searches once per claim, and H, AR, C and P' read its cache and must make zero Parallel calls (section 7).
- **`gemini-decision-1` is not an arm.** `models.list` on our key shows it supports only `createDecision`. The engine's judge calls `generateContent`, so testing it needs a new judge path in the engine, a production code change. That is out of scope for this run.
- **Model ids.** `models.list` on our key, 2026-11-14 03:31Z, lists all five arm models with `generateContent`. One call per Gemini 4 model with the engine's judge settings (thinking budget 4096, maximum output 6144, JSON reply) returned a verdict; these smoke calls are not part of the run.
- **Engine:** `origin/main` at registration, one local API per arm, with the judge set by `FAULTLINE_GEMINI_MODEL`. The rate-limit fallback (`FAULTLINE_GEMINI_FALLBACK_MODEL`) is unset, so every verdict comes from the arm's own model, and the runner's judge-model check fails any row that names another model.
- **Order:** A' first, then H, AR, C, then P'. `gemini-3.1-pro-preview` has a limit of 250 requests a day on our tier, and 226 were used on 2026-11-13 Pacific (AI Studio rate-limit page, read 2026-11-14 03:33Z). So P' runs after the Pacific day resets at 08:00Z. All arms run within 24 hours of A'.
- **No repeat arm.** The v1 spread of the same judge on the same sources, +0.019 [-0.007, +0.053], is cited beside the readings instead.

**Prices**, per million tokens, input / output, from the Gemini API pricing page, read 2026-11-14:

| Model | Billed during the run | From 2026-12-01 |
|---|---|---|
| `gemini-2.5-flash` | 0.30 / 2.50 | retired 2026-12-01 |
| `gemini-4-hydrogen` | 1.50 / 7.50 | 1.50 / 7.50 |
| `gemini-4-argon` | 2.00 / 10.00 | 4.00 / 20.00 |
| `gemini-4-carbon` | 2.00 / 10.00 | 4.00 / 20.00 |
| `gemini-3.1-pro-preview` | 2.00 / 12.00 | 2.00 / 12.00 |

- **Cost per claim in the table is at the price from 2026-12-01**, the price production would pay, plus the 0.005 USD Parallel search.
- **The spend cap is counted at the price billed during the run.**

**Choice rule, fixed now (program owner's ruling, recorded here before the run):**
1. A generally available model that is non-inferior (section 6, reading 1) beats the preview model.
2. Among GA models that are non-inferior, the cheapest per claim at its price from 2026-12-01 wins, unless another GA arm is shown better than it (paired lower bound above +0.03).
3. If no GA arm is non-inferior, `gemini-3.1-pro-preview` stands as the choice.

This file records the rule. The choice itself is made by the program owner from the table.

**Spend.**
- **Hard cap:** 15 USD for v2, at the billed price.
- **Per-arm guard** (the runner's `--cap-usd`, projected after 25 claims, including the search fee): A' 2.5, H 2.5, AR 3, C 3.5, P' 3 USD.
- **Estimate:** about 8 to 13 USD, scaled from the v1 token counts. Thinking tokens on the Gemini 4 models are the unknown.

**Data handling.** Google's storage of Generate Content requests was turned off for our project before v2 (AI Studio Logs and Datasets settings, 2026-11-14 03:35Z), so the run's requests are not stored. Section 4's rules on the cache hold for v2: kept outside the repository, readable by the owner only, deleted after scoring, and no claim, source or reply text committed.

**Results file:** `2026-11-1x-judge-model-ab-v2-results.md`, with the contents listed in section 11 (no RQ2 extraction check in v2), plus each arm's GA or preview status and the outcome of the choice rule.

## 11. What the result file will contain

`docs/research/2026-11-1x-judge-model-ab-results.md`, citing this file's registration commit:
- engine commit and run window;
- per arm: n, balanced accuracy with CI, paired difference with CI, the reading from section 6, unverified rate, not-checkable share, failures, cost per claim;
- the A2 minus A spread;
- the RQ2 table;
- total spend.
