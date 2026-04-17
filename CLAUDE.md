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
2. Document recent research in docs/ — **immediately at first discovery, not after the third recurrence**
3. Review and strengthen hollow test assertions
4. Check Portfolio Intelligence section for reuse signals
5. Update stale documentation (README, badges, CHANGELOG)

Time limit: 30 minutes. Log actions in NEXUS ## Self-Improvement Log.
Do NOT make architecture changes or add new features during self-improvement.

**Pattern documentation rule**: When a session produces a reusable pattern (mutation kill technique, test architecture, provider quirk), write it to `docs/` before closing the session. An incomplete doc that exists is more valuable than a complete doc that doesn't.

---

## CRUCIBLE Protocol (Test Quality)

This project follows the CRUCIBLE Protocol (`~/ASIF/standards/crucible-protocol.md`).
Rules that apply to this project (Critical tier — claim forensics is safety-critical):

- **Gate 2**: Non-empty assertions — data-producing tests must assert result is non-empty. If a test creates data then queries it, assert `length > 0` or exact count before checking downstream behavior.
- **Gate 4**: Delta gate — test count decreases > 5 require justification in commit message: `CRUCIBLE-G4: <reason>`. Enforced by pre-push hook.
- **Gate 6**: Mutation testing — `@stryker-mutator/core` active on claim forensics critical paths. Threshold: 80% mutation score. Configs: `stryker-cli.config.mjs`, `stryker-stream.config.mjs`, `stryker-gdpr.config.mjs`, `stryker-compliance.config.mjs`, `stryker-eu-ai-act.config.mjs`, `stryker-shell-injection.config.mjs`. See `docs/mutation-testing.md` for patterns. Current scores: `cli/scan.ts` 81.97%, `stream.ts` 88.64%, GDPR stores 80.94%–96.81%, `compliance-report.ts` 80.81% (N-210), `eu_ai_act.ts` 100% fn-level (N-211), `shell_injection_rule.ts` 80.29% (N-213) — all above threshold.
- **Gate 7**: Spec-test traceability — new integration/E2E tests must cite a NEXUS acceptance criterion via `// Validates: N-NN (...)` or `// NEXUS:` comment. **Denominator = integration/E2E test files only** (not all test files — unit tests and mutation hardening tests don't belong to acceptance criteria). Current: 7 integration/E2E files; 7/7 have spec refs (100%) after N-141. Not enforced by hook; tracked manually.
- **Oracle tier: CRITICAL** — all 4 oracle types required on claim forensics (example-based, property-based, contract, integration).

Current oracle coverage: example-based (✅ 4,492 tests), property-based (✅ 19 properties — fast-check, N-76), contract (✅ 43 Zod schema tests — N-77/N-212), integration (✅ 12 E2E tests, N-81).

## Dx3 Brain Integration
On every session start, recall relevant context from Dx3 before starting work:
- Use recall() to check for prior decisions, lessons, and patterns related to your current task
- After shipping work, use remember() to store what you learned
- The brain at dx3-cognitive MCP has context from ALL projects — use it

This is how the portfolio compounds intelligence. Your work benefits from every other team's learning.
