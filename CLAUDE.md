# CLAUDE.md — Faultline

## Project Overview

Faultline is a forensic AI claim verification platform. It extracts atomic claims from AI-generated text, verifies them against live web data, and presents a risk scorecard.

**Origin**: Kaggle competition entry using Google AI Studio (Gemini 3 Pro).
**NEXUS**: `.asif/NEXUS.md` (12 initiatives, 5 vision pillars)

## Tech Stack

- React 19, TypeScript, Vite, Tailwind CSS
- `@google/genai` (Gemini 3 Pro) — extraction + verification
- Google Custom Search API — web grounding
- Express.js (optional backend proxy for API key security)
- Vitest (testing, minimal coverage)

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server
npm run build        # Production build
npm test             # Run Vitest
```

## Architecture

4-phase pipeline:
1. **Extract** — Gemini JSON schema decomposes text into atomic claims (type, importance, dependencies)
2. **Verify** — Per-claim verification via Google Search + LLM verdict engine
3. **Synthesize** — Risk scorecard (Low/Medium/High/Critical) with seismic barometer
4. **Refine** — Generate improved prompts that force rigor

## Key Files

- `services/geminiService.ts` — All LLM logic (extraction, verification, synthesis). Hardcoded to Gemini 3 Pro.
- `App.tsx` — Pipeline orchestration, state management, API key handling
- `components/Dashboard.tsx` — Risk scorecard + seismic barometer visualization
- `types.ts` — Claim, VerificationResult, AnalysisState types

## Important Notes

- This repo is the **Kaggle competition entry** — it intentionally uses only Google AI Studio
- An FM-agnostic version exists in `git stash@{0}` (see ASIF PORTFOLIO.md P-08b)
- The stash contains multi-provider support (Google/OpenAI/Anthropic/Local), performance modes, and claim graph support
- Do NOT merge the stash into this repo — it will become a separate project (Faultline Pro)

---

## ASIF Governance

This project is **P-08** in the ASIF portfolio (AI Trust & Safety vertical). It is governed by the ASIF Chief of Staff.

**On every session**:
1. Read `.asif/NEXUS.md` — check the `## CoS Directives` section at the bottom
2. Execute any **PENDING** directives before other work (unless Asif explicitly overrides)
3. Write your response inline under each directive's `**Response**` section
4. Update initiative statuses in NEXUS if your work changes them
5. If you have questions for the CoS, add them under `## Team Questions` in NEXUS

## Execution Strategy
For any directive that touches 3+ files or requires architectural decisions:
1. USE PLAN MODE — think before you code. Outline your approach first.
2. USE AGENT TEAMS — break complex work into parallel sub-tasks. You have sub-agents. Use them.
3. Test everything. Test counts never decrease.
Do NOT skip planning on complex directives. Plan mode and agent teams are your super-powers.

**Escalation via Team Questions**: When you hit a blocker, need an architecture review, or have a portfolio-level question, add it under `## Team Questions` in your `.asif/NEXUS.md`. Your CoS checks these 3x daily during scheduled enrichment cycles and will respond inline or issue follow-up directives.

**Key constraint**: Do NOT touch `git stash@{0}`. It contains the FM-agnostic version (future P-08b).

## Idle Time Protocol
When no directives are pending and no active work exists:
1. Run CRUCIBLE Gates 1-7 self-audit on your test suite
2. Document recent research in docs/research/
3. Review and strengthen hollow test assertions
4. Check Portfolio Intelligence section for reuse signals
5. Update stale documentation (README, badges, CHANGELOG)

Time limit: 30 minutes. Log actions in NEXUS ## Self-Improvement Log.
Do NOT make architecture changes or add new features during self-improvement.

---

## CRUCIBLE Protocol (Test Quality)

This project follows the CRUCIBLE Protocol (`~/ASIF/standards/crucible-protocol.md`).
Rules that apply to this project (Critical tier — claim forensics is safety-critical):

- **Gate 2**: Non-empty assertions — data-producing tests must assert result is non-empty. If a test creates data then queries it, assert `length > 0` or exact count before checking downstream behavior.
- **Gate 4**: Delta gate — test count decreases > 5 require justification in commit message: `CRUCIBLE-G4: <reason>`. Enforced by pre-push hook.
- **Gate 6**: Mutation testing (future) — `@stryker-mutator/core` on claim forensics critical paths. Threshold: 60% mutation score.
- **Gate 7**: Spec-test traceability (future) — new integration tests must cite a NEXUS acceptance criterion.
- **Oracle tier: CRITICAL** — all 4 oracle types required on claim forensics (example-based, property-based, contract, integration).

Current oracle coverage: example-based (✅ 3,586 tests), property-based (✅ 19 properties — fast-check, N-76), contract (✅ 29 Zod schema tests — N-77), integration (✅ partial).
