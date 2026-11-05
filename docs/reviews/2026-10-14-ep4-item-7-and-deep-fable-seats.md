# Review: EP4 item 7 (the /scan cache) and the /scan/deep grounding-Link fix

- **Reviewer:** advisor-fable, not Codex. Transcript-blind Fable seats, each in its own git worktree, asked to falsify (founder ruling, emma-soul al:dd6c061407b2b112).
- **Request:** emma-soul al:193832a732e0b82e item 7. The deep fix is fp's own find while building item 7 (ruling al:07b45f0562efbbf0 class). GoPMO 1.18.11.3; PRM-CLX9-20261013-15.
- **Commits:** 437190e (item 7), a0a67da (deep), 6bdbacc (seat findings), and the commit that adds this file.

## Verdicts

| Seat | Reviewed | Verdict |
|---|---|---|
| Item 7 | 437190e | PASS, 2 MEDIUM, 1 LOW, plus a pre-existing HIGH outside the commit |
| Deep | a0a67da | **FAIL**, 1 HIGH, 1 MEDIUM, 2 LOW |
| Re-seat | a0a67da + 6bdbacc | PASS, 3 LOW |

## Findings and what was done

**Deep seat HIGH: the grounding host spelled with a trailing root dot got through.** `isGroundingRedirect` compared the hostname exactly, so `vertexaisearch.cloud.google.com.` (or `%2e`) passed while the SSRF guard admitted it as public; the seat reproduced a robots.txt GET and a HEAD reaching the host. The check is shared, so the evidence fetch and robots.txt paths had the same hole (shipped in 5b5bf0b; Gemini never emits that spelling, so the exposure was a hostile redirect only). Fixed in `evidence/grounding.ts`: trailing dots are stripped. The re-seat probed more than 15 spellings (case, several dots, `%2e`, port, userinfo, backslash, fullwidth, protocol-relative Location headers); all are caught, and no other host matches.

| Finding | Done |
|---|---|
| Deep MEDIUM: a robots.txt answering 5xx falling through to the probe was untested | UVG-15. |
| Deep LOW: the check before an installed fetcher was masked | UVG-16. |
| Item 7 MEDIUM: `/scan/deep` per-caller keying untested | Route test: cross-key and cross-user misses, `cache.checkedAt` on a hit. |
| Item 7 MEDIUM: a server-key request without a valid user ref fell into the operator's slot | `cacheCaller` returns null and nothing is cached; tests that relied on caching under the bare server key now send a user ref (no assertion removed; re-seat checked). |
| Item 7 LOW: the warmer's refusal untested | The warm-up is retired: `warmOne` scans nothing, and both run routes answer 410 `cache_warmup_retired` (re-seat LOW: they had answered 502). |
| Re-seat LOW: the cache's dotted-host test was unpinned | Test added; the exact-compare mutant now fails. |
| Re-seat LOW: the SSRF guard strips one trailing dot, not all | Not changed. The grounding check runs first and strips every dot. |

**Pre-existing, outside these commits (HIGH on its own):** `fireWebhookEvent` sends `scan.complete` to every webhook subscribed to the event, whatever its tenant. Registration needs an admin key and production has 0 webhooks registered, so exposure today is 0. Reported to emma-soul with a proposed fix; not started.

## Instruments

- Builder mutants, all caught: item 7, 4 then 4 more; deep, 4 then 5; M9 (exact compare in the cache).
- Re-seat mutants: 9 planted, 8 caught on its run; M9 has since been pinned.
- Full suite on 6bdbacc: 5,667 of 5,668. The one failure is the accuracy-g0 retry test under load average 22 to 30; it passes alone, 20 of 20.
- Bearer on a0a67da: 0 new.
