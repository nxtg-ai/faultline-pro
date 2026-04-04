# Architecture

Faultline is a 5-stage pipeline that transforms AI-generated text into a compliance-assessed trust report.

## Pipeline Stages

### 1. Extraction

The LLM provider decomposes input text into atomic `Claim` objects:

```typescript
interface Claim {
  id: string;          // "c1", "c2", ...
  text: string;        // Standalone assertion
  type: ClaimType;     // "fact" | "opinion" | "interpretation"
  importance: number;  // 1-5 (5 = critical to argument)
}
```

The extraction prompt enforces JSON schema output. Claims are classified by type and scored by structural importance to the argument.

### 2. Filtering & Verification

Only **facts with importance >= 3** are verified (max 8 per analysis). This avoids wasting API calls on opinions or low-stakes trivia.

Each selected claim is verified against live web data. The Gemini provider uses Google Search grounding; the Claude provider relies on the model's knowledge. Verification produces:

```typescript
interface VerificationResult {
  claimId: string;
  status: "supported" | "contradicted" | "mixed" | "unverified";
  explanation: string;
  sources: Array<{ title: string; uri: string }>;
}
```

### 3. Risk Scoring

Aggregate verdicts determine the overall risk level:

| Condition | Risk Level |
|-----------|-----------|
| 3+ contradicted | Critical |
| 1+ contradicted OR 3+ mixed | High |
| 1+ mixed | Medium |
| All supported/unverified | Low |

### 4. EU AI Act Mapping

Each verified claim is mapped to an EU AI Act risk category:

| Tier | Trigger | Reference |
|------|---------|-----------|
| **Unacceptable** | Social scoring, mass surveillance, subliminal manipulation, exploitation of vulnerabilities, workplace emotion recognition | Article 5 |
| **High** | Biometrics, critical infrastructure, education, employment, credit scoring, law enforcement, migration, justice, elections | Article 6, Annex III |
| **Limited** | Contradicted or mixed claims (transparency obligation for AI-generated content) | Article 50 |
| **Minimal** | Supported or unverified generic claims | Recital 32 |

Pattern matching uses domain-specific regexes against claim text. Contradicted high-importance claims in high-risk domains receive elevated confidence scores.

### 5. Compliance Report

`buildEuComplianceReport()` in `packages/cli/cli/compliance-report.ts` aggregates scan output into a full EU AI Act evidence report (N-157–N-209). The engine covers 12 enforcement-deadline articles:

| Article | Evidence Source | Status Logic |
|---------|----------------|--------------|
| Art. 5 — Prohibited Practices | `claimMappings` unacceptable tier | `non-compliant` if any; else absent |
| Art. 6 — High-Risk Classification | `claimMappings` high/unacceptable | `partial` if high-risk domains; else `not-applicable` |
| Art. 9 — Risk Management | `verifications` contradicted/mixed; PII/bias findings | `non-compliant`/`partial`/`compliant` |
| Art. 10 — Data Governance | `ruleFindings` bias/PII; `verifications` contradicted | `non-compliant` for bias; `partial` otherwise |
| Art. 11 — Technical Documentation | `verifications` explanation length + source citations | `compliant` if ≥1 explained claim; else absent |
| Art. 12 — Record-Keeping | `claims` presence + metadata | `compliant` if claims exist; else absent |
| Art. 13 — Transparency | `verifications` supported/contradicted/mixed split | `compliant`/`partial`/`gap` |
| Art. 14 — Human Oversight | `claims` interpretation-type | `partial` if interpretation claims; else `compliant` |
| Art. 15 — Accuracy & Robustness | Contradiction rate >30%; injection/shell `ruleFindings` | `partial` if signals; else `compliant` |
| Art. 50 — GPAI Transparency | `claims` opinion-type | `partial` if opinion claims; else `not-applicable` |
| Art. 52 — Specific AI System Types | Emotion/biometric/synthetic `ruleFindings`; opinion claims | `partial` if any signal; else `not-applicable` |
| Art. 53 — GPAI Provider Obligations | `scan.provider` (real vs mock) | `partial` if real GPAI; else `not-applicable` |

Each article entry carries: `status`, `findings[]`, `remediations[]`, `evidenceCount`, `sourceCount`, `strengthScore` (0–1), `owaspRef`.

**Evidence status states**: `compliant` → `partial` → `gap` → `non-compliant` → `not-applicable` (excluded from score)

**Annex III conformity checklist**: 8-item checklist triggered when `overallRisk` is high/critical or Art. 6 is partial/non-compliant. Covers Arts. 6/9/10/11/12/13/14/15.

**Output formats** (5): JSON, PDF (EU-branded PDFKit), Markdown (GFM for PR comments), SARIF 2.1.0 (GitHub Code Scanning), HTML (standalone).

**CI gate** (`--ci`): exits non-zero on compliance failure. Configurable via `--threshold N` (0–100 score) and `--strict` (all articles must be compliant). `art6ConformityRequired` flag in `CiGateResult` surfaces Annex III obligation explicitly.

## Provider Abstraction

All LLM interaction goes through the `LLMProvider` interface:

