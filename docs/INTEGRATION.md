# Faultline Pro — API Integration Reference

> **Audience**: FPW consumer teams building UIs against the Faultline Pro API.
> **Version**: API v0.2.0
> **Base URL**: `https://faultline-api.fly.dev` (production) · `http://localhost:3000` (local)
> **Swagger UI**: `{base}/docs` — live, explorable, always current

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Quick Start](#2-quick-start)
3. [Core Scan Endpoints](#3-core-scan-endpoints)
4. [Streaming (SSE)](#4-streaming-sse)
5. [Response Schemas](#5-response-schemas)
6. [Error Handling](#6-error-handling)
7. [Rate Limits](#7-rate-limits)
8. [Providers](#8-providers)
9. [Webhooks](#9-webhooks)
10. [GraphQL API](#10-graphql-api)
11. [Other Endpoints Reference](#11-other-endpoints-reference)
12. [CORS & Security](#12-cors--security)

---

## 1. Authentication

All API calls require an `x-api-key` header. There is **no Clerk, OAuth, or session-based auth** on the API — it is key-only.

```http
x-api-key: fl_your_key_here
```

**Key tiers** determine rate limits and which endpoints are accessible:

| Tier | Who has it | Rate limit |
|------|-----------|------------|
| `free` | Default for new keys | 10 req/min |
| `pro` | Keys with `pro` permission | 100 req/min |
| `admin` | Keys with `admin` permission | 10,000 req/min |

**Admin key**: The `FAULTLINE_API_KEY` environment variable on the server is the root admin key. It is not issued to consumers — use it only for key management operations.

**Getting a key for your team**: Make a `POST /keys` request with your admin key. The new key's secret is shown **once** in the response — store it immediately.

```http
POST /keys
x-api-key: {admin-key}
Content-Type: application/json

{
  "name": "fpw-team-1",
  "permissions": ["scan", "report", "upload"]
}
```

**Permission values**: `scan` `report` `upload` `admin` `pro`

---

## 2. Quick Start

### Minimal scan (fetch)

```typescript
const response = await fetch('https://faultline-api.fly.dev/scan', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'fl_your_key_here',
  },
  body: JSON.stringify({
    text: 'The Eiffel Tower was built in 1901.',
    provider: 'gemini',
  }),
});

const result = await response.json();
// result.overallRisk → 'high'
// result.claims[0].text → 'The Eiffel Tower was built in 1901.'
// result.verifications['c1'].status → 'contradicted'
```

### Check API is up before calling

```typescript
const health = await fetch('https://faultline-api.fly.dev/health').then(r => r.json());
// health.status → 'ok'
// health.providers.gemini → true
```

---

## 3. Core Scan Endpoints

### POST `/scan` — Single text scan

Extracts claims from text and verifies each one.

**Request**

```json
{
  "text": "string, required, 1–50,000 chars",
  "provider": "gemini | openai | claude | perplexity | mock  (optional)"
}
```

**Response** `200`

```json
{
  "claims": [
    { "id": "c1", "text": "string", "type": "fact | opinion | interpretation", "importance": 5 }
  ],
  "verifications": {
    "c1": {
      "status": "supported | contradicted | mixed | unverified",
      "explanation": "string",
      "sources": [{ "title": "string", "uri": "string" }]
    }
  },
  "overallRisk": "low | medium | high | critical",
  "provider": "gemini"
}
```

**Response headers**

```
X-Cache: HIT | MISS       (whether the result came from cache)
```

---

### POST `/scan/batch` — Multiple texts in one call

Submit 1–10 texts. Each text counts as one unit against your rate limit.

**Request**

```json
{
  "texts": ["string", "string"],
  "provider": "gemini | openai | claude | perplexity | mock  (optional)"
}
```

**Response** `200`

```json
{
  "total": 2,
  "succeeded": 2,
  "failed": 0,
  "results": [ /* ScanResult | null per text */ ],
  "errors": [{ "index": 1, "error": "string" }]
}
```

**Rate limit headers** are returned on this endpoint:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 8
X-RateLimit-Reset: 1711234567
```

---

### POST `/scan/upload` — File scan (PDF, image)

Accepts PDF, PNG, JPEG, or WebP. OCR extracts text, then runs the standard scan pipeline.

**Request**: `multipart/form-data`

| Field | Type | Notes |
|-------|------|-------|
| `file` | binary | required, max 10 MB |
| `provider` | string | optional |

**Response**: Same as `POST /scan`.

**Errors**: `400` if file missing, MIME unsupported, or size exceeds limit. `500` if OCR extraction fails.

---

### POST `/scan/deep` — Scan + URL evidence validation

Same as `/scan` but additionally validates source URLs found in the text and returns scored evidence links.

**Request / Response**: Same as `POST /scan`, with an extra `evidenceLinks` field in the response containing URL scores.

---

### POST `/scan/diff` — Before/after comparison

Run two texts through the scan pipeline and get a structured diff of how claims and verdicts changed.

**Request**

```json
{
  "before": "string",
  "after": "string",
  "provider": "gemini | openai | claude | perplexity | mock  (optional)"
}
```

**Response** `200`

```json
{
  "before": { /* ScanResult */ },
  "after":  { /* ScanResult */ },
  "newClaims": [ /* Claim[] */ ],
  "removedClaims": [ /* Claim[] */ ],
  "changedVerdicts": [
    { "claim": { /* Claim */ }, "before": "supported", "after": "contradicted" }
  ],
  "trustScoreDelta": -0.4,
  "summary": "string",
  "inlineDiff": [
    { "type": "added | removed | changed | unchanged", "claim": "string", "before": "string", "after": "string" }
  ]
}
```

---

### POST `/scan/report` — Generate PDF report

Run a scan and receive a downloadable PDF report.

**Request**

```json
{
  "text": "string",
  "provider": "gemini | openai | claude | perplexity | mock  (optional)",
  "projectName": "string, optional, max 200 chars"
}
```

**Response**: PDF binary

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="faultline-report-2026-03-24.pdf"
```

---

### POST `/scan/template/:id` — Scan with saved template

Run a scan applying a pre-configured template (provider selection, rule set, fail thresholds).

**Params**: `:id` — template ID
**Request/Response**: Same as `POST /scan`
**Error**: `404` if template not found

---

## 4. Streaming (SSE)

Use Server-Sent Events to receive claim verdicts as they are computed — ideal for showing a live progress UI.

### GET `/scan/stream`

**Auth**: `x-api-key` header
**Query params**:

| Param | Required | Notes |
|-------|----------|-------|
| `text` | yes | 1–50,000 chars |
| `provider` | no | defaults to first available |

**Response**: `Content-Type: text/event-stream`

**Event sequence**:

```
data: {"type":"start","claimCount":3,"provider":"gemini"}

data: {"type":"claim_verified","index":0,"claim":{"id":"c1","text":"...","type":"fact","importance":5},"verdict":{"status":"supported","explanation":"...","sources":[]}}

data: {"type":"claim_verified","index":1,"claim":{...},"verdict":{...}}

data: {"type":"claim_verified","index":2,"claim":{...},"verdict":{...}}

data: {"type":"complete","overallRisk":"medium","claimCount":3}
```

**On error**:

```
data: {"type":"error","message":"Provider unavailable"}
```

**TypeScript client example**:

```typescript
async function streamScan(text: string, apiKey: string) {
  const url = new URL('https://faultline-api.fly.dev/scan/stream');
  url.searchParams.set('text', text);
  url.searchParams.set('provider', 'gemini');

  const response = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));

      if (event.type === 'claim_verified') {
        console.log(`[${event.index}] ${event.claim.text} → ${event.verdict.status}`);
      }
      if (event.type === 'complete') {
        console.log(`Done — overall risk: ${event.overallRisk}`);
      }
      if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  }
}
```

---

## 5. Response Schemas

### Claim

```typescript
interface Claim {
  id: string;             // "c1", "c2", etc.
  text: string;           // the atomic claim as a standalone sentence
  type: 'fact' | 'opinion' | 'interpretation';
  importance: number;     // 1–5 (5 = critical to argument integrity)
}
```

### VerificationResult

```typescript
interface VerificationResult {
  status: 'supported' | 'contradicted' | 'mixed' | 'unverified';
  explanation: string;    // concise assessment, max 2 sentences
  sources: Array<{
    title: string;
    uri: string;
  }>;
}
```

**Status meanings**:

| Status | Meaning |
|--------|---------|
| `supported` | Claim is confirmed by sources |
| `contradicted` | Claim is directly refuted by sources |
| `mixed` | Sources conflict or evidence is ambiguous |
| `unverified` | Insufficient evidence to determine either way |

### ScanResult

```typescript
interface ScanResult {
  claims: Claim[];
  verifications: Record<string, VerificationResult>;  // keyed by claim id
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  provider: string;
}
```

**Risk level heuristic** (approximate):

| Risk | When |
|------|------|
| `low` | All or most claims supported |
| `medium` | Some mixed/unverified claims |
| `high` | Multiple contradicted or high-importance failures |
| `critical` | Critical-importance claims contradicted |

### RateLimitInfo (headers)

```
X-RateLimit-Limit: 10           // total quota for this window
X-RateLimit-Remaining: 7        // requests left
X-RateLimit-Reset: 1711234567   // Unix epoch, next window start
```

---

## 6. Error Handling

All errors return JSON with this shape:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_CODE"
}
```

**HTTP status codes**:

| Status | Code | When |
|--------|------|------|
| `400` | `VALIDATION_ERROR` | Invalid request body or query params |
| `401` | `UNAUTHORIZED` | Missing or invalid `x-api-key` |
| `403` | `FORBIDDEN` | Key lacks required permission |
| `404` | `NOT_FOUND` | Resource not found |
| `429` | `RATE_LIMIT_EXCEEDED` | Too many requests for this key |
| `500` | `INTERNAL_ERROR` | Unexpected server error |
| `503` | `SERVICE_UNAVAILABLE` | No providers configured, or all circuit-broken |

**Rate limit error body** (429):

```json
{
  "error": "Rate limit exceeded. Resets at 2026-03-24T10:01:00Z.",
  "code": "RATE_LIMIT_EXCEEDED",
  "limit": 10,
  "remaining": 0,
  "resetEpoch": 1711234567
}
```

**Recommended error handling pattern**:

```typescript
async function callFaultline(body: object, apiKey: string) {
  const res = await fetch('https://faultline-api.fly.dev/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const reset = res.headers.get('X-RateLimit-Reset');
    const waitMs = reset ? (Number(reset) * 1000 - Date.now()) : 60000;
    throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s.`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText, code: 'UNKNOWN' }));
    throw new Error(`${err.code}: ${err.error}`);
  }

  return res.json();
}
```

---

## 7. Rate Limits

Rate limits are applied per API key, per minute, on scan endpoints only.

**Scan endpoints that count against the limit**:
- `POST /scan`
- `POST /scan/upload`
- `POST /scan/batch` (counts as N, one per text)
- `POST /scan/diff`
- `POST /scan/deep`
- `POST /scan/template/:id`
- `POST /scan/compliance/:template`

**Endpoints with no rate limit**: Health, claims, scans history, keys management, webhooks, dashboard.

**Tiers**:

| Tier | Limit | How to get |
|------|-------|-----------|
| `free` | 10 req/min | Default |
| `pro` | 100 req/min | Key with `pro` permission |
| `admin` | 10,000 req/min | Key with `admin` permission |

**Alert threshold**: The server emits an internal alert when a key reaches 80% of its limit. Rate limit headers are present on every scan response for proactive checking.

**Custom limits**: Admins can set per-key overrides via `setCustomLimit` (internal store API, not exposed over HTTP currently).

---

## 8. Providers

The `provider` field in scan requests is optional. If omitted, the server picks the first available provider in priority order.

**Available providers**:

| ID | Model | Notes |
|----|-------|-------|
| `gemini` | Gemini 2.5 Flash (default) | Primary. Best speed/accuracy balance. Supports Google Search grounding. |
| `openai` | GPT-4o | Requires `OPENAI_API_KEY` on server |
| `claude` | Claude Sonnet 4.6 | Requires `ANTHROPIC_API_KEY` on server |
| `perplexity` | Perplexity API | Search-native verification. Requires `PERPLEXITY_API_KEY` |
| `mock` | Deterministic stub | Returns predictable test data. Safe for CI/testing. Never makes real LLM calls. |

**Check which providers are live before calling**:

```http
GET /health
```

```json
{
  "providers": {
    "gemini": true,
    "openai": false,
    "claude": true,
    "perplexity": false
  }
}
```

**Failover**: If the requested provider fails (or is circuit-broken), the server automatically falls back through the provider chain: `gemini → openai → claude → perplexity → mock`. A circuit breaker trips after 5 consecutive failures; it reopens after 5 minutes.

**For testing/development**: Always pass `"provider": "mock"`. It returns a valid scan result instantly without consuming quota or making external calls.

---

## 9. Webhooks

Subscribe to events emitted by the scan pipeline.

### Supported events

| Event | Fires when |
|-------|-----------|
| `scan.complete` | A scan finishes successfully |
| `scan.failed` | A scan errors out |
| `claim.verdict_changed` | A recurring scan changes verdict on a known claim |
| `compliance.deadline_approaching` | A compliance deadline is near |

### Register a webhook

```http
POST /webhooks
x-api-key: {admin-key}
Content-Type: application/json

{
  "url": "https://your-app.com/webhooks/faultline",
  "events": ["scan.complete", "scan.failed"],
  "secret": "your_signing_secret",
  "maxAttempts": 3,
  "retryDelayMs": 1000
}
```

### Webhook payload shape

```json
{
  "event": "scan.complete",
  "timestamp": "2026-03-24T10:00:00.000Z",
  "data": { /* ScanResult */ }
}
```

### Signature verification

If `secret` is configured, each delivery includes an HMAC-SHA256 signature:

```
X-Faultline-Signature: sha256=abc123...
```

Verify in your handler:

```typescript
import { createHmac } from 'crypto';

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return expected === signature;
}
```

### Delivery guarantees

- Retries: up to `maxAttempts` (default 3), with `retryDelayMs` (default 500ms) between
- Circuit breaker: trips after 5 failures per webhook URL; 5-minute cooldown
- Rate limit: 60 events/min per webhook (server-side, configurable)

**Check delivery history**: `GET /webhooks/deliveries` (admin)

---

## 10. GraphQL API

A GraphQL endpoint is available as an alternative to REST for clients that prefer it.

**Endpoint**: `POST /graphql`
**Auth**: `x-api-key` header (same as REST)

**Schema overview**:

```graphql
type Query {
  scan(text: String!, provider: String): ScanResult
  scans(keyId: String, limit: Int): [ScanResult!]!
  keys: [Key!]!
  usage(keyId: String!): [UsageDay!]!
  audit(limit: Int): [AuditEntry!]!
}

type Mutation {
  createKey(name: String!, permissions: [String!]): Key!
  deleteKey(id: String!): Boolean!
  scanBatch(texts: [String!]!, provider: String): [ScanResult!]!
}

type ScanResult {
  id: String!
  input: String!
  provider: String!
  claims: [Claim!]!
  overallRisk: String!
  scannedAt: String!
}

type Claim {
  id: String!
  text: String!
  type: String!
  importance: Int!
}
```

**Example query**:

```graphql
query VerifyClaim($text: String!) {
  scan(text: $text, provider: "gemini") {
    id
    overallRisk
    claims {
      id
      text
      type
      importance
    }
  }
}
```

---

## 11. Other Endpoints Reference

These are available if your UI needs them.

| Endpoint | Auth | Returns |
|----------|------|---------|
| `GET /health` | None | Server + provider status |
| `GET /health/deep` | None | Full subsystem health |
| `GET /status.json` | None | Machine-readable uptime, incidents, stats |
| `GET /metrics` | None | Prometheus-format metrics |
| `GET /dashboard` | Admin | Scan counts, risk distribution, provider status |
| `GET /usage` | API key | Per-day scan counts for your key |
| `GET /claims` | None | Claim database (searchable, filterable) |
| `GET /claims/trending` | None | Trending + emerging claims |
| `GET /claims/stats` | None | Accuracy rate, verdict distribution |
| `GET /scans/timeline` | None | Re-scan history for a given text |
| `GET /scans/search` | None | Full-text search over scan history |
| `GET /scan/:id/graph` | None | Mermaid claim graph for a scan |
| `GET /providers/health` | API key | Circuit breaker state + error rates per provider |
| `GET /templates` | API key | List saved scan templates |
| `POST /templates` | API key | Create a scan template |
| `GET /templates/compliance` | None | Built-in compliance templates (HIPAA, SOX, FERPA, Gov) |

---

## 12. CORS & Security

**Allowed origins**: `https://*.nxtg.ai` and `http://localhost:*`
**Allowed methods**: `GET POST PUT DELETE OPTIONS`
**Allowed headers**: `Content-Type` `x-api-key` `Authorization` `Accept-Language`
**Credentials**: `true`

Server-to-server calls (no `Origin` header) are always allowed.

**If your frontend is hosted outside `*.nxtg.ai`** during development, use `localhost`. For staging/production, the domain must be under `nxtg.ai` or request a CORS allowlist update.

**File uploads**: Max 10 MB per request.

**Key security**: API keys are never returned after creation. If lost, rotate the key (`POST /keys/:id/rotate`) — the old key remains valid for 24 hours (grace period) so you can migrate without downtime.

---

## Appendix — TypeScript SDK Types

Copy-paste ready types for your frontend codebase:

```typescript
export type ClaimType = 'fact' | 'opinion' | 'interpretation';
export type VerdictStatus = 'supported' | 'contradicted' | 'mixed' | 'unverified';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
  importance: number; // 1–5
}

export interface VerificationResult {
  status: VerdictStatus;
  explanation: string;
  sources: Array<{ title: string; uri: string }>;
}

export interface ScanResult {
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  overallRisk: RiskLevel;
  provider: string;
}

export interface ScanRequest {
  text: string;
  provider?: Provider;
}

export interface BatchScanRequest {
  texts: string[];
  provider?: Provider;
}

export interface BatchScanResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<ScanResult | null>;
  errors: Array<{ index: number; error: string }>;
}

export interface ApiError {
  error: string;
  code: string;
}

// SSE stream event types
export type StreamEvent =
  | { type: 'start'; claimCount: number; provider: string }
  | { type: 'claim_verified'; index: number; claim: Claim; verdict: VerificationResult }
  | { type: 'complete'; overallRisk: RiskLevel; claimCount: number }
  | { type: 'error'; message: string };
```
