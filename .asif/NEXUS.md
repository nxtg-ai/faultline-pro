# NEXUS — Faultline Pro Vision-to-Execution Dashboard

> **Owner**: Asif Waliuddin
> **Last Updated**: 2026-03-03
> **North Star**: FM-agnostic AI Trust & Safety — verify any LLM's claims, with any provider, no vendor lock-in.

---

## Executive Dashboard

| ID | Initiative | Pillar | Status | Priority | Last Touched |
|----|-----------|--------|--------|----------|-------------|
| N-01 | Multi-Provider Pipeline | PROVIDER | SHIPPED | P0 | 2026-02 |
| N-02 | CLI Tool (scan/report/watch/critique) | DEVELOPER-X | SHIPPED | P0 | 2026-02 |
| N-03 | EU AI Act Compliance Module | COMPLIANCE | SHIPPED | P1 | 2026-02 |
| N-04 | SARIF + VS Code Extension | DEVELOPER-X | SHIPPED | P1 | 2026-02 |
| N-05 | Rules Engine (PII/bias/toxicity) | FORENSIC | SHIPPED | P1 | 2026-02 |
| N-06 | Confidence Calibration | FORENSIC | SHIPPED | P1 | 2026-02 |
| N-07 | Claim Graph Visualization | FORENSIC | SHIPPED | P1 | 2026-02 |
| N-08 | Weakest-Link Detection | FORENSIC | SHIPPED | P1 | 2026-02 |
| N-09 | Critique + Improved Prompt | SYNTHESIS | SHIPPED | P1 | 2026-02 |
| N-10 | npm Package + GitHub Action | DISTRIBUTION | SHIPPED | P1 | 2026-02 |
| N-11 | Multimodal Upload (PDF/OCR) | MULTIMODAL | IDEA | P2 | 2026-02 |
| N-12 | Enterprise Features (SSO/audit) | ENTERPRISE | IDEA | P2 | — |

---

## Vision Pillars

### PROVIDER — "No Vendor Lock-In"
- Multi-provider abstraction: Gemini, OpenAI, Claude, Mock, local
- Provider registry with runtime switching
- **Shipped**: N-01

### FORENSIC — "Deep Claim Analysis"
- Confidence scoring, claim graphs, weakest-link detection
- Rules engine: PII, bias, toxicity, custom
- **Shipped**: N-05, N-06, N-07, N-08

### DEVELOPER-X — "Instant Integration"
- CLI, SARIF output, VS Code extension, GitHub Action
- Watch mode, batch scanning, config system
- **Shipped**: N-02, N-04, N-10

### COMPLIANCE — "Regulation Ready"
- EU AI Act risk classification
- **Shipped**: N-03

### SYNTHESIS — "Not Just Finding, Fixing"
- Critique of reasoning gaps + improved prompt generation
- **Shipped**: N-09

---

## Origin

Split from P-08 Faultline (Kaggle) on 2026-03-03. Asif rewrote the Kaggle Google-ADK-only entry as an FM-agnostic multi-provider CLI tool. 868 tests, 4 providers, 13 shipped initiatives.

The Kaggle version remains at  (tagged  at commit ).

---

## CoS Directives

### DIRECTIVE-NXTG-20260305-03 — Adopt CI Gate Protocol + Test Reconciliation
**From**: NXTG-AI CoS (Wolf) | **Priority**: P0
**Injected**: 2026-03-05 17:30 | **Estimate**: S | **Status**: PENDING

> **Estimate key**: S = hours (same session), M = 1-2 days, L = 3+ days

**Context**: Every NXTG-AI project has adopted the CI Gate Protocol (pre-push hook) — except Faultline-Pro, which was split after the 2026-03-04 push. Also: the Kaggle repo (P-08) has 893 tests vs Pro's 868 — a 25-test gap that may contain useful tests added post-split.

**Action Items**:
1. [ ] Install pre-push hook: `cp ~/ASIF/scripts/templates/pre-push-hook.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push`
2. [ ] Verify it works: make a no-op commit, `git push` should run `npm test` and show 868 passing
3. [ ] Check test gap: `diff <(cd ~/projects/Faultline && find tests -name "*.test.*" | sort) <(cd ~/projects/Faultline-Pro && find tests -name "*.test.*" | sort)` — identify which 25 tests exist in Kaggle but not Pro
4. [ ] If any tests are FM-agnostic (not Kaggle/Google-ADK-specific), port them to Pro
5. [ ] Update NEXUS test count if it changes

**Constraints**:
- Do NOT port Kaggle-specific tests (Google ADK, Gemini-only). Pro is FM-agnostic.
- Do NOT modify CI workflow files — they're already set up.

**Response** (filled by project team):
>

---

### DIRECTIVE-NXTG-20260305-04 — Read Competitive Brief + Draft GTM Plan — Read Competitive Brief + Draft GTM Plan
**From**: NXTG-AI CoS (Wolf) via Asif | **Priority**: P0
**Injected**: 2026-03-05 18:15 | **Estimate**: M | **Status**: PENDING