```typescript
interface LLMProvider {
  readonly name: string;
  readonly modelId: string;
  extractClaims(text: string, image?: ImageInput): Promise<Claim[]>;
  verifyClaim(claim: Claim): Promise<VerificationResult>;
  generateCritiqueAndPrompt(text: string, claims: Claim[]): Promise<CritiqueResult>;
}
```

### Implementations

- **GeminiProvider** — Thin adapter over `services/geminiService.ts`. Uses `@google/genai` SDK with JSON schema enforcement and Google Search grounding.
- **ClaudeProvider** — Direct `fetch` calls to the Anthropic Messages API (`/v1/messages`). No SDK dependency. Parses JSON from model responses with markdown-aware extraction. Default model: `claude-sonnet-4-20250514` (configurable via `FAULTLINE_CLAUDE_MODEL`).
- **OpenAIProvider** — Direct `fetch` calls to the OpenAI Chat Completions API with `response_format: { type: "json_object" }`. Default model: `gpt-4o` (configurable via `FAULTLINE_OPENAI_MODEL`).

### Registry

```typescript
import { getProvider } from './providers';

// Default: Gemini
const provider = getProvider('api-key');

// Explicit selection
const claude   = getProvider('api-key', 'claude');
const openai   = getProvider('api-key', 'openai');
const mock     = getProvider('',        'mock');   // no API key needed

// Environment variable: FAULTLINE_PROVIDER=claude|openai|gemini
const envProvider = getProvider('api-key');
```

New providers are added by:
1. Implementing `LLMProvider`
2. Exporting a `ProviderFactory` function
3. Registering in `providers/registry.ts`

## Data Flow

```
User Input (text/image)
       │
       ▼
  LLMProvider.extractClaims()
       │
       ▼
  Claim[] ──filter──▶ facts, importance ≥ 3, max 8
       │
       ▼
  LLMProvider.verifyClaim()  (per claim)
       │
       ▼
  VerificationResult[] ──aggregate──▶ Risk Level
       │
       ▼
  mapClaimToRiskCategory()  (per claim)
       │
       ▼
  generateComplianceReport()
       │
       ▼
  ComplianceReport { euRiskSummary, triggeredArticles, mitigations }
```

## Error Handling

Every stage fails gracefully:

| Stage | Failure Mode | Recovery |
|-------|-------------|----------|
| Extraction | API error, invalid JSON | Return `[]` (empty claims) |
| Verification | API error, parse failure | Return `status: "unverified"` |
| Critique | API error | Return fallback text |
| Risk Scoring | No verifications | Return `"low"` |
| Compliance | No claims | Report with "No verified claims" mitigation |

## CLI Layer

The `cli/` directory adds a full command-line interface on top of the core pipeline:

| Command | Description |
|---------|-------------|
| `faultline scan --input <file>` | Run full pipeline; output JSON/Markdown/HTML/SARIF |
| `faultline scan --dir <path>` | Batch scan all files in a directory |
| `faultline weakest --input <file>` | Identify the most fragile claim by fragility score |
| `faultline graph --input <file> --format mermaid\|dot` | Export claim graph grouped by EU risk tier |
| `faultline watch --dir <path>` | Re-scan on file save with 500ms debounce |
| `faultline history` | List past scans from `.faultline/history/` |
| `faultline trend --file <path>` | Show finding count trajectory (improving/degrading) |
| `faultline aggregate --dir <path>` | Multi-file risk heatmap and summary |
| `faultline rules` | List all detection rules (built-in + YAML) |
| `faultline templates list` | List red-team prompt templates |

## Rules Engine

`rules/` provides a content-based detection layer that runs in parallel with LLM verification:

- **Built-in TypeScript rules**: PII detection, bias detection, security credential detection
- **YAML rule engine**: Custom rules from `.yaml` files; supports regex patterns with per-pattern severity overrides
- **Built-in YAML rules**: `pii.yaml` (email/phone/SSN), `bias.yaml` (gender/racial/age), `security.yaml` (API keys/credentials)
- Rules are additive — custom rules supplement built-in, never override

## Analysis Modules

`analysis/` contains pure-computation modules with no I/O:

- **`weakest-link.ts`**: Per-claim fragility = `(verdictScore × 0.6 + uncertaintyScore × 0.4) × (importance/5)`. Classifies argument strength as resilient/stable/fragile/critical.
- **`claim-graph.ts`**: Maps claims to nodes grouped by EU risk tier; renders Mermaid `graph TD` and Graphviz DOT output.

## Scan History

`history/store.ts` saves every scan result to `.faultline/history/{timestamp}-{hash}.json`. `analyzeTrend()` compares first and last scan per file to report improving/degrading/stable direction.

## Test Architecture

829 tests across 27 files:

- **Unit tests**: types, geminiService, app logic, provider implementations (Gemini/Claude/OpenAI), compliance mapping, rules engine, weakest-link algorithm, claim graph rendering, scan history
- **Integration tests**: full pipeline (extract → score → map → report), multi-provider shape parity, confidence calibration, report aggregation
- **All API calls mocked** — tests run offline in ~1.2s
