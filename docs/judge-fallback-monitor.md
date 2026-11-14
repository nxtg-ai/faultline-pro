# Judge fallback monitor

GoPMO 1.18.11.7.127 (the judge model A/B, `docs/research/2026-11-14-judge-model-ab-results.md`). The production judge is `FAULTLINE_GEMINI_MODEL`. When it answers with a rate limit, the claim goes to `FAULTLINE_GEMINI_FALLBACK_MODEL`. This monitor shows how often that happens, so the cost of a higher Google quota tier is weighed against measured use, not a guess.

## What the server counts

- **Where it counts:** a process-wide usage observer counts every successful Gemini judge call (usage leg `callType` `grounded-verify:gemini`) under the model it ran on (`packages/api/src/store/judge-model-count.ts`).
  - A call that failed emits no leg, so each claim counts once, under the model that produced its verdict.
- **Ledger:** append-only, one row per judge call (`ts`, UTC `day`, `model`), at `FAULTLINE_JUDGE_MODEL_LEDGER`.
  - The default `/var/log/faultline/judge-models.jsonl` sits on the ledger volume, so a deploy keeps it.
  - A failed write never fails a scan. It is counted in `ledgerWriteFailures`.
- **Where to read it:** admin `GET /usage` returns `judgeModels`:
  - `byModel`: judge calls per model over the last 7 UTC days, today included;
  - `total` and `primary` (the configured judge);
  - `fallbackShare`: calls by any other model, divided by `total`; `null` with no calls;
  - `alert`: true when `fallbackShare` is above `alertShare` (0.10).

## The daily check

`node scripts/judge-fallback-check.mjs` reads that block with the server key, which is never printed, and appends one row to the spend-monitor log.

| Exit | Meaning |
|---|---|
| 0 | OK |
| 1 | ALERT |
| 2 | Probe failure |

- **Probe failure:** no key, a non-200 answer, or a missing or malformed `judgeModels` block. It is never read as OK.
- **On an alert,** once per UTC day:
  - one alignment post that wakes the program owner;
  - a paste into the Faultline lane's tmux pane, because a post by that lane cannot wake its own pane.
- **What an alert means:** the fallback judged more than 10% of claims over 7 days. That is the signal to price a higher quota tier for the primary judge.

No model is called.
