# Retrieval provider comparison (Cloudflare Web Search vs Google grounding): pre-registration v1

**GoPMO:** 1.18.6 (Faultline Pro SOTA architecture research) · **Owner:** fp · **Ruling:** emma-soul `al:83a122e890a57219` (research GO; a build waits on the result) · **Independent review:** CODEX-SUB, of this design and of the harness before the first paid call.
**Status:** REGISTERED, NOT RUN. The commit that puts this file on `origin/main` is the registration time. No provider call is made before it.
**Shape:** follows `2026-10-02-prereg-verdict-accuracy-g0-v1.md` and reuses its gold set, scorer and baseline run.

## 0. Why, and what is fixed from sources (read 2026-10-05)

- **Cost.** At paid grounding a scan costs about $0.22 at p50, and the Google grounding fee ($0.035 per grounded prompt) is about 95% of it (`docs/unit-economics-prod-default-2026-09-30.md`, lines 28 to 30). Inside the free 1,500 grounded prompts a day, the same scan costs about a cent.
- **The alternative.** Cloudflare Web Search API, open beta since 2026-10-02 (https://developers.cloudflare.com/changelog/, https://developers.cloudflare.com/web-search/). It is called with `POST /client/v4/accounts/{id}/ai/websearch/` and takes:
  - `query`, 1 to 1,024 characters;
  - `provider`, one of `ceramic`, `exa` or `linkup`;
  - `limit`, 1 to 10 results;
  - optional `byokAlias`, and `options.gateway.id`.

  It returns `items[{url, title, description}]` and `metadata.latencyMs` (https://developers.cloudflare.com/web-search/how-to-use/). Each search is billed to AI Gateway credits at the provider's list price, with no markup.

| Provider | List price (providers page) | ZDR through Cloudflare (providers page) | What it returns |
|---|---|---|---|
| Ceramic.ai | $0.25 per 1,000 | Yes | Long page descriptions, up to 8,000 characters |
| Exa | $7.00 per 1,000 | **No** | Query-relevant highlights as the description |
| Linkup | $5.00 per 1,000 | Yes | `fast` depth, raw results, no generated answer |

Source: https://developers.cloudflare.com/web-search/providers/

- **A source conflict, recorded rather than resolved.** The changelog says "All three support Zero Data Retention for requests made through Cloudflare". The providers page says Exa does not. §7 settles it from the terms before the first call.
- **What Google's terms forbid for the baseline.** Grounded results may not be cached or analysed, and may be shown only to the user who submitted the prompt (`2026-10-01-prereg-lever1-grounding-cost-v1.md` §0). So the baseline's citations cannot be measured. §4 says what that does to the comparison.
- **Relation to lever 1** (`2026-10-01-prereg-lever1-grounding-cost-v1.md`). Lever 1 batches claims inside Google grounding. This plan replaces Google grounding with another retrieval source. They are separate questions and neither depends on the other.

## 1. Question

With the same verifier model, does retrieving evidence through Cloudflare Web Search (Ceramic, Exa or Linkup) instead of Google grounding keep verdict accuracy, while giving citations that can be checked, acceptable latency, a lower cost per defensible scan, and terms that allow what Faultline does with results?

## 2. Items

The G0 gold set, unchanged:
- Factcheck-Bench subtask 4, 661 claims (472 true, 159 false, 30 not enough evidence);
- sha256 `b87f971ce324c87e0427f100fe24b50594b9d44e3a764490b1bef188917dbae1`;
- path `docs/research/data/`, per the G0 prereg §2.

The headline uses the 631 binary items, and the 30 NEE items are reported separately, as in G0. Every arm runs all 661 items, except the Arm G anchor (§3).

## 3. Arms

Every arm uses the same verifier: `gemini-2.5-flash` on the production Gemini key.

**Two things change at once between G and the other arms:** the evidence source, and the form of the prompt. Arm G uses Google's grounding tool, while arms C, E and L pass an evidence block to an ungrounded call. This cannot be separated: Google's terms do not allow grounded results to be fed back as an evidence block, so there is no "Google results, same prompt" arm. So the comparison is of the whole retrieval-and-prompt path, which is what a swap would ship. It is not a comparison of search indexes alone, and the readout says so.

| Arm | Evidence source | How it runs |
|---|---|---|
| **G** (baseline) | Google Search grounding, today's production engine | **Accuracy and cost:** the committed, independently verified G0 run `data/accuracy-g0-full-20261005T174223Z.jsonl` (engine `47b72f0`, BA 0.7633 [0.7223, 0.8020]). It is not re-run, which saves 661 grounded prompts. **Latency and drift anchor:** the 100 ids in `data/accuracy-g0-verify-subsample-ids.json`, re-run through `POST /admin/verify-claims` **one claim per request**, in the same window as the other arms. |
| **C** | Cloudflare Web Search, `provider: ceramic` | Harness, §6 |
| **E** | Cloudflare Web Search, `provider: exa` | Harness, §6 |
| **L** | Cloudflare Web Search, `provider: linkup` | Harness, §6 |

Each item in arms C, E and L gets exactly two calls:

1. **Retrieve.** One Web Search call:
   - `query` = the claim text verbatim; if it is over 1,024 characters it is cut there, and the count of cut claims is reported;
   - `limit: 5`;
   - the arm's provider;
   - no other options.
2. **Verify.** One ungrounded `gemini-2.5-flash` call, with no tools and the engine's generation settings. The prompt holds:
   - the claim;
   - the 5 results, numbered, each with title, URL and description;
   - an instruction to answer JSON `{"status": "supported"|"contradicted"|"mixed"|"unverified", "citedUrls": [...]}`, where `citedUrls` is a subset of the given URLs. The status definitions are the engine's own (`geminiService.ts` lines 145 to 161, for example "mixed" when the evidence is inconclusive). Both abstentions score the same in M1.

   Descriptions are passed whole: 8,000 characters is Ceramic's own maximum, so no arm is cut below what its provider sends.

The verify prompt's exact text is committed in the harness before the first call, and CODEX-SUB reviews it. It reuses the engine's verify instruction and status definitions (`packages/cli/services/geminiService.ts`) with the grounding tool removed and the evidence block added. Changing it after the first call makes the run INVALID (§5).

Retries: a retrieval or verify call that errors is retried up to 3 times with backoff, at most 4 calls per item per step, counted in an attempt ledger written before each call (as in G0 A2.7). An item still failing after that is a **failure**. An empty result list is **not** a failure: the verifier gets no evidence and should abstain.

## 4. Metrics

All CIs: bootstrap, 2,000 resamples, seed **20261005**. Paired differences resample item ids jointly.

**M1 · Verdict accuracy (headline per arm).** Balanced accuracy on the 631 binary items, with abstention (`mixed` or `unverified`) and failure counted wrong, computed by `scripts/accuracy-g0-score.py` unchanged. All the G0 secondary metrics are reported too: accuracy, both recalls, false-claim flag rate, coverage, selective accuracy, the NEE share, and the confusion matrix.

**M2 · Accuracy difference.** BA(arm) − BA(G) on the 631 binary items, paired against the committed G0 rows, with its 95% CI.

**M3 · Citation quality** (arms C, E and L only). Computed on the binary items where the arm gave a verdict (`supported` or `contradicted`):
- (a) **cited rate**: the share with at least one URL in `citedUrls` that is in the retrieved set;
- (b) **invented-citation rate**: the share of all cited URLs that are not in the retrieved set;
- (c) **resolve rate**: the share of cited URLs that answer HTTP 2xx within 10 seconds and at most 3 redirects. Each URL is fetched once with GET, within 24 hours of the run, through the SSRF-guarded `fetchOutboundFollow`. Only the status code is kept.
- (d) **support rate (secondary)**, measured only if §7 finds that storing descriptions for evaluation is allowed for that provider. A seeded 100 verdicts per arm (seed 20261006) are judged. The judge sees the claim, the verdict and the cited descriptions, and is blind to arm and gold. It answers supports, does not support, or cannot tell. The judge is `claude-opus-5-5`, a different model family from the verifier; CODEX-SUB hand-checks a seeded 20 of each arm's judgements and reports the agreement. If storage is not allowed, (d) is reported as not measured, with the reason.

Arm G's citations are **not measured**: Google's terms forbid analysing grounded results. M5 therefore treats every correct G verdict as defensible, which favours G, and the readout says so.

**M4 · Latency.** Wall time per claim, retrieval plus verify, run at concurrency 1:
- p50 and p95 with CIs, on all 661 items for arms C, E and L;
- for the comparison with G, on the 100 anchor ids for every arm;
- retrieval latency alone from `metadata.latencyMs`.

**M5 · Cost per defensible scan.**
- **Cost per claim:**
  - Arms C, E and L: the provider's list fee from the §0 table, plus the verify tokens actually used, priced at $0.30/M input and $2.50/M output including thinking (Gemini 2.5 Flash paid tier, as in the unit-economics doc). Token counts come from the API's usage metadata on every call.
  - Arm G: $0.035 per grounded prompt, plus tokens. The tokens come from the G0 spend-ledger change: $23.39 − 661 × $0.035 = $0.255 across 661 claims.
  - Arm G is reported twice, at paid grounding and inside the free allowance (tokens only).
- **Cost per scan:** extraction plus K × cost per claim, with K = 6 (the MEDIUM document) and extraction at the unit-economics median. Extraction is the same in every arm.
- **Defensible claim:** a binary item where the verdict is correct and, for arms C, E and L, at least one cited URL is in the retrieved set and resolves (M3 a and c).
- **Cost per defensible scan:** cost per scan ÷ the arm's defensible share.

**M6 · Terms** (§7). For each provider, and for Cloudflare's own service: may results be (i) stored for the submitting user's history, (ii) cached and served to another user, (iii) shown in a share link? And is a display requirement attached (such as Google's Search Suggestions)? Each answer is quoted from the primary terms and classed allowed, forbidden, silent, or pending reply.

## 5. Validity (any one makes an arm INVALID: its metrics are not reported, only the reason)

- More than 2% of items are failures.
- Any verify row records a model string other than `gemini-2.5-flash`.
- The verify prompt or the harness commit changes after the arm's first call.
- An id is missing or repeated, or a gold label differs from the file.
- All arms, including the G anchor, must run within one 72-hour window. A run outside it is INVALID.

**Drift check.** The G anchor (100 ids, run in the window) is compared with the committed G0 rows on the same ids using the G0 A3 rule:
- agreement ≥ 0.85, and the paired BA-difference CI wholly inside ±0.10.

If it fails, every M2 is published labelled "baseline drift: G0 not reproduced in the window", and no arm can be a candidate on M2.

## 6. Instruments and where it runs

- **Harness.** `scripts/retrieval-compare.mjs` (to build), plus an admin-only route on the hosted API, so that arms C, E and L run on production's Gemini key, model and region, the same as G0.
  - The route takes a claim and its evidence block and returns `{status, citedUrls, model, usage}`. It never returns or logs descriptions.
  - Each verify call runs inside `captureUsage`, as in G0's `/admin/verify-claims`, so its tokens reach the cost store and the append-only provider-spend ledger.
  - The M3 (d) judge calls go through the hosted API's Claude provider (configured per `/health`), so they are ledgered the same way.
  - The Cloudflare token lives in Fly secrets and is never printed.
  - **This is an experiment surface, not an architecture change.** No customer path changes, and the route is removed or left admin-only after the run.
- **Rows.** One JSONL row per item:
  - `id`, `gold`, `status`, `citedUrls`, `retrievedUrls`;
  - `resultCount`, `queryTruncated`, `apiError`, `attempts`;
  - `retrievalMs`, `verifyMs`, `providerLatencyMs`;
  - `inputTokens`, `outputTokens`, `model`, `engineSha`, `ts`.

  Descriptions are stored only if §7 allows it for that provider.
- **Scorer.** The G0 scorer for M1, M2 and the drift check, plus `scripts/retrieval-compare-score.py` (to build) for M3 to M5.
  - Seeds as fixed in §4.
  - It must be able to fail: on a fixture, flipping one gold label moves BA; scoring every citation as invented sends the cited rate to 0; doubling the Exa fee moves Arm E's M5.

  Each check is shown red on a mutation before the real run is scored.
- **Review.** CODEX-SUB reviews this file, then the harness, prompt and scorer, before the first paid call. A finding that changes a number is fixed and re-reviewed. The run waits for its PASS.

## 7. Terms read before the first call

Before any Web Search call, fp reads and quotes, into `docs/research/2026-10-0x-retrieval-terms.md`:
- the Cloudflare terms that govern Web Search and AI Gateway;
- the Ceramic.ai, Exa and Linkup terms of service, and any API or data terms each links to.

The quote covers storing, caching, displaying, sharing and retention, **fetching or crawling the result URLs** (M3 c depends on it; Google's grounding terms forbid the analogue), and the ZDR conflict in §0.

Targets:
- Cloudflare's Service-Specific Terms for the Developer Platform, covering AI Gateway, Workers AI and Web Search;
- the terms of service and any API or data-processing terms on ceramic.ai, exa.ai and linkup.so.

If a page cannot be found, that is recorded as "no primary text found", with the URLs tried.

A web search on 2026-10-05 found no primary statement from any of the three about the customer's right to store or cache results. That gap is why this step exists. Replies to the 2026-10-02 vendor outreach (Exa among them, `2026-10-02-search-vendor-outreach-drafts.md`; follow-up PRM-NXTG-20261002-01, due 2026-10-15) are added when they arrive.

Only URLs, statuses and counts are stored for a provider whose terms are silent or forbid storage. Results are never shown to anyone outside the run.

## 8. Decision rule (fixed now, before any data)

An arm is a **CANDIDATE** for a build proposal only if every condition holds:

1. **Accuracy, non-inferior.** The lower bound of the M2 95% CI is ≥ −0.05, and the drift check passed.
2. **Citations.** Cited rate ≥ 0.90, invented-citation rate ≤ 0.02, and resolve rate ≥ 0.90.
3. **Cost.** Cost per defensible scan is below Arm G's at paid grounding.
4. **Latency.** p95 per claim on the 100 anchor ids is ≤ 1.5 × Arm G's p95.
5. **Terms.** Storing results in the submitting user's own history is not forbidden, and no requirement is attached that Faultline cannot meet.

Otherwise the arm is **NOT A CANDIDATE**, and the readout names each failed condition. An arm may be called **better** than G on accuracy only if the M2 CI lower bound is > 0.

Every arm's numbers are published, including invalid arms with their reasons and arms that lose. No winner is chosen beyond this rule. A candidate result goes to emma-soul as evidence for a build proposal; it does not change the architecture by itself.

Why these margins:
- **−0.05** is half the ±0.10 equivalence margin of G0 A3. A swap that could cost 5 points of balanced accuracy is not offered as a like-for-like replacement.
- **0.90** on citations: a verdict that cannot point to a resolving source is not defensible to a customer.
- **1.5× p95** is a usability bound chosen now. It is not derived from data.

## 9. Spend and allowance

| Item | Count | List price | Cost |
|---|---|---|---|
| Ceramic searches | 661 (+ ≤ 2% retries) | $0.25 / 1,000 | ≈ $0.17 |
| Exa searches | 661 | $7.00 / 1,000 | ≈ $4.63 |
| Linkup searches | 661 | $5.00 / 1,000 | ≈ $3.31 |
| Verify tokens, 3 arms | 1,983 calls | Gemini 2.5 Flash | ≈ $1.80 to $6.00 (estimate: 2,000 to 8,000 input tokens per call with 5 results) |
| Arm G anchor | 100 grounded prompts | inside the free 1,500/day; $0.035 each at list | ≈ $0.04 tokens; the spend ledger records $3.50 at list |
| Support judge (M3 d), if allowed | ≤ 300 calls | claude-opus-5-5 | ≈ $3 |

**Ceiling: $30 at list price for the whole run.** Admin `GET /usage` and the AI Gateway logs are read before and after, and both are posted to `/alignment`. The harness stops at $30 (exit 5, resumable). The Arm G anchor uses the same runner allowance guard as G0 (stop if the day's count would pass 1,000).

**Setup.** This needs a Cloudflare account with an AI Gateway, credits or BYOK keys, and an API token with Workers AI Read and AI Gateway Read. Creating it is logged as spend under the ceiling. If it cannot be done inside the ceiling, it is raised with emma-soul before any call. State on 2026-10-05: NXTG already has a Cloudflare account (the N-226 D1), but `wrangler whoami` on NXTG-AI reports the login expired, and no Cloudflare token is in the environment or in the repo secrets. A token needs one interactive `wrangler login`, or a dashboard-minted API token, from whoever holds the account.

## 10. Not in scope

- Changing production retrieval, the default provider, or any customer path.
- Batching claims (lever 1).
- Search providers that Cloudflare does not offer (Brave, Tavily): a later amendment can add them.
- Extraction quality.

## 11. Amendments

None. Any amendment is committed before the call it affects, says what changed and why, and keeps this text unchanged above it.
