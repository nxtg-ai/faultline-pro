# Faultline CI/CD Integration Guide

Faultline verifies AI-generated claims against live evidence and maps findings to EU AI Act risk tiers. Running it in CI catches hallucinations, unsupported assertions, and compliance violations in PR descriptions, release notes, docs, and any AI-generated content — before it merges.

---

## CLI Usage in CI

```bash
faultline scan --input <file> --fail-on high --provider mock
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--input <file>` | Path to the text file to scan |
| `--provider <name>` | Provider to use: `gemini`, `openai`, `claude`, `perplexity`, `mock` |
| `--fail-on <level>` | Exit code 1 if findings at this severity or above are found |
| `--output-format <fmt>` | Output format: `json`, `markdown`, `html`, `sarif` (default: `markdown`) |
| `--min-confidence <n>` | Only report findings with confidence >= n (0.0–1.0) |
| `--rules <list>` | Comma-separated rule names: `pii`, `bias`, `toxicity` |

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Scan passed — no findings at or above the threshold |
| `1` | Scan failed — findings found at or above the threshold, or a CLI error occurred |

**`--fail-on` threshold semantics:**

| Value | Fails if... |
|-------|-------------|
| `critical` | Any CRITICAL findings exist |
| `high` | Any HIGH or CRITICAL findings exist |
| `medium` | Any MEDIUM, HIGH, or CRITICAL findings exist |
| `low` | Any findings exist at any level |

If `--fail-on` is omitted, the scan always exits 0 regardless of results (report-only mode).

---

## GitHub Actions

### Real provider (push gate)

Uses a real LLM provider to verify claims on every push. Fails the workflow if HIGH or CRITICAL risk is detected.

```yaml
name: Faultline Claim Audit

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  claim-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install Faultline
        run: npm install -g @nxtg/faultline

      - name: Scan release notes
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          faultline scan \
            --input docs/release-notes.md \
            --provider gemini \
            --fail-on high \
            --output-format sarif > results.sarif
        continue-on-error: false

      - name: Upload SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
```

### Mock provider (unit test stage)

No API key required. Use this for fast feedback during development or to validate pipeline shape without network calls.

```yaml
      - name: Faultline smoke check (mock)
        run: |
          faultline scan \
            --input docs/release-notes.md \
            --provider mock \
            --fail-on high
```

> The mock provider returns deterministic synthetic results (all claims "supported", confidence 0.30). It validates that the pipeline runs and exit codes work — it does not perform real claim verification.

### Scan multiple files

```yaml
      - name: Scan AI-generated docs
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          for file in docs/*.md; do
            echo "Scanning $file..."
            faultline scan \
              --input "$file" \
              --provider gemini \
              --fail-on high
          done
```

---

## GitLab CI

```yaml
faultline-claim-audit:
  image: node:20-alpine
  stage: test
  variables:
    GEMINI_API_KEY: $GEMINI_API_KEY   # set in GitLab CI/CD → Variables
  before_script:
    - npm install -g @nxtg/faultline
  script:
    - faultline scan
        --input docs/release-notes.md
        --provider gemini
        --fail-on high
        --output-format json
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'
  cache:
    key: faultline-node
    paths:
      - ~/.npm
```

For a mock-only pipeline (no API key required):

```yaml
faultline-mock-check:
  image: node:20-alpine
  stage: test
  before_script:
    - npm install -g @nxtg/faultline
  script:
    - faultline scan --input docs/release-notes.md --provider mock --fail-on high
```

---

## Pre-commit Hook

Scans staged markdown and text files before each commit. Requires `@nxtg/faultline` installed globally (`npm install -g @nxtg/faultline`).

Save as `.git/hooks/pre-commit` and make executable (`chmod +x .git/hooks/pre-commit`):

```bash
#!/usr/bin/env bash
set -e

# Scan staged markdown and text files with Faultline (mock provider — no API key required)
# Use --provider gemini with GEMINI_API_KEY set for real verification.

STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(md|txt)$' || true)

if [ -z "$STAGED" ]; then
  exit 0
fi

echo "Faultline: scanning staged files..."

FAIL=0
for file in $STAGED; do
  if [ -f "$file" ]; then
    echo "  Checking $file"
    if ! faultline scan --input "$file" --provider mock --fail-on high > /dev/null 2>&1; then
      echo "  [FAIL] $file — HIGH or CRITICAL claims detected"
      FAIL=1
    fi
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "Faultline pre-commit check failed. Run:"
  echo "  faultline scan --input <file> --provider gemini --fail-on high"
  echo "to see full details."
  exit 1
fi

echo "Faultline: all staged files passed."
```

