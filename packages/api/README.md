# @nxtg/faultline-api

REST API service for Faultline Pro — AI claim forensics and EU AI Act compliance reporting.

## Overview

Fastify v5 service, deployed on Fly.io as `faultline-api`. Hosted at `https://faultline-api.fly.dev` (version 0.11.0 on 2026-10-01, from `GET /health`). The package is not published to npm. The server registers about 190 routes (188 method+path pairs in `src/`, counted 2026-10-01). This README documents the scan, streaming, critique, usage and gating behavior in detail, then lists route groups. Other routes are listed by group only.

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check, no auth |
| `/scan` | POST | Scan text, return a JSON claim forensics report |
| `/scan/stream` | GET, POST | Scan with Server-Sent Events, one event per verified claim. `POST` accepts `pipelineConfig` (consensus is Enterprise only) |
| `/scan/report` | POST | Scan text, return a PDF compliance report |
| `/critique` | POST | Critique and improved prompt for failed claims |
| `/usage` | GET | Per-key usage, monthly quota position, and (admin keys only) the provider-spend budget |

## Authentication

All endpoints except `/health` (and a few public read-only status routes) require an API key.

**Header**: `x-api-key: <your-api-key>`

The server accepts either the `FAULTLINE_API_KEY` environment variable (treated as the admin key) or a key created through `POST /keys` (stored in the key store).

| Condition | Response |
|---|---|
| Header missing or wrong | `401 Unauthorized` |
| Neither `FAULTLINE_API_KEY` nor any stored key exists on the server | `503 Service Unavailable` |

## Tiers and gates in front of a scan

Rate limits are per key, per minute: free 10, pro 100, admin 10,000 (`429`, with `X-RateLimit-*` headers). Three more controls exist:

| Control | Applies to | Status code | Default |
|---|---|---|---|
| Per-key monthly scan quota (`FAULTLINE_USAGE_CAP`) | `/scan`, `/scan/template/:id`, `/scan/stream` | `402` | Dormant |
| Fleet provider-spend cap, $100/month (`FAULTLINE_PROVIDER_SPEND_CAP`) | `/scan`, `/scan/template/:id`, `/scan/stream`, `/critique` | `503` with `Retry-After` | Ledger on, enforcement dormant (off in production on 2026-10-01) |
| Consensus entitlement | `POST /scan/stream` with `pipelineConfig.consensus: true` | `403 consensus_not_in_plan` | **Enforced.** Enterprise only |

Details: `docs/provider-spend-cap.md`, `docs/usage-cap.md`, `docs/INTEGRATION.md` at the repo root.

---

## Endpoints

### `GET /health`

Health check. No authentication required.

**Response `200`**:
```json
{
  "status": "ok",
  "service": "faultline-api",
  "version": "0.11.0",
  "subsystems": { "keyStore": { "status": "ok", "activeKeys": 0 }, "scanEngine": { "status": "ok", "providersConfigured": 3 } },
  "providers": { "gemini": true, "openai": true, "claude": true, "perplexity": false }
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
| `402` | `{ "error": "Monthly scan quota exceeded.", ... }` | Per-key monthly quota reached (only when `FAULTLINE_USAGE_CAP` is on) |
| `429` | `{ "error": "Rate limit exceeded.", ... }` | Per-minute limit for the key's tier |
| `500` | `{ "error": "..." }` | Provider API call failed |
| `503` | `{ "error": "API key not configured on server." }` | Server not configured |
| `503` | `{ "error": "Monthly provider budget exhausted. ..." }` | Provider-spend cap reached (only when `FAULTLINE_PROVIDER_SPEND_CAP` is on) |
| `503` | `{ "error": "provider_not_configured", "provider": "..." }` | The requested provider has no key on the server |

**Example**:
```bash
curl -X POST https://faultline-api.fly.dev/scan \
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
curl -X POST https://faultline-api.fly.dev/scan/report \
  -H "Content-Type: application/json" \
  -H "x-api-key: $FAULTLINE_API_KEY" \
  -d '{"text": "Our AI model is 99.9% accurate.", "projectName": "ACME Q1 Audit"}' \
  --output report.pdf
