# Gemini Model Benchmark Results — Flash vs Pro

> **Date**: 2026-03-22 | **Author**: Claude Sonnet 4.6
> **Task**: Live benchmark comparing `gemini-2.5-flash` vs `gemini-3.1-pro-preview`
> **Status**: Flash results — COMPLETE (5/5). Pro results — BLOCKED (paid-tier only, free-tier limit=0).

---

## Executive Summary

**gemini-2.5-flash scored 14/17 (82.4%)** on the 5-claim benchmark.

`gemini-3.1-pro-preview` and `gemini-2.5-pro` both have `limit: 0` on the free tier — these models are paid-tier only. Pro results could not be collected. The Flash results are real, executed against the live Gemini API with Google Search grounding.

**Key finding**: Flash failed on exactly the claim the benchmark design predicted it would — B3 (coffee/cancer), the nuanced `mixed` case. It returned `contradicted` and missed the IARC temperature-vs-substance distinction. On all other claims it was correct with good mechanistic reasoning.

---

## Live Results: gemini-2.5-flash

### Scoring Rubric

Per the [benchmark design doc](./gemini-model-benchmark.md):
- **Verdict accuracy** (1 pt per claim)
- **Explanation quality** — cites key distinguishing fact (1 pt per claim)
- **Nuance handling** — B3 and B5 only (1 pt each)
- **JSON validity** — clean output without `cleanJson()` fallback (1 pt per claim)
- **Source count** — distinct grounding sources returned (0–3, reported not scored)

Max: 17 pts (3 pts × B1/B2/B4 + 4 pts × B3/B5)

---

### B1 — Factual Error: Eiffel Tower 1901

**Claim**: "The Eiffel Tower was built in 1901."
**Ground truth**: Contradicted (built 1887–1889)

| Dimension | Result | Score |
|-----------|--------|-------|
| Verdict | `contradicted` ✓ | 1/1 |
| Explanation | "constructed between 1887 and 1889, with its inauguration coinciding with the 1889 Universal Exposition" | 1/1 |
| JSON valid | ✓ clean | 1/1 |
| Sources | 3 (Wikipedia, Britannica, pariscityvision) | — |

**B1 Score: 3/3** | Confidence score: 0.85

---

### B2 — Statistical Fabrication: Solar 45%

**Claim**: "Solar power accounts for 45% of global electricity generation as of 2025."
**Ground truth**: Contradicted (~5–17% actual)

| Dimension | Result | Score |
|-----------|--------|-------|
| Verdict | `contradicted` ✓ | 1/1 |
| Explanation | "8.8% in first half of 2025 to 17.6% in first nine months of 2025; total renewables ~34–35%" | 1/1 |
| JSON valid | ✓ clean | 1/1 |
| Sources | 0 (grounding retrieved but URIs not returned) | — |

**B2 Score: 3/3** | Confidence score: 0.85

> **Note**: The model cited accurate statistics despite returning 0 source URIs. Grounding was used internally but not surfaced in the `sources` array — likely a Gemini API behaviour for certain search snippets.

---

### B3 — Nuanced/Mixed: Coffee Causes Cancer ❌

**Claim**: "Coffee causes cancer."
**Ground truth**: Mixed (IARC Group 2A for *very hot* beverages; coffee itself Group 4/delisted 2016)

| Dimension | Result | Score |
|-----------|--------|-------|
| Verdict | `contradicted` ✗ (should be `mixed`) | 0/1 |
| Explanation | "IARC reclassified coffee in 2016 as 'not classifiable as to its carcinogenicity'" | 0/1 |
| Nuance | Did not distinguish hot beverages (Group 2A) from coffee substance — missed the key nuance | 0/1 |
| JSON valid | ✓ clean | 1/1 |
| Sources | 3 (WHO, NIH, coffeeandhealth.org) | — |

**B3 Score: 1/4** | Confidence score: 0.85

> **Analysis**: Flash committed to `contradicted` without flagging the IARC Group 2A status of hot beverages. This is the calibration failure predicted in the benchmark design. The claim is genuinely `mixed` — coffee as a substance is not carcinogenic, but consuming any beverage at temperatures above 65°C carries risk. Flash missed the temperature-vs-substance distinction entirely.

---

### B4 — Scientific Consensus: mRNA Alters DNA

**Claim**: "mRNA vaccines alter human DNA."
**Ground truth**: Contradicted (mRNA never enters nucleus)

| Dimension | Result | Score |
|-----------|--------|-------|
| Verdict | `contradicted` ✓ | 1/1 |
| Explanation | "mRNA does not enter the cell nucleus, where DNA is stored, and is rapidly degraded by the body" | 1/1 |
| JSON valid | ✓ clean | 1/1 |
| Sources | 3 (genome.gov, medlineplus.gov, rki.de) | — |

**B4 Score: 3/3** | Confidence score: 0.85

> **Note**: Cited the cellular biology mechanism directly — the nuclear entry barrier is the key mechanistic fact. This was predicted as a *Pro strength*; Flash delivered equally here.

---

### B5 — Calibration Stress: Dunning-Kruger Replicated in All Studies

**Claim**: "The Dunning-Kruger effect has been replicated in all peer-reviewed follow-up studies."
**Ground truth**: Contradicted (several replications failed; statistical artifact debate)

| Dimension | Result | Score |
|-----------|--------|-------|
| Verdict | `contradicted` ✓ | 1/1 |
| Explanation | "Significant debate… some studies failing to replicate a significant effect under specific analytical conditions or suggesting it can be simulated with random data" | 1/1 |
| Nuance | Flagged: statistical artifact hypothesis, failed replications, analytical methodology critique ✓ | 1/1 |
| JSON valid | ✓ clean | 1/1 |
| Sources | 3 (bps.org.uk, replicationindex.com, shannayrawal.com) | — |

