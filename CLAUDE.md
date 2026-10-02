# CLAUDE.md — Faultline

## Operating Runbook (read first)

Deploy, release, cross-repo PR, secrets, live probes and UAT steps: **`docs/runbooks/fp-operating-runbook.md`**. Read it before shipping, deploying or releasing; update it in the same change when you learn something new.

## Voice Identity
**Voice**: `bm_fable`
**Service**: http://100.123.83.34:8880/v1/audio/speech
**Registry**: ~/ASIF/standards/portfolio-voice-registry.md
**Use**: every cycle-complete, every P0/P1 completion, every directive response.
**Wrapper**: `./scripts/speak` (project-local; always uses `bm_fable`). Rationale: Authoritative British — EU AI Act compliance voice.

## Project Overview

Faultline is a forensic AI claim verification product. It extracts atomic claims from AI-generated text, verifies each against live web evidence, and returns a risk scorecard. Positioning line: "We check the receipts on AI output."

This repo is the **monorepo** (`faultline-pro`, workspaces `packages/*`). It began as a Kaggle entry (React + Vite, Gemini only). That app survives as `packages/web`. The product is now the CLI, the API and the MCP server.

**NEXUS**: `.asif/NEXUS.md`. **State checked 2026-10-02**: CLI `@nxtg/faultline` 0.11.1 on npm, release stage **alpha** (`packages/cli/cli/release-stage.ts`, dx3-pm owns the value); hosted API `https://faultline-api.fly.dev` reports 0.11.1 and `stage`; web app https://faultline.nxtg.ai is a **separate repo** (`faultline-web`, Next.js on Vercel).

## Packages

| Path | What it is |
|---|---|
| `packages/cli` | `@nxtg/faultline`, the published CLI and the scan engine (extract, verify, synthesize, consensus, providers, compliance, rules) |
| `packages/api` | `@nxtg/faultline-api`, Fastify v5 REST API, deployed on Fly (`faultline-api`). Not published to npm |
| `packages/mcp` | `@nxtg/faultline-mcp` 0.1.0, MCP server with a `verify_claims` tool. Not on npm as of 2026-10-01 |
| `packages/terraform-provider` | Go Terraform provider |
| `packages/web` | `@nxtg/faultline-web`, the original React/Vite visualization app (Kaggle origin) |
| `sdks/python` | Python client source (pyproject name `faultline-sdk`). The PyPI name `faultline-sdk` belongs to an unrelated project, so do not tell users to `pip install faultline-sdk` |

## Tech Stack

- TypeScript (ESM), Node, `tsx` at runtime (the published CLI ships TypeScript sources)
- API: Fastify v5, Fly.io (`packages/api/fly.toml`, app `faultline-api`, region `lax`). **One machine plus the `faultline_ledgers` volume at `/var/log/faultline`** so the spend and grounding ledgers survive deploys (`docs/ledger-volume.md`). No `flyctl` login on NXTG-AI: Fly changes go through `.github/workflows/fly-ops.yml`
- Providers: Gemini (grounded with googleSearch), OpenAI, Claude, Perplexity, Mock
- Tests: Vitest (root `npm test` runs all packages), fast-check, Stryker; `pytest` for the Python SDK
- Web app (separate repo): Next.js, Clerk, Stripe, Vercel

## Development Commands

```bash
npm install                      # install all workspaces
npm test                         # vitest run, everything (5,053 tests, 230 files, 2026-10-02; root vitest.config.ts lists the 4 package projects)
npx vitest run                   # inside a package dir to run just that package
npm run version-parity           # 4-way version gate: repo:cli, repo:api, npm:latest, deployed:fly
npm run dev --workspace=packages/api   # API on http://localhost:3010 (PORT default 3010; fly.toml sets 3000)
node packages/cli/bin/faultline.js scan --input doc.txt --provider mock   # CLI from source
cd sdks/python && python3 -m pytest -q          # Python SDK tests (100)
```

## Architecture

Four-phase pipeline in `packages/cli`: **Extract** (atomic claims), **Verify** (per-claim verdict plus confidence, grounded on Gemini), **Synthesize** (risk scorecard, weakest link, EU AI Act mapping), **Refine** (critique and improved prompt). The CLI picks its transport by credential: `FAULTLINE_API_KEY` set means run on the hosted API; otherwise run in-process on the caller's own provider key. With neither, it reports that nothing was checked (it never invents a verdict).