> **Estimate key**: S = hours (same session), M = 1-2 days, L = 3+ days

**Context**: Wolf completed a competitive landscape analysis for Faultline Pro. Asif has reviewed it and wants this team to internalize the findings and come up with a GTM plan.

**Action Items**:
1. [ ] Read the competitive brief: `~/ASIF/enrichment/2026-03-05-faultline-pro-competitive-brief.md`
2. [ ] Understand the competitive landscape:
   - **Promptfoo** ($23.6M funded, 100K devs): Tests prompts via YAML configs. Open-core. npm distributed.
   - **DeepEval** (YC-backed, 13K stars, 3M monthly downloads): "Pytest for LLMs." Python-only. RAG metrics.
   - **Neither competitor does claim-level forensics, confidence calibration, weakest-link detection, or EU AI Act compliance.**
3. [ ] Draft a GTM plan covering:
   - **Positioning**: "AI Claim Forensics" — how to differentiate from prompt testing tools
   - **npm package**: What should `@nxtg-ai/faultline` README lead with? (Wolf recommends EU AI Act angle)
   - **First 30 days post-publish**: Where to announce (HN, Reddit r/MachineLearning, AI safety communities)?
   - **Content strategy**: What blog posts, comparison guides, or demos would drive adoption? (Coordinate with content-engine P-14)
   - **Developer experience**: What's the "hello world" for a new Faultline user? `npx faultline scan "claim"` → instant value
   - **EU AI Act positioning**: How to become THE tool teams reach for when auditing AI claims for August 2026 compliance
4. [ ] Identify gaps: What features are missing for a credible v0.1.0 npm launch? (Red teaming depth? Docs? Examples?)
5. [ ] Write the plan as `docs/GTM-PLAN.md` in this repo

**Constraints**:
- This is a PLAN, not execution. Do not publish anything yet.
- Do NOT copy Promptfoo's approach (prompt A/B testing). Own the "claim forensics" lane.
- Coordinate content ideas with P-14 (nxtg-content-engine) but don't block on them.
- The npm publish decision is Asif's. Your job is to make the plan so good he says GO.

**Response** (filled by project team):
> GTM plan drafted and committed as `docs/GTM-PLAN.md`. Covers: positioning ("AI Claim Forensics" — claims vs prompts differentiation), npm package strategy (README lead with EU AI Act angle, hello-world via `--provider mock`), launch day plan (HN Show HN + Reddit r/MachineLearning + r/artificial + r/ExperiencedDevs + r/europrivacy), 30-day content calendar (comparison post Week 2, EU AI Act guide Week 3, GitHub Action tutorial Week 4, P-14 coordination), gap analysis (10 critical/important items identified — repository URL, stale README, React deps in CLI package, no --help flag, CC-BY-4.0 license question, npx end-to-end validation needed), and metrics targets (100 npm downloads/week at 30 days, 50 GitHub stars). Pre-launch checklist included with 10 action items for Asif's review before GO decision.
> **Started**: 2026-03-05 18:30 | **Completed**: 2026-03-05 19:00 | **Actual**: S

---

## Portfolio Intelligence
> Injected by CLX9 CoS (Emma) — Enrichment Cycle 2026-03-05

- **npm publish**: Decision pending with Asif. **Competitive brief delivered**: `~/ASIF/enrichment/2026-03-05-faultline-pro-competitive-brief.md`. Wolf recommends GO.
- **Market opportunity**: $15.7B deepfake detection market. EU AI Act high-risk deadline **August 2026**.
- **Primary competitor**: Promptfoo — $23.6M funded (Insight Partners + a16z), 100K+ devs, 5.6K GitHub stars. Tests PROMPTS not CLAIMS.
- **Secondary competitor**: DeepEval (Confident AI) — YC-backed, 13K stars, 3M monthly downloads. Python-only. Tests RAG metrics, not trust forensics.
- **Faultline Pro's moat**: Claim-level forensics (graphs, confidence calibration, weakest-link detection) + EU AI Act compliance module. Nobody else has this combination.
- **Positioning**: "AI Claim Forensics" — NOT "another prompt testing tool." Avoid Promptfoo's and DeepEval's lanes.
- **Provider architecture**: 4 providers (Gemini/OpenAI/Claude/Mock) is a competitive differentiator.
- **Orphan repo**: `awaliuddin/Faultline-Pro` still exists on GitHub (cannot delete without `delete_repo` scope). Ignore it.

---

## Team Questions

_(Add questions for ASIF CoS here.)_

---

## Changelog

| Date | Change |
|------|--------|
| 2026-03-03 | Created. Split from P-08 by Emma (CLX9 Sr. CoS). 868 tests, 13/15 initiatives SHIPPED. |