To use a real provider in the hook, set `GEMINI_API_KEY` in your shell environment and change `--provider mock` to `--provider gemini`.

---

## API Batch Usage

The Faultline REST API exposes `POST /scan` for programmatic CI integration. You can POST multiple texts sequentially or in parallel from a CI script. This is useful when you need structured JSON output for downstream processing, or when scanning content that isn't stored as files on disk.

**Start the API server:**

```bash
cd packages/api
FAULTLINE_API_KEY=your-key npm run dev
# Listening on http://localhost:3000
```

**Scan a single text via API:**

```bash
curl -s -X POST http://localhost:3000/scan \
  -H "x-api-key: $FAULTLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "GPT-4 was trained on 1 trillion tokens.", "provider": "mock"}'
```

**Scan multiple texts in parallel (CI gate logic):**

```bash
#!/usr/bin/env bash
# Scan two PR description files and fail if any HIGH findings are found

BASE_URL="http://localhost:3000"
API_KEY="$FAULTLINE_API_KEY"

scan_file() {
  local file="$1"
  local text
  text=$(cat "$file")
  curl -s -X POST "$BASE_URL/scan" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$text" '{"text": $t, "provider": "mock"}')"
}

# Run scans in parallel
RESULT1=$(scan_file docs/pr-description.md) &
PID1=$!
RESULT2=$(scan_file docs/release-notes.md) &
PID2=$!

wait $PID1 $PID2

# Check overall risk from each result
check_result() {
  local result="$1"
  local label="$2"
  local risk
  risk=$(echo "$result" | jq -r '.complianceReport.overallRisk // "UNKNOWN"')
  echo "$label: $risk"
  if [[ "$risk" == "HIGH" || "$risk" == "CRITICAL" ]]; then
    return 1
  fi
  return 0
}

FAIL=0
check_result "$RESULT1" "docs/pr-description.md" || FAIL=1
check_result "$RESULT2" "docs/release-notes.md"  || FAIL=1

if [ "$FAIL" -eq 1 ]; then
  echo "CI gate: HIGH or CRITICAL risk detected. Blocking merge."
  exit 1
fi

echo "CI gate: all files passed."
```

**Response shape** (relevant CI fields):

```json
{
  "complianceReport": {
    "overallRisk": "HIGH",
    "riskTier": "HIGH"
  },
  "verifications": {
    "c1": { "status": "contradicted", "confidence": 0.91 },
    "c2": { "status": "supported",    "confidence": 0.85 }
  },
  "ruleFindings": [
    { "rule": "bias", "severity": "high", "claimId": "c1", "message": "..." }
  ]
}
```

Gate logic:
- `complianceReport.overallRisk` — `LOW | MEDIUM | HIGH | CRITICAL`
- `ruleFindings[].severity` — `low | medium | high | critical`
- `verifications[].status` — `supported | contradicted | mixed | unverified`

See the full API spec at [`packages/api/docs/openapi.yaml`](../packages/api/docs/openapi.yaml).

---

## Risk Level Reference

| Level | `--fail-on` behavior | Triggered by |
|-------|---------------------|--------------|
| `LOW` | Fails only when `--fail-on low` | Unverified claims, low-confidence assertions |
| `MEDIUM` | Fails when `--fail-on medium` or stricter | Mixed evidence, transparency-obligation claims |
| `HIGH` | Fails when `--fail-on high` or stricter | Contradicted claims, Annex III high-risk domain content |
| `CRITICAL` | Always fails when `--fail-on critical` | Prohibited practices (Article 5), social scoring, biometric surveillance |

**Recommended defaults:**

- Unit test / fast feedback stage: `--provider mock --fail-on high`
- PR merge gate: `--provider gemini --fail-on high`
- Nightly compliance audit: `--provider gemini --fail-on medium`

---

## Tips

**Cache node_modules** to speed up installs in CI:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
```

**Use mock provider in unit test stages, real provider only at the merge gate.** Mock runs in milliseconds with no network calls; real providers add 5–30 seconds per scan depending on claim count.

**SARIF output + GitHub Code Scanning** gives inline claim annotations on PRs. Use `--output-format sarif` and upload with `github/codeql-action/upload-sarif@v3`.

**Batch directories** with the CLI's built-in directory mode — no script looping needed:

```bash
faultline scan --dir ./docs --glob "*.md" --provider gemini --fail-on high
```

**Set a default provider** with `FAULTLINE_PROVIDER` env var to avoid repeating `--provider` on every command:

```yaml
env:
  FAULTLINE_PROVIDER: gemini
  GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```
