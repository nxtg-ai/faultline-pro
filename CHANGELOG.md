# Changelog

All notable changes to Faultline Pro are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- N-159: `faultline compliance-report --ci` — CI/CD compliance gate that exits non-zero if any EU AI Act article is non-compliant or overall risk is high/critical. New exports: `evaluateComplianceGate()`, `renderCiGateOutput()`, `CiGateResult`
- N-160: GitHub Action `compliance-gate` input — both `packages/cli/action.yml` and `.github/actions/faultline-scan/action.yml` now accept `compliance-gate: 'true'` to auto-enforce EU AI Act compliance in CI workflows. Outputs `compliance-status` (pass/fail)
- N-161: API compliance gate endpoints — `POST /scan/compliance-gate` (scan + evaluate in one call, 200=pass, 422=fail) and `GET /scan/:id/compliance` (evaluate existing scan). Auth + rate-limited
- N-162: Python SDK compliance gate — `compliance_gate()` and `get_scan_compliance()` methods with `CiGateResult`, `CiGateArticleResult`, `ComplianceGateResponse` models
- N-164: Compliance report diff — `faultline compliance-report --diff before.json,after.json` and `POST /scan/compliance-diff` API endpoint; shows per-article trend (improved/regressed/unchanged), risk trend, summary counts
- N-165: Compliance score (0–100) — numeric EU AI Act readiness score based on article status weights; shown in CI gate, JSON reports, and API responses

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
