# Accuracy G0 results: verdict accuracy on Factcheck-Bench

**Status (2026-10-05): MEASURED, NOT YET VERIFIED.** The run followed `docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md` with amendments A1, A2 and A3. Two §8 steps remain, both for dx3-pm: re-score the committed outputs, and re-run the 100-id subsample. Beta criterion (a), GoPMO 1.18.7.3.1, counts only once both pass.

## Headline

**Balanced accuracy 0.763, 95% CI [0.722, 0.802]**, on the 631 binary claims. An abstention (`mixed` or `unverified`) is counted as wrong. Bootstrap: seed 20260929, 2,000 resamples.

This measures whether the verify phase gives the right verdict for a claim it is handed. It does not measure claim extraction or the risk score.

## Run identity

| Item | Value |
|---|---|
| Gold set | Factcheck-Bench subtask 4, 661 claims, sha256 `b87f971c…917dbae1` (§2) |
| Path | Hosted API `POST /admin/verify-claims`, production engine |
| Engine | `/health` commit `47b72f099eda5c75dd2f7a7019ec8dde007b50ac`, version 0.11.1 |
| Model | `gemini-2.5-flash` on every item, grounded with Google Search |
| Run | 2026-10-05, 17:42Z to about 18:00Z |
| Outputs | `data/accuracy-g0-full-20261005T174223Z.jsonl` (sha256 `c0953365…7d33d35a`), its attempt ledger, and `…score.json` |
| Failures | 0 of 661; every item answered on its first call (661 ledger lines) |
| Validity | §5 VALID: one model, one engine, no missing or repeated id, gold labels match |
| Independent review | codex PASS on the design and harness, `al:6794f91790683de4` |

Re-score at $0: `python3 scripts/accuracy-g0-score.py docs/research/data/accuracy-g0-full-20261005T174223Z.jsonl`

## All metrics (95% bootstrap CIs)

| Metric | Value | CI |
|---|---|---|
| Balanced accuracy, abstention wrong (headline) | 0.7633 | [0.7223, 0.8020] |
| Accuracy | 0.7987 | [0.7670, 0.8288] |
| Recall on false claims | 0.6918 | [0.6178, 0.7597] |
| Recall on true claims | 0.8347 | [0.8008, 0.8695] |
| False-claim flag rate | 0.8050 | [0.7407, 0.8625] |
| Coverage (binary items given a verdict) | 0.9033 | [0.8811, 0.9271] |
| Selective accuracy (on items given a verdict) | 0.8842 | [0.8576, 0.9099] |
| NEE items: share left unverified or mixed (n=30) | 0.1333 | [0.0333, 0.2667] |
| Time-sensitive claims, BA (n=20) | 1.0000 | [1.0000, 1.0000] |
| Other claims, BA (n=611) | 0.7483 | [0.7059, 0.7904] |

## Confusion matrix

| Gold \ verdict | supported | contradicted | mixed | unverified |
|---|---|---|---|---|
| true (472) | 394 | 36 | 42 | 0 |
| false (159) | 30 | 110 | 18 | 1 |
| not enough evidence (30) | 13 | 13 | 4 | 0 |

`mixed` breakdown: 3 came from an unparseable model reply (`parseFallback`, 2 true and 1 NEE); the other 61 were the model's own inconclusive verdict.

## What the numbers say

- When the engine gives a verdict, it is right 88% of the time. It gives one on 90% of binary claims.
- The weaker side is false claims: 69% of them are marked contradicted, 19% (30 of 159) are passed as supported, and the rest go to `mixed`.
- On the 30 claims that the gold set says cannot be settled, the engine took a side 26 times, and only 4 were left `mixed`. Abstention is not yet calibrated. That is the lever 2 question in `2026-10-01-cache-and-jev-brief.md`.
- The time-sensitive subgroup has only 20 items. Its perfect score says little.

## Spend (logged per the dx3-pm request, al:1c79898f4d631cd1)

Read from admin `GET /usage`:

| | Before (≈17:40Z) | After (18:01:53Z) | Change |
|---|---|---|---|
| Grounded prompts, Pacific day 2026-10-05 | 0 | 661 | +661 |
| Provider-spend ledger, 2026-10 | $0.1424277 | $23.5320876 | +$23.39 |
| Ledger write failures | 0 | 0 | |

The $23.39 is under the prereg ceiling of $25. The ledger prices every grounded call at $0.035 (`packages/api/src/store/costs.ts:47`), including calls inside the free 1,500 a day. So $23.39 is the list-price bound. The day's 661 prompts were inside the free allowance, where Google charges only tokens, so the true charge should be about $0.25. That is a lead: the Google bill was not read.

## Limits

- One model, one day, one dataset. Factcheck-Bench claims date from 2023, and live search answers them with 2026 evidence.
- 159 false items, so recall on false claims carries a CI about 14 points wide.
- No grounded text was stored. Each row holds only `id`, `gold`, `status`, `apiError`, `parseFallback`, `attempts`, `model`, `engineSha` and `ts` (Google grounding terms).

## Next

1. dx3-pm re-scores the committed outputs. The numbers must match this page exactly.
2. dx3-pm dispatches `accuracy-g0.yml` with `set: verify-subsample`. A3 decides the outcome: AGREEMENT, or NOT REPRODUCED published as such.
3. Once both pass, the stage line "Verdict accuracy has not yet been measured on a labelled test set" changes on every surface, through CE copy review (prereg §11).
