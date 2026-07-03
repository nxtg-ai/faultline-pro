# v0.9.0 Consensus Unit-Economics — Measurement Design (for Wolf verify BEFORE spend)

**Directive**: PRM-NXTG-20260703-04 (Asif-caught: pricing blocked on a MEASURED cost/scan under v0.9.0 consensus).
**Author**: `fp` | **Date**: 2026-07-03 | **Status**: DESIGN — pre-spend, for Wolf's method-verify.
**Deliverable**: MEASURED cost/scan, fan-out multiplier, vs old Gemini-Flash baseline, $19/mo-vs-$19-one-time margin table. Every number carries scan-id + real-usage + telemetry field.

---

## 1. Why "read the telemetry" fails (instrument findings — cited)
The deployed cost telemetry is **not** a measurement of consensus cost — three structural defects (`packages/api/src/store/costs.ts`, `routes/stream.ts`):
1. **Tokens estimated from text length**, not provider-reported: `stream.ts:129-131` `inputTokens=ceil(text.length/4)`, `outputTokens=ceil(input*0.3)`. `costs.ts:52-56` says verbatim "estimate, not a measured billing value."
2. **Fan-out ignored**: the emitted `ManagedScanCostEvent` models ONE `effectiveProvider` — it does NOT multiply by the N consensus voters. Consensus cost is under-counted by ≈N×.
3. **Grounding mis-counted**: `groundingCalls = result.claims.length` (ALL claims) not the ≤8 actually verified.
→ Telemetry is kept only as a cross-check to quantify HOW wrong the estimate is; it is not the measured number.

