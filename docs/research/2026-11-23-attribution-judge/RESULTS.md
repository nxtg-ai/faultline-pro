# Results: the judge grades truth, not attribution (2026-11-23)

Plan: `PREREG.md` and `heldout.json`, committed in 43755d6 (2026-11-23 00:44:54Z) before any run on the set and before any judge change.

## Baseline (before the fix)

- **When:** 2026-11-23, 00:45:20Z to 00:49:45Z, on the hosted API, engine 0.12.3, commit 88c4350db33d.
- **How:** `POST /admin/verify-claims`, provider `gemini`, grounding `parallel`. 18 items, 3 runs each, in batches of 9 about 55 seconds apart.
- **Judge:** `gemini-3.1-pro-preview` on all 54 rows. No row was answered by the fallback model, and no row had a provider error.
- **Raw rows:** `baseline-runs.jsonl`, 54 rows (sha12 a28e1a17d4ad).

| Outcome | Result |
|---|---|
| P1, false claims passed (expected contradicted, majority supported) | 0 of 7 |
| P2, both halves of a pair supported | 0 of 3 |
| P3, expected supported but not supported | 0 of 11 |
| Exact agreement with the expected verdict | 18 of 18 items; 54 of 54 runs |

Every item gave the same verdict on all three runs.

**What this shows:** the held-out set does not reproduce the defect. The judge already handles named, well-documented AI errors and myths, and attributed claims, correctly. The failing case is narrower: an unattributed piece of a company's own policy text ("submit ... by completing our Ticket Refund Application form"), where most retrieved sources are news reports quoting that text. The set will still show whether the fix over-corrects (P3) and whether pairs stay apart (P2). As pre-registered, the fix is judged on the regression case and the tests.

## Regression case (development run, not scored)

The two files from the Air Canada case. One scan each, in-process, with the same judge, extraction model and Parallel mode as production.

| Scan | Engine | Claim 2 verdict |
|---|---|---|
| Chatbot answer, 2026-11-23 00:40:54Z | hosted 0.12.3 | supported: "The retrieved sources confirm that this exact text was provided by an Air Canada chatbot when advising a customer" |
| True policy, 2026-11-23 00:41:10Z | hosted 0.12.3 | supported |
| Chatbot answer, 2026-11-23 00:51:33Z | fix branch, local | **contradicted**: "the sources confirm that this information was inaccurate and directly contradicted the airline's actual policy prohibiting retroactive refunds" |
| True policy, 2026-11-23 00:51:42Z | fix branch, local | supported |

That is one run per file, and it is **not evidence** that the fix works: the unchanged engine also returns contradicted on this claim about 1 time in 3 (diagnostic below). A rate on both engines is needed.

## Set 2, baseline (before the fix)

Plan: `PREREG-set2.md` and `set2-policy-text.json`, committed in a3b7df9 (2026-11-23 00:56:07Z) before any run on the set.

- **When:** 00:56:23Z to 00:59:32Z, hosted API 0.12.3, same route and settings as above, batches of 5 about 40 seconds apart.
- **Judge:** `gemini-3.1-pro-preview` on 29 of 30 rows; one row (P06, run 2) was a provider error. No fallback.
- **Raw rows:** `set2-baseline-runs.jsonl`.

| Outcome | Result |
|---|---|
| D, false items supported | 0 of 5 |
| True items not supported | 0 of 5 |
| Pairs both supported | 0 of 5 |
| Exact agreement | 10 of 10 items |

Set 2 did not reproduce the defect either. Its false items are plain statements that name their subject ("Businesses in New York City are allowed to go cashless"). The judge gets those right.

## Diagnostic: what triggers the defect (regression case, not scored)

Written after both sets failed to reproduce. Same route (`/admin/verify-claims`, judge only, no extraction), hosted 0.12.3, 3 runs each. Raw rows: `diagnostic-runs.jsonl`.

| Claim text | Verdicts |
|---|---|
| The failing claim as extraction produced it: "If you need to travel immediately or have already travelled and would like to submit your ticket for a reduced bereavement rate, kindly do so within 90 days of the date your ticket was issued by completing our Ticket Refund Application form." | contradicted, supported, supported |
| The same claim with its subject named: "Air Canada lets a customer who has already travelled submit their ticket for a reduced bereavement rate within 90 days of the date the ticket was issued, using its Ticket Refund Application form." | contradicted, contradicted, contradicted |

