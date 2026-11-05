# Review: EP4 Amendment 2 items 5 and 6 (provenance bound at the call site; provenance and evidence in exports)

- **Reviewer:** advisor-fable, not Codex. One transcript-blind Fable seat per item, each in its own git worktree, asked to falsify (founder ruling, emma-soul al:dd6c061407b2b112).
- **Request:** emma-soul al:193832a732e0b82e (EP4 Amendment 2), items 5 and 6; GoPMO 1.18.11.3; PRM-CLX9-20261013-15.
- **Commits:** 813cea1 (item 5), f1c57df (item 6), and the commit that adds this file (both seats' findings).

## Item 5: bind retriever, verifiedAt and retrievedAt at the call site

**Seat verdict: PASS.** Two MEDIUM, three LOW, all addressed here.

The seat confirmed the subject, not only the specific: every stored or returned verdict now gets its provenance from one of two engine-side bindings, `withProvenance` in `cli/verify-runner.ts` or `consensusVerify`. Every API route goes through `scan()`; `admin-verify` returns no provenance. An API-registered plugin cannot resolve to the id `gemini` (enum-restricted routes, reserved names, a separate registry). A real Gemini verdict's grounding Links are still never fetched, because the host check in `isGeminiGroundingSource` and in `robots.ts` refuses them by URI whatever the label says. Mutants that re-spread the provider's object, or take `verifiedAt`, `retriever` or `provider` from it, all fail tests.

| Finding | Done |
|---|---|
| MEDIUM: a mutant taking `retrievedAt` from the provider survived (the real Gemini service stamps the same millisecond) | Test: a fixture registered as `gemini` returns a backdated `retrievedAt`; the result must be the call-site time. The mutant now fails. |
| MEDIUM: a non-Gemini provider citing only Google grounding Links got `not_fetched` on every source and no passage leg, so the verdict shipped with no evidence | `appliesTo` in `api/src/lib/evidence.ts` also fires when any source is a grounding Link. Test added; the mutant that drops it fails. |
| LOW: the prototype-safe lookup was untested | Test with a provider named `constructor`. It also exposed `resolveApiKey` reading `Object.prototype` (the error said "Set function Object() { [native code] }"); fixed to own keys only. |
| LOW: docs said only the `gemini` provider carries `gemini-grounding`; a consensus run whose shared retriever is Gemini grounding does too | CHANGELOG and INTEGRATION reworded. |
| LOW: `Verifier.providerName` optional, so a display-name fallback could fire | Now required; the fallback is gone. |
| Nit: CHANGELOG entry under Added | Moved to Fixed. |

## Item 6: provenance and evidence in SARIF, guard JSON and CSV

**Seat verdict: PASS.** One MEDIUM, four LOW.

The seat checked backward compatibility: the CSV appends 7 columns after the existing 14; the guard JSON is additive and keeps `verdict` in the `--fail-on` vocabulary, with the exit code untouched; the GitHub Action reads only SARIF `level`, and the VS Code extension treats `properties` as opaque. SARIF size stays bounded (passages of at most 300 code points, at most 3 independent sources, supported claims never enter SARIF). 8 of 9 mutants were killed.

| Finding | Done |
|---|---|
| MEDIUM: guard JSON `status` showed the placeholder `unverified` for a claim whose check never ran (`apiError`), the flattening `verdict.ts` forbids | `status` is null when `apiError` is set. Test added; the mutant fails. |
| LOW: the no-claims CSV row's padding was untested | Test: the row is as wide as the header. |
| LOW: the gate line mixed vocabularies ("1 CONTRADICTED" under `--fail-on refuted`) | Now "1 CONTRADICTED (refuted)". |
| LOW: CSV formula injection (a cell starting `=`, `+`, `-`, `@`) | Pre-existing in `claim_text` and `explanation`, not widened: the new JSON columns always start with `[` or `{` and are quoted. Not changed here. |
| LOW: MCP still prints "N VERIFIED" and describes "VERIFIED — supported by sources" | Outside item 6's scope; the same class the examiner flagged. Follow-up. |

## Instruments

- Builder mutants, all caught: item 5, 3 then 2 (seat findings); item 6, 4; `appliesTo` and the guard `status`, 1 each.
- Seat suites: cli 2,582 and 2,588, api 2,968, mcp 50, all passing at the reviewed commits.
