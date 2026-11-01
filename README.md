# Faultline — We check the receipts on AI output.

**Future-proof your agent stack. Independent of every model vendor: NXTG.ai does not build the models Faultline checks.**

Faultline decomposes AI-generated output into atomic claims, verifies each against live evidence, and can fail a CI build on the result.

[![Release stage: alpha](https://img.shields.io/badge/stage-alpha-orange.svg)](https://github.com/nxtg-ai/faultline-pro/blob/main/CHANGELOG.md)
[![CI](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nxtg/faultline.svg)](https://www.npmjs.com/package/@nxtg/faultline)
[![Tests](https://img.shields.io/badge/tests-4909%20passing-brightgreen)](#tests-and-quality)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

> **Release stage: alpha.** Usable today, with sharp edges. No accuracy figure is claimed: verdict accuracy has not yet been re-graded independently. Anything may change before 1.0.

### Governance records the API produces

The hosted API ships three governance records as code: a risk register export (`POST /scan/risk-register`), a tamper-evident audit log manifest (`GET /audit/log/manifest`, admin keys only), and human sign-off records (`POST /scans/:id/approve`, `GET /scans/:id/approvals`). In the manifest, each chain hash is the SHA-256 of the entry hash followed by the previous chain hash. You can recompute the chain with `openssl dgst -sha256` alone, with no Faultline tooling.

---

## Current Status (checked 2026-10-01)

| Item | State | How checked |
|---|---|---|
| CLI on npm | `@nxtg/faultline` 0.11.1 | `npm view @nxtg/faultline version` |
| Hosted API | `https://faultline-api.fly.dev`, version 0.11.1 | `curl https://faultline-api.fly.dev/health` |
| Web app | https://faultline.nxtg.ai (separate repo, `faultline-web`, on Vercel) | live pricing page read 2026-10-01 |
| Plans | Free 5 scans/month. Personal $19/mo, 100 scans. Pro $49/mo, 500 scans. Enterprise: custom, scan allowance set in the contract | https://faultline.nxtg.ai/pricing |
| Multi-model consensus | **Enterprise only.** The API returns `403 consensus_not_in_plan` to any caller below Enterprise, before the stream opens | `packages/api/src/plugins/consensus-entitlement.ts`; live check by fp 2026-10-01 (pro, personal and free 403, enterprise 200, mock provider) |
| `POST /critique` | Needs an API key. Rate limited. Covered by the provider-spend cap and written to the spend ledger | `packages/api/src/routes/critique.ts` |
| Provider-spend cap | $100/month. The ledger records every managed scan and critique. **Enforcement ships dormant** (`FAULTLINE_PROVIDER_SPEND_CAP=on` turns it on) and is off in production | `docs/provider-spend-cap.md`; `GET /usage` showed `providerBudget.enforced=false` on 2026-10-01 |
| Per-key monthly scan cap (API side) | Dormant (`FAULTLINE_USAGE_CAP`). Plan limits above are enforced by faultline-web | `docs/usage-cap.md` |

---

## What It Does

| Capability | Description |
|---|---|
| Atomic claim extraction | Decomposes AI output into fact / opinion / interpretation with importance scoring |
| Per-claim verification | Verdict: supported / contradicted / mixed / unverified + confidence score |
| Scan comparison | `POST /scan/compare` + `faultline compare` — new/removed claims, verdict changes, trust score delta |
| CI gate | `faultline compliance-report --ci` exits 1 when the scan's overall risk is high or critical, an article check in the report has failed, the report's domain checklist item has not passed, or the report score is below `--threshold`; `--strict` also fails on partly met article checks and on checklist items not assessed. Otherwise it exits 0 |
| Weakest-link detection | Per-claim fragility scoring — finds the claim that most undermines the argument |
| Claim dependency graph | Mermaid and Graphviz DOT visualizations |
| Rules engine | YAML-defined rules; built-in PII, bias, toxicity rulesets |
| CI gate | `--fail-on high` returns exit code 1; SARIF output for GitHub Code Scanning |
| Enterprise API | REST API (about 190 routes) with key management, audit trail, rate limiting, webhooks, batch scanning, caching |
| Provider failover | Automatic chain Gemini → OpenAI → Claude → Perplexity; circuit breaker with 5-min cooldown |
| Monitoring | `GET /health/deep`, `GET /metrics` (Prometheus), `GET /status` (HTML dashboard) |
| Scheduled jobs | `POST /jobs` — recurring scans on a cron schedule with webhook delivery |
| Integrations | Python client source in `sdks/python`, MCP server `packages/mcp`, Terraform provider `packages/terraform-provider`, GitHub Action `nxtg-ai/faultline-action` (see [SDKs](#sdks-and-integrations)) |
| Multi-tenant | Tenant CRUD, API key association, per-tenant usage aggregation |
| Cost tracking | Per-scan token/cost estimation; `GET /costs` with provider/tenant/date filters |
| Scan history | `GET /scans/search` — full-text across your API key's past scans (admin key: all), cursor pagination |
| Rule templates (HIPAA, SOX, FERPA, Gov) | HIPAA / SOX / FERPA / Gov templates; `POST /scan/compliance/:template` |
| Bulk import | `POST /scan/bulk` — ZIP of documents, async job, `GET /jobs/:id/progress` |
| Swagger UI | `GET /docs` — interactive OpenAPI 3.0 spec with Try-it for every endpoint |
| Claim explainability | `GET /claims/:id/explain` — reasoning chain, evidence found, actionable suggestions |
| Scan diff | `POST /scan/diff` — scan two texts, inline diff (added/removed/changed/unchanged) |
| Deadline list | `GET /compliance/deadlines` — a list of upcoming regulatory dates with days until each; no assessment |
| Deadline keyword check | `POST /compliance/scan-check` — match claim text against keywords tied to those dates |
| i18n | `Accept-Language: es/fr/en` — localized error messages and report labels (EN/ES/FR) |
| Property-based tests | `fast-check` oracle coverage: confidence bounds, dedup invariants, cost aggregation, sort stability |
| GDPR data requests (Article 15 export, Article 17 erasure) | Article 15 export (`GET /tenants/:id/export` → ZIP) + Article 17 erasure (`DELETE /tenants/:id/data`) covering scan history, audit log, notifications, webhooks, costs, schedules |
| Multi-model consensus | `POST /scan/stream` with `pipelineConfig.consensus: true`. Enterprise only, enforced server-side (403 below Enterprise) |
| Claim critique | `POST /critique`: critique plus improved prompt for failed claims; API key, rate limit and provider-spend cap apply |
| Real-time scan streaming | `GET /scan/stream?text=...&provider=mock` — Server-Sent Events; progressive per-claim delivery via `onClaimVerified` callback; streams `start` → `claim_verified` × N → `complete`; no polling required |
| Mutation-tested core | Stryker gate (CRUCIBLE Gate 6, threshold 80%): `cli/scan.ts` 81.97%, `stream.ts` 88.64%, `compliance-report.ts` 80.81%, GDPR stores 80.94% to 96.81%. Last measured 2026-03-21 to 2026-04-17 per `docs/mutation-testing.md`; not re-run since |

---

## Features

### Providers

| Provider | Requires | Best For |
|---|---|---|
| Gemini | `GEMINI_API_KEY` | Live web grounding (free key available) |
| Perplexity | `PERPLEXITY_API_KEY` | Real-time search-native verification |
| OpenAI | `OPENAI_API_KEY` | Training-data verification, GPT ecosystem |
| Claude | `ANTHROPIC_API_KEY` | Training-data verification, reasoning-heavy docs |
| Mock | None | CI pipelines, unit tests, offline development. Returns synthetic verdicts and verifies nothing; the CLI never falls back to it silently |

Switch providers with `--provider <name>`. No code changes required. With no provider key and no `FAULTLINE_API_KEY`, the CLI says nothing was checked and exits instead of inventing a verdict (since v0.10.1). With `FAULTLINE_API_KEY` set, `guard` and the MCP server run the scan on the hosted API with server-side provider keys.

### Document Ingestion
- **PDF + image upload with OCR** — `faultline scan --file document.pdf` or `POST /scan/upload`; powered by `pdf-parse` + `tesseract.js`
- **Text files** — `--input doc.txt`
- **Directories** — `--dir ./docs --glob "*.md"`

### Reports and Rules
- **Scan reports (PDF)** via `POST /scan/report`
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
- **Usage metering**: per-key daily scan counts and monthly quota position via `GET /usage` (admin keys also see the provider-spend budget)
- **Rate limiting** — per-tier per-minute limits: free 10/min, pro 100/min, admin 10,000/min; `X-RateLimit-*` headers
- **Spend and quota gates**: a per-key monthly scan quota (`402`) and a fleet provider-spend cap (`503`), both dormant until switched on; the spend ledger records every managed scan and `/critique` call either way
- **Multi-tenant** — tenant CRUD (`POST /tenants`); all resources scoped by tenant: scan history, notifications, webhooks, audit log; `GET /tenants/:id/usage`
- **Cost tracking** — per-scan token/cost estimates by provider rate; `GET /costs` (keyId/provider/date filters + aggregate)
- **Usage dashboard** — `GET /dashboard`: live scan feed, provider health, active keys, scan counts (today/week/month), risk distribution
- **Webhooks** — `POST /webhooks`; `scan.complete` / `scan.failed` / `job.complete` events; HMAC-SHA256 signing; per-webhook retry config (maxAttempts 1–5, retryDelayMs); rate limiting (FAULTLINE_WEBHOOK_RATE_LIMIT); circuit breaker (FAULTLINE_WEBHOOK_CIRCUIT_THRESHOLD/COOLDOWN_MS); delivery log + dashboard
- **Batch scanning** — `POST /scan/batch` (1–10 texts, concurrent, partial failure semantics); see [docs/ci-integration.md](docs/ci-integration.md)
- **Scan comparison** — `POST /scan/compare`: diff two scan results (new/removed claims, verdict changes, trust score delta)
- **Caching** — SHA-256 content-hash cache; 24h TTL (env `FAULTLINE_CACHE_TTL_MS`); `X-Cache: HIT/MISS` header; `GET /cache/stats`, `DELETE /cache`
- **Scheduled jobs** — `POST /jobs`: recurring scans on a `*/N * * * *` cron schedule; results dispatched to `webhookUrl`
- **Provider failover** — automatic chain Gemini → OpenAI → Claude → Perplexity → Mock; circuit breaker trips after 5 failures, resets after 5 minutes; `503` when all providers down
- **Scan history** — private per API key (the admin key sees all); `GET /scans/search?q=` full-text; stale scan detection (`GET /scans/stale`); usage analytics (`GET /scans/usage`); bulk pruning (`DELETE /scans/stale`); hygiene dashboard; `faultline scans` CLI
- **Rule templates (HIPAA, SOX, FERPA, Gov)** — HIPAA / SOX+FINRA / FERPA / Government; `POST /scan/compliance/:template`; custom template upload
- **Bulk import** — `POST /scan/bulk` (ZIP of documents → async job); `GET /jobs/:id/progress` (percentage + per-file status + summary)
- **Monitoring** — `GET /health/deep` (subsystem status + provider config flags), `GET /metrics` (Prometheus text), `GET /status` (HTML)
- **Swagger UI** — `GET /docs` (interactive OpenAPI 3.0), `GET /docs/json`, `GET /docs/yaml`
- **Claim search** — `GET /claims?text=&verdict=&from=&to=&source=` full-text claim index search
- **GDPR data requests (Article 15 export, Article 17 erasure)** — `GET /tenants/:id/export` (Article 15, admin-gated): ZIP archive with manifest, scan-history, audit-log (NDJSON), notifications, webhooks, usage, costs, schedules; `DELETE /tenants/:id/data` (Article 17, admin-gated): erases all PII across 8 data categories for a tenant; idempotent; tenant record preserved
- **i18n** — send `Accept-Language: es` or `Accept-Language: fr` for localized error messages; defaults to English

---

## Quick Start (CLI)

**Step 1:** Get a free Gemini key (no credit card): [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

**Step 2:**

```bash
export GEMINI_API_KEY="your-key"
npx @nxtg/faultline scan --input your-ai-output.txt --provider gemini
```

**Expected output (excerpt):**

```
Provider:     Google Gemini
Overall Risk: HIGH

--- Claim Verifications ---
  [OK] c1: supported     — Confirmed by census data. (confidence: 0.82)
  [!!] c2: contradicted  — Audit found significant bias. (confidence: 0.91)
  [??] c3: mixed         — Evidence varies by region. (confidence: 0.63)
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

**Check piped agent output:**

```bash
claude -p "..." | npx @nxtg/faultline guard --fail-on refuted
```

**CI gate (no API key required, synthetic verdicts, wiring test only):**

```bash
npx @nxtg/faultline scan --input doc.txt --provider mock --fail-on high
# exit 0 = pass, exit 1 = HIGH or CRITICAL findings found
# --provider mock verifies nothing; use a real provider for a real gate
```

---

## API Quick Start

Start the server:

```bash
cd packages/api
FAULTLINE_API_KEY=your-key npm run dev
# Server listening on http://localhost:3010
```

Scan a text payload:

```bash
curl -X POST http://localhost:3010/scan \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "GPT-4 has 1 trillion parameters.", "provider": "mock"}'
```

Upload a PDF or image for OCR scanning:

```bash
curl -X POST http://localhost:3010/scan/upload \
  -H "x-api-key: your-key" \
  -F "file=@report.pdf"
```

Generate a PDF report of a scan:

```bash
curl -X POST http://localhost:3010/scan/report \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "AI system processes medical records.", "provider": "mock"}' \
  --output scan-report.pdf
```

Create an API key:

```bash
curl -X POST http://localhost:3010/keys \
  -H "x-api-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-pipeline", "tier": "pro", "permissions": ["scan", "report"]}'
```

Register a webhook:

```bash
curl -X POST http://localhost:3010/webhooks \
  -H "x-api-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-service.example.com/hooks/faultline", "events": ["scan.complete"]}'
```

View the usage dashboard:

```bash
curl http://localhost:3010/dashboard -H "x-api-key: your-key"
```

Hosted API: `https://faultline-api.fly.dev` (`GET /health` needs no key). Interactive docs at `GET /docs` on a running server.

Check consensus gating (needs an API key; the mock provider spends nothing):

```bash
curl -X POST http://localhost:3010/scan/stream \
  -H "x-api-key: your-key" -H "Content-Type: application/json" \
  -d '{"text": "x", "provider": "mock", "pipelineConfig": {"consensus": true}}'
# below Enterprise: 403 {"error":"consensus_not_in_plan", ...}
```

Route reference: [`packages/api/README.md`](packages/api/README.md). The spec at [`packages/api/docs/openapi.yaml`](packages/api/docs/openapi.yaml) declares version 0.7.0 and has 48 paths, so it covers only part of the current routes.

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
  Critique of failed claims + improved prompt generation
```

**Monorepo layout:**

```
packages/
├── cli/                  # @nxtg/faultline (npm 0.11.1): CLI + scan engine
│   ├── cli/              # Commands: scan, guard, report, watch, critique, graph, weakest, compare…
│   ├── providers/        # Gemini, Claude, OpenAI, Perplexity, Mock adapters
│   ├── compliance/       # EU AI Act risk categories
│   ├── rules/            # Rule engine (PII, bias, shell injection…)
│   ├── analysis/         # Weakest-link scoring, claim graph
│   ├── history/          # Scan history store
│   ├── consensus/        # Multi-model consensus engine
│   └── templates/        # Red-team prompt template library
├── api/                  # @nxtg/faultline-api (not published to npm): Fastify v5 REST API, deployed on Fly
│   ├── src/routes/       # /scan, /scan/stream, /critique, /keys, /usage, /jobs…
│   ├── src/store/        # KeyStore, AuditLogger, CircuitBreaker, ScanCache, provider-spend ledger…
│   ├── src/plugins/      # Auth, rate limit, usage cap, provider-spend cap, consensus entitlement
│   └── docs/             # openapi.yaml (partial, version 0.7.0)
├── mcp/                  # @nxtg/faultline-mcp 0.1.0: MCP server (not on npm as of 2026-10-01)
├── terraform-provider/   # Go Terraform provider
└── web/                  # @nxtg/faultline-web: original React/Vite visualization app (Kaggle origin)
sdks/
└── python/               # Python client source (pyproject name faultline-sdk 0.5.0; not confirmed on PyPI, see SDKs)
```

The production web app at https://faultline.nxtg.ai is a separate repo (`faultline-web`, Next.js on Vercel). It is not in this monorepo.

**Stores (API layer):**

| Store | Responsibility |
|---|---|
| `KeyStore` | API key CRUD, permission scoping |
| `AuditLogger` | SHA-256 request hashing, append-only log |
| `UsageMeter` | Per-key daily scan counts |
| `ScanAnalytics` | Aggregated risk distribution, trend data |
| `RateLimiter` | Per-tier per-minute limits |
| `WebhookStore` | Endpoint registration, HMAC secret management |
| `ScanCache` | SHA-256 content-hash cache, configurable TTL, hit-rate stats |
| `CircuitBreaker` | Per-provider failure counting, cooldown management |
| `JobStore` + `JobScheduler` | Recurring scan job CRUD, cron-based background execution |
| `TenantStore` | Tenant CRUD, API key → tenant association |
| `CostStore` | Per-scan token/cost recording, provider rate table, aggregate queries |
| `ProviderSpend` (`store/provider-spend.ts`) | Append-only USD ledger and monthly rollup behind the $100/month provider-spend cap |
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

# Agent output
claude -p "..." | faultline guard --fail-on refuted    # verify piped text, gate on the verdict

# Red-team
faultline scan --templates injection,bias              # template library
faultline templates list --category injection

# History + trends
faultline history
faultline trend --file doc.txt

# Utilities
faultline stats                                      # npm download stats
faultline stats --costs --api-url http://localhost:3010 --api-key <key>
faultline rules                                        # list detection rules
faultline init                                         # generate .faultlinerc.json
faultline --version
faultline --help
```

---

## SDKs and Integrations

### TypeScript / Node.js

There is no TypeScript SDK package in this repo and `@nxtg/faultline-sdk` is not on npm (`npm view` returned 404 on 2026-10-01). Call the REST API directly, or use the CLI (`@nxtg/faultline`).

```typescript
const res = await fetch('https://faultline-api.fly.dev/scan', {
  method: 'POST',
  headers: { 'x-api-key': process.env.FAULTLINE_API_KEY!, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'GPT-4 has 1 trillion parameters.', provider: 'gemini' }),
});
const result = await res.json();
console.log(result.overallRisk); // 'low' | 'medium' | 'high' | 'critical'
```

### Python

Source is in [`sdks/python`](sdks/python) (pyproject name `faultline-sdk`, version 0.5.0, zero runtime dependencies). Install from a checkout:

```bash
pip install ./sdks/python
```

Do not run `pip install faultline-sdk`. On 2026-10-01 that name on PyPI (version 0.24.0) is an unrelated project (ML training checkpoints for "Faultline Cloud"). Whether this package was ever published to PyPI under a different name was not verified.

```python
from faultline_sdk import FaultlineClient

client = FaultlineClient(api_key="your-key", base_url="http://localhost:3010")
result = client.scan("GPT-4 has 1 trillion parameters.")
print(result.overall_risk)  # 'low' | 'medium' | 'high' | 'critical'
```

### MCP server

`packages/mcp` (`@nxtg/faultline-mcp` 0.1.0) exposes a `verify_claims` tool to Claude Code, Cursor and other MCP clients. It was not published to npm as of 2026-10-01 (`npm view` returned 404), so run it from a checkout. See [`packages/mcp/README.md`](packages/mcp/README.md).

### GitHub Action

The action lives in its own repo, `nxtg-ai/faultline-action` (tag `v1` exists).

```yaml
- uses: nxtg-ai/faultline-action@v1
  with:
    input: docs/release-notes.md
    fail-on: high
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
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
| Claim dependency graph | Yes | No | No |
| Scan comparison (diff two outputs) | Yes | No | No |
| FM-agnostic (Gemini / Claude / OpenAI / Perplexity) | Yes | Yes | No (Python) |
| Provider auto-failover + circuit breaker | Yes | No | No |
| Enterprise API with audit trail + caching | Yes | No | No |
| Python client + MCP server | Yes | No | No |

---

## Tests and Quality

Measured 2026-10-01 with `npx vitest run` in each package (all passing):

| Package | Test files | Tests |
|---|---|---|
| `packages/api` | 137 | 2,450 |
| `packages/cli` | 83 | 2,371 |
| `packages/mcp` | 3 | 49 |
| `packages/web` | 1 | 39 |
| Root `npm test` (all of the above) | 224 | 4,909 |
| `sdks/python` (`pytest`) | n/a | 100 |

Mutation scores are listed in the feature table above and were not re-measured on 2026-10-01.

---

Built by [NextGen AI](https://nxtg.ai)