```

---

### `POST /scan/stream` and `GET /scan/stream`

Server-Sent Events: `start`, then one `claim_verified` per claim, then `complete`. `GET` takes `text` and `provider` as query params. `POST` takes a JSON body with `text`, `provider` and an optional `pipelineConfig`.

**Multi-model consensus is Enterprise only.** `pipelineConfig.consensus: true` from any caller below Enterprise returns `403`:

```json
{ "error": "consensus_not_in_plan", "message": "Multi-model consensus is included in the Enterprise plan.", "plan": "pro" }
```

The check runs before the stream opens. The server refuses and never downgrades to a single-model scan. The plan is taken from the `x-user-tier` header only when the request uses the server's own `FAULTLINE_API_KEY` (the faultline-web proxy). For any other key the header is ignored, so setting it does not unlock consensus. Source: `src/plugins/consensus-entitlement.ts`.

---

### `POST /critique`

Generate a critique and an improved prompt for the claims that failed verification.

**Request body**: `claims` (array), `verifications` (object keyed by claim id), `text` (string), and optional `provider` (`gemini`, `openai`, `claude`, `perplexity` or `mock`; default `openai`).

**Response `200`**: `failedClaims`, `totalClaims`, `totalVerified`, `failedCount`, `hasCritique`, `critique`, `improvedPrompt`.

This route makes a paid LLM call on Faultline's provider keys, so it needs an API key, shares the per-minute rate limit bucket with scans, and is covered by the provider-spend cap and ledger. Its real reported usage is priced and appended to the spend ledger, even while the cap is dormant. If no claim failed, no LLM call is made and nothing is ledgered. It does not count against the monthly scan quota. An unknown `provider` returns `400`. When the cap is on and exhausted it returns `503` and does not call the provider.

---

### `GET /usage`

Returns `{ keyId, usage, quota }`. `quota` is `{ tier, enforced, limit, used, remaining, resetEpoch }` for the monthly scan quota. Admin keys also receive `providerBudget` (`{ month, enforced, capUsd, spentUsd, remainingUsd, exhausted }`). Other keys never see it, because it is Faultline's own spend.

---

## Other route groups

Registered in `src/routes/` (see the files for exact paths): scans history and search, batch and bulk scans, compare and diff, PDF and EU AI Act reports, compliance gate, history and deadlines, claims search and explain, keys (create, rotate, bulk), tenants and GDPR export and erasure, orgs, webhooks, schedules and jobs, cache and warmup, rules, templates, notifications, audit log (including the SHA-256 chain manifest), approvals, costs, analytics, providers health, `GET /metrics`, `GET /health/deep`, `GET /status`, Swagger UI at `GET /docs`, and `POST /graphql`. The OpenAPI file `docs/openapi.yaml` declares version 0.7.0 and has 48 paths, so it covers only part of the current surface.

---

## Running Locally

```bash
# Set your API key
export FAULTLINE_API_KEY=your-secret-key

# Set at least one provider key
export GEMINI_API_KEY=...         # or OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.

# Start the server
npm run dev --workspace=packages/api   # http://localhost:3010 (default PORT 3010)
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FAULTLINE_API_KEY` | yes | API key clients must send in `x-api-key` header |
| `PORT` | no | Server port (default: `3010`; `fly.toml` sets `PORT=3000`) |
| `GEMINI_API_KEY` | provider | Required when using `gemini` provider |
| `OPENAI_API_KEY` | provider | Required when using `openai` provider |
| `ANTHROPIC_API_KEY` | provider | Required when using `claude` provider |
| `PERPLEXITY_API_KEY` | provider | Required when using `perplexity` provider |
| `FAULTLINE_PROVIDER_SPEND_CAP` | no | `on` enforces the provider-spend cap. Default off (ledger only) |
| `FAULTLINE_PROVIDER_SPEND_CAP_USD` | no | Monthly ceiling in USD, default `100` |
| `FAULTLINE_PROVIDER_SPEND_LEDGER` | no | Ledger path, default `/var/log/faultline/provider-spend.jsonl` |
| `FAULTLINE_USAGE_CAP` | no | `on` enforces the per-key monthly scan quota. Default off |

## Deployment

The API includes a `Dockerfile` and `fly.toml` for deployment to [Fly.io](https://fly.io).

```bash
fly deploy --config packages/api/fly.toml
```
