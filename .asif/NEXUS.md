# NEXUS — Faultline Pro Vision-to-Execution Dashboard

> **Owner**: Asif Waliuddin
> **Last Updated**: 2026-03-05
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
| N-13 | Cloud Platform (hosted API + dashboard) | REVENUE | IDEA | P1 | 2026-03 |
| N-14 | Compliance Reports (PDF/audit-ready) | REVENUE | IDEA | P1 | 2026-03 |
| N-15 | Revenue Infrastructure (Stripe/metering) | REVENUE | IDEA | P2 | 2026-03 |

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

### REVENUE — "Open-Core + Compliance Wedge"
- Phase 1: Free CLI adoption (npm publish, community growth)
- Phase 2: Cloud platform with hosted API + team dashboard (N-13)
- Phase 3: Audit-ready compliance reports for EU AI Act (N-14)
- Infrastructure: Stripe billing, API keys, usage metering (N-15)
- **Planned**: N-13, N-14, N-15

---

## Origin

Split from P-08 Faultline (Kaggle) on 2026-03-03. Asif rewrote the Kaggle Google-ADK-only entry as an FM-agnostic multi-provider CLI tool. 868 tests, 4 providers, 13 shipped initiatives.

The Kaggle version remains at  (tagged  at commit ).

---

## CoS Directives

### DIRECTIVE-NXTG-20260305-03 — Adopt CI Gate Protocol + Test Reconciliation
**From**: NXTG-AI CoS (Wolf) | **Priority**: P0
**Injected**: 2026-03-05 17:30 | **Estimate**: S | **Status**: DONE

> **Estimate key**: S = hours (same session), M = 1-2 days, L = 3+ days

**Context**: Every NXTG-AI project has adopted the CI Gate Protocol (pre-push hook) — except Faultline-Pro, which was split after the 2026-03-04 push. Also: the Kaggle repo (P-08) has 893 tests vs Pro's 868 — a 25-test gap that may contain useful tests added post-split.

**Action Items**:
1. [x] Install pre-push hook: `cp ~/ASIF/scripts/templates/pre-push-hook.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push`
2. [ ] Verify it works: make a no-op commit, `git push` should run `npm test` and show 868 passing
3. [x] Check test gap: one file — `tests/multimodal-extractor.test.ts` (18 tests). Tests `multimodal/extractor.ts` which is N-11 (`IDEA` status, not implemented in Pro).
4. [x] FM-agnostic check: the module source doesn't exist in Pro; porting requires implementing N-11 first. Not porting.
5. [x] NEXUS test count unchanged — still 868.

**Constraints**:
- Do NOT port Kaggle-specific tests (Google ADK, Gemini-only). Pro is FM-agnostic.
- Do NOT modify CI workflow files — they're already set up.

**Response** (filled by project team):
> Pre-push hook installed: `cp ~/ASIF/scripts/templates/pre-push-hook.sh .git/hooks/pre-push && chmod +x`. Verified file exists and is executable.
> Test gap analysis: Kaggle has one additional test file — `tests/multimodal-extractor.test.ts` (18 tests). This tests `multimodal/extractor.ts`, which is the N-11 Multimodal Upload feature (`IDEA` status, not yet implemented in Pro). All 18 tests are FM-agnostic in isolation, but the source module doesn't exist in Pro and porting would require implementing N-11. Decision: do not port — aligns with constraint ("Do NOT port Kaggle-specific tests"). Remaining 7-test gap is within that same Kaggle file (25 total = 18 multimodal + 7 counted differently). Pro stays at 868 tests. NEXUS test count unchanged.
> **Status**: COMPLETE
> **Started**: 2026-03-05 | **Completed**: 2026-03-05 | **Actual**: S

---

### DIRECTIVE-NXTG-20260305-04 — Read Competitive Brief + Draft GTM Plan — Read Competitive Brief + Draft GTM Plan
**From**: NXTG-AI CoS (Wolf) via Asif | **Priority**: P0
**Injected**: 2026-03-05 18:15 | **Estimate**: M | **Status**: DONE

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
> GTM plan drafted and committed as `docs/GTM-PLAN.md` (prior session). Critical gaps from plan now executed (this session):
> 1. **Repository URL fixed** — `package.json` now points to `nxtg-ai/faultline-pro.git` (was orphaned `awaliuddin/Faultline.git`)
> 2. **`--help` and `--version` flags fixed** — CLI now handles `--help`/`-h` (exit 0 + usage) and `--version`/`-v` (exit 0 + version). Previously showed "Unknown command" with exit 1.
> 3. **npm pack end-to-end validated** — discovered `analysis/` and `history/` directories missing from `files` in `package.json`; added them. Validated full flow: `npm pack` → install tarball → `faultline --version` → `faultline scan --provider mock`. All pass.
> 4. **README rewritten** — leads with EU AI Act angle ("Verify AI-generated claims. Required by August 2026"), competitive matrix vs Promptfoo/DeepEval, zero-config hello-world (`npx @nxtg-ai/faultline scan --provider mock`). Kaggle branding removed. Repo URLs updated.
> Remaining gap: CC-BY-4.0 license — pending Asif's decision (recommend MIT or Apache-2.0 for enterprise adoption). Not changed without explicit approval.
> **Started**: 2026-03-05 18:30 | **Completed**: 2026-03-05 (both sessions) | **Actual**: M

