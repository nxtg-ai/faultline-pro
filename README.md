# Faultline — AI Claim Forensics

Forensic verification for AI-generated text. Faultline decomposes output into atomic claims, verifies each against live evidence, maps findings to EU AI Act risk tiers, and enforces a CI gate before hallucinations reach production.

[![CI](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nxtg/faultline.svg)](https://www.npmjs.com/package/@nxtg/faultline)
[![Tests](https://img.shields.io/badge/tests-4317%20passing-brightgreen)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

---

## What It Does

| Capability | Description |
|---|---|
| Atomic claim extraction | Decomposes AI output into fact / opinion / interpretation with importance scoring |
| Per-claim verification | Verdict: supported / contradicted / mixed / unverified + confidence score |
| Scan comparison | `POST /scan/compare` + `faultline compare` — new/removed claims, verdict changes, trust score delta |
| EU AI Act compliance | Risk tier mapping (Unacceptable / High / Limited / Minimal), triggered articles, mitigations |
| Weakest-link detection | Per-claim fragility scoring — finds the claim that most undermines the argument |
| Claim dependency graph | Mermaid and Graphviz DOT visualizations grouping claims by risk tier |
| Rules engine | YAML-defined rules; built-in PII, bias, toxicity rulesets |
| CI gate | `--fail-on high` returns exit code 1; SARIF output for GitHub Code Scanning |
| Enterprise API | REST API with key management, audit trail, rate limiting, webhooks, batch scanning, caching |
| Provider failover | Automatic chain Gemini → OpenAI → Claude → Perplexity; circuit breaker with 5-min cooldown |
| Monitoring | `GET /health/deep`, `GET /metrics` (Prometheus), `GET /status` (HTML dashboard) |
| Scheduled jobs | `POST /jobs` — recurring scans on a cron schedule with webhook delivery |
| Multi-SDK | TypeScript SDK (`@nxtg/faultline-sdk`), Python SDK (`faultline-sdk`), GitHub Action |
| Multi-tenant | Tenant CRUD, API key association, per-tenant usage aggregation |
| Cost tracking | Per-scan token/cost estimation; `GET /costs` with provider/tenant/date filters |
| Scan history | `GET /scans/search` — full-text across all past scans, cursor pagination |
| Industry compliance | HIPAA / SOX / FERPA / Gov templates; `POST /scan/compliance/:template` |
| Bulk import | `POST /scan/bulk` — ZIP of documents, async job, `GET /jobs/:id/progress` |
| Swagger UI | `GET /docs` — interactive OpenAPI 3.0 spec with Try-it for every endpoint |
| Claim explainability | `GET /claims/:id/explain` — reasoning chain, evidence found, actionable suggestions |
| Scan diff | `POST /scan/diff` — scan two texts, inline diff (added/removed/changed/unchanged) |
| Regulatory calendar | `GET /compliance/deadlines` — EU AI Act, GDPR, NIST deadlines with days-until |
| Compliance scan-check | `POST /compliance/scan-check` — match claim text against approaching deadlines |
| i18n | `Accept-Language: es/fr/en` — localized error messages and report labels (EN/ES/FR) |
| Property-based tests | `fast-check` oracle coverage: confidence bounds, dedup invariants, cost aggregation, sort stability |
| GDPR compliance | Article 15 export (`GET /tenants/:id/export` → ZIP) + Article 17 erasure (`DELETE /tenants/:id/data`) covering scan history, audit log, notifications, webhooks, costs, schedules |
| Mutation-tested core | Stryker gate: claim forensics 75.31%, webhook store 91.45%, GDPR stores (costs 89.36%, notifications 82.39%, schedules 70.11%); CRUCIBLE Protocol Gate 6 |

---

## Features

### Providers

| Provider | Requires | Best For |
|---|---|---|
| Gemini | `GEMINI_API_KEY` | Live web grounding (free key available) |
| Perplexity | `PERPLEXITY_API_KEY` | Real-time search-native verification |
| OpenAI | `OPENAI_API_KEY` | Training-data verification, GPT ecosystem |
| Claude | `ANTHROPIC_API_KEY` | Training-data verification, reasoning-heavy docs |
| Mock | None | CI pipelines, unit tests, offline development |

Switch providers with `--provider <name>`. No code changes required.

### Document Ingestion
- **PDF + image upload with OCR** — `faultline scan --file document.pdf` or `POST /scan/upload`; powered by `pdf-parse` + `tesseract.js`
- **Text files** — `--input doc.txt`
- **Directories** — `--dir ./docs --glob "*.md"`

### Compliance
- **EU AI Act** — risk tier classification per Articles 5–7 and Annex III; prohibited practice detection; transparency obligations
- **Compliance reports** — audit-ready PDF output via `POST /scan/report`
- **Rules engine** — YAML-defined rules: PII detection, bias indicators, toxicity flags, custom rules

### Output Formats
- `json` — programmatic processing, CI pipelines
- `markdown` — PRs, reports, documentation
- `html` — browser-readable audit reports
- `sarif` — VS Code Problems panel, GitHub Code Scanning (`--sarif` shorthand writes `results.sarif`)

### Enterprise API
- **API key management** — full lifecycle: `POST /keys`, `GET /keys`, `GET /keys/:id`, `PATCH /keys/:id`, `DELETE /keys/:id`; soft-disable/enable; scoped permissions (scan / report / upload / admin / pro)
- **Key hygiene** — dormant key detection (`GET /keys/dormant`), expiry notifications (7d/1d thresholds), bulk delete/disable/enable, usage analytics (`GET /keys/usage`), hygiene dashboard (`GET /keys/usage/view`)
- **Audit trail** — SHA-256 input hash logged on every request; `GET /audit/log` (query + filter), `GET /audit/log/stats`, `GET /audit/log/export` (NDJSON); tenant-scoped view
- **Usage metering** — per-key daily scan counts via `GET /usage`
- **Rate limiting** — per-tier per-minute limits: free 10/min, pro 100/min, admin 10,000/min; `X-RateLimit-*` headers
- **Multi-tenant** — tenant CRUD (`POST /tenants`); all resources scoped by tenant: scan history, notifications, webhooks, audit log; `GET /tenants/:id/usage`
- **Cost tracking** — per-scan token/cost estimates by provider rate; `GET /costs` (keyId/provider/date filters + aggregate)
- **Usage dashboard** — `GET /dashboard`: live scan feed, provider health, active keys, scan counts (today/week/month), risk distribution
- **Webhooks** — `POST /webhooks`; `scan.complete` / `scan.failed` / `job.complete` events; HMAC-SHA256 signing; per-webhook retry config (maxAttempts 1–5, retryDelayMs); rate limiting (FAULTLINE_WEBHOOK_RATE_LIMIT); circuit breaker (FAULTLINE_WEBHOOK_CIRCUIT_THRESHOLD/COOLDOWN_MS); delivery log + dashboard
- **Batch scanning** — `POST /scan/batch` (1–10 texts, concurrent, partial failure semantics); see [docs/ci-integration.md](docs/ci-integration.md)
- **Scan comparison** — `POST /scan/compare`: diff two scan results (new/removed claims, verdict changes, trust score delta)
- **Caching** — SHA-256 content-hash cache; 24h TTL (env `FAULTLINE_CACHE_TTL_MS`); `X-Cache: HIT/MISS` header; `GET /cache/stats`, `DELETE /cache`
- **Scheduled jobs** — `POST /jobs`: recurring scans on a `*/N * * * *` cron schedule; results dispatched to `webhookUrl`
- **Provider failover** — automatic chain Gemini → OpenAI → Claude → Perplexity → Mock; circuit breaker trips after 5 failures, resets after 5 minutes; `503` when all providers down
- **Scan history** — `GET /scans/search?q=` full-text; stale scan detection (`GET /scans/stale`); usage analytics (`GET /scans/usage`); bulk pruning (`DELETE /scans/stale`); hygiene dashboard; `faultline scans` CLI
- **Industry compliance templates** — HIPAA / SOX+FINRA / FERPA / Government; `POST /scan/compliance/:template`; custom template upload
- **Bulk import** — `POST /scan/bulk` (ZIP of documents → async job); `GET /jobs/:id/progress` (percentage + per-file status + summary)
- **Monitoring** — `GET /health/deep` (subsystem status + provider config flags), `GET /metrics` (Prometheus text), `GET /status` (HTML)
- **Swagger UI** — `GET /docs` (interactive OpenAPI 3.0), `GET /docs/json`, `GET /docs/yaml`
- **Claim search** — `GET /claims?text=&verdict=&from=&to=&source=` full-text claim index search
- **GDPR compliance** — `GET /tenants/:id/export` (Article 15, admin-gated): ZIP archive with manifest, scan-history, audit-log (NDJSON), notifications, webhooks, usage, costs, schedules; `DELETE /tenants/:id/data` (Article 17, admin-gated): erases all PII across 8 data categories for a tenant; idempotent; tenant record preserved
- **i18n** — send `Accept-Language: es` or `Accept-Language: fr` for localized error messages; defaults to English

---

## Quick Start (CLI)

**Step 1:** Get a free Gemini key (no credit card): [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

**Step 2:**

```bash
export GEMINI_API_KEY="your-key"
npx @nxtg/faultline scan --input your-ai-output.txt --provider gemini
```

**Expected output:**

```
=== FAULTLINE COMPLIANCE REPORT ===

Provider:     Google Gemini
Overall Risk: HIGH
EU Risk Tier: HIGH

--- Claim Verifications ---
  [OK] c1: supported     — Confirmed by census data. (confidence: 0.82)
  [!!] c2: contradicted  — Audit found significant bias. (confidence: 0.91)
  [??] c3: mixed         — Evidence varies by region. (confidence: 0.63)

--- Triggered EU AI Act Articles ---
  Annex III §4: Employment and recruitment AI (affects: c2)

--- Recommended Mitigations ---
  High-risk domain detected. Ensure a risk management system is in place (Article 9).
```

**Other providers:**

```bash
export ANTHROPIC_API_KEY="..."
npx @nxtg/faultline scan --input doc.txt --provider claude

export OPENAI_API_KEY="..."
npx @nxtg/faultline scan --input doc.txt --provider openai

export PERPLEXITY_API_KEY="..."
npx @nxtg/faultline scan --input doc.txt --provider perplexity
```

**Scan a PDF or image:**

```bash
npx @nxtg/faultline scan --file report.pdf --provider gemini
npx @nxtg/faultline scan --file screenshot.png --provider gemini
```

**CI gate (no API key required):**

```bash
npx @nxtg/faultline scan --input doc.txt --provider mock --fail-on high
# exit 0 = pass, exit 1 = HIGH or CRITICAL findings found
```

---

## API Quick Start

Start the server:

```bash
cd packages/api
FAULTLINE_API_KEY=your-key npm run dev
# Server listening on http://localhost:3000
```

Scan a text payload:

```bash
curl -X POST http://localhost:3000/scan \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "GPT-4 has 1 trillion parameters.", "provider": "mock"}'
```

Upload a PDF or image for OCR scanning:

```bash
curl -X POST http://localhost:3000/scan/upload \
  -H "x-api-key: your-key" \
  -F "file=@report.pdf"
```

Generate a compliance report (PDF):

```bash
curl -X POST http://localhost:3000/scan/report \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "AI system processes medical records.", "provider": "mock"}' \
  --output compliance-report.pdf
```

Create an API key:

```bash
curl -X POST http://localhost:3000/keys \
  -H "x-api-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-pipeline", "tier": "pro", "permissions": ["scan", "report"]}'
```

Register a webhook:

```bash
curl -X POST http://localhost:3000/webhooks \
  -H "x-api-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-service.example.com/hooks/faultline", "events": ["scan.complete"]}'
```

View the usage dashboard:

```bash
curl http://localhost:3000/dashboard -H "x-api-key: your-key"
```

Full API reference: [`packages/api/docs/openapi.yaml`](packages/api/docs/openapi.yaml)

---

## Architecture

```
Input: AI-generated text / PDF / image
  │
  ▼ Extract
  Atomic claims (fact / opinion / interpretation, importance 1–5)
  │
  ▼ Verify
  Per-claim verdict (supported / contradicted / mixed / unverified)
  Confidence score (0.0–1.0)
  │
  ▼ Synthesize
  Weakest-link detection — which claim collapses the argument?
  Claim dependency graph — how do failures propagate?
  │
  ▼ Refine
  EU AI Act risk tier, triggered articles, mitigations
  Critique of failed claims + improved prompt generation
```

**Monorepo layout:**

```
packages/
├── cli/                  # @nxtg/faultline — published CLI + scan engine
│   ├── cli/              # Commands: scan, report, watch, critique, graph, weakest…
│   ├── providers/        # Gemini, Claude, OpenAI, Perplexity, Mock adapters
│   ├── compliance/       # EU AI Act risk categories (Articles 5–7, Annex III)
│   ├── rules/            # YAML rule engine (PII, bias, toxicity)
│   ├── analysis/         # Weakest-link scoring, claim graph
│   ├── history/          # Scan history + trend analysis
│   └── templates/        # Red-team prompt template library
├── api/                  # @nxtg/faultline-api — Fastify v5 REST API
│   ├── routes/           # /scan, /batch, /compare, /upload, /report, /keys, /jobs, /cache, /metrics…
│   ├── store/            # KeyStore, AuditLogger, CircuitBreaker, ScanCache, JobScheduler…
│   ├── plugins/          # Auth, rate limiting
│   └── docs/             # OpenAPI 3.1 spec (openapi.yaml)
├── sdk/                  # @nxtg/faultline-sdk — TypeScript client SDK
└── web/                  # @nxtg/faultline-web — React visualization dashboard
sdks/
└── python/               # faultline-sdk — Python client (PyPI-ready, zero runtime deps)
```

**Stores (API layer):**

| Store | Responsibility |
|---|---|
| `KeyStore` | API key CRUD, permission scoping |
| `AuditLogger` | SHA-256 request hashing, append-only log |
| `UsageMeter` | Per-key daily scan counts |
| `ScanAnalytics` | Aggregated risk distribution, trend data |
| `RateLimiter` | Per-tier daily limits with midnight UTC rollover |
| `WebhookStore` | Endpoint registration, HMAC secret management |
| `ScanCache` | SHA-256 content-hash cache, configurable TTL, hit-rate stats |
| `CircuitBreaker` | Per-provider failure counting, cooldown management |
| `JobStore` + `JobScheduler` | Recurring scan job CRUD, cron-based background execution |
| `TenantStore` | Tenant CRUD, API key → tenant association |
| `CostStore` | Per-scan token/cost recording, provider rate table, aggregate queries |
| `ScanHistoryStore` | Last 1000 scans (newest-first), full-text + filter search, cursor pagination |
| `ComplianceTemplateStore` | HIPAA/SOX/FERPA/Gov templates + custom template registry |
| `BulkJobStore` | Async ZIP scan jobs: progress tracking, per-file results, summary report |

---

## CLI Commands

```bash
# Scan
faultline scan --input doc.txt --provider gemini
faultline scan --input doc.txt --provider claude --output-format markdown
faultline scan --input doc.txt --sarif                 # writes results.sarif
faultline scan --input doc.txt --fail-on high          # exit 1 if high/critical
faultline scan --file document.pdf                     # PDF/image via OCR
faultline scan --dir ./docs --glob "*.md"              # batch scan directory

# Compare two texts side-by-side
faultline compare --before "old-doc.txt" --after "new-doc.txt" --provider mock
faultline compare --before "old text" --after "new text" --output-format json

# Forensics
faultline weakest  --input doc.txt --provider gemini   # weakest-link claim
faultline graph    --input doc.txt --format mermaid    # claim dependency graph
faultline critique --input doc.txt --provider gemini   # critique + improved prompt

# Red-team
faultline scan --templates injection,bias              # template library
faultline templates list --category injection

# History + trends
faultline history
faultline trend --file doc.txt

# Utilities
faultline rules                                        # list detection rules
faultline init                                         # generate .faultlinerc.json
faultline --version
faultline --help
```

---

## SDKs

### TypeScript / Node.js

```bash
npm install @nxtg/faultline-sdk
```

```typescript
import { FaultlineClient } from '@nxtg/faultline-sdk';

const client = new FaultlineClient({ apiKey: 'your-key', baseUrl: 'http://localhost:3000' });

const result = await client.scan('GPT-4 has 1 trillion parameters.');
console.log(result.overallRisk); // 'low' | 'medium' | 'high' | 'critical'

const batch = await client.scanBatch(['claim one', 'claim two'], 'gemini');
console.log(batch.succeeded, '/', batch.total);
```

### Python

```bash
pip install faultline-sdk
```

```python
from faultline_sdk import FaultlineClient

client = FaultlineClient(api_key="your-key", base_url="http://localhost:3000")
result = client.scan("GPT-4 has 1 trillion parameters.")
print(result.overall_risk)  # 'low' | 'medium' | 'high' | 'critical'
```

### GitHub Action

```yaml
- uses: nxtg-ai/faultline-pro/packages/cli@main
  with:
    input-file: docs/release-notes.md
    provider: gemini
    fail-on: high
    upload-sarif: 'true'
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    FAULTLINE_API_KEY: ${{ secrets.FAULTLINE_API_KEY }}
```

---

## CI Integration

See [docs/ci-integration.md](docs/ci-integration.md) for:
- GitHub Actions workflow (real provider + mock)
- GitLab CI example
- Pre-commit hook for staged files
- API-based batch scanning with CI gate logic
- Risk level reference table

**Quick GitHub Actions example:**

```yaml
- name: Faultline Claim Audit
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  run: |
    npx @nxtg/faultline scan \
      --input docs/release-notes.md \
      --provider gemini \
      --fail-on high \
      --output-format sarif > results.sarif
```

---

## What Makes This Different

Promptfoo tests your prompts. DeepEval scores your RAG pipeline. **Faultline audits what the AI actually said.**

| | Faultline | Promptfoo | DeepEval |
|---|---|---|---|
| Decomposes AI output into atomic claims | Yes | No | No |
| Verifies claims against live evidence | Yes | No | No |
| Confidence calibration per claim | Yes | No | No |
| Weakest-link detection | Yes | No | No |
| EU AI Act risk classification | Yes | No | No |
| Claim dependency graph | Yes | No | No |
| Scan comparison (diff two outputs) | Yes | No | No |
| FM-agnostic (Gemini / Claude / OpenAI / Perplexity) | Yes | Yes | No (Python) |
| Provider auto-failover + circuit breaker | Yes | No | No |
| Enterprise API with audit trail + caching | Yes | No | No |
| TypeScript + Python SDK | Yes | No | No |

---

## EU AI Act — August 2026

The EU AI Act's high-risk AI system requirements take effect August 2026. Faultline maps each verified claim to the applicable risk tier:

- **Unacceptable risk** — Article 5 prohibited practices (social scoring, real-time biometric surveillance)
- **High risk** — Annex III systems (medical, recruitment, credit, law enforcement)
- **Limited risk** — transparency obligations (deepfakes, chatbots)
- **Minimal risk** — general-purpose AI outputs with no special obligations

Each scan produces a compliance report listing triggered articles and recommended mitigations.

---

Built by [NextGen AI](https://nxtg.ai)
