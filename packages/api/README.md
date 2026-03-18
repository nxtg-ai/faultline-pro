# @nxtg/faultline-api

REST API service for Faultline Pro — AI claim forensics and EU AI Act compliance reporting.

## Overview

Faultline API exposes two endpoints over HTTP:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check — no auth required |
| `/scan` | POST | Scan text and return a JSON claim forensics report |
| `/scan/report` | POST | Scan text and return a PDF compliance report |

## Authentication

All endpoints except `/health` require an API key.

**Header**: `x-api-key: <your-api-key>`

The server validates this against the `FAULTLINE_API_KEY` environment variable.

| Condition | Response |
|---|---|
| Header missing or wrong | `401 Unauthorized` |
| `FAULTLINE_API_KEY` not set on server | `503 Service Unavailable` |

---

## Endpoints

### `GET /health`

Health check. No authentication required.

**Response `200`**:
```json
{
  "status": "ok",
  "service": "faultline-api",
  "version": "0.1.0"
}
```

---

### `POST /scan`

Scan text for AI claims, verify them, and return a JSON risk report.

**Request headers**:
```
Content-Type: application/json
x-api-key: <your-api-key>
```

**Request body**:
```json
{
  "text": "string (required, 1–50000 chars)",
  "provider": "gemini | openai | claude | perplexity | mock  (optional, default: gemini)"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `text` | string | yes | 1–50000 characters |
| `provider` | string | no | One of: `gemini`, `openai`, `claude`, `perplexity`, `mock` |

**Response `200`** — `ScanResult`:
```json
{
  "input": "original text",
  "provider": "gemini",
  "claims": [
    {
      "id": "c1",
      "text": "GPT-4 is 92% accurate on medical diagnoses.",
      "type": "fact",
      "importance": 4
    }
  ],
  "verifications": {
    "c1": {
      "claimId": "c1",
      "status": "unverified",
      "explanation": "No independent source found to support this figure.",
      "sources": []
    }
  },
  "overallRisk": "high",
  "complianceReport": {
    "riskTier": "high",
    "findings": ["EU AI Act Article 13 — transparency obligation triggered"]
  },
  "ruleFindings": []
}
```

**`overallRisk` values**: `low` | `medium` | `high` | `critical`

**Verification `status` values**: `supported` | `contradicted` | `mixed` | `unverified` | `skipped`

**Error responses**:

| Code | Body | Cause |
|---|---|---|
| `400` | `{ "error": "..." }` | Missing/invalid `text` or unknown `provider` |
| `401` | `{ "error": "Unauthorized. Provide a valid x-api-key header." }` | Missing or wrong API key |
| `500` | `{ "error": "..." }` | Provider API call failed |
| `503` | `{ "error": "API key not configured on server." }` | Server not configured |

**Example**:
```bash
curl -X POST https://api.faultline.nxtg.ai/scan \
  -H "Content-Type: application/json" \
  -H "x-api-key: $FAULTLINE_API_KEY" \
  -d '{"text": "GPT-4 achieves 94.7% accuracy on USMLE medical exam questions.", "provider": "gemini"}'
```

---

### `POST /scan/report`

Scan text and generate a PDF compliance report suitable for EU AI Act audits.

**Request headers**:
```
Content-Type: application/json
x-api-key: <your-api-key>
```

**Request body**:
```json
{
  "text": "string (required, 1–50000 chars)",
  "provider": "gemini | openai | claude | perplexity | mock  (optional)",
  "projectName": "string (optional, max 200 chars)"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `text` | string | yes | 1–50000 characters |
| `provider` | string | no | One of: `gemini`, `openai`, `claude`, `perplexity`, `mock` |
| `projectName` | string | no | Label for the report cover page (max 200 chars) |

**Response `200`**:

- `Content-Type: application/pdf`
- `Content-Disposition: attachment; filename="faultline-report-YYYY-MM-DD.pdf"`
- Body: binary PDF

The PDF contains:
- **Cover page** — project name, date, provider, overall risk tier
- **Executive summary** — claim counts, verification breakdown
- **Claim analysis table** — each claim with verdict and source

**Error responses**:

| Code | Body | Cause |
|---|---|---|
| `400` | `{ "error": "..." }` | Missing/invalid `text` or unknown `provider` |
| `401` | `{ "error": "Unauthorized. Provide a valid x-api-key header." }` | Missing or wrong API key |
| `500` | `{ "error": "..." }` | Provider API call or PDF generation failed |
| `503` | `{ "error": "API key not configured on server." }` | Server not configured |

**Example**:
```bash
curl -X POST https://api.faultline.nxtg.ai/scan/report \
  -H "Content-Type: application/json" \
  -H "x-api-key: $FAULTLINE_API_KEY" \
  -d '{"text": "Our AI model is 99.9% accurate.", "projectName": "ACME Q1 Audit"}' \
  --output report.pdf
```

---

## Running Locally

```bash
# Set your API key
export FAULTLINE_API_KEY=your-secret-key

# Set at least one provider key
export GEMINI_API_KEY=...         # or OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.

# Start the server
npm run dev --workspace=packages/api   # http://localhost:3000
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FAULTLINE_API_KEY` | yes | API key clients must send in `x-api-key` header |
| `PORT` | no | Server port (default: `3000`) |
| `GEMINI_API_KEY` | provider | Required when using `gemini` provider |
| `OPENAI_API_KEY` | provider | Required when using `openai` provider |
| `ANTHROPIC_API_KEY` | provider | Required when using `claude` provider |
| `PERPLEXITY_API_KEY` | provider | Required when using `perplexity` provider |

## Deployment

The API includes a `Dockerfile` and `fly.toml` for deployment to [Fly.io](https://fly.io).

```bash
fly deploy --config packages/api/fly.toml
```