The API wraps the same engine and adds gates in front of a scan. They are different controls with different status codes:

| Gate | Code | Status |
|---|---|---|
| `rateLimitScan`, per key per minute (free 10, pro 100, admin 10,000) | 429 | on |
| `enforceMonthlyCap`, per-key monthly scan quota (`FAULTLINE_USAGE_CAP`) | 402 | dormant |
| `enforceProviderSpendCap`, fleet $100/month at providers (`FAULTLINE_PROVIDER_SPEND_CAP`) | 503 | **dormant in prod** (`GET /usage` showed `providerBudget.enforced=false`, 2026-10-01); the ledger records regardless |
| `enforceConsensusEntitlement`, `pipelineConfig.consensus:true` | 403 `consensus_not_in_plan` | **enforced**, Enterprise only (live-verified 2026-10-01) |

`POST /critique` sits behind the API key, the burst limiter and the spend cap, and its usage is ledgered (b33acff). Plan limits shown to customers (Free 5, Personal 100, Pro 500 scans per month, Enterprise custom) live in `faultline-web` and are read from https://faultline.nxtg.ai/pricing.

## Key Files

- `packages/cli/cli/index.ts`: command router (`scan`, `guard`, `report`, `watch`, `critique`, `graph`, `weakest`, `compare`, `compliance-report`, `stream`, `history`, `trend`, `scans`, `keys`, `stats`, `init`, ...)
- `packages/cli/cli/transport.ts`: hosted-or-local selection by credential
- `packages/cli/cli/scan.ts`: the scan pipeline entry
- `packages/cli/consensus/`: multi-model consensus engine
- `packages/cli/providers/`: provider adapters and registry
- `packages/api/src/server.ts`: route and plugin registration
- `packages/api/src/routes/scan.ts`, `stream.ts`, `critique.ts`: the paid-LLM routes
- `packages/api/src/plugins/`: `auth`, `ratelimit`, `usage-cap`, `provider-spend-cap`, `consensus-entitlement`
- `packages/api/src/store/provider-spend.ts`: append-only USD ledger (the ledger is the authority; the in-memory total is hydrated from it)
- `packages/mcp/src/server.ts`: MCP server
- `scripts/measure-consensus-cost.ts`, `scripts/version-parity.mjs`: cost measurement, release parity gate
- `docs/provider-spend-cap.md`, `docs/usage-cap.md`, `docs/INTEGRATION.md`: gate and API docs

## Important Notes

- **Docs rule**: a number in a doc must come from a run or a cited file. State "not re-measured since <date>" rather than guess. Mutation scores below are an example.
- **Never use `x-user-tier` for a money or entitlement decision on its own.** It is caller-supplied. Only the server's own `FAULTLINE_API_KEY` (held by faultline-web) may forward it (`consensus-entitlement.ts`, ae4987a).
- **There is no BYOK path through the API.** Provider keys come only from server env, so every API scan and critique spends Faultline's keys.
- **Consensus is Enterprise only.** Free, Personal and Pro run the non-consensus default (provider `gemini`, `consensus:false`); cost in `docs/unit-economics-prod-default-2026-09-30.md`.
- **The npm version is the CLI's.** Bumping `packages/cli/package.json` triggers the Release Protocol section below.
- **Deploy**: API deploys to Fly through GitHub Actions. Do not tag, publish or roll CHANGELOG `[Unreleased]` outside a release.

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

