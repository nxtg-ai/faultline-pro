# Faultline Pro: cache and Jev, research brief

**Backlog:** BLG-NXTG-20261001-001 (P1, revisit 2026-10-15) · **GoPMO:** 1.18.6.1 · **Owner:** fp · **Written:** 2026-10-01 · **Status:** for Asif's ruling. Nothing is built.
**Asked (Asif, verbatim):** "a deep dive for FaultlinePro SOTA Architecture enhancement to research the power of cache and Jev on enhancing / elevating the product."
**Plans (pre-registered, not run):** `docs/research/2026-10-01-prereg-lever1-grounding-cost-v1.md` and `docs/research/2026-10-01-prereg-lever2-verdict-calibration-v1.md`.

## Bottom line

1. **A shared cache of verdicts is not allowed with Google grounding.** Google's terms forbid caching grounded answers and showing them to anyone but the user who asked. The cost lever that *is* allowed is **batching**: Gemini 2.5 bills grounding per prompt, and Faultline sends one prompt per claim. A 6-claim scan buys 6 prompts today. Batched, it would buy 1. Modelled, not measured: about $0.05 a scan past the free allowance instead of $0.22.
2. **Jev cannot cut the main cost.** About 95% of a paid scan is the search fee, and Jev, Laya and every judge model only decide; they do not search. Their value is quality: a calibrated "how sure are we" per claim, so Faultline can say "unverified" instead of guessing. Faultline has never measured its own verdict accuracy, so step one is a baseline.
3. **The terms reading also touches today's product (four leads, below).** That matters more than either lever. It is my reading of the terms, not a legal opinion.
4. **Money saved today is about $0.** Production ran 5 grounded prompts on 2026-10-01 after the 22:44Z restart, against 1,500 free a day. Batching buys headroom: about 250 six-claim scans a day fit in the free allowance today, and about 1,500 batched.

## Lever 1: cache and grounding cost

