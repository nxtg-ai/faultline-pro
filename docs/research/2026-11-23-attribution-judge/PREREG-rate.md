# Pre-registration: the failing claim's verdict rate, N = 10 per engine (2026-11-23)

Committed before any of these runs. It replaces single runs, which cannot show a change: on the unchanged hosted engine this claim came back contradicted once and supported twice in 3 runs.

## Claim

The claim as extraction produced it in the Air Canada case, judged alone (no extraction):

> If you need to travel immediately or have already travelled and would like to submit your ticket for a reduced bereavement rate, kindly do so within 90 days of the date your ticket was issued by completing our Ticket Refund Application form.

Expected verdict: contradicted. This is the regression case, so the result is about this one claim, not a rate for the product.

## Engines and runs

`POST /admin/verify-claims`, provider `gemini`, grounding `parallel`, Parallel mode `advanced`, judge `gemini-3.1-pro-preview`, 10 runs on each engine, one claim per request, about 15 seconds apart. Every run makes its own search.

- **H:** the hosted API, 0.12.3 (commit 88c4350).
- **M:** `origin/main` 6b2f410 on a local API, the same local Gemini and Parallel keys as X.
- **X:** the fix branch at 4c54939 on a local API (judge attribution rule; extraction is not on this route).

## Outcomes

- **Rate supported** on each engine, out of 10, with its counts of every other status.
- **Run-to-run agreement** on each engine: the share of runs giving that engine's most common verdict. A buyer re-running a scan can get a different verdict; this reports how often on this claim.
- **Reading rule, stated now:** X is better than M only if X has at least 4 fewer supported runs out of 10 than M. A smaller gap is reported as no clear difference. M against H shows whether the local setup matches production.
- Any provider error is counted and reported, never dropped or re-run.