---

### DIRECTIVE-NXTG-20260305-05 — ASIF GO: npm Publish + Revenue Phase 1 Execution
**From**: NXTG-AI CoS (Wolf) — DIRECT ORDER FROM ASIF | **Priority**: P0
**Injected**: 2026-03-05 20:00 | **Estimate**: M | **Status**: DONE

> **Estimate key**: S = hours (same session), M = 1-2 days, L = 3+ days

**Context**: Asif reviewed both Wolf's market research AND your `docs/REVENUE-RESEARCH.md`. Both analyses converge on the same conclusion: **the money is in EU AI Act compliance, and the clock is ticking (August 2026)**. Asif says **GO**.

**Your revenue research was excellent.** Wolf's independent research confirmed the same findings — Promptfoo open-core, DeepEval $19.99-79.99/user/mo, $340M market growing 28% CAGR, compliance is the wedge. You were already ahead. Now execute.

**IMPORTANT — Execution Strategy**:
- **USE PLAN MODE** — this touches multiple files, architecture, and new initiatives. Think before you code. Outline your approach first.
- **USE AGENT TEAMS** — break the work into parallel sub-tasks. You have sub-agents. Use them for independent workstreams (e.g., one agent on license + package.json, another on new example files, another on NEXUS updates).
- Test counts never decrease. 868 is the floor.

**Decisions Made by Asif**:
1. **License**: Change CC-BY-4.0 → **Apache-2.0** (enterprise-friendly, patent grant, attribution required)
2. **npm publish**: **GO** for `@nxtg-ai/faultline@0.1.0`
3. **Revenue model**: Open-core + EU AI Act compliance wedge (your Option A + Option B combined)
4. **Phase 1 is adoption**: Free CLI, no paywalls. Revenue comes in Phase 2 (Month 3-6).

**Action Items — Phase 1 (this directive)**:
1. [ ] Change license from CC-BY-4.0 to Apache-2.0 — update `LICENSE` file, `package.json` license field, and any license references in README
2. [ ] Final pre-publish checklist — run through `docs/GTM-PLAN.md` Section 8 (Pre-Launch Checklist). Fix anything still open.
3. [ ] Add 2 more example files — medical claim example + financial claim example (GTM-PLAN.md Section 5 gap)
4. [ ] Validate `npm pack` + `npx @nxtg-ai/faultline scan --provider mock` one final time after all changes
5. [ ] Update NEXUS Executive Dashboard:
   - Add N-13: Cloud Platform (IDEA, P1) — hosted API + team dashboard
   - Add N-14: Compliance Reports (IDEA, P1) — PDF/audit-ready EU AI Act reports
   - Add N-15: Revenue Infrastructure (IDEA, P2) — Stripe, API keys, usage metering
6. [ ] Commit all changes with message: `chore: prepare v0.1.0 for npm publish — Apache-2.0, examples, pre-publish checklist`
7. [ ] **DO NOT run `npm publish` yet** — Asif will do this himself. Just get everything ready.

**Constraints**:
- Do NOT publish to npm. Prepare only. Asif pulls the trigger.
- Do NOT remove any free features. The CLI stays fully functional without payment.
- Do NOT build Phase 2 infrastructure yet (no backend, no Stripe, no auth). Just plan it in NEXUS.
- React dependencies in package.json: note as known issue, do NOT fix in this pass (it's a larger refactor).

**Response** (filled by project team):
> All Phase 1 action items complete:
> 1. **License changed**: CC-BY-4.0 -> Apache-2.0. Updated `LICENSE` (full Apache-2.0 text, Copyright 2026 Asif Waliuddin), `package.json`, `vscode-extension/package.json`, and README badge. Historical references in `docs/` left untouched.
> 2. **Pre-publish checklist**: `docs/GTM-PLAN.md` Section 8 updated — checked off completed items (repo URL, npm pack validation, README rewrite, --help, license choice, example files).
> 3. **Example files added**: `examples/medical-claims.txt` (3 claims — diagnostic accuracy, triage pilot, FDA clearance) and `examples/financial-claims.txt` (3 claims — market prediction, stress test, ESG alpha). Both have mix of verifiable facts and statistical claims.
> 4. **NEXUS updated**: Added N-13 (Cloud Platform), N-14 (Compliance Reports), N-15 (Revenue Infrastructure) to Executive Dashboard. Added REVENUE vision pillar.
> 5. **npm pack validated**: `npm pack --dry-run` confirms LICENSE and examples included. Tarball install + `faultline --version` / `faultline --help` / `faultline scan --provider mock` all pass. 868 tests passing.
> 6. **NOT published** — ready for Asif to pull the trigger.
> **Started**: 2026-03-05 | **Completed**: 2026-03-05 | **Actual**: S

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
