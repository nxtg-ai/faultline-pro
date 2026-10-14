> Copied from the reviewer's verdict file (scratchpad) for the record; disposition of each finding is at the end, added by fp.

VERDICT: PASS
Reviewer: transcript-blind Fable seat
Commit: a304f11c0d080b9d6d81dbd7e813381b096520ed (parent ebb1a83), reviewed in a detached worktree; main tree untouched.
Instruments: `git show a304f11`; `tsc --noEmit` cli rc=0, api rc=0; `vitest run` cli 94 files / 2548 passed, api 162 files / 2963 passed; two throwaway probe files run in the worktree and deleted (contents reproduced below where load-bearing).

Note on the suite: `packages/api/vitest.config.ts` sets `FAULTLINE_OUTBOUND_ALLOW_PRIVATE=1` for every api test, which DISARMS the SSRF guard. My first probe "failed" for that reason, not a code defect. The commit's own route test deletes that variable in `beforeEach` (`packages/api/tests/passage-leg-routes.test.ts:56`), so its guard assertions are real.

## 1. No code path fetches a Gemini grounding Link — HELD
- `packages/cli/evidence/independent.ts:45-48`: every result page goes through `fetchSourceEvidence`, which at `packages/cli/evidence/passage.ts:141` returns `{status:'not_fetched', reason:'provider_terms'}` for host `vertexaisearch.cloud.google.com` before any fetch. Covered by `packages/cli/tests/evidence-independent.test.ts:85-90` (fetch spy never called).
- The leg's input is the OpenAI retriever's `url_citation` list (`openai_web_search_retriever.ts:147-157`), never the verdict's `sources`; `attachIndependentEvidence` never reads `result.sources`.
- Routes only pass `apiIndependentEvidenceOptions()` (`packages/api/src/lib/evidence.ts:32-41`); no route fetches on its own. `attachEvidence` (parent commit) is unchanged by this diff.
- Gap, not a refutation: the provenance-based check `isGeminiGroundingSource` (`passage.ts:193`) is not consulted for independent sources, only the host check. That is correct here because the sources are OpenAI's, but a future retriever that re-emits a non-redirect Google link would pass; the host rule is the only barrier. LOW.

## 2. independentEvidence never merged into `sources`, never carries `snippet` — HELD
- `independent.ts:47`: `const source = { title: s.title, uri: s.uri }` drops `snippet` by construction; `independent.ts:56`: `{ ...result, independentEvidence }` leaves `sources` as given. Test `evidence-independent.test.ts:48,59` asserts both; my probe also asserted `JSON.stringify(v)` lacks the snippet text through the API's real option object.
- PDF prints them under a separate heading (`pdf-report.ts:569-589`), not under the sources list. POST /scan/report/pdf keeps `verifications` as an untyped object with `additionalProperties: true` (`routes/pdf-report.ts:27,32`), so the field reaches the renderer on that route too.

## 3. Flag off / key missing → no OpenAI request — HELD
- `packages/api/src/lib/evidence.ts:33-35`: `(FAULTLINE_PASSAGE_LEG ?? '').toLowerCase() !== 'on'` → undefined; empty `OPENAI_API_KEY` → undefined. Probe: `undefined, '', 'off', 'true', '1', 'yes', ' on', 'on '` all → undefined; `on/ON/On` → defined; `on` + empty key → undefined.
- `verify-runner.ts:351-353` only calls `attachIndependentEvidence` when the option is set; the retriever is constructed only inside the `on` branch, so no OpenAI call can happen with the flag off (route test `passage-leg-routes.test.ts:133-145` counts zero OpenAI bodies for both off cases).
- The pre-existing consensus retriever (`verify-runner.ts:166`) is the only other OpenAI web_search path and is untouched.

## 4. Cost and ledger pricing — HELD
- Per claim, one search (`independent.ts:40`, `retriever.retrieve` once; `MAX_RESULTS` caps citations, at most 3 pages fetched, page fetches cost nothing at OpenAI). Worst case with the stated figures: 0.010 + 8174×0.15/1e6 + 430×0.60/1e6 = 0.010 + 0.0012261 + 0.000258 = **0.011484 USD ≤ 0.015**. The 8,000-token search block is inside `input_tokens` (rates.ts comment, consistent with the measured 8,174).
- Ledger: `consensus-cost.ts:120` adds `groundingPerCall` only when `leg.isGrounding`; the only producer of `isGrounding: true` in the engine is the web_search retriever (`openai_web_search_retriever.ts:115`); `openai_provider.ts:172` and `claude_provider.ts:178` record `false`. Probe: gpt-4o-mini `extraction` leg → 0 fee; `web_search` leg 8174/430 → ≤ 0.015. `rates.ts:67` and `consensus-cost.ts:45` agree; drift guard `consensus-cost-replay.test.ts` green.
- Side effect, correct but worth naming: a consensus-path retriever configured to `gpt-4o-mini` via `FAULTLINE_OPENAI_SEARCH_MODEL` is now also priced with the 1-cent fee. That is a correction of an under-count, not a regression.

## 5. Pages fetched only through the guarded fetch — HELD
- `independent.ts:48` passes `opts.fetch`; the API supplies `fetchOutboundFollow(url, init, 5)` (`evidence.ts:39`), which calls `assertSafeOutboundUrl` at every hop (`outbound-url.ts:377-388`). The retriever's own call to `api.openai.com` uses global fetch (`openai_web_search_retriever.ts:86`), which is the intended target, not a result page.
- Probe with the override removed: literal `169.254.169.254` and a host resolving to `127.0.0.1` → both `blocked`, inner fetch never called; `https://ok.example` 302 → `http://evil.internal` (resolves 10.0.0.5) → `blocked`, only the first hop requested.