| Option | Allowed? | What it saves | Evidence |
|---|---|---|---|
| Shared verdict cache over Google grounding (the backlog's idea b) | **No, as written.** "You will not… cache… Grounded Results" and display them only "to the end user who submitted the prompt" (https://ai.google.dev/gemini-api/terms; same in Google Cloud terms §20(k), https://cloud.google.com/terms/service-terms) | — | terms text read 2026-10-01 |
| A user's own repeat scans | **Yes:** storing a user's own history is allowed for up to 2 years. faultline-web already does this per browser and per account | small; it only helps that user | terms text |
| **Batch all claims into one grounded prompt** | Yes | K prompts → 1 per scan on Gemini 2.5 ("billed per prompt", https://ai.google.dev/gemini-api/docs/google-search) | Quality unmeasured. That is Lever 1 Q1 |
| Move to Gemini 3.x | Yes | Billed per search query: $14 per 1,000 with 5,000 free a month (https://ai.google.dev/gemini-api/docs/pricing). Batching saves nothing there. Per claim ≈ $0.014 × searches run | arm B3 measures the searches per claim |
| **Own retrieval** (a search API we license, then a model judges the evidence) | Depends on the search vendor. Brave forbids storing results without a separately priced plan; Exa's general terms forbid storing; Tavily: no restriction found, which is not permission | $5–8 per 1,000 searches vs $35 per 1,000 grounded prompts; evidence becomes cacheable where licensed | prices from vendor pages, 2026-10-01 |
| Gemini context caching | Yes | input tokens only (90% off); cannot touch the search fee | https://ai.google.dev/gemini-api/docs/caching |

State of the art says semantic caches serve wrong answers. vCache measured 1.7% wrong at a 0.99 similarity threshold on 150k web-search queries (https://arxiv.org/abs/2502.03771). "X is Y" and "X is not Y" sit close in embedding space. **If a verdict cache is ever built (over licensed evidence), it matches exact normalised claims first, never similarity alone.** No paper measures wrong-answer rates for cached fact-check verdicts.

## Lever 2: Jev and typed decisions

What the Jev eval established (`~/ASIF/enrichment/2026-10-01-jev-calibration-eval-results.md`):
- Jev is fast (0.15 s) and nearly free ($0.000013 a decision).
- It is accurate on yes/no document checks (0.87).
- It is **not calibrated**: pooled ECE 0.156, overconfident.

Where a typed model fits in Faultline:

| Seat | What it does | Blocker |
|---|---|---|
| **Judge plus abstention gate** (best fit) | Given a claim and evidence text, return P(supported). Below a calibrated threshold, Faultline answers "unverified" instead of a guess | Google's terms forbid letting anyone "analyze… or otherwise learn from Grounded Results" and using grounding links for crawling. So the judge needs our own retrieved evidence (the own-retrieval option above) |
| Check-worthiness router | Skip searches for opinions, predictions and common knowledge | No primary source measures the saving for claim verification. Adaptive-RAG cut retrieval steps about 60% at equal F1, but on QA (https://arxiv.org/abs/2403.14403) |
| Confidence on today's verdict | Ask Gemini for a confidence, or read its logprobs | Verbalised confidence in fact-checking lands at ECE 0.20–0.45, and Gemini 2.5 Flash was among the models tested (https://arxiv.org/abs/2601.02574). Logprobs together with grounding is unconfirmed |

**Who fills the judge seat (canon e2b770ad: vendor-neutral, open models first, Jev a comparator):** small open judges already match 2024 frontier models on claim-versus-evidence checks (LLM-AggreFact, https://llm-aggrefact.github.io/):
- FactCG-DeBERTa-L: 0.4B, MIT, 75.6.
- MiniCheck-Flan-T5-L: 0.8B, MIT, 75.0.
- Granite Guardian 3.3: 8B, Apache 2.0, 76.5.
- For comparison: gpt-4o 75.9 and Claude 3.5 Sonnet 77.2.

These are the primary candidates. **Laya's English checkpoint leaves about 320 tokens for the input**, too small for a claim plus evidence; the multilingual one is tested as canon's named candidate. **Jev stays a comparator.** Neither Jev nor Laya has a published fact-verification result.

## Compliance leads (my reading of Google's terms, not legal advice)

All four apply to the product **today**, independent of this research.

| # | What exists today | Clause it meets | Owner |
|---|---|---|---|
| C1 | `POST /scan` caches grounded results in memory for 24 h and serves them to **any** API key that sends the same text (`packages/api/src/store/cache.ts`). The CLI's hosted mode and the Python SDK use this route | "will not… cache… Grounded Results"; display only "to the end user who submitted the prompt" | fp. Reversible: turn the cache off for grounded providers |
| C2 | faultline-web share links (`/scan/[id]`, stored in KV) show grounded verdicts to anyone with the link | same | fw |
| C3 | Neither repo reads or shows Google's **Search Suggestions** (`searchEntryPoint`; zero hits in either repo) | "will only display the Grounded Results with the associated Search Suggestion(s)". Vertex lets customers opt out at standard pricing under 1M prompts a day; the Gemini API terms do not say so | fp + fw |
| C4 | Faultline reshapes Gemini's grounded answer into its own verdict card and report | "will not modify, or intersperse any other content with, the Grounded Results"; "analyze" | product-level; needs a proper reading |

Own retrieval removes C1–C4 by construction, because the evidence then comes from a search API whose terms we pick.

## Target architecture (if the evidence supports it)

```
claims → [router: does this need a search?] → licensed search API → evidence (cacheable where licensed)
       → SemanticDecisionProvider judge (open model first; Jev comparator) → P(supported)
       → asifctl-style deterministic policy: auto-verdict above threshold, "unverified" or Gemini-grounded fallback below
```

**Modelled, not measured:** per claim ≈ $0.005–0.008 (search) + $0 (local judge) + (1 − c) × $0.035 (fallback), where c is the share the judge decides confidently. It beats today's $0.035 a claim once c > about 0.2. **The fallback leg still carries C1–C4.**

## Options for Asif

Pick any; each is one line.

| # | Option | Spend ceiling | Needs from you |
|---|---|---|---|
| **A** | GO Lever 2 judge test (RQ2): open judges plus Jev on LLM-AggreFact's own evidence. No web search, no Google-terms exposure | ≈ $0.10 (Jev allocation); local GPU | nothing |
| **B** | GO a terms read on C1–C4 (counsel or a Google contact). Separately, fp turns off the cross-key `/scan` cache for grounded providers now (reversible) | $0 for the cache change | yes/no on each |
| **C** | GO the baseline-plus-batching run (Lever 1 Q1 + Lever 2 RQ1, one shared run on AVeriTeC) | $35 ($25 + $10), one day, ≤ 1,000 grounded prompts | an AVeriTeC licence ruling (CC BY-NC) and the C4 "analyze" question settled |
| **D** | GO the repeat-rate instrument (hashed claim ids, 14 days) | Fly volume plus an fw change | not worth it at today's volume; revisit when daily grounded prompts pass ~1,000 |
| **E** | DEFER all to 2026-10-15 | $0 | — |

**Recommendation: A and B now, C after B, D later.** A is near-free and answers the Jev question without touching Google's terms. B covers the exposure that exists today. C is the only path to a measured quality baseline and a measured batching saving, and it should run after the terms question is settled.

## Not checked

- Production volume before 2026-10-01: ledger resets on deploy; Vercel aggregate timed out; the local Clerk key is a dev key.
- Whether Gemini 2.5 Flash returns logprobs with grounding on.
- Whether Gemini API (as opposed to Vertex) skips the grounding charge when a prompt returns no sources.
- Legal effect of the terms.
- The full meaning of the Web Grounding for Enterprise terms carve-out (§20(l) deletes one subsection of §20(k); which one was not mapped).

## Sources

Research notes with quotes: written to the session scratchpad and summarised here. Primary pages read directly by fp:
- https://ai.google.dev/gemini-api/terms
- https://cloud.google.com/terms/service-terms
- https://ai.google.dev/gemini-api/docs/google-search
- https://ai.google.dev/gemini-api/docs/pricing
- the Vertex pricing page

Papers and leaderboards as linked above. Internal sources:
- `docs/unit-economics-prod-default-2026-09-30.md`
- `~/ASIF/enrichment/2026-10-01-jev-calibration-eval-results.md`
- Dx3 e2b770ad
- `GET /usage` (2026-10-01)
