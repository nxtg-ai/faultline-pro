# Consensus Model-Default SKU Proposal — A-110 item 3

**Status**: PROPOSE-ONLY. **No model default was changed.** The prod flip is Asif's one-click.
**Asked for**: A-110 item 3 — *"Propose current SKUs with PRIMARY-SOURCE pricing for the model-default flip … Present SKU options → Asif one-clicks the prod flip (don't decide; gpt-4o→gpt-4o-mini retrieval is the ~16× cost lever, quality-check required per spike)."*
**Primary sources fetched 2026-08-09** (not the repo's 2026-07-03 pins):
- OpenAI model pricing — <https://developers.openai.com/api/docs/pricing>
- OpenAI web_search tool — <https://developers.openai.com/api/docs/guides/tools-web-search>
- Anthropic model pricing — <https://platform.claude.com/docs/en/about-claude/pricing>

---

## Headline: the directive's "~16×" lever does not survive its own arithmetic

**A-110 item 3 states the gpt-4o → gpt-4o-mini retrieval swap is a "~16× cost lever." It is not — the ceiling is ~5×, and the named target model's support is doubtful.** Two independent reasons, both grounded below:

1. **The web_search tool fee is a FIXED per-call charge that no model swap touches.** OpenAI bills web_search at **$10.00 / 1k calls** ($0.010/call) *plus* search-content tokens at model rates. 16.7× is the ratio of *token rates alone* (gpt-4o $2.50/M ÷ gpt-4o-mini $0.15/M). On the measured baseline the fixed fee is $0.51 of a $3.08 leg — after any cheap-model swap it becomes the **majority** of the leg and caps the total cut at ~5×.
2. **gpt-4o-mini's web_search support is not confirmable and one path is already dead.** The current tool doc's limitations table names **`gpt-4.1-mini`** (search context capped at 128k) and the current-generation `gpt-5.x` models; `gpt-4o-mini-search-preview` was **shut down 2026-07-23** — *after* the A-110 card was written. Sources disagree on whether plain `gpt-4o-mini` still accepts the tool, so I am not asserting either way (see *Acceptance instrument*).

This is the BL-3 lesson firing again: the card's ground truth was stale, so the probe went first.

## Measured baseline (the thing being cut)

From `DIRECTIVE-NXTG-20260704-01`: the web_search retrieval leg is **88–91% of consensus-scan cost** — **51 calls, 886k input tokens, $3.08** across the 18-scan matrix, at gpt-4o.

Decomposition (reproduces $3.08 from today's published rates — the arithmetic instrument for everything below):

| Component | Calculation | USD |
|---|---|---|
| Input tokens | 886,000 × $2.50/M | 2.215 |
| Output tokens | ~35,500 × $10.00/M | 0.355 |
| web_search fee | 51 × $0.010 | 0.510 |
| **Total** | | **3.080** ✓ |

## SKU options for the retrieval leg (`openai_web_search_retriever.ts:19`, today `gpt-4o`)

Same 886k in / ~35.5k out / 51 calls, repriced. **Projection from the measured baseline, not a re-measurement** — the harness re-run is the VERIFY-GATE.

| # | Model | Rates in/out per 1M | Leg cost | Cut vs gpt-4o | web_search support (2026-08-09 docs) |
|---|---|---|---|---|---|
| **A** | **`gpt-4.1-mini`** | $0.40 / $1.60 | **$0.92** | **3.3×** | **Named in the limitations table** (128k search context) |
| B | `gpt-4.1` | $2.00 / $8.00 | $2.57 | 1.2× | Named |
| C | `gpt-5.6-luna` | $0.20 / $1.20 | $0.73 | 4.2× | `gpt-5.6` family named; luna variant unverified |
| D | `gpt-5-nano` | $0.05 / $0.40 | $0.57 | 5.4× | Unverified; "no web search with `gpt-5` + `minimal` reasoning" |
| E | `gpt-4o-mini` (the card's pick) | $0.15 / $0.60 | $0.66 | 4.6× | **Doubtful** — `*-search-preview` sibling shut down 2026-07-23 |
| — | `gpt-4o` (today) | $2.50 / $10.00 | $3.08 | 1.0× | Legacy generation |

**Recommendation: Option A (`gpt-4.1-mini`).** It is the only cheap candidate whose web_search support is affirmatively documented, it is a 3.3× cut on the dominant leg (~$0.17 → ~$0.05 per scan), and its one real constraint — search context capped at 128k — is comfortably above the measured ~17k tokens/call. C/D are cheaper on paper and worth probing, but recommending an unverified tool path to save a further $0.2/matrix is the wrong trade.

**Second-order finding that changes lever ranking.** Once the model is cheap, **$0.51 of the $0.92 leg is the fixed per-call fee**. The remaining levers in the spike must therefore cut **call count**, not tokens: dedup (lever 3), cache (lever 4), batching (lever 5) now outrank "trim search-content tokens" (lever 2). The spike's original ordering assumed the token bill dominated; after a model swap it does not.

## The voter leg — an unasked-for correction

`CONSENSUS_MODEL_RATES` prices `claude-opus-4-8` at **$5.00 / $25.00**. Today's Anthropic page: Claude Opus 4.8 = **$5 / $25 — CONFIRMED, no drift.** The web_search fee also matches ($10/1k). The pinned table is accurate.

But the *choice* is now questionable: Opus 4.8 is Anthropic's premium tier, and a grounded-verify voter reading retrieved snippets is not a frontier-reasoning task. Current cheaper SKUs:

| Model | in/out per 1M | vs Opus 4.8 |
|---|---|---|
| Claude Haiku 4.5 | $1 / $5 | **5×** cheaper |
| Claude Sonnet 5 | $2 / $10 (intro **through 2026-08-31**, then $3 / $15) | 2.5× cheaper now |
| Claude Opus 4.8 (today) | $5 / $25 | 1× |

**Flagged, not recommended** — a voter-model downgrade changes verdict quality, which is the product. It needs the spike's quality check, not a pricing table. **Time-boxed note for Asif: Sonnet 5's introductory rate expires 2026-08-31** (+50% on 2026-09-01), so any decision assuming $2/$10 has a 22-day shelf life.

## Acceptance instrument (before any flip)

Doc-reads are leads. The deterministic proof is one live call per candidate on the funded key — **~$0.01 each, well inside the $100/mo ledgered budget** (`docs/provider-spend-cap.md`):

```
# per candidate: does the tool bind, and what does one call actually cost?
POST /v1/responses  { model: "<candidate>", tools: [{ type: "web_search" }], input: "<one probe query>" }
# → 200 with a url_citation annotation = supported; read usage off the response
```

Then the real gate: re-run `scripts/measure-consensus-cost.ts` (18-scan matrix, keys kept) per surviving candidate and compose `docs/asif-post-spike-cost-card-YYYY-MM-DD.md` with the raw provider-usage records committed alongside, for Wolf/kestrel independent recompute — the generator does not grade itself.

## What I did NOT do

- **No model default changed.** `openai_web_search_retriever.ts:19` still reads `gpt-4o`; `openai_provider.ts:12` still reads `gpt-4o-mini`. Item 3 is propose-only.
- **No spend.** Every number above is arithmetic on published rates plus the already-measured baseline.
- **No pricing decision.** Cap, SKU, and flip are Asif's.
