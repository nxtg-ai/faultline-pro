# Faultline Engine — Reality vs Vision-of-Record (2026-06-21)

Code-grounded answer to the vision-alignment question (EmmaSoul directive, Asif weekly review).
**Vision-of-record** (`~/ASIF/enrichment/blog-core-and-surfaces.md`): *"the Faultline Pro testing
engine that generates adversarial probes across FIVE foundation-model providers and classifies
safety responses."* — i.e. a multi-provider, multi-step **adversarial FM-safety testing** engine.

**Every claim below is traced to a file:line at HEAD `29f7bb0`. No prose memory.**

---

## Q1 — Does the live engine EVER do multi-provider / multi-step per-claim evaluation?

**Verdict: the live engine is a 2-stage *claim-verification-against-web-sources* pipeline,
single-provider-per-scan by default, with an OPT-IN unused per-stage provider split and a
no-op synthesis slot. It is NOT the adversarial 5-provider safety-testing engine of the vision.**

| Vision-of-record | Live reality | Status |
|---|---|---|
| Adversarial probe generation | No such code exists anywhere (`grep adversarial\|safety.?response\|probe` → 0 hits in api/cli/services) | **NOT BUILT** |
| Classifies safety responses | Engine classifies claim verdicts (supported/contradicted/mixed/unverified) vs **web sources** — not model safety responses | **DIFFERENT PRODUCT** |
| FIVE FM providers | Registry has 4 real (`gemini, openai, claude, perplexity`) + `mock` = 5 entries; **live health: 3 configured, perplexity:false** | **PARTIAL (4 real, 2 live-grounding-capable)** |
| Multi-step pipeline | **2 FM stages**: `extractClaims()` → per-claim `verifyClaim()`, then a deterministic report stage (rules + risk, no FM) | **BUILT (2-step)** |
| Each FM used for its strength per step | Per-stage provider routing EXISTS (`PipelineConfig.extractionProvider`/`verificationProvider`) but is **opt-in and unused by any client**; default = one provider for both stages | **BUILT BUT DORMANT** |
| Multi-provider per claim (consensus) | Each claim verified by **exactly one** provider; no N-way fan-out / cross-model consensus | **NOT BUILT** |
| Synthesis stage | `synthesisProvider` is "reserved — **no-op** in current API pipeline" | **REDUCED (declared, no-op)** |

### Code path (`packages/cli/cli/scan.ts`, called by `packages/api/src/routes/stream.ts:4`)

- `scan()` resolves ONE default provider: `resolvedProvider = providerName || 'gemini'` (`scan.ts:176`).
- Per-stage names default to that single provider: `extractionName/verificationName = pipelineConfig?.X ?? resolvedProvider` (`scan.ts:179-180`). **No client passes `pipelineConfig`**, so both stages use one provider.
- Stage 1: `extractionProvider.extractClaims(text)` (`scan.ts:192`).
- Stage 2: per-claim `verificationProvider.verifyClaim(claim)` — one provider, concurrent slots, 3 retries (`scan.ts:199-224`).
- Report: deterministic `calculateRisk` + `runAllRules` (no FM) (`scan.ts:227-232`).

### Source grounding is provider-dependent BY DESIGN (this is why the default returns empty)

| Provider | Returns real `sources`? | Evidence |
|---|---|---|
| **gemini** | YES — Google-Search grounded (verified live: wikipedia.org/nasa.gov) | `gemini_provider.ts` grounding |
| **perplexity** | YES — citations → sources, but **live health = false (down)** | `perplexity_provider.ts:80` |
| **openai** | **NO — hardcoded `sources: []`** (ungrounded LLM judgment) | `openai_provider.ts:87` |
| **claude** | **NO — hardcoded `sources: []`** | `claude_provider.ts:84` |
| mock | NO | `mock_provider.ts:31` |

The user-facing `/scan/stream` defaults to **openai** (`stream.ts:80,189`) → empty sources by design.
`scan.ts` (non-streaming) defaults to **gemini** → grounded. The streaming path is the inconsistent outlier.

---

## Q2 — Step-by-step reproduction (engine/API surface — fp). UI surfaces (landing/results/widget/wizard) = fw.

Requires a deployed API key. Source it locally (never paste the value):
```bash
cd ~/projects/Faultline-Pro
export KEY=$(grep -E '^FAULTLINE_API_KEY=' packages/api/.env | cut -d= -f2- | tr -d '"'\''')
export API=https://faultline-api.fly.dev
export TEXT="The Eiffel Tower is in Paris. The JWST launched in 2021. The speed of light is ~299792 km/s."
```

**R1 — DEFAULT path returns EMPTY sources (the overclaim):**
```bash
curl -s -H "x-api-key: $KEY" -G "$API/scan/stream" --data-urlencode "text=$TEXT" | grep -oE '"provider":"[a-z]+"|"sources":\[[^]]*\]'
# => provider":"openai", every "sources":[]  (empty)
```

**R2 — gemini path returns REAL sources (grounding works when selected):**
```bash
curl -s -H "x-api-key: $KEY" -G "$API/scan/stream" --data-urlencode "text=$TEXT" --data-urlencode "provider=gemini" | grep -oE '"sources":\[[^]]+\]' | head
# => real Google-Search citations (wikipedia.org, nasa.gov)
```

**R3 — single-provider-per-scan (no per-claim multi-provider):** every `claim_verified` event in R1/R2 carries the same single `provider`; there is no per-claim provider variation.

**R4 — health: which providers are actually live:**
```bash
curl -s "$API/health" | python3 -m json.tool | grep -A6 providers
# => gemini:true, openai:true, claude:true, perplexity:false ; providersConfigured:3
```

**R5 — measured tradeoff (why the default-flip is an Asif call):** openai ≈ 4.8s / 0 grounded vs gemini ≈ 14.0s / 3 grounded (3-claim scan, live).

---

## Q3 — Demo-ready

The API is live and probeable now (`$API/health` 200, `$API/scan/stream` per R1–R2). Running R1 in
front of Asif shows the empty-sources default with no hiding; R2 shows grounding works on gemini.
The web UI walkthrough (faultline.nxtg.ai landing → scan → results → widget/wizard) is **fw's surface** —
fw produces that half. Nothing greens until Asif has seen it live and ruled.
