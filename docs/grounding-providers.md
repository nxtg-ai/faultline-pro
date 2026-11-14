# Grounding providers

Which search grounds a claim's verdict. Set by `FAULTLINE_GROUNDING`. Code: `packages/cli/cli/grounding.ts` (the mode), `packages/cli/cli/verify-runner.ts` (`retrieveThenVerify`), `packages/cli/providers/parallel_search_retriever.ts` (the search), `packages/api/src/lib/grounding.ts` (the per-request read).

## Values

| `FAULTLINE_GROUNDING` | What a gemini verify does |
|---|---|
| unset, `google`, or any other value | Today's behaviour. One Gemini call with the `googleSearch` tool searches and judges (`verifyClaim`). Provenance `retriever: "gemini-grounding"`. |
| `parallel` | Retrieve, then judge. One request to Parallel's Search API (`POST https://api.parallel.ai/v1/search`) finds the sources. One Gemini call with **no** search tool judges the claim against them (`verifyClaimGrounded`, with each source's excerpts in the prompt). Provenance `provider: "gemini"`, `model` (the Gemini model that judged: `FAULTLINE_GEMINI_MODEL`, or `FAULTLINE_GEMINI_FALLBACK_MODEL` with `judgeFallback: true` when the primary was rate-limited), `retriever: "parallel-search"`, `retrieverModel: "parallel-search-<mode>"`, `retrievedAt`, `verifiedAt`. |

The mode changes only a non-consensus verify on `gemini`, the one verify that runs a Google search. `openai`, `claude`, `perplexity` and `mock` verify without a Google search and run as before. A consensus scan with no OpenAI key used to fall back to Gemini grounding for its shared search. In the `parallel` mode it falls back to Parallel instead.

**One search per verdict.** A Parallel verdict holds Parallel sources only. It never carries Google grounded output: no Search Suggestions, no grounding Links.

**No fallback.** If the Parallel search fails, the claim is not checked: `apiError: true` with a reason, the same result as any failed search. The reason is `rate_limited` (429), `provider_out_of_credits` (402), `provider_unavailable` (503), `timeout`, or `provider_error` (any other non-200, no key, or no usable result). Nothing falls back to Google, and the claim is not billed.

## The request

- Body fields: `objective` (the claim, and what would confirm or refute it), `search_queries` (one or two keyword queries of up to six content words, taken from the claim), `mode`, `max_chars_total` 12,000, and `advanced_settings.max_results` 8 with `advanced_settings.excerpt_settings.max_chars_per_result` 1,500.
- `source_policy` and `fetch_policy` are not set.
- Limits come from `CALL_CEILINGS.parallelSearch.retrieve` in `packages/cli/providers/call-ceilings.ts`.
- Deadline: 20 s, enforced by an AbortController.
- Key: `PARALLEL_API_KEY`.
- Mode: `FAULTLINE_PARALLEL_MODE`, one of `advanced` (the default, Parallel's own default and highest quality), `basic`, `fast` or `turbo`.
- Each source keeps `uri`, `title`, `publishDate` (from `publish_date`) and `excerpts`. `snippet` holds the excerpts joined, which is the text the judge reads.

## Which surfaces

| Surface | Mode |
|---|---|
| Hosted API: every key (customer keys and the server key faultline-web uses) and every scan path (`/scan`, `/scan/stream`, `/scan/template/:id`, `/scan/deep`, `/scan/batch`, bulk, diff, upload, reports, compliance, GraphQL, queued and scheduled scans, full-scan jobs) | The server's `FAULTLINE_GROUNDING`, read on each request and passed to the engine as an argument. The engine never reads or writes the variable. |
| Hosted `POST /mcp` | The server's mode. The route runs `POST /scan` in-process with the caller's key. |
| `faultline-mcp` (stdio) and the CLI with `FAULTLINE_API_KEY` set (hosted transport) | The server's mode: the scan runs on the hosted API. |
| Local CLI and stdio MCP on the user's own provider key | Unchanged (Google) unless the user sets `FAULTLINE_GROUNDING=parallel` in their own environment, plus `PARALLEL_API_KEY`. |
| `POST /admin/verify-claims` (admin key) | The body field `grounding` (`google` or `parallel`) and `parallelMode` pick the arm. When `grounding` is absent the server's mode applies. The response names the arm that ran (`grounding`). |

Fly: `gh workflow run fly-ops.yml -f action=parallel-key-set`, then `-f action=grounding-parallel-on`. Rollback: `-f action=grounding-parallel-off`. Each one restarts the machine.

## Ledgers

- **Provider-spend ledger.** A Parallel search is a usage leg (`provider: "parallel"`, model `parallel-search-<mode>`). It is priced per request in `CONSENSUS_MODEL_RATES` (`packages/api/src/store/consensus-cost.ts`): advanced and basic 0.005 USD, fast and turbo 0.001 USD (5 and 1 USD per 1,000 requests, parallel.ai/pricing, read 2026-11-05). The scan's spend row adds that to the Gemini tokens. The row's provider label gains `+parallel-search`.
- **Grounding allowance.** The allowance counts Gemini calls that carry `googleSearch`. A Parallel search is not one of them. The Gemini judge call carries no search tool, so it is not one either.
- **Scan cache and claim index.** A Parallel verdict's provenance names Gemini, so `isGroundedVerification` keeps it out of both. Neither store's rules are loosened, and the mode builds no evidence store of its own.

## Measuring the two arms

```bash
node scripts/accuracy-g0.mjs --set full --arm both --sample 200 --seed 20261105 --out docs/research/data/grounding-arms.jsonl
python3 scripts/accuracy-g0-score.py --arms docs/research/data/grounding-arms.google.jsonl docs/research/data/grounding-arms.parallel.jsonl
```

- The runner writes one JSONL row per claim for each arm: id, gold, verdict, sources count, `notCheckable`, cost in USD (retries included) and Google grounded calls.
- It then writes `<base>.summary.json`: balanced accuracy per arm, the paired bootstrap 95% CI of BA(parallel) minus BA(google) (2,000 resamples, the scorer's fixed seed), the unverified rate, the not-checkable rate (rows with `notCheckable: true`, a part of the unverified rate), the mean cost per claim, and the Google grounded calls per arm.
- `--arm parallel-fast` runs arm P on Parallel's `fast` mode as an optional extra.

## Why

Licensing. Google's terms for Grounding with Google Search limit Grounded Results to display to the end user who submitted the prompt. They forbid reselling Grounded Results and post-processing them. A paid API that hands verdicts to a customer's own software sits poorly with those terms. Parallel's terms allow this use, provided one query's output is never given to another customer. That condition is why the per-caller cache and claim-index rules stay as they are, and why the mode stores no Parallel results across customers.
