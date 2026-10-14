# Review: evidence fetches honour robots.txt, user agent, 300-character passages

- **Reviewer:** advisor-fable, not Codex. Three transcript-blind Fable seats in turn, each given only the diff and the files, asked to falsify (founder ruling, emma-soul al:dd6c061407b2b112).
- **Change:** emma-soul al:15b443bc1ccf7a4e, GoPMO 1.18.11.3, PRM-CLX9-20261013-15. Items (a) a named user agent with a contact URL on every evidence fetch; (b) honour robots.txt Disallow for that agent, cached per host for 24 h, a disallowed page reads `{status: not_fetched, reason: robots}`; (c) a stored passage of at most 300 characters.
- **Commit:** the commit that adds this file.

## Verdicts

| Seat | Verdict | Findings |
|---|---|---|
| 1 | FAIL | 2 HIGH, 3 MEDIUM, 2 LOW |
| 2 | FAIL | 2 HIGH, 2 LOW |
| 3 | **PASS** | 1 MEDIUM, 3 LOW |

## What each seat found and what was done

Seat 1:
- **HIGH: rules matched by regular expression backtracked.** `Disallow: /a*a*…(12)b` against a 40-character path took 37 s; `/****x` against 600 characters, 19.6 s. Any cited site controls its own robots.txt, so one scan could stall the API. Fixed: rules are matched without regular expressions by tracking reachable path positions (the google/robotstxt method), with a fixed work budget per verdict; over budget, the page is not fetched. Seat 2 measured a 500 KiB hostile robots.txt against a 2,000-character path at 104 ms cold.
- **HIGH: a robots.txt redirect could land on Google's grounding host.** Fixed: `vertexaisearch.cloud.google.com` is refused on every robots.txt hop and every page hop (`evidence/grounding.ts`).
- **MEDIUM: RFC 9309 2.2.2 percent-encoding.** `Disallow: /café` let `/caf%C3%A9` through. Fixed: rule and URL paths are normalised to one form.
- **MEDIUM: a mid-chain grounding hop was untested.** Test added.
- **MEDIUM: robots.txt time sat outside the 6 s per-source deadline.** Fixed: one deadline per source; a caller stops waiting for a shared load through its own signal.
- **LOW: cache bounded by origin count, not size.** Now bounded by total rule characters. **LOW: the cut could split a surrogate pair.** Now cut by code point, then (seat 2) by grapheme.

Seat 2:
- **HIGH: unhandled rejection.** A caller whose signal had already aborted left the shared load's promise without a handler; a robots.txt at a refused address then rejected it, and Node 22 ends the process on an unhandled rejection. Fixed: the shared promise is marked handled; awaiters still see the rejection.
- **HIGH: a short-deadline caller poisoned the cache.** The shared load took the caller's remaining time, timed out and cached "unreachable" for an hour for every caller. Fixed: the shared load always gets its own 4 s; callers stop waiting through their signal.
- **LOW:** docs now say "300 Unicode code points".

Seat 3 (PASS) reproduced both seat 2 HIGHs closed against the real module and confirmed `Intl.Segmenter` on the Fly image (`node:20-alpine`, ICU 78.2). Its MEDIUM, that the "at most 5 redirects" caps were untested, is fixed: two tests, and the mutants that lift either cap to 1e6 now fail. Its LOWs: the CHANGELOG now names the 1-hour unreachable case; the robots.ts header states that loads in flight are bounded by time, not count. Not changed: the page body read relies on the fetch implementation erroring the body on abort, as undici does (pre-existing).

## Instruments

- Mutants planted by the builder, all caught: 6 on the first build, 6 on seat 1's fixes, 3 on seat 2's fixes, 2 on seat 3's.
- Full suite on the seat 3 tree: 5,635 of 5,635 (261 files).
- Bearer on b827490 (closing an earlier gap): 115 blocking, all baselined, 0 new.

## Disclosures

- **Redirect following moved from the API into the engine.** The API now passes `fetchOutbound`, which refuses a private address on every request; the engine follows at most 5 redirects and asks robots.txt before each hop. All three seats checked that no request bypasses the guard.
- **robots.txt that cannot be read** (5xx, network error, timeout) means nothing on that site is fetched (RFC 9309 2.3.1.4). The source reads `fetch_failed`, not `robots`, because the site rather than its rules stopped the fetch. Cached 1 hour.
- **The cache is in memory,** so a deploy clears it.
- **The user agent** is `FaultlineEvidence/1.0 (+https://faultline.nxtg.ai)`. The contact URL is the product home page; there is no page yet that explains the crawler to site owners (fw's surface).
