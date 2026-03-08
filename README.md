# Faultline — AI Claim Forensics

**Verify AI-generated claims. Required by August 2026.**

The EU AI Act mandates conformity assessments for high-risk AI systems. Faultline decomposes AI output into atomic claims, stress-tests each against live evidence, and maps findings to EU AI Act risk tiers — so you can ship with confidence, not hope.

[![CI](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/nxtg-ai/faultline-pro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nxtg/faultline.svg)](https://www.npmjs.com/package/@nxtg/faultline)
[![Tests](https://img.shields.io/badge/tests-873%20passing-brightgreen)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

---

## Quick Start

**Step 1**: Get a free Gemini key (30 seconds, no credit card): [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

**Step 2**: Run your first scan:

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
Generated:    2026-03-06T14:00:00.000Z

--- EU AI Act Risk Summary ---
  Unacceptable: 0
  High:         1
  Limited:      1
  Minimal:      1
  Total Claims: 3

--- Claim Verifications ---
  [OK] c1: supported — Confirmed by census data. (confidence: 0.82)
  [!!] c2: contradicted — Audit found significant bias. (confidence: 0.91)
  [??] c3: mixed — Evidence varies by region. (confidence: 0.63)

--- Triggered EU AI Act Articles ---
  Annex III §4: Employment and recruitment AI (affects: c2)

--- Recommended Mitigations ---
  High-risk domain detected. Ensure a risk management system is in place (Article 9).
```

**Other providers:**

```bash
export ANTHROPIC_API_KEY="..."
npx @nxtg/faultline scan --input doc.txt --provider claude --output-format markdown

export OPENAI_API_KEY="..."
npx @nxtg/faultline scan --input doc.txt --provider openai

export PERPLEXITY_API_KEY="..."
npx @nxtg/faultline scan --input doc.txt --provider perplexity
```

> **Verification accuracy**: Gemini and Perplexity verify against live web data. Claude and OpenAI use training data only. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for the full comparison.

---

## What Is AI Claim Forensics?

Promptfoo tests your prompts. DeepEval scores your RAG pipeline. **Faultline audits what the AI actually said.**

| | Faultline | Promptfoo | DeepEval |
|---|---|---|---|
| Decomposes AI output into atomic claims | **Yes** | No | No |
| Verifies claims against live evidence | **Yes** | No | No |
| Confidence calibration per claim | **Yes** | No | No |
| Weakest-link detection | **Yes** | No | No |
| EU AI Act risk classification | **Yes** | No | No |
| Claim dependency graph | **Yes** | No | No |
| FM-agnostic (Gemini / Claude / OpenAI / Perplexity) | **Yes** | Yes | No (Python) |

---

## How It Works

```
Input: AI-generated text
  │
  ▼ Extract
  Atomic claims (fact / opinion / interpretation, importance 1-5)
  │
  ▼ Verify
  Per-claim verdict (supported / contradicted / mixed / unverified)
  Confidence score (0.0–1.0) with calibration
  │
  ▼ Forensic Analysis
  Weakest-link detection — which claim collapses the argument?
  Claim dependency graph — how do failures propagate?
  │
  ▼ Compliance Mapping
  EU AI Act risk tier (Unacceptable / High / Limited / Minimal)
  Triggered articles, mitigations, per-tier summary
  │
  ▼ Output
  JSON / Markdown / HTML / SARIF (VS Code + GitHub Code Scanning)
```

---

## Features

- **AI Claim Forensics** — atomic decomposition into fact/opinion/interpretation with importance scoring (1–5) and confidence calibration
- **FM-agnostic** — Gemini, Claude, OpenAI, Perplexity, and Mock providers via a clean `LLMProvider` interface; switch with one flag
- **EU AI Act compliance** — risk category mapping per Articles 5–7 and Annex III; prohibited practice detection; transparency obligations
- **Weakest-link detection** — per-claim fragility scoring; identifies the claim that most undermines argument integrity
- **Claim graph export** — Mermaid and Graphviz DOT visualizations grouping claims by EU risk tier
- **SARIF output** — VS Code / GitHub Code Scanning integration with `relatedLocations`, `uriBaseId`, and `codeFlows`
- **YAML rule engine** — custom compliance rules in YAML; built-in PII, bias, and security rule sets
- **Scan history + trend analysis** — local `.faultline/history/` store; `faultline trend` shows improving/degrading direction over time
- **Watch mode** — `faultline watch --dir` re-scans on file save with 500ms debounce and new/resolved diff highlights
- **Red-team templates** — curated prompt template library for injection, bias, and adversarial testing
- **868 tests** — unit, integration, and full pipeline tests across 27 files; all API calls mocked; CI via GitHub Actions

---

## CLI Commands

```bash
# Scan a file (set GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY first)
faultline scan --input doc.txt --provider gemini
faultline scan --input doc.txt --provider claude --output-format markdown
faultline scan --input doc.txt --sarif               # writes results.sarif
faultline scan --input doc.txt --fail-on high        # exit 1 if high/critical findings

# Batch scan a directory
faultline scan --dir ./outputs --provider gemini --glob "*.txt"

# Forensics
faultline weakest --input doc.txt --provider gemini  # weakest-link claim
faultline graph   --input doc.txt --format mermaid   # claim dependency graph
faultline critique --input doc.txt --provider gemini # critique + improved prompt

# Red-team
faultline scan --templates injection,bias            # run template library
faultline templates list --category injection        # browse templates

# History
faultline history                                    # list past scans
faultline trend --file doc.txt                       # finding trend over time

# Utilities
faultline rules                                      # list detection rules
faultline init                                       # generate .faultlinerc.json
faultline --version
faultline --help
```

---

## Testing & CI (No API Key Required)

For automated pipelines, pre-commit hooks, and local development without API access, use the **mock provider**:

```bash
npx @nxtg/faultline scan --input doc.txt --provider mock
```

The mock provider returns deterministic results without network calls. It is a **test double** — all verdicts are "supported" with flat 0.30 confidence. Use it to validate pipeline shape and CI integration, not to evaluate real claims.

**GitHub Action example** (mock for CI, real provider for nightly audits):

```yaml
- name: Faultline AI Claim Audit (CI)
  run: |
    npx @nxtg/faultline scan \
      --input ai-output.txt \
      --provider mock \
      --output-format sarif \
      --fail-on high
```

---

## Output Formats

| Format | Flag | Use Case |
|--------|------|----------|
| JSON | `--output-format json` | Programmatic processing, CI pipelines |
| Markdown | `--output-format markdown` | PRs, reports, documentation |
| HTML | `--output-format html` | Browser-readable audit reports |
| SARIF | `--output-format sarif` or `--sarif` | VS Code, GitHub Code Scanning |

---

## GitHub Action

See the [Testing & CI](#testing--ci-no-api-key-required) section above for CI examples. For production audits with real verdicts, set `GEMINI_API_KEY` as a repository secret and use `--provider gemini`.

Upload the SARIF output to GitHub Security tab for PR-level claim annotations.

---

## Provider Configuration

```bash
# Environment variables
export GEMINI_API_KEY="..."        # Gemini provider
export ANTHROPIC_API_KEY="..."     # Claude provider
export OPENAI_API_KEY="..."        # OpenAI provider
export PERPLEXITY_API_KEY="..."    # Perplexity provider
export FAULTLINE_PROVIDER=claude   # Set default provider

# Config file (.faultlinerc.json, walks up from cwd)
faultline init
```

---

## Project Structure

```
├── cli/                   # CLI entry point (15+ commands)
├── analysis/              # Weakest-link scoring, claim graph
├── providers/             # Gemini, Claude, OpenAI, Mock adapters
├── compliance/            # EU AI Act risk categories (Articles 5-7, Annex III)
├── rules/                 # YAML rule engine (PII, bias, security)
├── history/               # Scan history + trend analysis
├── templates/             # Red-team prompt template library
└── tests/                 # 868 tests across 27 files
```

---

## EU AI Act — August 2026 Deadline

The EU AI Act's high-risk AI system requirements take effect August 2026. Faultline maps each verified claim to the applicable risk tier:

- **Unacceptable risk** — Article 5 prohibited practices (social scoring, real-time biometric surveillance)
- **High risk** — Annex III systems (medical, recruitment, credit, law enforcement)
- **Limited risk** — transparency obligations (deepfakes, chatbots)
- **Minimal risk** — general-purpose AI outputs with no special obligations

Each scan produces a compliance report listing triggered articles and recommended mitigations.

---

Built by [NextGen AI](https://nxtg.ai)
