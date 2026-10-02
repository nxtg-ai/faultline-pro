# Accuracy G0 harness

How to run and score the pre-registered verdict-accuracy baseline. The spec is `docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md` (§2 to §8, amendments A1 and A2). This page does not change it; where they differ, the prereg wins.

**Status (2026-10-02): built and tested against fakes only. No run has been made.** The real run waits for the independent design review named in the prereg header. Every test uses the mock provider, a mocked Gemini SDK or a fake HTTP server on 127.0.0.1. None calls the hosted API or a real provider.

## Parts

| Part | Path | What it does |
|---|---|---|
| Route | `packages/api/src/routes/admin-verify.ts` | `POST /admin/verify-claims`, admin key only. Verifies 1 to 25 claims as given. |
| Runner | `scripts/accuracy-g0.mjs` | Checks the gold hash, sends batches, applies the guards, writes one JSONL row per item. Node 20, no dependencies. |
| Scorer | `scripts/accuracy-g0-score.py` | Computes the §4 metrics with bootstrap CIs, checks §5 validity, compares two runs for §8. Python 3 and numpy. |
| Workflow | `.github/workflows/accuracy-g0.yml` | `workflow_dispatch` with `set: full | verify-subsample` (A1). Runs the scorer tests, the runner, then the scorer, and uploads the outputs. |
| Engine commit | `GET /health` → `commit` | The git sha the deployed image was built from (`FAULTLINE_GIT_SHA`, passed by `fly-deploy.yml`). `null` until the first deploy after this change. |

## The route

`POST /admin/verify-claims`, header `x-api-key: <admin key>`, body:

```json
{ "claims": [{ "id": "17", "text": "Justice William O. Douglas was born on October 16, 1898." }], "provider": "gemini" }
```

- 1 to 25 claims, each `id` 1 to 128 characters and unique within the request, each `text` 1 to 2,000 characters. Anything else is a 400. Unknown fields are dropped (Fastify `removeAdditional`, the same as `/scan`), so `pipelineConfig` cannot switch consensus on.
- `provider` is optional. The default is the one a production non-consensus scan uses, `gemini` (`DEFAULT_SCAN_PROVIDER` in `packages/cli/cli/provider-keys.ts`, shared with `scan()`). A provider with no key on the server answers `503 provider_not_configured` before any call.
- Each claim becomes `{id, text, type: 'fact', importance: 3}` and goes to `verificationProvider.verifyClaim`, the call `scan()` makes, with at most 4 in flight. One call per claim and no retry: retries belong to the runner, which checks the allowance first.
- Response: `{ "provider": "gemini", "results": [{ "id", "status", "apiError", "parseFallback", "model" }] }`, in request order. A response schema drops any other field, so no explanation, source or grounded text can leave the route (Google grounding terms).
- `apiError: true` means the call did not produce a verdict (the provider failed). `parseFallback: true` means the model's reply was not JSON and the engine returned `mixed` for that reason (prereg §3). `model` is the model string the engine recorded for the call, `null` when the call failed.

Gates and ledgers, the same as a scan:

| | How |
|---|---|
| Admin only | `requireAdmin`: 403 for a missing, wrong or non-admin key |
| Burst limit | `rateLimitScan` (admin tier: 10,000 per minute) |
| Spend cap | `enforceProviderSpendCap`: 503 when the fleet budget is exhausted and enforcement is on |
| Spend ledger | Each claim runs inside `captureUsage`; the batch is priced by `buildManagedCostEvent` into the cost store, the scan-cost log and the append-only provider-spend ledger |
| Grounding allowance | Each grounded Gemini prompt is counted by the process-wide usage observer, as for every scan |

It does not touch the scan cache, scan history, the claim index or the monthly scan quota: none of them is a ledger of spend.

## Running it

Do not run against production until the design review has passed.

```bash
# Full run, all 661 items (prereg §2)
node scripts/accuracy-g0.mjs --set full

# The verifier's 100-id re-run (prereg §8)
node scripts/accuracy-g0.mjs --set verify-subsample

# Continue a stopped run from the next unanswered id
node scripts/accuracy-g0.mjs --set full --out docs/research/data/accuracy-g0-full-<runid>.jsonl --resume
```

Options: `--api <url>` (default `https://faultline-api.fly.dev`), `--out <path>` (default `docs/research/data/accuracy-g0-<set>-<UTC timestamp>.jsonl`), `--resume`, `--engine-sha <sha>` (only used when `/health` reports no commit).