## 2. Fan-out model (the real cost driver) — cited
`packages/cli/cli/scan.ts` + `consensus/consensus_engine.ts`:
- Verified claims **K capped at 8** (`filterClaimsForVerification` slice(0,8), scan.ts:145).
- Extraction = **1 call**, default `openai` gpt-4o-mini under consensus (scan.ts:261-284).
- Per verified claim: **1 retrieval** (OpenAI Responses `web_search` if OPENAI key) + **N parallel verify votes** (`DEFAULT_CONSENSUS_PROVIDERS=['openai','gemini','claude']`, missing-key providers silently skipped, so N≤3).
- **Formula: total LLM calls = 1 + K·(1 + N).** Default N=3, K=8 → **33 calls/scan**.
- Reachable only via `POST /scan/stream` `pipelineConfig:{consensus:true}` (CLI doesn't wire it).
- **Mock can't be used to count fan-out** — `mock_provider` has no `verifyClaimGrounded`, so consensus makes zero grounded calls under mock.

## 3. Measurement method (real provider-reported usage, no product-code change)
A standalone analysis harness (instrumentation, not product code) that reproduces the engine's exact fan-out and captures REAL usage:
- **Faithful prompts**: lift the engine's actual templates verbatim — extraction prompt (`geminiService.ts`), grounded-verify prompt (`providers/grounded_prompt.ts`), web_search retrieval (`providers/openai_web_search_retriever.ts`). Fidelity is load-bearing: harness prompts must equal production prompts or the tokens don't reflect real scans.
- **Capture real usage**: OpenAI `response.usage.{prompt_tokens,completion_tokens}`, Gemini `usageMetadata.{prompt,candidates}TokenCount`, Claude `usage.{input,output}_tokens`. (The engine discards these today — the harness is where they're read.)
- **Representative matrix** (doc size × claim count K): SMALL (~150w, K≈3), MEDIUM (~600w, K≈6), LARGE (~1500w, K=8 cap). ≥3 reps each to average variance. Run consensus-ON (N=3) and single-model (N=1) for the multiplier.
- **Composition**: measured_cost_scan = Σ over the 1+K(1+N) real calls of (real_input×inputRate + real_output×outputRate) + K×groundingRate. Rates from `MANAGED_PROVIDER_RATES` (costs.ts) — **sanity-checked against current published pricing before use** (gpt-4o-mini $0.15/$0.60 per M, gemini-flash $0.15/$0.60, claude-haiku $0.80/$4.00, web_search grounding per-call).
- **Cross-check**: for each run, log scan-id + measured_cost + telemetry_estimate (via `/costs`) → quantifies the telemetry gap (a finding for Emma).
- **Spend**: 3 sizes × ~3 reps × (consensus + single) ≈ 18 real scans, ≤33 calls each on cheap models → **est. low single-digit USD**; append-only logged; flag only if the matrix pushes toward tens.

## 4. Baseline (apples-to-apples, per SCAN not per call)
Old app = single-provider Gemini-Flash, ~$0.03/**call**. A scan is 1 extract + K verify (no fan-out, no per-claim web_search) → old cost/scan ≈ (1+K)×per-call. New cost/scan = the composed measured number above. Report BOTH as $/scan; the multiplier = new÷old.

## 5. Margin table (method)
- **$19/mo**: break-even scans/user/mo = 19 ÷ measured_cost_scan; show gross-margin curve at representative usage (e.g. 20/50/100 scans/mo).
- **$19 one-time**: margin = 19 − (avg_scans_per_license × measured_cost_scan); needs an avg-scans/license assumption (flag as the one input Asif/Emma must supply, or bound it).
- Both tables carry the measured cost/scan + its scan-id evidence so Wolf's spot-check (measured==provider-usage) is verifiable.

## 6. Open method questions — status
1. Run the ~18-scan matrix (~low single-digit $)? → **GATED on Wolf's method-verify** (verify-before-spend; Emma re-affirmed sequencing 20:53).
2. avg-scans-per-license for the one-time row? → **RESOLVED (Emma 20:53): BOUND as a sensitivity row 5/20/50.** FP is pre-revenue → no real usage distribution to supply; the sensitivity row IS the honest form. **If the $19 verdict FLIPS within the 5–50 band, that flip is itself a finding = one-time pricing is volume-fragile.**
3. Rate table `MANAGED_PROVIDER_RATES` as-is vs re-pin to live pricing? → still open for Wolf; default plan = use as-is AND sanity-check vs live published pricing on the run date, report if they diverge.

## 6b. Wolf method-verify gates (2026-07-03 20:54 — method-nod GIVEN, grounded)
Wolf spot-checked the load-bearing citations (scan.ts:145 K-cap, scan.ts:187 N=3 default set, ceil(len/4) token-estimate) — they HOLD. Two MANDATORY strengthenings before the matrix runs:
- **G1 — PROVE prompt fidelity (CHECKED assertion, not a comment)**: before any matrix spend, assert `harness_prompt == engine_produced_prompt` for ≥1 sample per call-type (extraction / grounded-verify / web_search). Best realized by IMPORTING the engine's actual prompt-builder functions (not re-implementing) so equality holds by construction, then asserting the import identity. If any call-type fails equality → **STOP, no spend**, report. This is the single point the measurement can be silently wrong.
- **G2 — re-pin rates to LIVE published pricing on the run date**; `MANAGED_PROVIDER_RATES` (costs.ts) kept only as a cross-check, not the source of truth (else stale-constant estimate-trap).
- Q1 = YES (spend GO'd, logged). Q2 = bound 5/20/50. Gap-number + verbatim-into-card confirmed.

## 6d. Rate-pin DONE + compose-time fidelity note (2026-07-03 21:17)
G2 rates pinned in `scripts/consensus-cost/rates.ts` (`LIVE_RATES_PINNED_ON='2026-07-03'`, `liveRatesReady()` guard live). **claude-opus-4-8 = $5/$25 VERIFIED against the canonical claude-api reference** (not just a web-fetch) — the G2 opus-vs-haiku finding is solid. Model→call map confirmed by grep: extraction/openai-verify=`gpt-4o-mini` (openai_provider.ts:12), retrieval=`gpt-4o`+web_search (openai_web_search_retriever.ts:19), gemini-verify=`gemini-2.5-flash` (geminiService.ts:5), claude-verify=`claude-opus-4-8` (claude_provider.ts:20). All 4 in LIVE_RATES → no rate gap.
- **Caveats to carry into the table**: gpt-4o/gpt-4o-mini rates are legacy/aggregator-sourced (not on the current official OpenAI page); web_search per-call $0.010 is the GPT-5.x-page figure (historically $25–35/1k) and excludes the search-content-token surcharge → treat the retrieval leg as a sensitivity, report a low/high band.
- **COMPOSE-TIME FIDELITY (must verify before trusting numbers)**: key each captured call's rate on its **real emitted `model` field**, NOT `ENGINE_DEFAULT_MODELS` (which labels extraction `gemini-2.5-flash`, but under consensus extraction defaults to openai `gpt-4o-mini` per instrument probe — doc-table drift, harmless to coverage, fatal if used as the pricing key).

## 6c. Wolf optional-accepted (2026-07-03 20:57) — cost DISTRIBUTION, dual-purpose
Report measured cost/scan as **p50 / p90 / p99**, not just the mean. Near-zero marginal cost — the harness already records per-scan cost across the matrix; percentiles are a compose-step over those records (the telemetry even has a `/costs/percentiles` concept, costs.ts). Rationale (Wolf, recalling prior FP work — Kestrel Faultline Intelligence Loop + repricing record): Enterprise/managed-key tiers are margin-risk on **p90/p99** scan cost, so the SAME ~18-scan matrix serves BOTH the $19/mo consumer decision AND enterprise repricing at zero extra spend. The $19 table stays the committed deliverable; the distribution is an accepted add-on.

## 7. Emma rulings folded (2026-07-03 20:53)
- **Telemetry-vs-measured gap = a named deliverable**, not just a cross-check: Emma wants the number — it becomes the **fix spec** for the cost-telemetry follow-up (the fix: capture provider usage + multiply by N fan-out).
- **Asif card must carry the structural finding VERBATIM**: his mental anchor is the old **$0.03/CALL**; the unit is now **~33 calls/SCAN** at defaults (1+K(1+N)) — *the anchor's unit itself changed* (per-call → per-scan-with-fan-out). Lead the card with the unit change, then the measured $/scan.
- **Sensitivity-as-finding**: present the $19-one-time margin across 5/20/50 scans/license; a band-flip = flag one-time as volume-fragile vs the $19/mo subscription.
