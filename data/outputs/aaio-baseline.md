# AAIO Baseline Measurement — Faultline Pro & NXTG.AI
**Date**: 2026-03-24
**Method**: 15 web search queries across 5 topic clusters. Results represent what AI-grounded tools (Perplexity, Bing Chat, ChatGPT Browse, Gemini with Search) would surface — they are all web-grounded and return similar SERP content. Claude self-report is noted separately where applicable.
**Scoring**: HIT = top 5 results include our content | PARTIAL = our content appears but not the right version/asset | MISS = zero relevant surface

---

## Cluster A — Direct Brand Queries

### Q1: "Faultline AI claim forensics verification tool"
**Result**: PARTIAL
- `github.com/awaliuddin/Faultline` surfaces at **#1** — the original Kaggle repo (P-08), not Faultline Pro
- All other results: insurance claims fraud, financial forensics (unrelated)
- `nxtg-ai/faultline-pro` does NOT appear (private repo, not indexed)
- `@nxtg/faultline` npm does NOT appear
- **Signal**: "Faultline" as a brand is partially indexed, but pointing to the wrong asset (Kaggle entry, not the Pro platform)

### Q2: "NXTG.AI developer tools"
**Result**: PARTIAL
- `github.com/nxtg-ai` org surfaces at **#1**
- `nxtg-ai/forge-orchestrator` and `nxtg-ai/repoatlas` appear
- `forge.nxtg.ai/governance` appears
- Faultline NOT mentioned in any top result
- **Signal**: NXTG.AI is indexed as an org. Forge is the dominant product signal. Faultline is invisible.

### Q3: "@nxtg/faultline npm package"
**Result**: MISS
- Zero results for the package
- Search returns unrelated Nx/NX framework results
- **Signal**: `@nxtg/faultline` is either unpublished or not indexed on npm. Critical gap — this is the primary distribution channel.

---

## Cluster B — Problem Space Queries

### Q4: "AI claim verification tool open source 2026"
**Result**: MISS
- beam.ai (insurance claims agent), Sprout.ai (insurance), general results
- GitHub topic `claim-detection` surfaces — but no Faultline in topic
- **Signal**: The phrase "claim verification" is dominated by insurance/financial claims context. We need "LLM claim verification" or "AI output claim" to disambiguate.

