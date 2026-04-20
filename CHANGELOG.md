# Changelog

All notable changes to Faultline Pro are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Ops

- fly.dev redeployment (2026-04-20): `POST /scan/stream` now live in production — deployed SHA `8a726b0` (includes `b9ccd5a` / v0.5.4). Was missing since `b9ccd5a` merged; production was running older image. Verified: `POST https://faultline-api.fly.dev/scan/stream` returns 401 (auth gate), not 404.
- Default provider mock→openai (2026-04-20, commit `b045803`): `stream.ts`, `scan.ts`, `diff.ts`, `bulk.ts` — missing/unknown provider now falls back to `openai` instead of `mock`. Explicit `provider:"mock"` still works. UI path now returns real LLM verdicts; MockProvider eliminated from all default call paths. 4,492 tests GREEN.
- fly.dev secrets (2026-04-20): set `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` on production. MockProvider eliminated. **OpenAI (`provider=openai`) is fully functional in production** — use for Show HN demo. Gemini path blocked by free-tier quota (Asif: enable billing on AI Studio key). Claude path blocked by `400` / model ID bug in `claude_provider.ts` (post-launch fix needed). Production secrets: `FAULTLINE_API_KEY`, `NODE_ENV`, `OPENAI_API_KEY` ✅, `GEMINI_API_KEY` ⚠️, `ANTHROPIC_API_KEY` ⚠️.

### Added

- N-217/218/219 (commit `c845c63`, 2026-04-16): EU AI Act compliance evidence layer — Art. 9/12/14 API endpoints:
  - Art. 9 — `POST /scan/risk-register`: structured risk register aggregating all scan history by lifecycle phase (development/testing/deployment/monitoring); riskDistribution, highRiskCount, criticalRiskCount, per-scan findings. 14 tests (RR1–RR14).
  - Art. 12 — `GET /audit/log/manifest`: SHA-256 chained-hash manifest; chainHash(n) = SHA-256(entryHash(n) + chainHash(n-1)); rootHash covers entire log; verifiable by third-party auditors using `openssl dgst -sha256` without Faultline tooling. 13 tests (AM1–AM13).
  - Art. 14 — `POST /scans/:id/approve` + `GET /scans/:id/approvals`: human sign-off record with approver identity, decision (approved/rejected), UTC timestamp, optional note; immutable once recorded. 19 tests (AP1–AP19).

## [v0.5.4] — 2026-04-16

### Added

- FR-1 (N-221): `POST /scan/stream` — same SSE event sequence as `GET /scan/stream` but accepts a JSON body, removing the ~2KB querystring ceiling. Supports `pipelineConfig` (FR-3). Event sequence: `start` → N × `claim_verified` → `complete`, `error` on failure. Existing `GET /scan/stream` and `POST /scan` unchanged. API: 0.5.1→0.5.2. 10 tests (SPP1–SPP10).

---

## [v0.5.3] — 2026-04-16

### Added

- FR-3 (N-220): Per-stage model routing (`PipelineConfig`) — optional `pipelineConfig` in `POST /scan` request body lets callers specify distinct providers for extraction and verification stages. Falls back to `provider` field if absent; backward-compatible. `synthesisProvider` accepted for forward compatibility (no-op in current API pipeline — requires FR-1 POST /scan/stream). Missing API key returns `{"error":"provider_not_configured","provider":"..."}`. Invalid provider name returns 400. 7 tests (PC1–PC7). CLI: 0.5.2→0.5.3, API: 0.5.0→0.5.1.

---

## [v0.5.2] — 2026-04-15

### Fixed

- Cold install — `plugins/` directory missing from `files` array in `packages/cli/package.json`. Caused `ERR_MODULE_NOT_FOUND: plugins/loader.js` on any fresh npx/global install. Fixed by adding `"plugins/"` to the published file list.

---

## [v0.5.1] — 2026-04-15

### Fixed

- Cold install / npx failure — `bin/faultline.js` used `--import tsx` (bare specifier), which Node.js resolves from CWD. In a fresh npx install where tsx is not in the user's working directory, this caused `ERR_MODULE_NOT_FOUND`. Fix: use `createRequire(import.meta.url)` to resolve tsx relative to the package's own install directory, then pass the absolute `file://` URL to `--import`. VERSION constant in `cli/index.ts` also corrected 0.4.0 → 0.5.1.

---

### Added

- N-215: Gemini calibration prompt hardening — multi-point `CALIBRATION RULE` replaces single-sentence rule in `verifyClaim()` prompt (CLI + web `geminiService.ts`); 7-condition "use mixed when" list covering: conflicting meta-analyses, dose-dependent effects, IARC/WHO/FDA Group 2A/2B partial classifications, population-dependent effects, contested peer-reviewed consensus; explicit "when in doubt between contradicted and mixed, always choose mixed" tie-breaker; fixes B3 overconfidence failure (IARC Group 2A hot-beverages classification returned `contradicted` instead of `mixed`); 5 prompt-integrity + behavioral tests in `gemini-service-hardening.test.ts` (CAL-1–CAL-5)

### Fixed

- Compliance calendar staleness — added `eu-ai-act-annex-i-2027` deadline (2027-08-02, severity: high) for EU AI Act full application to Annex I regulated products (medical devices, machinery, aviation). Previous `getUpcoming()` returned 0 results when queried after 2026-08-02 since the only remaining future deadline was missing. CC13 expected count updated 5→6.

