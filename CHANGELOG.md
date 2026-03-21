# Changelog

All notable changes to Faultline Pro are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- N-123 Tenant-scoped cost tracking — `ScanCost.tenantId?`; `CostStore.record()` accepts tenantId; `CostFilter.tenantId?`; `CostStore.deleteTenantCosts(tenantId)`; GDPR export adds `costs.json`; erasure adds `costs` to deleted counts; 15 tests (TC1–TC15)
- N-122 GDPR notification prefs erasure — `deletePrefsForKeys(keyIds[])` on `NotificationStore`; `DELETE /tenants/:id/data` now also erases notification prefs for all tenant keys; response extended with `notificationPrefs` count; 15 tests (EP1–EP15)
- N-121 GDPR erasure endpoint — `DELETE /tenants/:id/data` (admin-gated, Article 17); `deleteTenantEntries()` on ScanHistory + Audit, `deleteTenantHistory()` on Notifications, `deleteTenant()` on Webhooks, `deleteKey()` on UsageMeter; tenant record preserved; idempotent; 15 tests (ER1–ER15)
- N-120 GDPR export endpoint — `GET /tenants/:id/export` (admin-gated, Article 15); ZIP archive via `adm-zip` with manifest, scan-history, audit-log (NDJSON), notifications, webhooks, usage; 15 tests (GE1–GE15)
- N-119 v0.3.0 publish prep — CHANGELOG rewrite; README badge 2,757→4,166; 15 release-prep tests (RP1–RP15)
- N-118 CRUCIBLE Gate 6 — Stryker mutation testing on `cli/scan.ts` (claim forensics critical path); root-level monorepo config; initial 26.75% → final 60.91%; 15 hardening tests (MH1–MH15)
- N-117 CRUCIBLE Gate 6 — Stryker mutation testing on `webhooks.ts`; initial 86.51% → final 91.45%; 15 hardening tests (MH1–MH15)
- N-116 `resolveRequestTenantId()` auth helper — centralized tenant resolution in `auth.ts`; dead code cleanup
- N-115 Per-webhook retry configuration — `maxAttempts` (1–5) and `retryDelayMs` (0–30 000 ms) per webhook
- N-114 Webhook circuit breaker — `WebhookCircuitBreaker`; `FAULTLINE_WEBHOOK_CIRCUIT_THRESHOLD` + `FAULTLINE_WEBHOOK_CIRCUIT_COOLDOWN_MS` env vars
- N-113 Webhook per-minute rate limiting — `WebhookRateLimiter` sliding 60 s window; `FAULTLINE_WEBHOOK_RATE_LIMIT` env var
- N-112 Shared HTML escape utility — `src/lib/html.ts` `esc(unknown)` + `escHtml`; XSS auditable at one grep target
- N-111 Tenant-scoped audit log — `AuditEntry.tenantId?` resolved at record time; `GET /audit/log?tenantId=`; closes enterprise tenancy surface
- N-110 Tenant-scoped webhooks — `Webhook.tenantId?` stored at create time; `GET /webhooks?tenantId=`
- N-109 Webhook delivery log HTML dashboard — `GET /webhooks/deliveries/view`; stat cards, per-delivery table, auto-refresh
- N-108 Tenant-scoped notifications — `NotificationRecord.tenantId?`; `GET /notifications/history?tenantId=`
- N-107 `faultline scans prune` CLI — dry-run-safe destructive command; `--confirm` gate; preview + execute modes
- N-106 Webhook delivery retry dashboard — `WebhookDeliveryRecord` ring-buffer; `GET /webhooks/deliveries` + `GET /webhooks/:id/deliveries`
- N-105 Tenant-scoped scan history — `ScanEntry.tenantId?`; `GET /scans/search`, `/scans/usage`, `/scans/stale` all support `?tenantId=`
- N-104 `faultline keys prune` CLI — dry-run-safe; `GET /keys/dormant` preview; `POST /keys/bulk-delete` execute; `--confirm` gate
- N-103 `faultline keys rotation` CLI — `keys rotation [--days 90]`; OVERDUE/CRITICAL chips; never-rotated label
- N-102 Key rotation reminder notifications — `key.rotation_due` event; 90d/180d thresholds with per-key×threshold dedup
- N-101 Mission control scan hygiene — `GET /mission-control/status` includes `scans.totalDocuments`, `staleCount`, `riskDriftedCount`
- N-100 `faultline scans` CLI — `scans stale [--days 30]` and `scans usage [--staleDays 30]`; FAULTLINE_API_KEY/URL env vars
- N-99 Scan hygiene HTML dashboard — `GET /scans/stale/view`; STALE + DRIFT chips; auto-refresh 60 s
- N-98 Bulk scan pruning — `DELETE /scans/stale?days=N` (admin-gated); group-level delete; returns `{ deletedGroups, deletedEntries }`
- N-97 Scan usage analytics — `GET /scans/usage?staleDays=N`; per-textHash stats: scanCount, firstScannedAt, riskDrifted, avgLatencyMs
- N-96 Stale scan detection — `GET /scans/stale?days=N`; entries grouped by textHash, oldest-first
- N-95 Key hygiene HTML dashboard — `GET /keys/usage/view`; HEALTHY/DORMANT/EXPIRING/EXPIRED/DISABLED chips; auto-refresh 60 s
- N-94 Key usage analytics — `GET /keys/usage`; daysSinceCreation/LastUse/LastRotation; isDormant/isExpiringSoon/isExpired per key
- N-93 Bulk disable/enable — `POST /keys/bulk-disable` + `POST /keys/bulk-enable`
- N-92 `faultline keys` CLI — `keys list`, `keys dormant`, `keys expiring`, `keys rotation`; FAULTLINE_API_KEY/URL env vars
- N-91 Expiring-soon key list — `GET /keys/expiring-soon?days=N` (default 7)
- N-90 Notifications event catalogue refactor — `EVENT_CATALOGUE` as single source of truth; future event types auto-register
- N-89 Bulk key deletion — `KeyStore.bulkDelete(ids[])` + `POST /keys/bulk-delete`
- N-88 Key expiry notifications — `key.expiring_soon` event; 7d/1d thresholds with per-key×threshold dedup
- N-87 Dormant key detection — `GET /keys/dormant?days=N`; uses lastUsedAt ?? createdAt
- N-86 ApiKey expiry — `expiresAt?: string`; `validateKey()` rejects expired keys; `PATCH /keys/:id` accepts `expiresAt`
- N-85 ApiKey `lastUsedAt` tracking — stamped by `validateKey()` on every successful auth
- N-82 — N-84 Additional API key management: `GET /keys/:id`, `PATCH /keys/:id`, soft-disable/enable

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
