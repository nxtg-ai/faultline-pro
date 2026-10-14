# Review: runtime verdict allowlist (P2)

- **Reviewer:** advisor-fable, not Codex. This is the certifying seat under the founder ruling (emma-soul al:dd6c061407b2b112, 2026-10-14). One seat: P2 adds no user-data retention, so the two-seat rule does not apply.
- **How it was asked:** to falsify named behaviours. The reviewer saw the builder's transcript.
- **Change:** GoPMO 1.18.11.3 P2 (emma-soul al:ea03474ab4809de5), Honor System point #1, from EP4 recert evidence `02-codex-evidence.md` row 1.
- **Commit:** the commit that adds this file.

## Verdict

**PASS, conditional on items 1 to 4 below, all met before commit. No HIGH.**

- There is a single engine choke point: `runVerification` → `guardVerdict`.
- Stores refuse an invalid status at their write methods.
- `POST /scan` answers 502 before any write.
- The examiner's own instruments, replayed through the real paths, now flip:
  - P1, a provider registered to return the status `ROYALLY_CERTIFIED`;
  - A1, `scan()` mocked to return that status into the real Fastify route.
- Suite: 253 files, 5,552 tests passing. Bearer: 115 findings, all baselined, 0 new.

## The rule: two tiers

| Where | Status allowlist | Shape checked |
|---|---|---|
| Engine, at the verifier (`guardVerdict`) | `supported`, `contradicted`, `mixed`, `unverified` | object, string `explanation`, `sources` array, every source has a string `uri` |
| Stores (`assertValidScanResult`, `storedVerdictProblem`) | the four above plus `skipped` | `sources`, when present, has a string `uri` on every item |

Why two tiers:
- The claim index takes partial verdicts (status and sources only) by design.
- Reports render `skipped` for a claim that was not sent to verification.
- `loading` is never valid anywhere.
- The engine checks the full shape where a verdict is produced.

What happens on refusal:
- **Engine:** an invalid verdict becomes `unverified` + `apiError` + `apiErrorReason: provider_error`. A full scan refunds it.
- **Stores:** scan store, scan cache, claim index and CLI disk history throw `InvalidVerdictError`, which the API answers as `502 invalid_verdict`.
- **Full-scan job store:** replaces the verdict instead of throwing.

## Conditions and how each was met

1. **The mutants must be measured on the code being shipped,** after the two-tier split. Met: each guard was removed in turn and a test failed.
   - M1, the engine guard in `runVerification`: 2 of 9 failed.
   - M2, the route check in `POST /scan`: 1 of 4 failed (history size 2, expected 0).
   - M3, the full-scan job store guard: the direct store test failed.
2. **This file.** Met.
3. **The fixture corrections must be stated.** Four existing tests mocked `scan()` with values the engine never produces, and the API used to accept them. That is the finding in miniature. No assertion changed; only the fixture data did:
   - `benchmark.test.ts` and `graphql.test.ts`: status `verified` (not a status) changed to `supported`.
   - `e2e.test.ts` and `integration-flow.test.ts`: source field `url` changed to `uri`, the engine's `Source` shape (`packages/cli/types.ts:18`).
4. **Doc drift.** Met:
   - The INTEGRATION 502 row names `skipped` and says the 502 applies to `POST /scan` only.
   - CHANGELOG says the job store *replaces* a bad verdict; it does not refuse.

## Residuals, named rather than fixed here

- **The admin verify route is outside the guard.** `POST /admin/verify-claims` calls `provider.verifyClaim` directly (`packages/api/src/routes/admin-verify.ts:137`), not through `runVerification`. It is admin-only, a research harness, and returns labels only.
- **Consensus provider votes are not checked.** `guardVerdict` checks the fused top-level status, but `consensus.providerVotes[].status` inside the metadata is not checked. Consensus already counts only `supported`/`contradicted`/`mixed` votes. Enterprise only.
- **Some routes refuse without the 502 shape.** GraphQL, compliance-gate and deep scan rely on the store throwing. The write is still refused, but the HTTP shape is not `502 invalid_verdict` (GraphQL returns an `errors` array).
- **Live behaviour changes.** A Gemini reply with an off-vocabulary status used to reach the client as given. It now reads `unverified` + `apiError` (degraded; refunded in a full scan), so it can raise the degraded and refund rates. Monitor: the hourly full-scan refund-rate alert (`scripts/grounding-allowance-check.mjs`, alert above 10%).
- **Integrity of stored records is not addressed.** Edited disk history and mutable in-memory results are Honor System point #8, outside P2.