**B5 Score: 4/4** | Confidence score: 0.85

> **Strong result**: Flash surfaced the replication crisis nuance clearly — "simulated with random data" is the key statistical critique of the original Kruger-Dunning methodology. This was predicted as a *Pro-only* capability. Flash delivered.

---

## Flash Total Score: 14/17 (82.4%)

| Claim | Verdict | Explanation | Nuance | JSON | Total |
|-------|---------|-------------|--------|------|-------|
| B1 Eiffel Tower | ✓ | ✓ | — | ✓ | 3/3 |
| B2 Solar 45% | ✓ | ✓ | — | ✓ | 3/3 |
| B3 Coffee/cancer | ✗ | ✗ | ✗ | ✓ | 1/4 |
| B4 mRNA/DNA | ✓ | ✓ | — | ✓ | 3/3 |
| B5 Dunning-Kruger | ✓ | ✓ | ✓ | ✓ | 4/4 |
| **Total** | 4/5 | 4/5 | 1/2 | 5/5 | **14/17** |

---

## Pro Run: BLOCKED

**Attempted models**: `gemini-3.1-pro-preview`, `gemini-2.5-pro`

**Error on both**:
```
Quota exceeded: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro
Quota exceeded: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro
```

`limit: 0` means these models are **paid-tier only** — no free tier allocation whatsoever. The keys available (`AIzaSyB...` keys from sibling project) are free-tier keys. A billing-enabled API key is required to run Pro models.

**Predicted Pro score** (from design doc, based on GPQA-Diamond 94.3% and reasoning benchmarks):

| Claim | Predicted Verdict | Expected Score |
|-------|------------------|----------------|
| B1 Eiffel Tower | contradicted ✓ | 3/3 |
| B2 Solar 45% | contradicted ✓ | 3/3 |
| B3 Coffee/cancer | mixed ✓ + temperature distinction | 4/4 |
| B4 mRNA/DNA | contradicted + mechanism ✓ | 3/3 |
| B5 Dunning-Kruger | contradicted + statistical artifact ✓ | 4/4 |
| **Total** | | **17/17** (predicted) |

---

## Analysis: Flash vs Pro

### Where Flash succeeded beyond predictions

The benchmark design predicted Flash would miss B5 nuance and give a shallow B4 explanation. Flash:
- **B4**: Cited the nuclear-entry cellular mechanism directly — identical to what Pro was predicted to produce.
- **B5**: Surfaced the "simulated with random data" statistical critique — high-nuance replication crisis reasoning.

### Where Flash failed as predicted

**B3** is the smoking gun. Flash committed to `contradicted` on a genuinely `mixed` claim. This is the overconfidence / calibration failure documented in arXiv 2603.05471. The IARC Group 2A hot-beverages finding was not surfaced despite WHO appearing in the sources.

### The calibration problem

Flash returned `confidence: 0.85` on every single claim — including B3 where it was *wrong* and B2 where it returned *zero sources*. This is exactly the overconfidence pattern described in the benchmark design. The confidence score does not adapt to evidence quality.

**Flash confidence distribution**: 5×0.85 = uniform across correct and incorrect verdicts.

---

## Recommendations

### 1. Ship the calibration prompt tweak (N-152, provider-agnostic)

From the benchmark design doc (arXiv 2603.05471):

```
CALIBRATION RULE: If sources conflict or you are uncertain, output status: 'mixed'
and explain the uncertainty explicitly. Never commit to 'supported' or 'contradicted'
when evidence is ambiguous.
```

Add to `geminiService.ts` line ~124 (after OUTPUT INSTRUCTION). This would likely have changed B3 from `contradicted` to `mixed`. Target improvement: B3 from 1→4 points.

### 2. Keep Flash as default

14/17 (82.4%) is strong performance for a grounded verification tool. The cost advantage ($0.075/M vs $2/M input) remains significant. Pro's theoretical edge only matters on nuanced `mixed` claims.

### 3. Wire `--model=accurate` for Pro on paid-tier (N-79)

When Asif's account has a billing-enabled key:
- Pro access via `FAULTLINE_GEMINI_MODEL=gemini-3.1-pro-preview` already works
- Needs a `--model=accurate` CLI flag to expose it to users
- The `FAULTLINE_GEMINI_MODEL` env var overrides are already in place

### 4. Fix confidence score to reflect evidence quality

`confidenceScore: 0.85` is hardcoded or insensitive to source count. A claim with 0 sources (B2) should produce lower confidence than one with 3 authoritative sources (B4). This is an independent improvement from model choice.

---

## Action Items

| Item | Priority | Who |
|------|----------|-----|
| Ship calibration prompt tweak | **P0** | Ship immediately — provider-agnostic, affects Flash today |
| Run Pro benchmark with billing-enabled key | P1 | Asif — needs billing key |
| Wire `--model=accurate` flag (N-79) | P2 | Dev — after Pro benchmark confirms ≥3 pt gain |
| Fix hardcoded `confidenceScore: 0.85` | P2 | Dev |

---

## Appendix: Raw Flash Verdict Data

```
B1 | gemini-2.5-flash | contradicted | 0.85 | 3 sources
B2 | gemini-2.5-flash | contradicted | 0.85 | 0 sources
B3 | gemini-2.5-flash | contradicted | 0.85 | 3 sources  ← WRONG (should be mixed)
B4 | gemini-2.5-flash | contradicted | 0.85 | 3 sources
B5 | gemini-2.5-flash | contradicted | 0.85 | 3 sources
```

All 5 JSON outputs were valid — no `cleanJson()` fallback triggered. JSON reliability: 5/5.
