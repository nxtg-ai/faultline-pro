# Grounding providers

Which search grounds a claim's verdict. Set by `FAULTLINE_GROUNDING`. Code: `packages/cli/cli/grounding.ts` (the mode), `packages/cli/cli/verify-runner.ts` (`retrieveThenVerify`), `packages/cli/providers/parallel_search_retriever.ts` (the search), `packages/api/src/lib/grounding.ts` (the per-request read).

## Values

| `FAULTLINE_GROUNDING` | What a gemini verify does |
|---|---|
| unset, `google`, or any other value | Today's behaviour. One Gemini call with the `googleSearch` tool searches and judges (`verifyClaim`). Provenance `retriever: "gemini-grounding"`. |
| `parallel` | Retrieve, then judge. One request to Parallel's Search API (`POST https://api.parallel.ai/v1/search`) finds the sources. One Gemini call with **no** search tool judges the claim against them (`verifyClaimGrounded`, with each source's excerpts in the prompt). Provenance `provider: "gemini"`, `model` (the Gemini model that judged: `FAULTLINE_GEMINI_MODEL`, or `FAULTLINE_GEMINI_FALLBACK_MODEL` with `judgeFallback: true` when the primary was rate-limited), `retriever: "parallel-search"`, `retrieverModel: "parallel-search-<mode>"`, `retrievedAt`, `verifiedAt`. When a source policy is in force, `provenance.sourcePolicy` names it (below). |

The mode changes only a non-consensus verify on `gemini`, the one verify that runs a Google search. `openai`, `claude`, `perplexity` and `mock` verify without a Google search and run as before. A consensus scan with no OpenAI key used to fall back to Gemini grounding for its shared search. In the `parallel` mode it falls back to Parallel instead.

**One search per verdict.** A Parallel verdict holds Parallel sources only. It never carries Google grounded output: no Search Suggestions, no grounding Links.

**No fallback.** If the Parallel search fails, the claim is not checked: `apiError: true` with a reason, the same result as any failed search. The reason is `rate_limited` (429), `provider_out_of_credits` (402), `provider_unavailable` (503), `timeout`, or `provider_error` (any other non-200, no key, or no usable result). Nothing falls back to Google, and the claim is not billed.

## The request

- Body fields: `objective` (the claim, and what would confirm or refute it), `search_queries` (one or two keyword queries of up to six content words, taken from the claim), `mode`, `max_chars_total` 12,000, and `advanced_settings.max_results` 8 with `advanced_settings.excerpt_settings.max_chars_per_result` 1,500.
- With no source policy, `source_policy` and `fetch_policy` are not set. The JSON body is the same bytes as before the policy existed.
- Limits come from `CALL_CEILINGS.parallelSearch.retrieve` in `packages/cli/providers/call-ceilings.ts`.
- Deadline: 20 s, enforced by an AbortController.
- Key: `PARALLEL_API_KEY`.
- Mode: `FAULTLINE_PARALLEL_MODE`, one of `advanced` (the default, Parallel's own default and highest quality), `basic`, `fast` or `turbo`.
- Each source keeps `uri`, `title`, `publishDate` (from `publish_date`) and `excerpts`. `snippet` holds the excerpts joined, which is the text the judge reads.

## Source policy

An optional allowlist for the Parallel search only. It is off unless a caller sets it. Google Search and OpenAI web search are not filtered by it. A deployment that still grounds with Google does not apply a key's policy: set `FAULTLINE_GROUNDING=parallel` as well, or the allowlist is not sent.

Field names are Parallel's, from the v1 Search API reference and the Source Policy page on docs.parallel.ai (read 2026-11-17):

| Sent as | Meaning |
|---|---|
| `advanced_settings.source_policy.include_domains` | Hard allowlist. Only a matching page is returned. |
| `advanced_settings.source_policy.exclude_domains` | Optional. Also applied inside the allowlist. |
| `advanced_settings.source_policy.after_date` | Optional `YYYY-MM-DD`. Pages published on or after that day. |

`fetch_policy` is a different setting and is never sent. `include_domains` and `exclude_domains` together cannot pass 200 entries. The same entry in both lists is refused (Parallel would answer 422). A domain matches that host and its subdomains; a leading `www.` is ignored. A path matches at a segment boundary (`cms.gov/archive` does not match `cms.gov/archive-notes`).

| How | What is set |
|---|---|
| Local CLI and stdio MCP on the user's own provider key | `FAULTLINE_SOURCE_POLICY`. Unset, blank, `off`, `none` or `open` means no policy. `healthcare-authority` is the built-in profile. A JSON object or a comma-separated domain list is a custom allowlist. |
| Hosted API | The calling key's `sourcePolicy`, set by an admin with `POST /keys` or `PATCH /keys/:id` (`null` clears it). It is not a field of the scan body. The server key (`FAULTLINE_API_KEY`, key id `admin`) has no keystore record, so it stays unrestricted. `POST /admin/verify-claims` does not read a key policy or `FAULTLINE_SOURCE_POLICY`, so a pre-registered accuracy run is unchanged. |
| Hosted transport (`FAULTLINE_API_KEY` on the CLI or `faultline-mcp`) | The key's policy on the server. The local env var is not sent. |

`healthcare-authority` allows these apex domains and their subdomains: `cms.gov`, `ecfr.gov`, `federalregister.gov`, `govinfo.gov`, `congress.gov`, `hhs.gov`, `ahrq.gov`, `fda.gov`, `nih.gov`, `cochranelibrary.com`. That includes `pubmed.ncbi.nlm.nih.gov` (under `nih.gov`). It does not include a state agency, a payer's own site, or a journal outside the list.

A custom policy is a JSON object. Either spelling is accepted from the env var; the key API uses camelCase:

```json
{"includeDomains":["cms.gov","fda.gov"],"excludeDomains":["fda.gov/tobacco"],"afterDate":"2024-01-01"}
```

`{"profile":"healthcare-authority","excludeDomains":["cms.gov/archive"],"afterDate":"2024-01-01"}` keeps the profile list and adds the exclude and the date.

When a policy is set:

- The search request adds `source_policy` and nothing else. There is no second request without it.
- A returned page outside the allowlist, on the exclude list, or (when `after_date` is set) undated or older is dropped. An undated page is not treated as recent.
- If no page remains, the claim is unverified and not checked (`apiError: true`, `apiErrorReason: "provider_error"`). The open web is not searched instead. The explanation is "No source on the configured source-policy allowlist was found, so this claim was not checked."
- A value that cannot be used (a bad domain, a scheme, an unknown profile, the same entry included and excluded) does not search at all. The claim is unverified the same way.
- A verdict that was judged under the policy carries `provenance.sourcePolicy`: `profile` when the built-in list was used, `includeDomains`, and `excludeDomains` / `afterDate` only when they were sent. A claim that was not checked has no provenance, as every other unchecked claim.

Code: `packages/cli/cli/source-policy.ts`, applied in `packages/cli/providers/parallel_search_retriever.ts`. The engine does not read `FAULTLINE_SOURCE_POLICY`. The local CLI reads it in `scanLocal` / `batchScan`. The API reads the key in `packages/api/src/lib/grounding.ts`.

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