**Reading:** the defect follows a claim with no named subject ("our", "you"). Such a claim can only be checked by finding where its text appears, and the sources that contain it are reports of the chatbot saying it. The cause is upstream of the judge: extraction kept the chatbot's second-person wording. The extraction prompt asks for "a standalone sentence" but does not ask that words like "our", "we" and "you" be replaced by who they refer to. The passage leg is not needed for the defect: it reproduces without it.


## Corrections recorded 2026-11-23 ~11:20Z

- **Void: the judge-only rate test's fix arm and the extraction test.** My scratch worktrees linked `node_modules` to the main checkout. Their local engines therefore resolved `@nxtg/faultline` to main's CLI. The judge-only rate test's fix arm (reported as "no clear difference") and the extraction test's fix arm both measured main's code; both results are void. A G0 arm X attempt the night before was also void. The proof of arm is now `scripts/arm-proof.sh`: every file the arm commit tracks in `packages/cli`, compared by git hash-object, plus untracked files and `require.resolve` from the engine's working directory. A commit taken from git HEAD cannot prove which code ran.
- **Rate-test rerun (arm X only, approved before it ran):** commit 8909f0a, engine proven by arm-proof (MATCH), measurement project, 11:20 to 11:24Z, the same claim. Result: contradicted 10 of 10, judge gemini-3.1-pro-preview on all 10. Last night's arms gave M supported 6 / contradicted 3 / 1 error, and H supported 6 / contradicted 4. Three differences from those arms:
  - the Google project and key;
  - the time, about 10 hours later;
  - the evidence pool, since every call made a fresh search at a different time.

  The 6-run gap may not come from the judge rule alone. This is one claim on the judge-only route, the regression case. It is a **lead** for the held-out sets of the next design (a separate subject field), not evidence, and no decision rests on it. A first rerun attempt is invalid: its engine's search cache was read-only and the claim was not cached, so all 10 calls failed before the judge.

## G0 no-harm check (PREREG-g0.md with amendments A1 to A3)

| Arm | Code (arm-proof) | BA [95% CI] | Binary claims with a status | Unverified | Fallback |
|---|---|---|---|---|---|
| M, production engine code run locally, configuration matched | 6b2f410 (reflog window) | 0.8146 [0.7445, 0.8798] | 192 of 193 | 2.5% | 0 |
| X, judge attribution rule | 8909f0a (257 of 257 files) | 0.7634 [0.6920, 0.8376] | 190 of 193 | 4.0% | 0 |

- **Paired difference X minus M:** -0.0512 [-0.1085, +0.0000] (2,000 resamples, seed 20260929, n = 193).
- **Reading, under the pre-registered rule:** **FAIL.** The point estimate is below -0.02. Both arms are valid (at least 190 of 193), and X made zero searches.
- **Where X lost:** 8 binary claims that M had right, and X won 2.
  - 3 were judge replies that could not be read (provider_unparseable).
  - 4 moved to mixed (3 from contradicted, 1 from supported).
  - 1 the judge marked not checkable.
  - None came from the new downgrade of an assertion-only "supported" to unverified.
- **Agreement:** 179 of 193 binary claims kept the same status (0.927) on the same cached searches.

## Decision

- **The judge attribution rule is dropped.** It failed its own pre-registered no-harm bar, and is neither shipped nor sent back for another measurement.
- **Where the losses came from:** the prompt change itself, not the rule firing. None of X's losses was the new downgrade. Unreadable judge replies rose from 1 to 3 after one extra JSON key, and 4 verdicts moved to mixed.
- **Bar for the next design:** the next design (a separate subject field) also changes the Gemini response schema. Its no-harm bar will include the parse-failure rate and the share of verdicts moved to mixed, each with its own limit stated before the run, beside the paired balanced-accuracy floor.
- **What ships:** only the parts that do not touch a verdict. That is the full-input fingerprint, `engineCommit`, the runner's `--batch-size` and `--pause-ms`, and `scripts/arm-proof.sh`.
