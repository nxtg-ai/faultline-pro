# Changelog

All notable changes to Faultline Pro are documented here.

## [0.2.0] — 2026-03-19

### Major Features

#### 🔍 Claim Forensics (N-34 – N-37)
- **Claim Evidence Linking** (`POST /scan/deep`) — validates source URLs with HEAD requests, scores 0–100 (availability +50, relevance +30, recency +20)
- **Claim Dependency Graph** (`GET /scan/:id/graph`) — Mermaid diagram of claim type-hierarchy edges (fact→interpretation→opinion)
- **Claim Trending** (`GET /claims/trending`) — cross-scan frequency tracking, emerging claims (24h window), verdict-flip alerts
- **Claim Attribution** (`GET /claims/:id/attribution`) — full provenance chain with 0–100 confidence score, stable UUID per claim across re-ingests

#### 📋 Compliance (N-38)
- **EU AI Act Full Report PDF** (`POST /scan/eu-report`) — cover page, risk classification badge, applicable articles (Art. 6/9/13/14/15, Annex III for high-risk; Art. 52/69 for limited; Art. 69/Recital 47 for minimal), per-claim compliance table

#### 🌐 GraphQL API (N-32)
- `POST /graphql` via mercurius — queries: `scan`, `scans`, `keys`, `usage`, `audit`; mutations: `createKey`, `deleteKey`, `scanBatch`
- Context-aware: `keyId` threaded through all resolvers

#### ⚡ Performance (N-33)
- Benchmark suite: health p99 < 50ms, scan p99 < 200ms, cache HIT vs MISS (50+50 samples)
- `docs/benchmarks.md` — methodology + baseline tables

#### 🌍 Internationalization (N-31)
- 47-key i18n catalogue (English, Spanish, French)
- CLI `--lang` flag, API `Accept-Language` header (RFC-7231 quality-factor parsing)

#### 🏗️ Production Hardening (N-39)
- CORS: `faultline.nxtg.ai` + `*.nxtg.ai` allowlist
- Rate limiter: per-minute window (free: 10/min, pro: 100/min, admin: 10k/min)
- `GET /health` upgraded with subsystem + provider status
- Global error handler: consistent `{ error, code }` JSON, no stack traces

### Earlier Features (since v0.1.3)

#### Enterprise + Platform (N-11 – N-15)
- Multimodal upload: PDF text extraction + Tesseract OCR (`POST /scan/upload`)
- API key management with permissions (free/pro/admin), audit trail, usage metering
- Stripe metering hooks, admin-gated endpoints
- Compliance PDF reports (`POST /report/pdf`)

#### Automation + Observability (N-19 – N-25)
- Webhook system: HMAC-signed events (`scan.complete`, `scan.failed`, `job.complete`, `claim.verdict_changed`), retry queue
- Batch scan API: `POST /scan/batch` — parallel multi-text scanning
- Prometheus metrics: `GET /metrics`
- Deep health: `GET /health/deep` — all subsystem + provider states
- Provider auto-failover: circuit breaker (5-failure threshold, 5-min cooldown)
- Caching layer: content-hash cache, TTL, `X-Cache: HIT/MISS` headers
- Scheduled jobs: `POST/GET/DELETE /jobs` with cron expressions

#### Developer Experience (N-26 – N-31)
- Scan comparison: `GET /compare?a=id1&b=id2` — trust score delta
- Provider plugin system: `FaultlineProvider` interface, registry, Wikipedia built-in
- Provider health monitoring: latency scoring, `GET /providers/health`
- Scan templates: `POST/GET/DELETE /templates`, `POST /scan/template/:id`, CLI `--template`
- Full platform E2E tests (S1–S26)

#### Multi-SDK Distribution (N-21)
- TypeScript SDK (`packages/sdk/`)
- Python SDK (`packages/sdk/python/`)
- GitHub Action

### Bug Fixes
- mercurius `MercuriusContext` augmented with `keyId` — fixes TS2769 typecheck error
- `vi.mock()` TDZ in ESM: mock factory values inlined to avoid pre-initialization reference
- `templateRoutes` binding guard for Node 20 ESM live-binding TDZ
- POST `/scan/template/:id` moved to `scanRoutes` (was incorrectly in `templateRoutes`)

## [0.1.3] — 2026-03-09

- Perplexity provider (N-16) — search-native verification with citation sources
- Provider documentation (`docs/PROVIDERS.md`) with search-gap callout (N-17)
- npm published: `@nxtg/faultline@0.1.3`

## [0.1.2] — 2026-03-06

- CRUCIBLE Protocol adopted (pre-push hook, Gate 2 non-empty assertions)
- README Quick Start updated to real Gemini provider
- DX fix: `mock` provider moved to Testing & CI section

## [0.1.0] — 2026-03-05

- Initial release: 4-phase claim forensics pipeline (Extract→Verify→Synthesize→Refine)
- 5 providers: Gemini, OpenAI, Claude, Perplexity, Mock
- CLI tool with `scan`, `report`, `watch`, `critique` commands
- EU AI Act compliance module (N-03)
- Rules engine: PII, bias, toxicity (N-05)
- Confidence calibration (N-06)
- Weakest-link detection (N-08)
- SARIF output + GitHub Action (N-04, N-10)
