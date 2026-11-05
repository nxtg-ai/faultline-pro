# Verdict accuracy baseline (G0): pre-registration v1

**GoPMO:** 1.18.7.3.1 (Faultline beta gate, criterion a) · **Owner:** fp · **Verifier:** dx3-pm (re-run), plus an independent review of this design before any paid run · **Status:** REGISTERED, NOT RUN.
**Registered:** 2026-10-02. The commit that lands this file on `origin/main` is the registration timestamp. Nothing in §5 may change after the run starts; a change before it is an amendment in §10 with its reason.

## 0. Scope, and what this is not

- This measures **today's production verdict**: hosted API, provider `gemini`, `consensus: false`, model `gemini-2.5-flash`. Production sets no `FAULTLINE_GEMINI_MODEL` (Fly `secrets list`, fly-ops run 37058538417, names only), so the default in `packages/cli/services/geminiService.ts:7` applies.
- It is the **G0 / RQ1 baseline** from `docs/research/2026-10-01-prereg-lever2-verdict-calibration-v1.md`. The Jev and judge arms of that plan stay **deferred** (Asif, 2026-10-02). No judge, no Jev, no batching arm runs here.
- It measures the **verify step only**. Each gold claim is sent as one claim. Claim extraction is not measured: a document-level number would mix extraction errors with verdict errors and could not be scored against claim-level gold.
- **Confidence is not measured.** `verifyClaim` returns a status and an explanation, no confidence (`geminiService.ts:211-216`), so there is nothing to calibrate.

## 1. Question and the number it produces

**RQ:** How often is Faultline's production verdict right on claims a human has labelled against the open web?

**Headline number (one, fixed now):** balanced accuracy on the binary items (§3), with abstentions counted as wrong, and its 95% bootstrap CI.

Balanced accuracy is the mean of recall on true claims and recall on false claims. It is used because the set is 75% true: a system that says "supported" to everything would score 0.75 plain accuracy and 0.50 balanced accuracy. It is also the LLM-AggreFact metric, so the number sits beside published verifiers.

## 2. Gold set

