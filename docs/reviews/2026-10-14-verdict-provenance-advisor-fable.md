# Review: per-verdict provenance (P1a)

- **Reviewer:** advisor-fable, not Codex, the certifying seat under the founder ruling (emma-soul al:dd6c061407b2b112). One seat, because P1a adds no user-data retention.
- **Method:** the reviewer saw the builder's transcript and was asked to falsify named behaviours.
- **Change:** GoPMO 1.18.11.3 P1a (emma-soul al:ea03474ab4809de5), Honor System point #2. Evidence: EP4 recert `02-codex-evidence.md` row 2: "Model ID, retrieval identity and fetch time are not bound to each verdict… Index `seenAt` is ingestion time."
- **Commit:** the commit that adds this file.

## Verdict

**PASS, conditional on items 1 to 3 below. All three were met before commit. No HIGH.**

- **Who and when are bound per verdict.** Every verdict whose check ran carries `provenance {provider, model, verifiedAt, retriever?, retrievedAt?}`, bound at the provider call. The engine binds the provider id itself.
- **Gemini** reports the served model (`modelVersion`), with `retriever: gemini-grounding` and one time for retrieval and verdict.
- **Consensus** names every voter's model, its retriever, and when the shared retrieval returned.
- **The API PDF** prints a "Checked by" line and each source URI.
- **Evidence:** mutants M4 to M6 were each caught by a test; the suite has 5,562+ tests passing; Bearer shows 0 new findings.

## Conditions and how each was met

1. **Retrieval identity on consensus.** Codex row 2 names three bindings: model, retrieval identity and fetch time. Met.
   - `provenance.retriever` is the consensus rig's `Retriever.name` (`gemini-grounding` or `openai-web-search`).
   - For a single Gemini grounded call it is `gemini-grounding`, because Google Search runs inside the same request.
   - Tests check both.
2. **Index `seenAt` must not be ingestion time.** Met.
   - `ClaimIndex.ingest` now records `seenAt` as the verdict's `provenance.retrievedAt` when that is a valid time, and the index time otherwise.
   - Test: `packages/api/tests/claims-seen-at.test.ts`.
3. **This file, plus two disclosures:**
   - **Shape pin updated.** `packages/cli/tests/gemini-parse-fallback.test.ts` pins the exact key set of a parsed Gemini verdict, and that set now includes `provenance`. This is a contract change, not a weakened test: `parseFallback` stays absent.
   - **Test moved because of an unexplained harness interaction.** The assertion "a Gemini API error carries no provenance" failed in `verdict-provenance.test.ts` with the mocked 503 error reported as a test error. In the same file, `verifyClaim` was observed returning the correct `apiError` result, and the cause was not found. The assertion now lives in `gemini-service-hardening.test.ts` (GS4e), where the same scenario passes.

## Residuals, named rather than fixed here

- **Provider-reported model and time are trusted.**
  - The engine binds only the provider id. A registered provider can set `model` and `verifiedAt`, and any extra provenance key it adds is kept.
  - This is deliberate, so Gemini's served `modelVersion` survives.
  - If the engine owned `verifiedAt` outright, Gemini's `retrievedAt === verifiedAt` "same request" signal would break.
- **Consensus provenance is stamped inside `consensusVerify`** and does not pass through the runner's `withProvenance`. The two paths are separate.
- **`exhaustedRetryResult` with `flagExhaustedRetries: false`** carries neither `apiError` nor `provenance`. Every live path uses the default, `true`.
- **`pdf-parse` reaches the API test by workspace hoisting** from the CLI package's dependency, so the test relies on a root `npm ci`.
- **The cache key does not bind the model** (Honor System point #7). A cached verdict does keep its original `verifiedAt`, so its age is visible.