### Maintenance

- Dependency updates (2026-04-12, `npm update --workspaces`): `@google/genai` 1.32.0→1.49.0, `vitest` 4.0.18→4.1.4, `@vitest/coverage-v8` 4.0.18→4.1.4, `@types/node` 22.19.2→22.19.17, `@vitejs/plugin-react` 5.1.2→5.2.0, `vite` 6.4.1→6.4.2, `react`/`react-dom` 19.2.1→19.2.5, `adm-zip` 0.5.16→0.5.17, `graphql` 16.13.1→16.13.2, `mercurius` 16.8.0→16.9.0, `@stryker-mutator/core`+`vitest-runner` 9.6.0→9.6.1. Post-update: 4,403/188 GREEN, `npm audit` 0 vulnerabilities. Major-version bumps (TypeScript 6, Vite 8, `@fastify/multipart` 10, `tesseract.js` 7, `lucide-react` 1.x, `pdf-parse` 2.x, `jsdom` 29) deferred to N-216.

---

## [v0.5.0] — 2026-04-15

### Added

- N-214: `faultline stats` CLI command — fetches last-week npm download counts for `@nxtg/faultline` and `@nxtg/faultline-sdk` via npmjs.org API; weekly snapshots persisted in `.faultline/stats-snapshots.json` (52-week ring, dedup by periodEnd); WoW trend arrows (▲/▼/──); flags: `--no-save`, `--package`, `--snapshot-path`; partial-success handling; 34 tests (ST-F/L/S/T/R/C/I)

- N-204: EU AI Act compliance sprint — Art. 6 (Classification Rules for High-Risk AI Systems), Art. 15 (Accuracy/Robustness/Cybersecurity) evidence blocks; Art. 50(4) PLACEHOLDER resolved to `not-applicable` when no opinion/GPAI signals present; 10 articles in `articleEvidence` (was 7); 11 tests
- N-205: `testCategoryMappings` missing Art. 10/11/12 cross-references — `buildTestCategoryMappings()` extended with `ruleFindings` 3rd param; bias→Art.10(2), high-importance-unverified→Art.10(3), documented-claims→Art.11, structured-metadata→Art.12; 8 tests
- N-206: `annexApplicable` logic blind to Art. 6 evidence — medium-risk scans with Annex III domain content (biometric/employment/etc.) now trigger the conformity checklist; `annex-iii-0` (Art. 6 classification trigger) added as first checklist item; items 7→8; 4 tests
- N-207: CI gate `default` mode silent on Art. 6 conformity obligation — `art6ConformityRequired` boolean added to `CiGateResult`; gate fails when Annex III triggered by Art. 6 domain content even at medium risk; `renderCiGateOutput` surfaces the reason; 5 tests
- N-208: Article 52 (Transparency Obligations for Specific AI System Types) completely absent — added `articleEvidence` block (§1 chatbot/opinion signals, §2 emotion-recognition/biometric, §3 synthetic-media/deep-fake); `getRemediations()` branch; Art. 6 `testCategoryMappings` entry via `claimMappings` 4th param; 8 tests
- N-209: Article 53 (Obligations for Providers of GPAI Models) added to `articleEvidence` — `partial` when real GPAI provider detected (`scan.provider`), `not-applicable` for mock; 5-item `getRemediations` branch (documentation/training-data/copyright/AUP/procurement); 3 tests (A53-1–A53-3)
- N-210: CRUCIBLE Gate 6 hardening sprint for `compliance-report.ts` — mutation score raised from 50.44% to 80.81% (threshold 80%); 292 new tests across 7 hardening files; `break: 80` enforced in `stryker-compliance.config.mjs`
- N-211: CRUCIBLE Gate 6 for `eu_ai_act.ts` — `mapClaimToRiskCategory()` function-level score 100% (59/59 mutants killed); 37 hardening tests covering all articleRef/annexRef values, confidenceScore literals, and isEscalated branch; `stryker-eu-ai-act.config.mjs` created; ESM static mutation limitation documented in `docs/mutation-testing.md`
- N-212: CRUCIBLE contract oracle for EU AI Act types — Zod schema tests for `EuArticleEvidence` (with `evidenceCount`/`sourceCount`/`strengthScore`), `AnnexIIICheckItem` (with `id`/`evidence`), `EuAiActComplianceReport`, and `CiGateResult` (with `art6ConformityRequired`, `exitCode: 0|1`); 14 new contract tests in `contract.test.ts`; 4,314 tests total
- N-213: CRUCIBLE Gate 6 for `shell_injection_rule.ts` — mutation score 80.29% (108 killed / 2 timeout / 26 survived / 137 effective); 50 hardening tests in `shell-injection-hardening.test.ts` (SH-B/C1/S/R/A/M/H/FP/N groups covering boundary mutations, severity literals, ruleId strings, hex-format uppercase, control-char named messages, false-positive suppression); `stryker-shell-injection.config.mjs` targets lines 100–208 (check() body only); 4,364 tests total