**Key constraint**: Do NOT touch `git stash@{0}`. It was described as holding the FM-agnostic version (future P-08b). `git stash list` was empty on 2026-10-01, so that stash no longer exists in this clone; the rule stands if it reappears.

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
- **Gate 6**: Mutation testing — `@stryker-mutator/core` active on claim forensics critical paths. Threshold: 80% mutation score. Configs: `stryker-cli.config.mjs`, `stryker-stream.config.mjs`, `stryker-gdpr.config.mjs`, `stryker-compliance.config.mjs`, `stryker-eu-ai-act.config.mjs`, `stryker-shell-injection.config.mjs`. See `docs/mutation-testing.md` for patterns. Scores from `docs/mutation-testing.md`: `cli/scan.ts` 81.97% (2026-03-21), `stream.ts` 88.64% (2026-04-17), GDPR stores 80.94%–96.81% (2026-03-21), `compliance-report.ts` 80.81% (N-210, 2026-04-04), `eu_ai_act.ts` 100% fn-level (N-211, 2026-04-04), `shell_injection_rule.ts` 80.29% (N-213, 2026-04-04). **Last measured 2026-03-21 to 2026-04-17 (config commit dates and the doc's own dates). Stryker was not re-run on 2026-10-01**, and `stream.ts`, `scan.ts` and others have changed since, so treat these as stale until re-run.
- **Gate 7**: Spec-test traceability — new integration/E2E tests must cite a NEXUS acceptance criterion via `// Validates: N-NN (...)` or `// NEXUS:` comment. **Denominator = integration/E2E test files only** (not all test files). Re-counted 2026-10-01 by filename (`*e2e*`, `*integration*`, `integration/*`): 9 files, 9 of 9 contain a `Validates:` or `NEXUS:` line. This checks that a reference line exists, not that it names the right criterion. Not enforced by hook; tracked manually.
- **Oracle tier: CRITICAL** — all 4 oracle types required on claim forensics (example-based, property-based, contract, integration).

Current oracle coverage (re-measured 2026-10-01): example-based: 5,053 JS/TS tests passing across 230 files (api 2,586; cli 2,379; mcp 49; web 39; re-measured 2026-10-02), plus 100 Python SDK tests; property-based: 29 `fc.assert` calls in 2 files (`packages/cli/tests/property-based.test.ts` 19, `packages/api/tests/property.test.ts` 10); contract: `packages/cli/tests/contract.test.ts`, 39 static `it(` declarations (the older figure of 43 Zod tests was not reproduced); integration: 9 integration/E2E files, 115 static `it(`/`test(` declarations. Static counts are declarations, not run counts.

## Release Protocol Enforcement (ASIF Standard, ADR-036)

When you bump the version in `packages/cli/package.json` (the published `@nxtg/faultline`):
1. **Tag**: `git tag vX.Y.Z && git push origin vX.Y.Z`
2. **GH Release**: `gh release create vX.Y.Z --notes-from-tag` (or with CHANGELOG section)
3. **Publish**: `gh workflow run publish.yml --ref vX.Y.Z` (GitHub OIDC trusted publishing; never `npm publish` locally) — verify with `npm view @nxtg/faultline version`
4. **CHANGELOG**: roll `[Unreleased]` → `[vX.Y.Z] — YYYY-MM-DD` in CHANGELOG.md
5. **Docs**: update any pinned version references in README.md / docs

If you bump the version but skip steps 1–5, you've broken the release train. The Wolf-loop sense pass surfaces drift portfolio-wide; the daily `release-protocol-check.yml` action opens a `release-drift` issue. Atomic releases or no version bump.

**Origin incident**: 2026-04-29 13:32 PDT — Worker shipped to production with v0.5.3 in repo, but npm at v0.5.2, no tag, no release, CHANGELOG `[Unreleased]`. Asif caught it. DIRECTIVE-NXTG-20260429-02 closed the gap. ADR-036 prevents recurrence.

**Bypass (EMERGENCY ONLY)**: `git push --no-verify` — and document the bypass in NEXUS or HANDOFF.

## Dx3 Brain Integration
On every session start, recall relevant context from Dx3 before starting work:
- Use recall() to check for prior decisions, lessons, and patterns related to your current task
- After shipping work, use remember() to store what you learned
- The brain at dx3-cognitive MCP has context from ALL projects — use it

This is how the portfolio compounds intelligence. Your work benefits from every other team's learning.

<!-- ASIF:TEAM-ALIGNMENT-WIRING:START -->
## ASIF Alignment Wiring

@/home/axw/ASIF/standards/claude-team-alignment-wiring.md

- Team alignment id: `fp`.
- Cross-team room: `/alignment`, written through `~/ASIF/scripts/alignment-say`.
- If an `[ALIGNMENT ...]` message appears, respond through `alignment-say`; do not answer only in this private TUI.
- Deterministic state first: typed Dx3/asifctl, `.asif/NEXUS.md`, git/tests/runtime probes. Prose is backup and local steering only.
<!-- ASIF:TEAM-ALIGNMENT-WIRING:END -->