**Factcheck-Bench**, subtask 4, claim factuality (Wang et al. 2023, https://arxiv.org/abs/2311.09000).

- File: `https://raw.githubusercontent.com/yuxiaw/Factcheck-GPT/main/subtasks/subtask4_claim_factuality.jsonl`
- sha256 `b87f971ce324c87e0427f100fe24b50594b9d44e3a764490b1bef188917dbae1`, 661 lines, fetched 2026-10-02. The run refuses any other hash.
- Licence: the repository is Apache-2.0 (`gh api repos/yuxiaw/Factcheck-GPT` → `license.spdx_id`). We copy the file into the repo under `docs/research/data/` with its licence notice.
- Labels: human annotators checked atomic claims from ChatGPT answers against open-web evidence. `true` 472, `false` 159, `not_enough_evidence` 30.
- **Why this set.** It is the closest public match to what Faultline does: claims taken from AI output, judged against the open web.
  - AVeriTeC is CC BY-NC 4.0, and admitting it for a commercial product is Asif's call (lever-2 prereg §3). It stays out.
  - LLM-AggreFact labels a claim against a supplied document, not live retrieval, so it measures something else.
  - Our own scans (set F in the lever-2 plan) have no human labels. A human labeller is a named dependency, not part of this run.

**Item ids:** the 0-based line number in the file. **All 661 items run.** Nothing is sampled out and nothing is excluded after the run.

## 3. Label mapping and abstention (fixed now)

| Faultline status | Scored as |
|---|---|
| `supported` | predicts `true` |
| `contradicted` | predicts `false` |
| `mixed` | **abstention** |
| `unverified` | **abstention** |
| `apiError: true` after retries (§6) | **failure**, counted as wrong and reported separately |

- **Binary items:** the 631 with gold `true` or `false`. These carry the headline. An abstention on a binary item is wrong.
- **NEE items:** the 30 with gold `not_enough_evidence`. They are reported separately (§4) and do not enter the headline.
- **Known confound:** `verifyClaim` returns `mixed` when the model's reply is not parseable JSON (`geminiService.ts:186-191`). So `mixed` can mean "inconclusive" or "unparseable". Both count as abstention. The run logs which one it was (a flag, not the text) so the split can be reported, but the score does not change.

## 4. Metrics (all fixed now)

On the 631 binary items:

1. **Balanced accuracy, abstention counted wrong** (headline).
2. Plain accuracy, abstention counted wrong.
3. Recall on false claims (gold `false` → `contradicted`). Catching false claims is the product.
4. Recall on true claims (gold `true` → `supported`).
5. False-claim flag rate: gold `false` → `contradicted` or `mixed`. The UI flags both, so this is the user-visible catch rate. It is secondary and never replaces 3.
6. Coverage: share not abstained. Selective accuracy: accuracy on the items not abstained.
7. Full confusion matrix: 3 gold classes × (4 statuses + failure).

On the 30 NEE items: share returned as `unverified` or `mixed`.

Subsets, descriptive only (no bar, no exclusion):

- **Time-sensitive claims.** A claim matches if it contains a 4-digit year from 2019 on, or matches `(?i)\b(current(ly)?|now|today|latest|recent(ly)?|as of|this year)\b`. The gold labels are from 2023, and some of these may have changed since. Report metrics 1–4 inside and outside this subset.
- **Parse-failure `mixed`**, per the confound in §3.

**Uncertainty:** 2,000 bootstrap resamples over items, `numpy.random.default_rng(20260929).integers(0, n, (2000, n))` with items sorted by id, 95% percentile CI. This is the convention kestrel pinned in the Jev Part 1 and Part 2 readouts (`~/ASIF/governance/probes/2026-10-02-jev-p2-repro-kestrel/README.md`).

## 5. Bars

There is no pass bar. Beta criterion (a) asks for the number measured and published, not for a value. The number is reported as measured, with its CI.

Bars apply only to **run validity**. The run is **invalid**, and is re-run or reported as a blocker, never scored, if:

- the gold hash differs from §2;
- more than 2% of items (more than 13) end as failures after retries;
- the model string logged by the engine changes during the run;
- the engine commit changes during the run.

## 6. Harness

- **Path:** the hosted API, so the run uses production's engine, key, model and region, and its grounded prompts are counted by production's own grounding-allowance ledger and spend ledger.
- **Route:** there is no verify-only route today. `POST /scan` would re-extract the claim and could split or reword it. The run therefore needs a new admin-only route, `POST /admin/verify-claims`, that takes up to 25 `{id, text}` claims and calls the same `verificationProvider.verifyClaim` that `packages/cli/cli/scan.ts:311` calls, under the same usage capture as a scan. It is admin-key only, so no customer can reach it. It returns `{id, status, apiError, parseFallback}` only.
- **Runner:** `scripts/accuracy-g0.mjs` reads the gold file, checks the hash, sends batches with concurrency 4, and retries any `apiError` item up to 3 times with backoff. It writes `docs/research/data/accuracy-g0-<runid>.jsonl`, one row per item: `{id, gold, status, apiError, parseFallback, attempts, model, engineSha, ts}`.
- **Nothing grounded is stored.** No explanation, no sources, no search suggestions. This follows the Google grounding terms (`docs/research/2026-10-01-cache-and-jev-brief.md`, and memory `reference_google_grounding_terms`). A status label is our own output.
- **Scorer:** `scripts/accuracy-g0-score.py` reads only the committed outputs plus the gold file, so scoring is exactly reproducible at $0.
- **The scorer must be able to fail.** On a fixture: flip one gold label and balanced accuracy must change; mark every item `supported` and balanced accuracy must be 0.50. Both are shown red on revert before the real run is scored.

## 7. Spend and allowance

- **661 grounded prompts**, plus up to 13 retries.
- The free allowance is 1,500 grounded prompts a day for the project (Gemini 2.5), shared with production traffic.
- **Guard:** the runner reads admin `GET /usage` → `groundingAllowance.groundedPrompts` before starting and before each batch. It stops if the day's count would pass **1,000**, the lever-1 daily cap, which leaves room for production. It resumes the next Pacific day from the next unanswered id. A run split over two days is still one run if §5 holds.
- **Ceiling:** $25 provider spend. At list price, 674 paid prompts would cost $23.59 ($35 per 1,000), and token cost is under $1. Expected cost inside the free allowance is about $1 of tokens.

## 8. Verification by a lane that did not gather the evidence

dx3-pm verifies in two steps, both fixed now:

1. **Re-score:** run the scorer on the committed outputs. The numbers must match the published ones exactly.
2. **Re-run:** run the runner on the **seeded 100-id subsample**. The ids are `sorted(numpy.random.default_rng(20261002).choice(631 binary ids, 100, replace=False))`, and the list is committed with this file before the main run. Compare per item with the original run on the same 100 ids, as a paired bootstrap of the balanced-accuracy difference (same seed and method as §4).
   - **Agreement** if the 95% CI of (re-run − original) contains 0.
   - Also report the per-item status agreement rate.

Live web search is not deterministic, so agreement is defined statistically, not as an identical number.

## 9. Known limits, stated before the run

- **Contamination.** Factcheck-Bench is public (2023). Gemini may have seen it in training, which would flatter the number. Our own labelled scans would not have this problem; that set needs a human labeller.
- **Drift.** The labels reflect 2023. A claim that was true then may be false now, or the reverse. The time-sensitive subset (§4) shows how much this moves the number. Nothing is relabelled.
- **Single claims, not documents.** A real scan also extracts claims, and extraction errors are not in this number.
- **The `mixed` confound** (§3).
- **One model, one day.** It is a baseline for the current production configuration, not a property of the product forever. A change of model or prompt needs a re-run.

## 10. Amendments

- **A1 (2026-10-02, before any run): how the verifier runs without our keys.** §8 named no credential. dx3-pm has no Gemini key and no Faultline admin key. The runner will also exist as a GitHub Actions `workflow_dispatch` workflow, `accuracy-g0.yml`, in `nxtg-ai/faultline-pro`. It has two fixed inputs, `full` (all 661 items) and `verify-subsample` (the 100 ids in `docs/research/data/accuracy-g0-verify-subsample-ids.json`). It reads the admin key from a repo secret, `FAULTLINE_ADMIN_KEY`, which fp sets and never prints. It uploads the per-item output file as a run artifact. Anyone with write access to the repo, dx3-pm included, can dispatch the re-run, and the run id is the instrument. No metric, mapping, item or bar changes.

- **A2 (2026-10-02, before any run): choices the text left open, fixed by the harness.** Each was needed to write `scripts/accuracy-g0.mjs` and `scripts/accuracy-g0-score.py`. No metric, mapping, item or bar changes. Reason for each: the scorer has to compute one exact number, so every open choice is fixed here before the run.
  1. **Year regex (§4).** "A 4-digit year from 2019 on" is `(?<!\d)20(19|[2-9]\d)(?!\d)`: 2019 to 2099, not touching another digit, so "2020s" matches and "12020" does not. The word regex is used as written.
  2. **Failure bar on the subsample (§5).** "More than 2% of items" is `failures > floor(0.02 × items in the set)`: more than 13 of 661 (as written), more than 2 of the 100-id subsample.
  3. **Bootstrap scope (§4).** Every metric family is bootstrapped over its own items, sorted by id, with a fresh `numpy.random.default_rng(20260929).integers(0, n, (2000, n))`: the binary metrics over the binary items, the NEE share over the NEE items, each side of the time-sensitive split over its own items. The CI is `numpy.percentile(values, [2.5, 97.5])` (default linear interpolation). A resample where a metric is undefined (a class absent) is dropped and the number dropped is reported.
  4. **Failures and odd statuses (§3, §4).** A failure is wrong on every metric, and it is not covered: coverage is the share returned as `supported` or `contradicted`, and selective accuracy is accuracy on those. A failure on an NEE item is not a hit. A status outside the four (none is expected) is scored as an abstention and shown as its own confusion column, `other`.
  5. **Paired direction (§8).** The difference is (run named first) − (run passed as `--paired`). For §8 the re-run is named first and the original is `--paired`, so the CI is of (re-run − original). Per-item agreement compares outcomes, with `failure` as an outcome.
  6. **Engine identity (§5).** `GET /health` now reports `commit`, the git sha the image was built from (`FAULTLINE_GIT_SHA`, passed by `fly-deploy.yml`). The runner takes the engine sha from `/health`; only when `/health` has none does it accept `--engine-sha`, and with neither it refuses. It rechecks `/health` before each batch and stops the run as invalid when the commit (or, without a commit, the version) changes. "The model string logged by the engine" is the `model` of the engine's usage record for that call; a call that failed has none and does not count as a change.
  7. **Retries (§6).** "Up to 3 times" is at most 4 calls per item, recorded as `attempts`. A batch whose HTTP call fails as a whole counts one attempt for every item in it. The route makes one provider call per claim and never retries, so every grounded prompt it sends passes the runner's allowance check first. (`scan()` retries only thrown errors; the Gemini adapter never throws, so production verify is one call per claim too.)
  8. **Claim object (§6).** The route builds `{id, text, type: 'fact', importance: 3}`. The verify prompt reads only `text`.
  9. **`parseFallback` (§3).** True only when the reply is non-empty and not JSON, the one path that returns `mixed` for that reason. An empty reply returns `unverified` with no flag; it is an abstention either way.
  10. **Allowance guard (§7).** The runner stops when today's count + the batch size > 1,000; reaching exactly 1,000 is allowed. A `full` run dispatched through the workflow cannot resume in a later dispatch; a run split over two days uses the local runner with `--resume`.
  11. **Completeness.** A run is also invalid if an id is missing, repeated or outside the set, or if a row's `gold` differs from the gold file (§2: all items run, none excluded).

- **A3 (2026-10-03, before any run): the §8 agreement rule, replaced.** This overrides the §8 sentence "Agreement if the 95% CI of (re-run − original) contains 0", and the A2.5 sentence that counts `failure` as an outcome in per-item agreement. Nothing else in §8 changes: the same 100 ids, the same paired bootstrap (§4 seed and method, A2.3, A2.5 direction).
  - **Rule.** The verifier reports **AGREEMENT** only when both hold:
    1. **Per-item status agreement ≥ 0.85** on the 100 subsample ids: the share of ids where the re-run returned the same Faultline status as the original. A failure (`apiError` after retries) on either side counts as a disagreement, including when both sides failed.
    2. **The 95% paired-bootstrap CI of (re-run BA − original BA) lies wholly inside [−0.10, +0.10]**, endpoints included (−0.10 ≤ lower and upper ≤ +0.10), with the same seed and method as §4. A CI that cannot be computed (a gold class absent) does not meet this.
  - Otherwise the verifier reports **NOT REPRODUCED**. The scorer prints both components and the verdict, and still prints whether the CI contains 0, as information only.
  - **Why the old rule was wrong.** "The CI contains 0" is a test for a difference, so failing to find one counted as agreement. The independent reviewer (codex, alignment post `al:d9dff4d8f98c5bc2`) built two runs on the committed 100 ids in which **every** prediction was opposite. The shipped scorer called them AGREEMENT: BA difference 0.0301, CI [−0.2075, 0.2832], per-item agreement 0.0000. A wide CI passed. Agreement has to be shown, not merely not refuted, so A3 asks for equivalence within a margin plus a per-item floor.
  - **Why ±0.10.** It is the size the fleet's Jev context prereg (`~/ASIF/enrichment/2026-10-01-jev-context-eval-prereg-v1.md`, §4, H5) required before a context effect counted: the paired-bootstrap CI entirely above 0 **and** a gain of at least 10 points of accuracy. That was a one-sided floor on an effect, on plain accuracy. Here the same size is used as a two-sided equivalence margin on balanced accuracy: a difference that could be 10 points or more either way is treated as material. The margin is a choice made now, before any data.
  - **Why 0.85.** At most 15 of the 100 verdicts may change on a re-run. Live search is not deterministic, so some movement is expected; more than 15 changed verdicts is not a reproduction even when the two balanced accuracies happen to match.
  - **On failure.** NOT REPRODUCED is a published result. The G0 number is still published, labelled "not reproduced by the verifier", and beta criterion (a) is **not met** until a follow-up, registered as a new amendment before it runs, resolves the disagreement. The re-run is not repeated until it passes.
  - **Accepted in advance.** The subsample holds 79 true and 21 false items. Each false item moves recall on false claims by about 0.048, so the BA difference CI will be wide, and the margin may be hard to meet even for a stable system. That is accepted now and will not be adjusted after data.

## 11. After the number exists (follow-on, not part of this run)

Every stage line shipped on 2026-10-02 says "Verdict accuracy has not yet been measured on a labelled test set". It appears in both READMEs, `llms.txt`, the CHANGELOG and the faultline-action README. When the number is published, that sentence changes on every surface and goes back through CE copy review.
