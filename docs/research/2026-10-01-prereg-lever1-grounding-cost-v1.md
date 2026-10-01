# Lever 1 (cache and grounding cost): pre-registration v1

**Backlog:** BLG-NXTG-20261001-001 · **GoPMO:** 1.18.6.1.1 · **Owner:** fp · **Status:** REGISTERED, NOT RUN. Nothing here runs until Asif rules on the brief (`docs/research/2026-10-01-cache-and-jev-brief.md`).
**Registered:** 2026-10-01. The commit that lands this file on `origin/main` is the registration timestamp. Shape follows `~/ASIF/enrichment/2026-09-29-jev-calibration-eval-prereg-v1.md`.

## 0. What changed the question before registration (disclosed)

The backlog row asked about (a) a grounding/retrieval cache, (b) a claim-level verdict cache with a freshness TTL, and (c) the latency win. Reading the primary sources changed the question:

1. **A shared verdict cache built on Google grounding is not allowed as written.**
   - The Gemini API Additional Terms (https://ai.google.dev/gemini-api/terms, "Grounding with Google Search" section) say: "You will only use Grounding with Google Search in an application that is owned and operated by you and will only display the Grounded Results with the associated Search Suggestion(s) to the end user who submitted the prompt. You will not, and will not allow your end user or any third party to, cache, frame, syndicate, resell, analyze, train on, or otherwise learn from Grounded Results or Search Suggestions."
   - The Google Cloud Service Specific Terms §20(k) (https://cloud.google.com/terms/service-terms) say the same for Vertex.
   - The permitted storage is narrow: the end user's own history (up to 2 years), display evaluation, and legal compliance.
2. **Batching is the cost lever, not caching.**
   - Gemini 2.5 bills grounding per prompt (https://ai.google.dev/gemini-api/docs/google-search: "when you use search grounding with Gemini 2.5 or older models, your project is billed per prompt").
   - Faultline sends one grounded prompt per claim (`packages/cli/services/geminiService.ts:172`), so a K-claim scan buys K prompts. One prompt carrying all K claims buys one.
3. **Production has no server-side cache on its main path.**
   - faultline-web calls `POST /scan/stream`, which has no cache (`packages/api/src/routes/stream.ts`).
   - The only server cache is on `POST /scan` (`packages/api/src/store/cache.ts`: in-memory, 24 h TTL, keyed on text plus provider, shared across API keys). The CLI's hosted mode (`packages/cli/cli/transport.ts:97`) and the Python SDK use that route.
4. **Volume today is far below the free allowance.**
   - `GET /usage` on 2026-10-01 showed 5 grounded prompts since the 22:44Z restart and $0.18 recorded for October.
   - Longer history is not readable from fp's seat: the ledger resets on deploy, a Vercel 14-day aggregate timed out, and the local Clerk key is a dev key.
   - Below 1,500 grounded prompts a day, any cost lever saves $0 today. It buys headroom: how many scans a day fit in the free allowance.

So this plan measures the **allowed** levers: batching (Q1) and the repeat rate that would size an own-retrieval evidence cache (Q2). It does not measure a cross-user cache over Google grounding.

## 1. Questions

- **Q1 (batching):** Does verifying all of a document's claims in **one** grounded Gemini 2.5 Flash prompt keep verdict quality, compared with today's one prompt per claim?
- **Q2 (repeat rate):** On real traffic, what share of verified claims repeat (a) within one user and (b) across users, under exact and normalised matching? (b) only sizes the own-retrieval option in the brief; it does not license a cache.
- **Q3 (latency):** What does each arm do to time-to-first-verdict and time-to-last-verdict?

**Decision this drives:** whether to build batched verification (and behind which flag), and whether the repeat rate justifies the own-retrieval architecture in the brief.

## 2. Arms (Q1)

| Arm | What it is | Grounded prompts per document of K claims |
|---|---|---|
| **B0** (baseline) | Today's `verifyClaim`: one `googleSearch` prompt per claim, prompt text unchanged | K |
| **B1** (batched) | One `googleSearch` prompt carrying all K claims, asking for one verdict object per claim id, same CALIBRATION RULE text, same 4 statuses | 1 |
| **B3** (descriptive only, no bar) | B0 on the newest Gemini 3.x Flash model, billed per search query. Logs the query count per claim to price per-query billing | K prompts, Q queries |

Pinned: model string logged per call; a mid-run model change invalidates the arm.

## 3. Items

- **Gold set G** is shared with Lever 2 and defined in `docs/research/2026-10-01-prereg-lever2-verdict-calibration-v1.md` §3. Human labels only; no model-made labels.
- Q1 groups G's test items into synthetic documents of K = 6 claims (seeded shuffle, recorded). It also groups them at K = 3 and K = 8 to expose size sensitivity. A document never mixes calibration and test items.

## 4. Metrics

- **Correctness:** 4-class accuracy and macro-F1 against G, plus **recall on false claims**: the share of gold-refuted claims the arm marks `contradicted` or `mixed`. Catching false claims is the product.
- **Failure rate:** `apiError` share; unparseable or missing per-claim verdicts in B1, counted as wrong, never dropped.
- **Cost:** grounded prompts (B0, B1) and search queries (B3) per document, at list price.
- **Latency:** wall-clock time to first and last verdict per document.
- **Uncertainty:** 2,000-resample paired bootstrap per document, 95% CI.

## 5. Hypotheses and bars (fixed before any data)

| ID | Claim | Bar | Verdict words |
|---|---|---|---|
| **H1.1** | Batching keeps accuracy | Paired accuracy difference B1 − B0 at K = 6: 95% CI lower bound ≥ −0.03 | *keeps quality* / *loses quality* |
| **H1.2** | Batching keeps false-claim recall | B1 − B0 recall on refuted claims: 95% CI lower bound ≥ −0.03 | same |
| **H1.3** | Batching does not add failures | B1 failure rate ≤ B0 failure rate + 0.01 | *no added failures* / *adds failures* |
| **H1.4** | Size sensitivity | Descriptive: H1.1 at K = 3 and K = 8 | — |
| **H2.1** | A within-user cache is worth building | Within-user exact-or-normalised repeat share ≥ 10% of grounded verifies over 14 days | *worth building* / *not worth it* |
| **H2.2** | The own-retrieval evidence cache is worth costing | Cross-user normalised repeat share ≥ 20% **and** median daily grounded prompts ≥ 1,000 over the same 14 days | *cost it* / *not yet* |

Batching ships only if H1.1, H1.2 and H1.3 all pass. A missed bar is reported with its numbers and never moved after data is seen.

## 6. Instruments

- **Q1 runner:** a script beside `scripts/measure-consensus-cost.ts`, run with `--paid --confirm-spend`. It writes one JSONL row per claim per arm: item id, document id, arm, model string, status, latency, `apiError`, grounded prompt count, query count.
  - **Grounded text is not kept.** The runner scores the verdict label, then drops the explanation and source fields before writing. This keeps the eval inside the terms' storage limits (see §8).
- **Scorer:** deterministic, and it must be able to fail. Two checks on a fixture, each shown red on revert:
  - A label flip must lower accuracy.
  - Marking a refuted item `supported` must lower recall.
  - Kestrel's scorer in `~/ASIF/governance/evals/jev-calibration/runs/jevcal-d2b-3arm-20261001T043407Z/` is reused where it fits.
- **Q2 instrument (a code change, gated):**
  - Per `verifyClaim`, log `HMAC-SHA256(server secret, normalise(claim.text))` plus an HMAC of the caller (Clerk user id via faultline-web, or API keyId).
  - No claim text, no grounded text. Append-only file next to the spend ledger.
  - `normalise` = lowercase, Unicode NFKC, collapse whitespace, strip trailing punctuation. Numbers and negations are kept exactly, so "is" and "is not" never collide.
  - It needs a Fly volume (the ledger resets on deploy today) and a faultline-web change to forward a hashed user id. fw owns that change.
- **Independence:** codex reviews this plan and the result. The author does not grade the run.

## 7. Where it runs

The Q1 runner runs on NXTG-AI against the production Gemini project (the local key is free-tier and rate-limited: `docs/unit-economics-prod-default-2026-09-30.md` §Status). It runs in one Pacific day, capped at 1,000 grounded prompts, so production keeps at least 500 of the 1,500 daily free prompts. The runner reads `GET /usage` `groundingAllowance.groundedPrompts` before each batch and stops at the cap.

## 8. Spend and terms

- **Q1 size:**
  - G test ≈ 240 items. B0 = 240 prompts. B1 at K = 3/6/8 ≈ 80 + 40 + 30 = 150 prompts. B3 = 240 prompts. Total ≈ 630 grounded prompts, one draw.
  - That fits one day's free allowance. **Ceiling if it spills past the allowance: $25** (630 × $0.035 = $22.05, rounded up).
- **Q2:** $0 provider spend. Small Fly volume cost (the brief carries the number).
- **Terms:** the eval scores labels and keeps no Grounded Results. Whether scoring grounded verdicts against gold labels counts as "analyze" under the terms is an open question for Asif (brief §Compliance). **If Asif's ruling says it does, Q1 does not run, and Lever 2's own-retrieval arms become the only path.**

## 9. Amendments

None.
