# Review: Gemini grounding Links are never fetched for evidence

- **Reviewer:** advisor-fable, not Codex. This is the certifying seat (al:dd6c061407b2b112).
- **Seats:** one. Nothing new is retained.
- **Ruling:** emma-soul al:07b45f0562efbbf0, 2026-10-14. Google's Gemini API terms, *Grounding with Google Search*, say it is a violation "to use Grounding with Google Search to extract or collect one or more of these components for another purpose (for example, ... using Links to identify destination pages for crawling or scraping)". P1b (`e66d6d1`, live from about 03:1xZ) did exactly that. This commit narrows it.
- **Commit:** the commit that adds this file.

## Verdict

**PASS. No HIGH.**

- **Gemini-grounded links are never requested.** Each such source reads `{status: "not_fetched", reason: "provider_terms", passage: null}`, with no `fetchedAt`, `finalUri` or hash.
- **`not_fetched` is separate from `no_match`.** No scan can report "nothing found" for a link it never read.
- **Other retrievers still fetch.** Links from them keep going through the guarded fetch. The private-redirect refusal is still tested end to end through the real route.

Detection has three layers:
1. **Retriever name:** the verdict's `provenance.retriever === 'gemini-grounding'`. This covers a Gemini grounded verdict, and a consensus verdict whose rig uses `GeminiGroundingRetriever`, whose name is `'gemini-grounding'` (`packages/cli/providers/gemini_provider.ts:50`).
2. **Host backstop in `attachEvidence`:** the link's host is `vertexaisearch.cloud.google.com`.
3. **The same host check inside `fetchSourceEvidence`:** no caller can fetch a grounding Link through it.

Tests:
- Mutant M9 (the check removed) fails 2 engine tests and 1 route test.
- Suite: 5,586+ tests passing. Bearer: 0 new findings.

## What this supersedes

The P1b verdict (`2026-10-14-evidence-passages-advisor-fable.md`) rested on a reading that this ruling overturns:
- **Its condition 1** ("6 of 6 redirects follow for our user agent") measured feasibility, not permission.
- **Its residual** "passages are publisher text, not Grounded Results" does not hold for Links obtained through grounding.

## Residuals

- **Other providers' terms are unread.** Fetching stays on for links cited through OpenAI, Claude, Perplexity and the consensus OpenAI web-search retriever. emma-soul's ruling scoped Google's terms only. Whether those providers allow fetching their cited links is a **lead, not cleared**.
- **Every hosted scan verifies with Gemini today**, so Honor System #3 is PARTIAL for those verdicts: they carry the URL plus `retrievedAt` only. That stays true until Google answers case 76466763 or a second retriever whose terms allow fetching runs beside the verdict.