The admin key comes from `FAULTLINE_ADMIN_KEY`, else the `FAULTLINE_API_KEY=` line of `~/.config/faultline/hosted-api-key.env`. It goes only into the `x-api-key` header and is never printed (a test checks stdout and stderr).

Through GitHub Actions (A1): dispatch **Accuracy G0** with `set`. It needs the repo secret `FAULTLINE_ADMIN_KEY` and fails at its first step without it. The outputs are uploaded as the artifact `accuracy-g0-<set>-<run id>`; the run id is the instrument. A `verify-subsample` dispatch is paired automatically with the committed full run when exactly one `docs/research/data/accuracy-g0-full-*.jsonl` exists.

## Guards

| Guard | Rule | What happens |
|---|---|---|
| Gold hash | sha256 must be `b87f971c…917dbae1` (§2) | Exit 2 before any request |
| Admin key | Must be present | Exit 2 before any request |
| Engine identity | `/health.commit`, else `--engine-sha` (A2.6) | Exit 2 if neither, or if they disagree |
| Allowance | Before each batch, admin `GET /usage` → `groundingAllowance.groundedPrompts`; stop if count + batch > 1,000 (§7) | Exit 3, rows so far kept, resume with `--resume` after `resetsAt` |
| Retries | `apiError` items retried up to 3 times with exponential backoff (§6) | After 4 calls the item is written as a failure |
| Model change | The engine's model string differs from earlier rows (§5) | Exit 4, INVALID, do not score |
| Engine change | `/health` commit (or version) changes before a batch, or a resumed file has another engine sha (§5) | Exit 4, INVALID, do not score |
| Spend cap | The route answers 503 budget exhausted | Exit 5, resumable |

Exit codes: 0 done, 1 error, 2 refused, 3 allowance stop, 4 INVALID, 5 spend cap.

Two operating limits. A `full` dispatch through the workflow that stops with exit 3 cannot resume in a later dispatch, because each dispatch starts a new file; a run that may need two days is run locally with `--resume`. Each batch of 25 at concurrency 4 is a single HTTP request that can take a minute or more; the runner waits up to 10 minutes for it.

## Output rows

One JSON object per item, written as soon as the item is final:

| Field | Meaning |
|---|---|
| `id` | 0-based line number in the gold file |
| `gold` | `true`, `false` or `not_enough_evidence`, copied from the gold file |
| `status` | `supported`, `contradicted`, `mixed` or `unverified` |
| `apiError` | `true` when no verdict was produced after retries: a failure (§3) |
| `parseFallback` | `true` when `mixed` came from an unparseable reply |
| `attempts` | Calls made for this item, 1 to 4 |
| `model` | The engine's model string for the call, `null` on a failure |
| `engineSha` | The deployed commit |
| `ts` | When the row was written |

Nothing grounded is stored. Commit the output as `docs/research/data/accuracy-g0-<runid>.jsonl` (prereg §6).

## Scoring

```bash
python3 scripts/accuracy-g0-score.py docs/research/data/accuracy-g0-full-<runid>.jsonl --json out/score.json

# §8 re-run: the re-run first, the original as --paired, so the CI is of (re-run − original)
python3 scripts/accuracy-g0-score.py <rerun>.jsonl --paired docs/research/data/accuracy-g0-full-<runid>.jsonl
```

It prints a readout and, with `--json`, writes every number. Headline: balanced accuracy on the binary items, abstentions and failures counted wrong, with its 95% bootstrap CI. Also: plain accuracy, recall on false and on true claims, the false-claim flag rate, coverage and selective accuracy, the full confusion matrix, the NEE share, the time-sensitive split and the `mixed` parse-failure split. A2 fixes the details the prereg left open.

An INVALID run (§5: more than 2% failures, a model or engine change, a missing or repeated id, or a gold label that differs from the file) prints its reasons and no metric, and exits 4. A gold file with the wrong hash exits 2.

The scorer can fail: `scripts/tests/test_accuracy_g0_score.py` checks that all-`supported` scores exactly 0.50, that flipping one gold label moves the number, and the numbers of a fixture computed by hand. With the abstention rule mutated (`mixed` scored as predicting `false`), two of those tests went red; restored, all passed (2026-10-02).

## Tests

| Suite | File |
|---|---|
| Route | `packages/api/tests/admin-verify-claims.test.ts` |
| Runner | `packages/api/tests/accuracy-g0-runner.test.ts` |
| `parseFallback` | `packages/cli/tests/gemini-parse-fallback.test.ts` |
| Scorer | `scripts/tests/test_accuracy_g0_score.py` (`python3 -m pytest scripts/tests`; CI job `accuracy-g0-scorer`) |