- N-159: `faultline compliance-report --ci` — CI/CD compliance gate that exits non-zero if any EU AI Act article is non-compliant or overall risk is high/critical. New exports: `evaluateComplianceGate()`, `renderCiGateOutput()`, `CiGateResult`
- N-160: GitHub Action `compliance-gate` input — both `packages/cli/action.yml` and `.github/actions/faultline-scan/action.yml` now accept `compliance-gate: 'true'` to auto-enforce EU AI Act compliance in CI workflows. Outputs `compliance-status` (pass/fail)
- N-161: API compliance gate endpoints — `POST /scan/compliance-gate` (scan + evaluate in one call, 200=pass, 422=fail) and `GET /scan/:id/compliance` (evaluate existing scan). Auth + rate-limited
- N-162: Python SDK compliance gate — `compliance_gate()` and `get_scan_compliance()` methods with `CiGateResult`, `CiGateArticleResult`, `ComplianceGateResponse` models
- N-164: Compliance report diff — `faultline compliance-report --diff before.json,after.json` and `POST /scan/compliance-diff` API endpoint; shows per-article trend (improved/regressed/unchanged), risk trend, summary counts
- N-165: Compliance score (0–100) — numeric EU AI Act readiness score based on article status weights; shown in CI gate, JSON reports, and API responses
- N-166: Remediation recommendations — each article evidence entry now includes actionable `remediations[]` array; context-specific guidance per article (Art. 5 legal review, Art. 9 risk mitigations, Art. 13 transparency, Art. 14 oversight, Art. 50 disclosure); shown in CI gate output and PDF reports when gate fails
- N-167: Compliance threshold configuration — `--threshold N` (0–100 minimum score) and `--strict` (all articles must be compliant/N-A) flags for CLI `--ci` mode; `threshold` and `strict` parameters on `POST /scan/compliance-gate` and `GET /scan/:id/compliance` API endpoints
- N-168: Compliance badge SVG — `renderComplianceBadgeSvg()` generates shields.io-style badge with score + PASS/FAIL; `GET /scan/:id/compliance/badge` returns SVG for README embedding
- N-169: Compliance history tracking — `ComplianceHistoryStore` records every gate evaluation; `GET /compliance/history` (time-series), `GET /compliance/trend` (score direction per project)
- N-170: Compliance config file — `.faultline-compliance.json` with projectName, threshold, strict, requiredArticles; auto-loaded in `--ci` mode; `--config` flag for explicit path
- N-171: Python SDK compliance enhancements — `compliance_badge()`, `compliance_history()`, `compliance_trend()` methods; `threshold`/`strict` params on `compliance_gate()`
- N-172: Compliance report Markdown renderer — `renderComplianceReportMarkdown()` GFM output for PR comments; `--format markdown` CLI flag with `--output` file support
- N-173: Compliance report SARIF 2.1.0 — `renderComplianceReportSarif()` maps EU AI Act articles to SARIF rules/results; `--format sarif` CLI flag; integrates with GitHub Code Scanning, GitLab SAST, Azure DevOps
- N-174: GitHub Action compliance SARIF upload — `compliance-sarif`, `compliance-threshold`, `compliance-strict` inputs; auto-uploads compliance findings to GitHub Code Scanning Security tab
- N-175: Compliance report HTML renderer — `renderComplianceReportHtml()` standalone viewable report; `--format html` CLI flag
- N-176: Python SDK compliance diff — `compliance_diff()` with `ComplianceDiffResult`; `get_scan_compliance()` threshold/strict params
- N-177: Updated `llms.txt` — AI crawler-optimized project description with full compliance surface, 5 output formats, 176 SHIPPED, 3,730 tests
- N-178: Python SDK expanded API coverage — `scan_diff()`, `compliance_deadlines()`, `claims_trending()`, `gdpr_export()`, `gdpr_erase()` with `ScanDiffResult`, `ComplianceDeadline`, `GdprErasureResult` models; 61 Python tests
- N-179: Python SDK README — full API reference documenting all 20 client methods (compliance, GDPR, diff, claims, deadlines); updated models table with 6 new types
- N-180: Model `from_dict` test coverage — 11 new tests for ScanDiffResult, ComplianceDeadline, ComplianceDiffResult, GdprErasureResult, CiGateResult, ComplianceGateResponse; 72 Python tests total
- N-181: Python SDK security tests — SSRF protection (file://, ftp:// rejected), https:// accepted, trailing slash stripped, API key in header; 77 Python tests
- N-182: CI workflow Python SDK job — parallel `python-sdk` job running pytest on `sdks/python` with Python 3.12
- N-183: Python SDK `scan_deep()` — multi-provider chain with evidence links (POST /scan/deep); 80 Python tests
- N-184: TypeScript SDK expanded API coverage — 14 new methods: `scanDiff()`, `scanDeep()`, `complianceGate()`, `getScanCompliance()`, `complianceDiff()`, `complianceBadge()`, `complianceHistory()`, `complianceTrend()`, `complianceDeadlines()`, `claimsTrending()`, `gdprExport()`, `gdprErase()`; 7 new type interfaces
- N-185: npm download metrics pipeline — `NpmMetricsStore` (time-series daily download counts from npmjs.org API), 4 REST endpoints (`GET /npm/downloads`, `/npm/downloads/:pkg`, `/npm/trend/:pkg`, `POST /npm/poll`), Prometheus `faultline_npm_downloads_total` gauge, hourly auto-polling; 19 tests
- N-186: Article 10 (Data and Data Governance) evidence mapping — critical gap: the only core EU AI Act article without dedicated evidence was now mapped: bias→Art.10(2), PII→Art.10(5), contradicted→Art.10(3), high-importance unverified→Art.10(3); 5 remediation rules; Articles 5/9/10/13/14/50 all mapped; 10 tests
- N-187: Per-article evidence strength scoring — `evidenceCount`, `sourceCount`, `strengthScore` (0.0–1.0) on every `EuArticleEvidence` entry; evidence-weighted compliance score replaces flat average; 6 tests
- N-188: TypeScript SDK npm download metrics — `getNpmDownloads()`, `getNpmPackageDownloads()`, `getNpmTrend()`, `triggerNpmPoll()`; 5 new types
- N-189: Python SDK npm download metrics — `npm_downloads()`, `npm_package_downloads()`, `npm_trend()`, `npm_poll()`; URL-encodes scoped package names; 9 tests
- N-190: Annex III conformity assessment checklist — `AnnexIIIChecklist` with 7 conformity items (Art. 9–15) auto-derived from article evidence; applicable for high/critical risk tiers; Art. 15 accuracy proxy via 30% contradiction threshold; `passRate` percentage; included in JSON compliance output; 8 tests
- N-191: Annex III in all compliance renderers — CI gate output shows checklist with [PASS]/[FAIL]/[PART] per item + pass rate; Markdown GFM table for PR comments; SARIF conformity gap rules/results for Code Scanning; HTML styled table with badges; 9 tests
- N-192: Annex III conformity gate in strict mode — `--strict` now fails the CI gate when any Annex III conformity item is `fail` or `not-assessed` (applies to high/critical risk only); CI output shows which articles need attention; 4 tests
- N-193: Article 11 & 12 evidence mapping — Art. 11 (Technical Documentation) derives evidence from verification explanations/source citations; Art. 12 (Record-Keeping) from provider recording/structured claims/monitoring; remediations RR20-RR21; all 7 core articles (9-14, 50) now fully automated; Annex III no longer has `not-assessed` items; 8 tests
- N-194: Annex III in PDF renderer — conformity assessment table with pass rate badge, colored status labels, dynamic section numbering; cover page updated to show all 8 mapped articles + Annex III; 2 tests
- N-195: Security headers + GraphQL query bounds — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-XSS-Protection` on all responses; `Content-Security-Policy` on API responses; GraphQL `scans` capped at 200, `audit` at 500, `scanBatch` at 20; 10 tests
- N-196: EU AI Act Compliance HTML Dashboard — `GET /compliance/dashboard` with score gauge, pass rate, Article 50 enforcement countdown, recent evaluations table; XSS-safe, 30s auto-refresh; 10 tests
- N-197: Compliance dashboard article grid + sparkline — per-article compliance status (8 articles) from latest scan with colour-coded chips and strength %; score trend bar chart (last 10 evaluations); 3 tests
- N-198: Compliance export endpoint — `GET /compliance/export?format=csv|json` for EU AI Act audit trail; RFC 4180 CSV escaping; projectName/since filters; Content-Disposition headers; 10 tests
- N-199: Compliance gate failure webhook alerts — `compliance.gate_failed` event fires on `POST /scan/compliance-gate` failure; payload includes scanId, projectName, complianceScore, failedArticles; registered in NotificationEventType, ALL_EVENT_TYPES, EVENT_CATALOGUE, WebhookEvent; 6 tests
- N-200: Inline compliance score in `POST /scan` — every scan response now includes `complianceScore` (0–100) and `compliancePass` (boolean); works for fresh scans and cache hits; zero-friction EU AI Act readiness; 3 tests
- N-201: TypeScript SDK compliance enhancements — `complianceExport()` method with filters; `ComplianceHistoryEntry` + `ComplianceExportResponse` types; `WebhookEvent` union updated with `compliance.gate_failed`; `ScanResult` extended with optional `complianceScore`/`compliancePass`; 4 tests
- N-202: Python SDK compliance enhancements — `compliance_export()` method (JSON + CSV formats); `ComplianceHistoryEntry` + `ComplianceExportResponse` dataclass models with `from_dict()`; inline `compliance_score`/`compliance_pass` on `ScanResult`; 14 new tests (100 Python SDK total)
- N-203: Shell injection detection rules — YAML rule with 12 regex patterns (command substitution, IFS injection, eval/exec, base64-decode-pipe, curl-pipe-shell, dangerous rm, PATH/LD_PRELOAD override, process substitution, semicolon chains, dd overwrite, mkfifo reverse shell) + TypeScript rule for Unicode obfuscation (zero-width chars, bidi overrides, non-ASCII whitespace, control characters, Cyrillic/Greek homoglyphs); 31 new tests. Inspired by Claude Code's 21-check bash security layer (RESEARCH-001 Phase 2)

### Fixed

- `getRemediations()` Art. 5 branch condition matched `'Article 52'` and `'Article 53'` due to substring overlap (`'Article 52'.includes('Article 5')` is `true`). Added explicit exclusion guards for Art. 52 and Art. 53 so their `else if` branches are reachable. 6 remediation tests added (RR22–RR27); 5 were previously failing silently. Total: 3,886 tests.
- `.github/workflows/faultline-ci.yml` missing `permissions: security-events: write` — the composite action already contained `github/codeql-action/upload-sarif` but the calling workflow lacked the required permission, causing SARIF upload to silently fail on every CI run. Added `permissions:` block to the `faultline-scan` job.
- CRUCIBLE Gate 2: two hollow assertions in N-210 hardening tests (H4g-1, H5d-6) asserted only `toBeDefined()` without content verification. Strengthened with `euArticle` and `tags` content assertions respectively.
- CRUCIBLE Gate 2 full sweep (cycles 101–109): 126 hollow terminal `toBeDefined()`/`toBeTruthy()` assertions hardened across 103 test files. All were terminal assertions with no downstream content check (the hollow pattern). Replaced with typed assertions: ISO date regex, `typeof === 'string'/'number'/'object'`, `Array.isArray()`, `toHaveProperty()`, `toMatchObject()`, `toMatch(/^sha256=/)`, exact error strings. Two confirmed guards retained (attribution.ts:81, plugin.ts:168). Detection script and fix patterns documented in `docs/hollow-assertion-patterns.md`.

---

## [v0.4.1] — 2026-03-30

### Security

- 13-commit security hardening sweep (semgrep 35 → 24 findings, remaining are false positives)
- npm audit fix — patched picomatch ReDoS (high), fastify host spoofing, brace-expansion DoS, yaml stack overflow (0 vulns remaining)
- F-03: Mermaid XSS — `sanitizeMermaidLabel()` strips injection chars from claim dependency graph
- F-04: Rate limiting added to `GET /scan/stream` (was unthrottled)
- F-06: Timing-safe API key comparison via `crypto.timingSafeEqual` in auth + keystore
- F-09: PATCH `/orgs/:id` — plan/status changes restricted to org owner (was any admin)
- Auth gates added to 8 previously-unauthenticated routes (analytics, mission-control, scans/timeline, webhooks/test, playground)
- GraphQL endpoint gated behind `requireApiKey`
- CORS: null-origin requests blocked in production
- Error handler: 5xx responses no longer leak internal `error.message`
- GitHub Actions shell injection fixed in both `action.yml` files (env vars instead of `${{ inputs }}`)
- Dockerfile: non-root `USER faultline` in runtime stage
- docker-compose: `no-new-privileges` + `read_only` filesystem
- Python SDK: URL scheme validation (http/https only) + 30s timeout on urllib
- `.gitignore`: `.env` files excluded from version control

### Changed

- N-140 CRUCIBLE self-audit + CLAUDE.md process hardening — Gate 1/2/3/4/5/8 PASS; Gate 7 PARTIAL (48/108 test files, 44%, not P0); Gate 6 all 5 modules above 80% threshold; CLAUDE.md: Idle Time Protocol gains pattern-documentation-at-first-discovery rule + pattern documentation note; CRUCIBLE section updated: Gate 6 changed from "(future)/60%" to "active/80%" with config references and current scores; Gate 7 "(future)" removed; oracle coverage count updated 3,586→4,467 with N-81 integration oracle noted
- N-139 `docs/mutation-testing.md` — permanent reference for mutation hardening sessions; 9 killable patterns (exact-count 3-mutant guard, two-entry exact-sum accumulator, ObjectLiteral field assertion, catch-block injection via missing API key, exact-string assertion, asymmetric normalization input, synthetic claim ID ordinals, EU tier accumulation via real compliance pipeline, riskOrder StringLiteral); 3 untestable patterns documented with root-cause analysis (symmetric normalization, VALID_PROVIDERS mock-only, riskOrder 'low'→'' fallback masking); config reference (coverageAnalysis 'off', testFiles explicit manifest, vitest.dir); threshold table with current scores for all 5 hardened modules
- N-138 `cli/scan.ts` mutation hardening round 3 — `stryker-cli.config.mjs` updated; baseline 75.41% → 81.97% (200 killed, 38 survived, 6 no-cov, 244 total); 15 tests (HN1–HN15) in `scan-mutation-hardening-3.test.ts`; killed: `guaranteeClaimPerSentence` idx arithmetic (`result.length+1`→`result.length-1`, HN1) and update (`idx++`→`idx--`, HN2) via synthetic ID ordinal assertions; `aggregateResults` euTierCounts.high/unacceptable/limited/minimal `+=`→`-=` (HN3–HN6) via batchScan 2-file EU tier accumulation using employment/social-scoring/contradicted/supported claims; euTierCounts `={}` ObjectLiteral (HN7) by asserting all tier counts are defined numbers; totalClaims/totalVerifications `+=`→`-=` (HN8–HN9) by 2-file batchScan exact count; batchScan `glob` field BooleanLiteral+LogicalOperator mutations (HN10–HN11) by `r.glob === '*.txt'` and `r.glob === null` assertions; `collectFiles` ArrayDeclaration phantom-path (HN12) via `filesSkipped === 0`; `normalizeSentence` `' '`→`"Stryker was here!"` StringLiteral + `/\s+/g`→`/\s/g` Regex (HN13) via triple-space sentence vs single-space claim fingerprint mismatch; riskOrder `'critical'`→`""` and `'high'`→`""` StringLiterals (HN14–HN15) by batchScan with 3×contradicted ('critical') and 1×contradicted ('high') scenarios; surviving: 6 no-cov + normalizeSentence `' '`→`""` + `.trim()` (symmetric normalization makes them untestable) + riskOrder `'low'`→`""` (|| 'low' fallback masks it) + `|| ""` fallback
- N-137 `stream.ts` mutation hardening — `stryker-stream.config.mjs` created; baseline 45.00% → 85.00%; 15 tests (SM1–SM15) in `stream-route-mutation-hardening.test.ts`; killed: `startEmitted` guard mutations (lines 68 ConditionalExpression/70 BooleanLiteral/84 BooleanLiteral+ConditionalExpression × 2 → "exactly 1 start event" assertion), missing-text error message exact-match (line 45), Cache-Control/Connection header key+value mutations (lines 98–99), error-path catch block no-coverage mutants (SM9–SM11 via provider=gemini without API key to force scan failure); surviving: 6 VALID_PROVIDERS StringLiteral/ArrayDeclaration (untestable with mock-only provider environment) + 3 Fastify schema string literals (documentation-only, not runtime-behavioral)
- N-136 `faultline stream` CLI command — `GET /scan/stream` HTTP client; `streamScan(apiUrl, apiKey, text, provider)` fetches SSE endpoint, parses events, returns typed `StreamResult`; `formatStreamResult()` renders provider header, per-claim verdict with icons (✓/✗/~/?) and 80-char preview, final risk level; `case 'stream'` in `index.ts` with positional text arg or `--text` flag, `--provider`, `--api-key`/`FAULTLINE_API_KEY`, `--api-url`/`FAULTLINE_API_URL`; 15 tests (ST1–ST15): formatter unit (error, provider header, no-claims, ✓ icon, text truncation), CLI integration (missing auth, missing text, call args, error propagation, success, env var fallback, provider flag, default provider, risk line, --text flag)
- N-135 Progressive per-claim SSE streaming — `ScanClaimCallback` type + `onClaimVerified?(claim, verdict, index, total)` as 6th param to `scan()`; fires after each `verifyClaim()` inside the verification loop; `GET /scan/stream` updated to use `onClaimVerified` for true progressive delivery (emits `claim_verified` events as claims complete, not after full scan); `start` event emitted on first claim callback using `total` param; 0-claim edge case handled; backward-compat (all existing callers unaffected); 15 tests (PS1–PS15): callback API (fires once per claim, claim/verdict shape, index ascending, total consistent), backward compat (result shape + overallRisk unchanged), stream delivery (0-based contiguous indices, claimCount consistency across start/complete/events, no duplicate delivery)
- N-134 Server-Sent Events scan streaming — `GET /scan/stream?text=...&provider=mock`; streams `start` → `claim_verified` × N → `complete` events in SSE format; `type`/`claimCount`/`provider` on start, `index`/`claim`/`verdict` on each claim_verified, `overallRisk`/`claimCount` on complete; `error` event on scan failure; auth-gated (401 without x-api-key); 400 on missing text; provider defaults to `mock`; no new dependencies (HTTP-native SSE via reply.send); 15 tests (WS1–WS15): status+content-type, start/claim_verified/complete event shape, event ordering, validation, auth
- N-133 ScheduleStore.update() + recordRun() mutation hardening (SH16–SH30) — `schedules.ts` 77.35%→80.94%, GDPR cluster 86.31%; 15 tests killing: `update()` conditional guards for notifyEmail/webhookUrl/maxRuns (3 mutants each: ConditionalExpression if(false)/if(true) + EqualityOperator `!==`→`===`); description and name guards (1 mutant each); `recordRun()` `maxRuns=0` unlimited guard (`>` → `>=`, SH24); nextRunAt non-null + ISO 8601 format after recordRun (SH25–SH26); history cap at MAX_HISTORY=20 after 21 runs (SH27); unknown-id early-return guard (SH28); parseCron step regex `/^\*\/\d+$/` "never matches" and "always matches" variants (SH29–SH30)
- N-132 CostStore.getAggregate() + getCosts() mutation hardening — `costs.ts` 89.36%→96.81%, GDPR cluster 85.19%; 15 tests (CA1–CA15) killing: provider filter `if(false)` (all entries returned regardless of provider, CA1) and `if(true)` (all entries rejected, CA2) ConditionalExpression mutations at line 54; `totalCostUsd +=` → `-=` at line 78 by exact-sum assertion on 2 gemini entries (CA3); `byProvider[p].costUsd +=` → `-=` at line 84 by 3-entry sum assertion (CA4); `!byDate[date]` initialization guard `if(true)` (reinitializes accumulator each iteration) at line 86 by 3-same-date-entries token sum (CA5); `byDate[d].tokens +=` → `-=` at line 89 (CA6) and `byDate[d].costUsd +=` → `-=` at line 90 (CA7) by exact cross-entry sum; supporting: byProvider multi-key isolation (CA8), byDate single-key for same-date entries (CA9), mock provider zero cost (CA10), provider-filtered aggregate token count (CA11), cross-provider cost exclusion (CA12), empty-filter-result zero structure (CA13), distinct-provider key count (CA14), per-provider independent accumulation (CA15)
- N-131 `dispatchScheduleNotification` event-type correctness fix — adds `'scan.completed'` to `NotificationEventType` union, `ALL_EVENT_TYPES`, and `EVENT_CATALOGUE`; `dispatchScheduleNotification` now dispatches `'scan.completed'` on success and `'scan.failed'` on error (was always `'scan.failed'`); error catch block in `runSchedule()` now also calls dispatch so failures are reported; 15 tests (SC1–SC15): catalogue membership, description/example content, event routing (success→completed, error→failed, no cross-dispatch), payload correctness (overallRisk, claimCount, error field), subscription filtering isolation
- N-130 NotificationStore dispatch mutation hardening — `notifications.ts` 82.39%→92.45%, GDPR cluster 82.32%; 15 tests (ND1–ND15) killing: `if(!res.ok)` all 3 ConditionalExpression variants (if(true)/if(false)/if(res.ok)) by asserting `delivered` and `error` on HTTP 200/503 responses; `catch` BlockStatement removal by asserting thrown message captured; `method:'POST'` + `Content-Type` header mutations by inspecting captured fetch call; `body:JSON.stringify({})` mutation by asserting event/keyId/payload in parsed body; `if(webhookUrl)` BlockStatement by asserting 'no-webhook-configured' error when url=null; convenience dispatcher ObjectLiteral payload `{}` mutations for `notifyScanFailed` (error+provider), `notifyProviderStatus` (available+timestamp via global webhook fallback), `notifySubscriptionChanged` (change fields); `deleteTenantHistory` `(r)=>false` ConditionalExpression by asserting count=0 + records preserved; `EVENT_CATALOGUE['key.rotation_due']` description/example/keyId/keyName string mutations
- N-129 ScheduleStore + nextCronTime + parseCron second-pass hardening — `schedules.ts` 70.11%→76.26%, GDPR cluster 79.87%; 15 tests (SH1–SH15) killing: `*/1` step boundary, `*/0` invalid step, comma-list validity, `nextCronTime` range lower bound (`value >= a`), range upper bound (`value <= b`), midpoint range (kills `if(false)` at line 134), plain-value match (kills `if(true)` at line 134), comma-list integer match; `ScheduleStore.create()` MAX_SCHEDULES capacity guard (500) and description default; `update()` provider/status conditional patches and cron→nextRunAt recalculation; `recordRun()` maxRuns=1 completion gate (`>= maxRuns` off-by-one)
- N-128 ScheduleRunner + parseCron + nextCronTime mutation hardening — `schedules.ts` score 57.82% → 70.11% (overall GDPR cluster 76.27%); 16 hardening tests (SR1–SR16) in `schedule-runner-mutation-hardening.test.ts`; killed mutants in `parseCron` `/\s+/` regex, range bounds (day min=1, month min=1, weekday max=7), range-part bounds (`a < min`, `b > max`), `nextCronTime` step arithmetic (`value % step`), range match (`value >= a && value <= b`), UTC field extraction, `ScheduleStore.create()` defaults (provider='gemini', maxRuns=0), `ScheduleRunner.runSchedule()` text/URL/error paths and duration arithmetic

---

## [v0.4.0] — 2026-03-21

### Added

- N-127 v0.4.0 publish prep — CHANGELOG v0.4.0 block cut; `@nxtg/faultline` + `@nxtg/faultline-api` bumped to 0.4.0; README updated with GDPR compliance + mutation testing rows; 15 release-prep tests (RP16–RP30)
- N-126 CRUCIBLE Gate 6 — Stryker mutation testing on GDPR stores (`costs.ts`, `schedules.ts`, `notifications.ts`); baseline 60.07% → final 69.07% (costs 62.77%→89.36%, notifications 67.30%→82.39%, schedules 56.15%→57.82%); 15 hardening tests (NH1–NH15) in `gdpr-store-mutation-hardening.test.ts`; killed mutants in `CostStore` token arithmetic (ceil/4, ×2, cost formula /1000), date range filters, `getAggregate` accumulators; `NotificationStore` broadcast event-type filter, `hasFallback` condition; `ScheduleStore` `recordRun`, `parseCron` range validation; `stryker-gdpr.config.mjs` created
- N-125 CRUCIBLE Gate 6 hardening round 2 — Stryker mutation score on `cli/scan.ts` raised 60.91% → 75.31%; 15 new hardening tests (MH16–MH30) in `scan-mutation-hardening-2.test.ts`; killed mutants in `splitSentences` word-count filter, `onProgress` callbacks, default provider 'gemini' error message, `collectFiles`/`walk` recursion, glob pattern include/exclude, `globToRegex` `?` wildcard
- N-124 GDPR schedule erasure — `ScheduleStore.deleteForKeys(keyIds[])` + `listForKeys(keyIds[])`; GDPR export ZIP gains `schedules.json`; `DELETE /tenants/:id/data` extended with `schedules` count; 15 tests (SS1–SS15); store audit complete — `JobStore`/`BulkJobStore`/`ScanCache`/`ClaimIndex` have no tenant association (no action needed)
- N-123 Tenant-scoped cost tracking — `ScanCost.tenantId?`; `CostStore.record()` accepts tenantId; `CostStore.deleteTenantCosts(tenantId)`; GDPR export adds `costs.json`; erasure adds `costs` to deleted counts; 15 tests (TC1–TC15)
- N-122 GDPR notification prefs erasure — `deletePrefsForKeys(keyIds[])` on `NotificationStore`; `DELETE /tenants/:id/data` erases notification prefs for all tenant keys; 15 tests (EP1–EP15)
- N-121 GDPR erasure endpoint — `DELETE /tenants/:id/data` (admin-gated, Article 17); erases scan history, audit log, notifications, webhooks, usage across all tenant keys; tenant record preserved; idempotent; 15 tests (ER1–ER15)
- N-120 GDPR export endpoint — `GET /tenants/:id/export` (admin-gated, Article 15); ZIP archive with manifest, scan-history, audit-log (NDJSON), notifications, webhooks, usage, costs, schedules; 15 tests (GE1–GE15)
- N-119 v0.3.0 publish prep — CHANGELOG rewrite; README badge 2,757→4,166; 15 release-prep tests (RP1–RP15)

### Fixed

- CI shallow clone: added `fetch-depth: 0` to `actions/checkout@v4` — changelog endpoint needs git tags

---

## [v0.3.0] — 2026-03-20

### Added

- N-84 `GET /keys/:id` — single key lookup (secret redacted, disabled state visible)
- N-83 `PATCH /keys/:id` — update name and/or permissions post-creation (admin-gated)
- N-82 ApiKey soft-disable — `disabled?: boolean`; `PATCH /keys/:id/disable` + `/enable`; `validateKey()` rejects disabled keys
- N-81 Real Integration Oracle — 12 E2E tests (no scan mock); full pipeline HTTP→scan()→mock provider; CRUCIBLE 4/4 oracle types complete
- N-80 Coverage gate — vitest thresholds (stmts 80%, branch 70%, funcs 85%, lines 80%) enforced on every push via `.asif-ci`
- N-79 Claim filter threshold — `filterClaimsForVerification` importance `>= 2` (was `>= 3`); exported for direct testing
- N-78 Audit Log API — `GET /audit/log`, `GET /audit/log/stats`, `GET /audit/log/export` (NDJSON)
- N-77 Contract oracle (Zod) — 29 schema validation tests across all 6 core pipeline types
- N-76 Property-based oracle (fast-check) — 19 properties: `guaranteeClaimPerSentence`, `mapClaimToRiskCategory`, `generateComplianceReport`
- N-75 Interactive demo mode — `faultline scan --demo`; no API key required
- D-149 Changelog page — `/changelog` HTML + `/changelog.json` + `/changelog.md`
- D-148 Status page — `/status` HTML + `/status.json`
- D-147 Scan history export — `faultline export` + `POST /export`
- D-146 Benchmark suite — provider latency, cache, concurrent throughput
- D-145 Docker image — multi-stage `Dockerfile` + `docker-compose.yml`
- D-144 CLI plugin system — custom rules + providers as npm packages
- D-143 i18n — `Accept-Language: es/fr/en`; localized error messages and report labels
- D-142 Multi-language support — EN/ES/FR translations
- D-149 Regulatory calendar — `GET /compliance/deadlines`; EU AI Act ×3, GDPR, NIST AI RMF deadlines
- D-149 Compliance scan-check — `POST /compliance/scan-check`; claim keyword alerts against approaching deadlines
- SG-01 OpenAPI decoration — full 48-path spec; `GET /docs` Swagger UI
- SG-02 Property-based tests + CRUCIBLE audit (Phase 1 complete)
- N-57 through N-74: claim explainability, scan diff, mission control, claim graph, GraphQL, Python SDK, GitHub Action, Terraform provider, caching, scheduled jobs, provider failover, bulk import, industry templates, scan search, cost tracking, multi-tenant, claim search, Swagger UI, scan dashboard

### Fixed

- `validateKey()` now counts `!disabled` keys correctly for `activeKeys` in mission control
- 15 pre-existing TypeScript errors resolved across 9 files
- `ci.yml`: `cancel-in-progress: true` to prevent stale-run false alarms

---

## [v0.2.0] — 2026-03-19

### Added

- Enterprise API: API keys + audit trail + usage metering
- Rate limiting (per-tier per-minute limits)
- POST /scan Fastify cloud endpoint (N-13)
- Compliance PDF reports (`POST /scan/report`)
- Scan history + trend analysis
- YAML rule engine (PII, bias, toxicity built-in rulesets)
- Watch mode with file type filter and debounce
- Claude provider (configurable model)
- Report aggregation with multi-file summary and risk heatmap
- Confidence score calibration with per-provider profiles
- MockProvider as first-class registered provider
- `--fail-on` flag for severity-based exit codes in CI
- SARIF output, VS Code extension, GitHub Action
- Batch scan, rules engine, caching layer
- CRUCIBLE Protocol Phase 1: Gates 2, 4, 6, 7 (Critical tier)

### Fixed

- Perplexity citation type fix
- All provider models updated to current versions
- CLI spinner, model IDs, package metadata

---

## [v0.1.0] — 2025-12-09

### Added

- Initial project structure: React frontend, Gemini provider, EU AI Act compliance module
- 4-phase pipeline: Extract → Verify → Synthesize → Refine
- Seismic Barometer risk visualization
