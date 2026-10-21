# Cost ceilings: output-token limits on every model call

GoPMO 1.18.11.7.18. Source of truth: `packages/cli/providers/call-ceilings.ts`. This page repeats that table; if the two disagree, the code wins and this page is stale.

## What it does

Every model request the engine sends carries a ceiling on its output tokens, looked up in one frozen table by provider and call purpose. Every Gemini request also carries a thinking budget. On Gemini 2.5, `maxOutputTokens` counts thinking tokens too, so each Gemini ceiling is its thinking budget plus a visible allowance.

Before this change only the Claude adapter set a limit (`max_tokens: 4096` on every call); Gemini, OpenAI and Perplexity requests had none.

Prompts, model ids and temperatures are unchanged. The verify prompts' sha256 pins in `packages/cli/tests/abstain-unverified.test.ts` pass unchanged.

## The table

The numbers were sized from a sample run on 2026-10-21. The basis column is the `basis` string on each row in the code.

| Provider (wire field) | Purpose | Thinking budget | Output ceiling | Basis |
|---|---|---|---|---|
| Gemini (`config.maxOutputTokens`, `config.thinkingConfig.thinkingBudget`) | extract (`extractClaims`) | 2048 | 34816 (2048 + 32768 visible) | sample n=8 2026-10-21: thoughts max 899, visible max 221 for 4 claims; visible sized for the 50,000-char scan input cap |
| Gemini | grounded verify (`verifyClaim`) | 4096 | 5120 | sample n=40 grounded verifies 2026-10-21: thoughts p50 701 max 3423, visible p50 104 max 250, all finishReason STOP |
| Gemini | grounded retrieve (`retrieveSources`) | 4096 | 5120 | reuses the grounded-verify row (not sampled separately) |
| Gemini | shared-source judge (`verifyClaimGrounded`) | 4096 | 5120 | reuses the grounded-verify row (not sampled separately) |
| Gemini | critique (`generateCritiqueAndPrompt`) | 4096 | 6144 | sample n=1 2026-10-21: thoughts 1864, visible 107 |
| OpenAI Chat, gpt-4o-mini (`max_completion_tokens`) | extract | | 16384 | sample n=1: 273 for 6 claims; 16384 is gpt-4o-mini's maximum |
| OpenAI Chat | verify, verifyClaimGrounded | | 1024 | sample n=10: max 85 |
| OpenAI Chat | critique | | 2048 | not sampled for this provider; the Gemini critique sample (n=1 2026-10-21) was 107 visible tokens |
| OpenAI Responses web_search retriever (`max_output_tokens`) | retrieve | | 2048 | sample n=5: max 811 |
| Claude (`max_tokens`) | extract | | 16384 | sample n=1: 369 for 6 claims; was 4096 for every call, which could cut a long extraction |
| Claude | verify, verifyClaimGrounded | | 1024 | sample n=10: max 184 |
| Claude | critique | | 2048 | not sampled for this provider; same reference as the OpenAI critique row |
| Perplexity (`max_tokens`) | extract | | 16384 | not measured (no key on the build host); same values as the OpenAI chat rows for the same prompts |
| Perplexity | verify | | 1024 | as above |
| Perplexity | critique | | 2048 | as above |

The OpenAI extract ceiling is gpt-4o-mini's maximum. A deployment that sets `FAULTLINE_OPENAI_MODEL` to a model with a lower output maximum would have its extraction requests refused by OpenAI; the same holds for a `FAULTLINE_GEMINI_MODEL` that does not accept a thinking budget.

## `output_truncated`: a cut-off reply is never a verdict

A reply that stopped at its ceiling is reported, not used. Each wire says so its own way:

| Wire | Signal |
|---|---|
| Gemini | `candidates[0].finishReason === 'MAX_TOKENS'` |
| OpenAI Chat, Perplexity | `choices[0].finish_reason === 'length'` |
| OpenAI Responses | `status === 'incomplete'` and `incomplete_details.reason === 'max_output_tokens'` |
| Claude | `stop_reason === 'max_tokens'` |

What happens next depends on the call:

- **Verify** (single-provider verify and a consensus vote): the claim is unchecked. `status: "unverified"`, `apiError: true`, `apiErrorReason: "output_truncated"`, no sources (a consensus vote keeps the shared retrieved set, as every vote does), no provenance. This is checked before the reply is parsed, so a cut-off reply that happens to parse is still not a verdict. It carries no `parseFallback`: that flag counts unreadable replies for the accuracy run, and this reply was cut, not unreadable.
- **Consensus**: when every failed vote was cut off, the fused claim carries `apiErrorReason: "output_truncated"`. When failed votes differ (one cut off, one unreadable or errored), the fused claim carries no single reason, as with `provider_unparseable`.
- **Extraction**: the extraction fails with `ExtractionError` reason `output_truncated`. The scan reports it (the API answers `502 {"error":"extraction_failed","reason":"output_truncated"}` after its provider fallback chain); it never returns the claims that did arrive. CLI telemetry classifies it as `PARSE_ERROR`.
- **Retrieval** (Gemini `retrieveSources`, the OpenAI web_search retriever): a failed retrieval, the same as a retrieval API error: no sources.
- **Critique**: the existing critique fallback.

MCP and `faultline guard` report such a claim as `UNCHECKED` with `unchecked_reason: "output_truncated"`, and the scan is degraded. A full scan refunds it with reason `output_truncated` (`fullScanRefunds.reasons.output_truncated`).

## Unbilled

A truncated claim is unbilled exactly like `provider_unparseable`: it carries `apiError: true`, so every meter that skips `apiError` (`isBillableVerdict`, the scan-cost log's verified count, faultline-web's meter) does not count it, and the scan cache does not keep it. The provider's own token spend is still recorded in the spend ledger, because the tokens were spent.

## Validation before deploy

A G0 run on the branch (`docs/research/accuracy-g0-harness.md`) validates these ceilings before deploy; it had not run when this page was written. Unit tests prove each request carries its row (`packages/cli/tests/call-ceilings.test.ts`, which also counts the call sites in `services/` and `providers/` so a new call without a ceiling fails CI) and that each wire's cut-off becomes `output_truncated` (`packages/cli/tests/output-truncated.test.ts`, `packages/api/tests/output-truncated-routes.test.ts`). They do not measure how often a ceiling is hit in production.

The Kaggle-origin browser app (`packages/web/services/geminiService.ts`) has its own Gemini calls and is not covered by this table.
