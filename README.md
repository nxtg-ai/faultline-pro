# Faultline — AI Claim Forensics

Forensic verification for AI-generated text. Faultline decomposes output into atomic claims, verifies each against live evidence, maps findings to EU AI Act risk tiers, and enforces a CI gate before hallucinations reach production.

[![CI](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nxtg/faultline.svg)](https://www.npmjs.com/package/@nxtg/faultline)
[![Tests](https://img.shields.io/badge/tests-1140%20passing-brightgreen)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

---

## What It Does

| Capability | Description |
|---|---|
| Atomic claim extraction | Decomposes AI output into fact / opinion / interpretation with importance scoring |
| Per-claim verification | Verdict: supported / contradicted / mixed / unverified + confidence score |
| EU AI Act compliance | Risk tier mapping (Unacceptable / High / Limited / Minimal), triggered articles, mitigations |
| Weakest-link detection | Per-claim fragility scoring — finds the claim that most undermines the argument |
| Claim dependency graph | Mermaid and Graphviz DOT visualizations grouping claims by risk tier |
| Rules engine | YAML-defined rules; built-in PII, bias, toxicity rulesets |
| CI gate | `--fail-on high` returns exit code 1; SARIF output for GitHub Code Scanning |
| Enterprise API | REST API with key management, audit trail, rate limiting, webhooks, usage metering |

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
- **API key management** — `POST /keys`, `GET /keys`, `DELETE /keys/:id`; scoped permissions (scan / report / upload / admin / pro)
- **Audit trail** — SHA-256 input hash logged on every request via `onResponse` hook
- **Usage metering** — per-key daily scan counts via `GET /usage`
- **Rate limiting** — per-tier daily limits: free 10/day, pro 1,000/day, admin 10,000/day; `X-RateLimit-*` headers on all scan responses
- **Usage dashboard** — `GET /dashboard`: scan counts (today/week/month), risk distribution, key usage breakdown
- **Webhooks** — `POST /webhooks` to register endpoints; `scan.complete` / `scan.failed` events; HMAC-SHA256 signing in `X-Faultline-Signature`; 3-attempt retry with backoff
- **Batch scanning** — `faultline scan --dir <path>` scans all files in a directory; API parallel patterns documented in [docs/ci-integration.md](docs/ci-integration.md)
- **OpenAPI 3.1 spec** — [`packages/api/docs/openapi.yaml`](packages/api/docs/openapi.yaml), 12 routes, all schemas defined

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
│   ├── routes/           # /scan, /scan/upload, /scan/report, /keys, /usage, /dashboard, /webhooks
│   ├── plugins/          # Auth, rate limiting, audit logger
│   └── docs/             # OpenAPI 3.1 spec (openapi.yaml)
└── web/                  # @nxtg/faultline-web — React visualization dashboard
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
| FM-agnostic (Gemini / Claude / OpenAI / Perplexity) | Yes | Yes | No (Python) |
| Enterprise API with audit trail | Yes | No | No |

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