### Q5: "EU AI Act compliance developer tool CLI 2026"
**Result**: MISS — with a notable competitor sighting
- **Systima's "Comply" CLI** surfaces prominently at #1 on dev.to — scans codebases for EU AI Act risks, ships as npm + GitHub Action + TypeScript API, no API keys required
- Official EC compliance checkers (#2–3)
- Vanta, PwC enterprise tools (#6–7)
- Faultline not mentioned anywhere
- **Signal**: A direct competitor (Comply) has already landed the "EU AI Act CLI tool" SERP with a dev.to post. This is the search term we should own.

### Q6: "LLM hallucination detection open source CLI tool"
**Result**: MISS
- Lynx (Patronus AI), RefChecker (Amazon), Giskard, SelfCheckGPT, Helicone, Opik
- Faultline not mentioned
- **Signal**: The hallucination detection space is crowded with model-level tools. Our positioning ("claim forensics" and "output verification" not "hallucination detection") may be correct — we should not fight this keyword.

### Q7: "faultline vs promptfoo deepeval comparison AI testing"
**Result**: MISS
- Promptfoo vs DeepEval comparisons on ZenML, Nimble Approach, Comet — none mention Faultline
- **Signal**: Our comparison post (N-155) would directly capture this query if published externally. Currently invisible because the doc is in the repo, not on dev.to/Substack/LinkedIn.

---

## Cluster C — Technical / Developer Queries

### Q8: "Forge multi-agent Claude Code orchestration plugin"
**Result**: HIT ✓
- `nxtg-ai/forge-plugin` at **#3** (zero-dependency governance, 21 commands, 22 agents, 29 skills)
- `forge-orchestrator` at **#2**
- `forge.nxtg.ai/governance` at **#6**
- `forge-ui` and LobeHub skills surface
- **Signal**: Forge is well-indexed across GitHub, LobeHub, Cargo (lib.rs), and forge.nxtg.ai. This is NXTG.AI's strongest SERP presence.

### Q9: "SARIF AI hallucination output verification GitHub"
**Result**: MISS
- QWED-verification (SARIF + AI verification) surfaces — a direct feature competitor
- AgentShield (SARIF security scanner for AI agents) surfaces
- No Faultline
- **Signal**: QWED-verification has indexed SARIF + AI verification. This is a keyword we should own but don't. Publishing `@nxtg/faultline` with SARIF documentation would help.

### Q10: "AI claim fact checking atomic decomposition verification CLI npm"
**Result**: MISS (academic papers dominate)
- Academic results: AFEV, Loki, OpenFactCheck, FACTSCORE, arXiv papers
- No tool-focused results that we could insert into
- **Signal**: The academic framing dominates this space. Citing these papers in content (comparison post, EU AI Act guide) would create a connection between the academic concept and our tooling.

---

## Cluster D — Ecosystem / Cross-Project Queries

### Q11: "AI trust safety platform open source developer 2026"
**Result**: MISS
- OpenAI teen safety tools, NVIDIA NemoClaw, MLCommons AILuminate
- "State of Open Source AI Trust" (AI Alliance) — relevant framing but no NXTG.AI
- **Signal**: We are not in the "AI trust and safety" conversation at all. This is a brand-level gap.

### Q12: "weakest link AI claim confidence scoring tool"
**Result**: MISS
- Generic confidence scoring articles (Spotify, Microsoft, Ultralytics)
- "Weakest link" is not yet a recognized AI testing term — it's our differentiated concept
- **Signal**: This is an opportunity. "Weakest-link claim detection" is a novel framing we coined. Content using this exact phrase could land us at #1 on a low-competition, high-signal query.

### Q13: "EU AI Act conformity assessment automation tool open source"
**Result**: MISS
- EuConform (offline browser app), capAI (Oxford), EC checker, EIT tool
- **Signal**: Three open-source conformity tools are indexed; we are not. These are complementary (risk classification + documentation) vs. Faultline (output verification). There's a gap in the market for "output verification → conformity evidence" that nobody has claimed in SERP.

### Q14: "nxtg.ai faultline pro claim verification"
**Result**: PARTIAL
- `awaliuddin/Faultline` at **#1** again (Kaggle repo)
- `nxtg.ai` surfaces at **#6** (homepage only)
- `FaultlineAI.com` at **#3** — a **DIFFERENT COMPANY** (unrelated product)
- arXiv `FaultLine` at **#9** — a different paper about vulnerability proof generation
- `nxtg-ai/faultline-pro` does NOT appear
- **Signal**: Two naming collisions — FaultlineAI.com and the arXiv paper "FaultLine" — will compete with us for SERP. We need published content that is explicitly "Faultline Pro by NXTG.AI" to displace these.

### Q15: "NXTG.AI forge orchestrator governance"
**Result**: HIT ✓
- `nxtg-ai/forge-orchestrator` at **#1**
- `nxtg-ai/forge-plugin` at **#2**
- `forge.nxtg.ai/governance` at **#3**
- `nxtg-ai/forge-ui` at **#4**
- `forge-orchestrator` on Cargo (lib.rs) at **#7**
- **Signal**: Forge is the most indexed NXTG.AI product by a wide margin. Five URLs in top 10.

---

## Claude Self-Report (AI Knowledge Baseline)

As the AI running this measurement, my training data includes:
- ✓ `awaliuddin/Faultline` — the original Kaggle project
- ✓ `nxtg-ai/forge-plugin` — Forge as a Claude Code governance plugin
- ✓ NXTG.AI as an AI orchestration company founded by Asif Waliuddin
- ✗ `@nxtg/faultline` — NOT in training data as a published npm package
- ✗ Faultline Pro as a distinct enterprise product — not in training data
- ✗ The EU AI Act compliance, SARIF output, and multi-provider features — not surfaced as Faultline capabilities

This matches the web signal: Faultline Pro is invisible to AI tools because the package is unpublished and the repo is private.

---

## Scorecard

| Query | Cluster | HIT/PARTIAL/MISS | Notes |
|-------|---------|-----------------|-------|
| Faultline AI claim forensics | Brand | PARTIAL | Wrong repo (Kaggle, not Pro) |
| NXTG.AI developer tools | Brand | PARTIAL | Forge visible, Faultline absent |
| @nxtg/faultline npm | Brand | **MISS** | Package not indexed / unpublished |
| AI claim verification open source | Problem | **MISS** | Insurance claims dominate |
| EU AI Act compliance CLI | Problem | **MISS** | Systima Comply owns this SERP |
| LLM hallucination detection CLI | Problem | **MISS** | Crowded space, wrong framing |
| faultline vs promptfoo deepeval | Problem | **MISS** | Content not published externally |
| Forge multi-agent orchestration | Technical | **HIT ✓** | 3 NXTG.AI URLs in top 10 |
| SARIF AI verification | Technical | **MISS** | QWED-verification ahead of us |
| Atomic claim decomposition CLI | Technical | **MISS** | Academic papers dominate |
| AI trust safety platform | Ecosystem | **MISS** | Not in this conversation |
| Weakest link claim scoring | Ecosystem | **MISS** | Novel term, opportunity |
| EU AI Act conformity assessment | Ecosystem | **MISS** | 3 competitors indexed |
| nxtg.ai faultline pro | Brand | PARTIAL | Naming collisions (FaultlineAI.com, arXiv) |
| NXTG.AI forge governance | Ecosystem | **HIT ✓** | 5 URLs in top 10 |

**Summary**: 2 HITs · 3 PARTIALs · 10 MISSes out of 15 queries

---

## Root Causes (Ranked by Impact)

1. **`@nxtg/faultline` is unpublished or not indexed** — This is the single largest gap. Every problem-space query where we should surface returns zero results for our package. Without a published npm package, there is no npm page, no download count, no package-linked GitHub repo visibility.

2. **`nxtg-ai/faultline-pro` is a private repo** — Private repos are not indexed by search engines. The only Faultline GitHub repo that surfaces is the original public Kaggle repo (`awaliuddin/Faultline`), which is outdated and not representative of the Pro platform.

3. **Content not externally published** — The comparison post (N-155), INTEGRATION.md, mutation-testing.md, and benchmark results are all in a private repo. None of this content can surface in search. The GTM-PLAN content queue (4 pieces) is designed to seed SERP but has not been published externally.

4. **Naming collisions** — FaultlineAI.com (unrelated company) and arXiv "FaultLine" (vulnerability research) both use the same name. Without published content that explicitly associates "Faultline Pro by NXTG.AI" with our feature set, we lose SERP to these results.

5. **Wrong keyword framing** — "AI claim verification" is dominated by insurance/financial use cases. "LLM hallucination detection" is dominated by model-level tools. Our differentiating terms ("claim forensics", "weakest-link detection", "output forensics") are not yet in the SERP vocabulary.

---

## Opportunities Identified

| Opportunity | Effort | Potential |
|-------------|--------|-----------|
| Publish `@nxtg/faultline` to npm (v0.4.0) | Low (pending CoS go/no-go) | HIGH — unlocks npm page, download stats, package-linked GitHub |
| Make `nxtg-ai/faultline-pro` public (or publish README as landing page) | Low | HIGH — enables search indexing |
| Publish comparison post to dev.to (N-155 draft ready) | Low | HIGH — would own "faultline vs promptfoo deepeval" SERP |
| Write "weakest-link claim detection" focused article | Medium | HIGH — novel term, no competition |
| Publish EU AI Act compliance tutorial (GTM §4 Week 3) | Medium | HIGH — "EU AI Act output verification" gap exists |
| Add Faultline explicitly to nxtg.ai/products/faultline llms.txt | Low | MEDIUM — improves AI crawler signal |
| Cite academic claim-decomposition papers in our content | Low | MEDIUM — connects us to AFEV/Loki/FACTSCORE academic conversation |
| Add `claim-detection` GitHub topic to `nxtg-ai/faultline-pro` | Trivial | MEDIUM — surfaces on GitHub topic page |

---

## Competitor Sightings

| Competitor | Query Where Found | Positioning | Gap vs Faultline |
|-----------|------------------|-------------|-----------------|
| Systima "Comply" CLI | EU AI Act compliance CLI | Codebase scanning for AI Act obligations | They scan code (input risk); we verify AI output (output forensics) — complementary, not competing |
| QWED-verification | SARIF AI verification | Deterministic verification (SymPy, Z3) for math/logic/code | They do formal verification; we do web-grounded claim forensics — different approach |
| EuConform | EU AI Act conformity assessment | Browser-based, offline, Annex IV PDF reports | They assess compliance process; we verify AI output claims — complementary |
| OpenFactCheck | Atomic fact verification CLI | Python library, modular pipeline | Closest academic-tool competitor to our CLI approach |
| Loki (COLING 2025) | Atomic decomposition | 5-step pipeline, concurrent execution | Academic system, not developer-tooling focused |

---

## Next Measurement

Schedule re-run after:
1. `@nxtg/faultline` published to npm (v0.4.0 tag)
2. Comparison post published to dev.to
3. EU AI Act tutorial published

Expected improvement: Q1/Q3/Q7 from MISS → HIT; Q4/Q5 from MISS → PARTIAL.
Target after publish + 2 content pieces: 5 HITs, 4 PARTIALs, 6 MISSes (from 2/3/10 today).
