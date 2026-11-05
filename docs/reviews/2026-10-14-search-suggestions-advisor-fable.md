# Review: Google Search Suggestions on grounded verdicts

- **Reviewer:** advisor-fable, not Codex. The certifying seat under the founder ruling relayed by emma-soul (al:dd6c061407b2b112, 2026-10-14). The reviewer saw the builder's full transcript; it was asked to falsify named behaviours, not to review in general.
- **Change:** Gemini grounded verdicts carry `searchEntryPoint.renderedContent` and `webSearchQueries` from their own grounded request (fw al:da4e96a09515f831 item 3, GoPMO 1.18.11.3).
- **Commit:** the commit that adds this file.

## Verdict

**PASS, conditional on items 1 to 3 below, all met before commit.** No HIGH. `searchSuggestionsOf` passes the suggestion through byte for byte and omits both fields when the response has none (tests GS4b to GS4e). Real-path tests prove all three surfaces: `GET /scan/stream`, `POST /scan`, full-scan `GET`. A non-vacuous check shows no ledger file receives the suggestion.

## Conditions and how each was met

1. **The API route test file must be in the commit** (it was untracked). Met: `packages/api/tests/search-suggestions-routes.test.ts` is added.
2. **The full suite must pass.** Met on the second and third runs: 251 files, 5,537 tests. The first run had 2 failures, both in `release-prep.test.ts` RP11, which reads `CHANGELOG.md`; the builder edited that file during the run.
3. **No strict client schema may reject the new fields.** Met:
   - The Python SDK builds `VerificationResult` from named keys (`sdks/python/faultline_sdk/models.py:146`), so extra keys are ignored.
   - `packages/cli/tests/contract.test.ts` passes in the suite.
   - There is no `.strict()` or `extra='forbid'` in the SDK or the MCP server.
4. **Bearer pre-check before push.** Met: `scripts/security-gate.mjs` on a local Bearer run reports 115 blocking findings, all baselined, 0 new, 0 stale.

Also applied: the stream test now asserts that the ledgers are non-empty before asserting they hold no suggestion (CRUCIBLE Gate 2).

## Residuals, named rather than fixed here

- **The `/scan` cache serves results across API keys (compliance lead C1, 2026-10-01).** A cache hit therefore hands a grounded verdict, now including its Search Suggestions, to a caller who did not submit that prompt. This is not new in kind, since explanations and sources already travelled this way. All faultline-web traffic uses one server key. Planned fix: P2 (GoPMO 1.18.11.3) touches the cache.
- **The consensus path (Enterprise only) has no suggestions.** `retrieveSources` makes its own grounded call, and its sources are shown without that call's `searchEntryPoint`.
- **The CLI terminal output prints sources without suggestions.** A terminal cannot render Google's HTML chip.