## 6. apiError verdict triggers no search — HELD
- `independent.ts:37`: `if (result.apiError === true) return result;` runs before `retrieve`. `guardVerdict` passes `apiError` through (`verdict-guard.ts:85`), and the exhausted-retry result carries it when `flagExhaustedRetries` is on (default on, `verify-runner.ts:239-284`). Test `evidence-independent.test.ts:71-75`.

## 7. Wiring and default behaviour — HELD
- POST /scan: both the `pipelineConfig` branch (`scan.ts:110,124`) and the cached/default branch (`scan.ts:206`); POST /scan/template/:id (`scan.ts:325,353`); GET /scan/stream (`stream.ts:182`) and POST /scan/stream (`stream.ts:297`); full scan (`full-scan.ts:215` → `verifyFullScan` → `runFullVerification` → `runVerification`, `verifyFullScan` spreads its opts into the context at `packages/cli/cli/scan.ts:366`, `runFullVerification` forwards at `scan.ts:396`). `scan(mode 'full')` forwards it at `scan.ts:302`; the capped path at `scan.ts:309`.
- Default behaviour: `OpenAIWebSearchRetriever` constructor keeps `opts = {}` default, `opts.model || env || 'gpt-4o'` (`:53-58`); the consensus call site passes no opts (`verify-runner.ts:166`). Probe: with `FAULTLINE_PASSAGE_SEARCH_MODEL=gpt-4o-mini` set, `new OpenAIWebSearchRetriever('k').model` is still `gpt-4o`. `model` becoming public `readonly` has no behavioural effect. Full suites green on both packages.
- Not wired (and not claimed): batch, deep, upload, report, compliance, eu-report, jobs/queue/schedules, GraphQL. Fine for a flagged leg; note only.

## Findings

### HIGH
None.

### MEDIUM
- **M1. No deadline on the search call when the leg is on.** `openai_web_search_retriever.ts:86-97` fetches `api.openai.com` with no `signal`/timeout, and `IndependentEvidenceOptions.timeoutMs` (`independent.ts:24`) governs only the page fetches. A stalled OpenAI connection stalls that claim's verification (and the SSE stream's `claim_verified` event for it) indefinitely. Pre-existing in the consensus path (Enterprise only); this commit puts it on every tier's default path once the flag is turned on. Zero effect with the flag off. Fix: `signal: AbortSignal.timeout(...)` in `callAPI`, or wrap `retrieve` in a race inside `attachIndependentEvidence`.

### LOW
- **L1. `FAULTLINE_EVIDENCE_FETCH=off` does not stop the leg's page fetches.** `evidence.ts:18-19` gates only the verdict-source fetch; the leg has its own fetch (`evidence.ts:39`). The leg has its own kill switch (`FAULTLINE_PASSAGE_LEG`), so this is a documentation/expectation gap, but the runbook line that the evidence switch "turns the fetch off" is no longer the whole truth.
- **L2. `FAULTLINE_PASSAGE_SEARCH_MODEL` has no cap guard.** The docs record gpt-4.1-mini at 1.4–1.7 cents (over the 1.5-cent authorization) yet the env override accepts any model (`evidence.ts:36`). Operator config, but the authorized limit is enforced only by convention.
- **L3. The leg runs for every verified claim regardless of verdict provider or outcome**, including `provider: 'mock'` scans (allowed by `PROVIDER_ENUM`, `scan.ts:31`) and `status:'unverified'` verdicts without `apiError`. Each still costs at most one search (≤ cap), but with the flag on a mock scan spends real money. Consider gating on `provenance.retriever === 'gemini-grounding'` (the stated motivation) or at least on a non-mock provider.
- **L4. Consensus + flag = two web_search calls per claim** (the consensus retriever's and the leg's). Per-leg cost stays ≤ 1.5 cents; total per claim does not. Note for the cost model, not a defect in this commit's scope.
- **L5. Scan cache ignores the flag.** `scan.ts:164` keys on text/provider/cap; a result cached while the flag was off is served without `independentEvidence` until TTL after the flag is turned on. Cosmetic.
- **L6. Provenance-based grounding check not applied to independent sources** (see item 1). Host check suffices today.

## Disposition (fp, after the verdict)

- **M1, fixed:** the leg's search call carries a 12 s deadline (`OpenAIWebSearchRetriever` `timeoutMs`; `PASSAGE_SEARCH_TIMEOUT_MS`). The consensus retriever keeps its previous behaviour. Test: `passage-leg-routes.test.ts` "the search call carries a deadline (M1)".
- **L1, fixed:** `FAULTLINE_EVIDENCE_FETCH=off` now stops the leg too.
- **L2, fixed:** only models measured under the cap (`gpt-4o-mini`) are accepted; any other `FAULTLINE_PASSAGE_SEARCH_MODEL` leaves the leg off.
- **L3 and L4, fixed:** the leg runs only beside Gemini-grounded verdicts (`appliesTo`). A mock scan spends nothing, and consensus (which already searches with OpenAI) gets no second search.
- **L5, accepted:** a result cached while the flag was off is served without `independentEvidence` until its TTL ends. The deploy that turns the flag on also restarts the machine, which clears the in-memory cache.
- **L6, accepted:** the host check covers independent sources today.
