# Review: evidence passages from the fetched page (P1b)

- **Reviewer:** advisor-fable, not Codex. This is the certifying seat under the founder ruling (emma-soul al:dd6c061407b2b112).
- **Seats:** one. fp persists nothing new; the two-year owner history belongs to fw's W3.
- **Method:** the reviewer saw the builder's transcript and was asked to falsify named behaviours.
- **Change:** GoPMO 1.18.11.3 P1b (emma-soul al:ea03474ab4809de5), Honor System point #3.
- **Evidence it addresses:** EP4 recert `02-codex-evidence.md` row 3: "Span is sliced from model response text, not independently fetched original-page bytes… No source fetch timestamp."
- **Commit:** the commit that adds this file.

## Verdict

**PASS, conditional on items 1 to 4 below, all met before commit. No HIGH.**

What the change does:
- Each cited source on the wired routes carries `evidence {status, passage, fetchedAt, finalUri?, httpStatus?, contentSha256?, truncated?}`.
- The passage comes from the page's own bytes, never from the model. Mutant M7, which builds the passage from the claim text instead, is caught by 3 engine tests and 1 route test.
- The runner attaches evidence before a claim is reported. Mutant M8, which removes that, is caught.
- The API's guarded fetch refuses a redirect hop to a private address. This was tested in the real route with the guard switched back on: the private target was never requested.

Checks: suite 5,582 passing; Bearer 0 new.

## Conditions and how each was met

1. **Real grounding redirects must follow for a server-side fetch.** This decides whether row 3 moves at all. Met, at zero spend. The six real `grounding-api-redirect` URIs from the 03:0xZ live scan each returned `302` to a publisher host when fetched with the `FaultlineEvidence/1.0` user agent:
   - oceanblueproject.org
   - en.wikipedia.org
   - oceanexplorer.noaa.gov
   - geology.com
   - earthdate.org
   - williamsonadventures.com

   Followed through, all six returned `200 text/html`, between 6.6 KB and 820 KB, all under the 1.5 MB cap.
2. **Every new file must be in the commit:**
   - `packages/cli/evidence/passage.ts`
   - `packages/api/src/lib/evidence.ts`
   - both test files
   - `packages/api/vitest.config.ts`
   - `packages/cli/package.json`

   Met.
3. **Disclosures:**
   - **Open ruling.** The redirect question went to emma-soul in fp's plan at 02:23Z with "default proceed" and has had no ruling since. fp proceeded on that default. If the ruling goes the other way, the change is one line: refuse `grounding-api-redirect` URIs in `fetchSourceEvidence`.
   - **Evidence fetching is off in the API test suite.** `packages/api/vitest.config.ts` sets `FAULTLINE_EVIDENCE_FETCH=off` so that no existing test reaches the network through a mocked verdict's URL. `tests/evidence-routes.test.ts` turns it on with a stubbed network, and turns the private-address guard back on.
   - **Package `files` list.** `evidence/` was added to `packages/cli/package.json` `files`. Without it, the next npm release would ship a `verify-runner.ts` that imports a file missing from the package. `npm pack --dry-run` lists `evidence/passage.ts` and `lib/verdict-guard.ts`.
4. **Doc scope.** Met. INTEGRATION names the wired routes and says GraphQL, batch, compliance-gate and deep scan do not carry evidence yet.

## Residuals, named rather than fixed here

- **`status: 'ok'` means lexical overlap, not support.** The threshold is max(2, 40% of the claim's content words). "The Eiffel Tower is in Paris" would be quoted for an 1889 completion claim. INTEGRATION says so, and the verdict's `status` stays the judgment. Percentages such as "45%" tokenize to two characters and are dropped, so percentage claims match on their words only.
- **The live mix will include failures.** Pages behind bot protection will answer 403 (`http_error`), PDFs are `unsupported_type`, and non-UTF-8 pages decode badly and come out `no_match`. The live probe posts the full distribution.
- **Latency and fan-out.**
  - Fetching adds up to 6 s per claim before its `claim_verified` event.
  - A 500-fact full scan runs about 125 waves.
  - At most 3 fetches × 4 claims × 4 running jobs = 48 concurrent outbound connections from one Fly machine.
  - The DNS lookup inside `assertSafeOutboundUrl` runs outside the abort signal, so a stalled resolver can exceed the 6 s budget.
- **robots.txt is not consulted.** The user agent is honest and names the service.
- **CLI and MCP engine paths pass no fetcher,** so local scans carry no passages.
- **The `/scan` cache serves passages across API keys** (beside compliance lead C1). Passages are publisher text, not Grounded Results.
- **`snippet` vs `evidence`.** `snippet`, which is model-derived, still appears on OpenAI-retriever sources next to `evidence`. The docs tell them apart; the field names do not.
