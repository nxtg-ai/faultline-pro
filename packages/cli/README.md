# Faultline Pro — AI Claim Forensics

[![npm version](https://img.shields.io/npm/v/@nxtg/faultline.svg)](https://www.npmjs.com/package/@nxtg/faultline)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![CI](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Forensic verification of AI-generated claims. Extract atomic facts, verify against live web data, risk-score your AI outputs.

---

## Quick Start

```bash
npm install -g @nxtg/faultline
export GEMINI_API_KEY=your-key
faultline scan --input report.txt
```

---

## What It Does

Faultline decomposes AI-generated text into atomic claims, then runs a four-phase forensic pipeline:

1. **Extract** — Break text into atomic claims classified by type (fact, interpretation, opinion) and importance (1--5).
2. **Verify** — Verify each claim against live web sources. Produce a verdict (supported, contradicted, mixed, unverified) with a calibrated confidence score.
3. **Synthesize** — Score overall risk (Low / Medium / High / Critical). Detect the weakest-link claim. Map claim dependencies into a graph.
4. **Refine** — Classify under EU AI Act risk tiers. Generate a critique of failed claims and an improved prompt that forces rigor.

---

## Features

### Core Forensics

- Atomic claim extraction with type classification (fact / interpretation / opinion)
- Per-claim verification against live web sources
- Confidence calibration (0--100)
- Weakest-link detection — find the claim that most undermines the argument
- Claim dependency graph (Mermaid output)
- Cross-scan claim trending and frequency tracking
- Verdict-change alerts (verified to unverified flips)
- Claim attribution chain with provenance confidence score

### Evidence and Sources

- URL validation with availability, relevance, and recency scoring (0--100)
- Source deduplication across scans (stable claim UUIDs)

### Risk Scoring

- Overall risk level: Low / Medium / High / Critical
- Seismic barometer visualization (CLI)
- Rules engine: PII detection, bias detection, toxicity detection, custom YAML rules

### Compliance

- EU AI Act risk classification (Article 6/9/13/14/15, Annex III)
- EU AI Act full PDF report generation (`POST /scan/eu-report`)
- SARIF output for GitHub Code Scanning

### Providers

- **Gemini** (Google AI Studio) — live web grounding
- **OpenAI** (GPT-4) — complex reasoning
- **Claude** (Anthropic) — nuanced analysis
- **Perplexity** — search-native, real-time grounding
- **Mock** — testing and CI, zero latency
- Provider auto-failover with circuit breaker (5-failure threshold, 5-min cooldown)
- Custom provider plugin interface

### CLI

- `scan` — scan a file, text, PDF, or image
- `report` — generate PDF compliance report
- `watch` — continuous monitoring
- `critique` — generate improved prompts
- `--lang` — output in English, Spanish, or French
- `--template` — reusable scan configurations
- `--output-format` — sarif, json, markdown, html

### API

- REST API (Fastify v5) — 35+ endpoints
- GraphQL API (`POST /graphql`)
- Batch scanning (`POST /scan/batch`)
- Webhooks with HMAC-SHA256 signing
- Caching with `X-Cache` HIT/MISS headers
- Scheduled scan jobs (cron expressions)
- Scan comparison (trust score delta)
- i18n (`Accept-Language` header, RFC 7231 quality-factor parsing)

### Enterprise

- API key management with tiers (free / pro / admin)
- Rate limiting (10/min free, 100/min pro)
- Audit trail (SHA-256 input hashing, append-only log)
- Usage metering with dashboard
- Prometheus metrics (`GET /metrics`)
- CORS allowlist

---

## Providers

| Provider | Best For | Requires |
|---|---|---|
| `gemini` | General verification, grounding | `GEMINI_API_KEY` |
| `openai` | Complex reasoning, GPT-4 | `OPENAI_API_KEY` |
| `claude` | Nuanced analysis | `ANTHROPIC_API_KEY` |
| `perplexity` | Real-time search grounding | `PERPLEXITY_API_KEY` |
| `mock` | Testing, CI/CD | None |

Switch providers with `--provider <name>`. No code changes required.

---

## EU AI Act Compliance

Faultline classifies AI outputs by EU AI Act risk tier. High-risk outputs (Article 6 / Annex III) receive article-level findings with recommended mitigations. `POST /scan/eu-report` generates an audit-ready PDF covering Articles 6, 9, 13, 14, and 15.

The EU AI Act's high-risk AI system requirements take effect **August 2026**. Run Faultline against your AI outputs now to identify compliance gaps before the deadline.

---

## GitHub Action

```yaml
- uses: nxtg-ai/faultline-pro@v0.2.0
  with:
    api-key: ${{ secrets.GEMINI_API_KEY }}
    fail-on: high
    path: ./reports/
```

See [`examples/ci-integration.yml`](https://github.com/nxtg-ai/faultline-pro/blob/main/examples/ci-integration.yml) for a full workflow with SARIF upload to GitHub Code Scanning.

---

## CLI Usage

```bash
# Basic scan
faultline scan --input doc.txt --provider gemini

# Output formats
faultline scan --input doc.txt --output-format json
faultline scan --input doc.txt --sarif          # writes results.sarif

# CI gate — exit 1 on high/critical risk
faultline scan --input doc.txt --provider mock --fail-on high

# PDF / image scan (OCR)
faultline scan --file document.pdf --provider gemini

# Forensics
faultline weakest  --input doc.txt --provider gemini
faultline graph    --input doc.txt --format mermaid
faultline critique --input doc.txt --provider gemini

# Compare two texts
faultline compare --before old.txt --after new.txt --provider mock

# Multi-language output
faultline scan --input doc.txt --provider gemini --lang es

# Reusable scan templates
faultline scan --input doc.txt --template strict-compliance
```

---

## API Quick Start

```bash
# Start the API server
npx tsx packages/api/src/index.ts

# Scan
curl -X POST http://localhost:3000/scan \
  -H "x-api-key: $FAULTLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your AI-generated text here", "provider": "gemini"}'
```

See the full [OpenAPI 3.1 spec](https://github.com/nxtg-ai/faultline-pro/blob/main/packages/api/docs/openapi.yaml) for all 35+ endpoints.

---

## Examples

The [`examples/`](https://github.com/nxtg-ai/faultline-pro/tree/main/examples) directory contains runnable scripts:

| File | Description |
|---|---|
| `basic-scan.js` | Scan a string of AI-generated text via the CLI |
| `batch-scan.js` | Batch scan multiple texts via the API |
| `webhook-handler.js` | Receive and verify webhook events |
| `ci-integration.yml` | GitHub Actions workflow with SARIF upload |

---

## Pricing

| | Free | Pro | Enterprise |
|---|---|---|---|
| Scans | 10/min | 100/min | Custom |
| CLI + API | Yes | Yes | Yes |
| All providers | Yes | Yes | Yes |
| SARIF output | Yes | Yes | Yes |
| Priority support | -- | Yes | Yes |
| Advanced rules | -- | Yes | Yes |
| SSO | -- | -- | Yes |
| Audit-ready EU compliance reports | -- | -- | Yes |
| SLA | -- | -- | Yes |

Contact: [hello@nxtg.ai](mailto:hello@nxtg.ai)

---

## Telemetry

Faultline Pro collects **optional, anonymized** usage telemetry to improve reliability and prioritize development. Telemetry is **opt-in only** — it is never sent unless you explicitly enable it.

**To enable:**
```bash
export FAULTLINE_TELEMETRY=1
```

**What is collected** (when enabled):

| Field | Value |
|---|---|
| `install_id` | Anonymous UUID created once per install (`~/.faultline/install-id`) |
| `run_id` | UUID per run |
| `version` | CLI version string |
| `provider` | Provider name (`gemini`, `openai`, `claude`, `perplexity`, `mock`) |
| `exit_status` | `0` (success) or `1` (error) |
| `eval_count` | Number of claims scanned |
| `error_code` | Enumerated error code only — never raw `error.message` |
| `os_platform` | `linux`, `darwin`, or `win32` |

**What is never collected**: API keys, eval content, file paths, hostnames, IP addresses, email, or any personally identifiable information.

Telemetry is processed by a Cloudflare Worker (operator: Cloudflare, Inc.) and stored in Cloudflare D1. The telemetry module source is Apache-2.0 licensed: `packages/cli/cli/telemetry.ts`.

---

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)

Built by [NextGen AI](https://nxtg.ai)
