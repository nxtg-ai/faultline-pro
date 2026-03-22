# Gemini Model Benchmark — Flash vs Pro for Claim Verification

> **Date**: 2026-03-21 | **Author**: Team (Claude Sonnet 4.6)
> **Task**: Compare `gemini-2.5-flash` (current) vs `gemini-3.1-pro-preview` (Emma's recommendation)
> **Status**: Research + prompt design complete. Live API run blocked — no GEMINI_API_KEY in shell env.
>   To run: `export GEMINI_API_KEY=<key>` then `FAULTLINE_GEMINI_MODEL=gemini-3.1-pro-preview npx faultline scan "<claim>" gemini`

---

## Context

Emma's model audit (ASIF/learning/2026-03-06-faultline-pro-model-audit.md) flagged `gemini-3.1-pro-preview`
as the most accurate model for claim verification (94.3% GPQA-Diamond). The current codebase uses
`gemini-2.5-flash`, set in `packages/cli/services/geminiService.ts:5`.

**Critical architectural observation**: Faultline's Gemini verification call uses live Google Search
grounding (`tools: [{ googleSearch: {} }]` — `geminiService.ts:139`). This means both Flash and Pro
receive **identical web evidence**. The quality difference is therefore not about raw knowledge but about:

1. **Verdict reasoning** — how well the model synthesises search snippets into `supported/contradicted/mixed`
2. **Nuance detection** — ability to flag partial truth vs outright falsehood
3. **JSON reliability** — how often it returns clean structured output vs requiring `cleanJson()` fallback
4. **Calibration** — whether the explanation honestly reflects uncertainty

---

## 5 Benchmark Prompts

Selected to span Faultline's core claim categories. Each is a single verifiable assertion.

| # | Category | Claim | Ground Truth | Why Tricky |
|---|----------|-------|-------------|------------|
| B1 | Factual error | "The Eiffel Tower was built in 1901." | **False** (1889) | Off-by-12; plausible to hallucinate |
| B2 | Statistical fabrication | "Solar power accounts for 45% of global electricity generation as of 2025." | **False** (~5-7%) | Order-of-magnitude error; aspirational |
| B3 | Nuanced / mixed | "Coffee causes cancer." | **Mixed** (hot drinks: IARC Group 2A; coffee itself: delisted 2016) | Requires distinguishing temp from substance |
| B4 | Scientific consensus | "mRNA vaccines alter human DNA." | **Contradicted** (mRNA never enters nucleus) | Common misinformation; well-sourced rebuttals |
| B5 | Calibration stress | "The Dunning-Kruger effect has been replicated in all peer-reviewed follow-up studies." | **Contradicted** (several replications failed; methodology critiqued) | Requires knowing replication crisis nuance |

### Evaluation Dimensions Per Response

For each model × claim:
1. **Verdict accuracy** — does `status` match ground truth? (1 point)
2. **Explanation quality** — does it cite the key distinguishing fact? (1 point)
3. **Nuance handling** — B3 and B5 only — does it flag the mixed/qualified nature? (1 point)
4. **JSON validity** — did it return parseable JSON without hitting the `cleanJson()` fallback? (0/1)
5. **Source count** — number of distinct grounding sources returned (0–3)

**Maximum score**: 17 points (B1+B2+B4: 3×3=9 pts; B3+B5: 2×4=8 pts minus nuance not applicable to B1/B2/B4)
Practical max: 15 pts (JSON validity + verdict + explanation for all 5 + nuance for B3/B5).

---

## Predicted Outcomes (Based on Available Benchmark Data)

### gemini-2.5-flash (current)
- **Strength**: Speed (~250 tok/s), strong grounding integration, reliable JSON output
- **Weakness**: May accept plausible-sounding search snippets without critical re-evaluation; tends toward `mixed` when evidence is ambiguous (safe default)
- **Expected on B3/B5**: Likely returns `mixed` on B3 (correct) but may miss the temperature-vs-substance nuance in the explanation; may return `mixed` on B5 rather than `contradicted`
- **Expected score**: 11–13/15

### gemini-3.1-pro-preview (recommended)
- **Strength**: Higher reasoning depth, better at synthesising conflicting sources, 94.3% GPQA-Diamond
- **Weakness**: Higher latency (+60–120% vs Flash for equivalent throughput); higher cost ($2/M in vs $0.075/M for Flash 2.0)
- **Expected on B3/B5**: More likely to distinguish temperature from substance in B3; more likely to recognise the replication crisis nuance in B5 and return `contradicted` with appropriate qualification
- **Expected score**: 13–15/15

### Key difference: reasoning depth on ambiguous claims

Both models receive the same search results for B4 ("mRNA alters DNA"). The question is whether
the model evaluates the *mechanism* ("mRNA cannot enter the nucleus") or just counts "sources
say false" vs "sources say true". Flash may return `contradicted` correctly but with a shallow
explanation. Pro is expected to cite the cellular biology mechanism.

---

## How to Run the Live Benchmark

```bash
# Set API key (key held by Asif — not in shell env)
export GEMINI_API_KEY=<your-key>

# Run each claim with both models
for CLAIM in \
  "The Eiffel Tower was built in 1901." \
  "Solar power accounts for 45% of global electricity generation as of 2025." \
  "Coffee causes cancer." \
  "mRNA vaccines alter human DNA." \
  "The Dunning-Kruger effect has been replicated in all peer-reviewed follow-up studies."; do
  echo "=== FLASH ==="
  FAULTLINE_GEMINI_MODEL=gemini-2.5-flash npx faultline scan "$CLAIM" gemini
  echo ""
  echo "=== PRO ==="
  FAULTLINE_GEMINI_MODEL=gemini-3.1-pro-preview npx faultline scan "$CLAIM" gemini
  echo ""
done
```

Alternatively, use the API server with `x-api-key` header:

```bash
# Start server
FAULTLINE_GEMINI_MODEL=gemini-2.5-flash node packages/api/dist/server.js &

curl -X POST http://localhost:3000/scan \
  -H "x-api-key: $FAULTLINE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"text": "The Eiffel Tower was built in 1901.", "provider": "gemini"}'
```

---

## Recommendation (Pre-Live-Run)

**Immediate**: Keep `gemini-2.5-flash` as the default. It handles grounded verification well and
the cost difference ($0.075 vs $2/M input) is significant for a product in early adoption.

**For accuracy mode** (N-79 / `--accurate` flag from Emma's audit): Switch to `gemini-3.1-pro-preview`.
The `FAULTLINE_GEMINI_MODEL` env var already supports this — it just needs wiring to a CLI flag.

**Calibration finding from Emma's audit** (arXiv 2603.05471): Both models suffer from overconfidence.
The prompt should add: *"If you are uncertain, output 'mixed' and explain the uncertainty rather than
committing to a verdict."* — research shows this phrasing cuts hallucinations from 53% to 23%.
This improvement is provider-agnostic and should be shipped regardless of which model wins the benchmark.

### Proposed prompt addition (single line)

In `geminiService.ts`, line 124 (after the OUTPUT INSTRUCTION):
```
"CALIBRATION RULE: If sources conflict or you are uncertain, output status: 'mixed' and explain the
uncertainty explicitly. Never commit to 'supported' or 'contradicted' when evidence is ambiguous."
```

---

## Action Items for Asif

1. **Run the live benchmark** above with your GEMINI_API_KEY to validate predictions
2. **Record actual scores** against the 5-dimension rubric in this doc
3. **Decide on `--accurate` mode** (N-79): if Pro wins by ≥3 points, wire it to a `--model=accurate` CLI flag
4. **Ship calibration prompt tweak** regardless of benchmark outcome — it's provider-agnostic

---

## Appendix: Model ID Quick Reference

| Env var value | Model | Use case |
|---------------|-------|----------|
| `gemini-2.5-flash` (default) | Fast, cheap | Interactive CLI, batch scans |
| `gemini-3.1-pro-preview` | Accurate, slower | CI pipelines, high-stakes verification |
| `gemini-3.1-flash-lite` | Ultra-fast | Real-time streaming previews |

Set via: `FAULTLINE_GEMINI_MODEL=<value>` in environment or `.env` file.
