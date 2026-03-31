# faultline-sdk

Python SDK for the [Faultline Pro](https://github.com/nxtg-ai/faultline-pro) API — AI claim forensics and risk scoring.

Zero external dependencies. Requires Python 3.10+.

## Installation

```bash
pip install faultline-sdk
```

## Quick start

```python
import os
from faultline_sdk import FaultlineClient, FaultlineError

client = FaultlineClient(api_key=os.environ["FAULTLINE_API_KEY"])

try:
    result = client.scan("The Eiffel Tower is 330 metres tall.")
    print(result.overall_risk)   # 'low' | 'medium' | 'high' | 'critical'
    for claim in result.claims:
        v = result.verifications.get(claim.id)
        status = v.status if v else "unverified"
        print(f"  [{status}] {claim.text}")
except FaultlineError as exc:
    print(f"API error {exc.status_code}: {exc}")
    print(exc.body)  # parsed JSON from the error response
```

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `api_key` | API key (required) | — |
| `base_url` | API root URL | `http://localhost:3000` |

Use an environment variable to avoid hardcoding secrets:

```python
client = FaultlineClient(api_key=os.environ["FAULTLINE_API_KEY"])
```

## Methods

### Scanning

#### `scan(text, provider=None) -> ScanResult`

Extract claims from `text` and verify them.

```python
result = client.scan("GPT-4 was released in March 2023.", provider="mock")
print(result.overall_risk)
print(result.claims)          # list[Claim]
print(result.verifications)   # dict[str, VerificationResult]
```

#### `scan_batch(texts, provider=None) -> BatchScanResponse`

Verify multiple texts in a single request.

```python
response = client.scan_batch(["claim one", "claim two"])
print(response.total, response.succeeded, response.failed)
for item in response.results:
    if item is not None:
        print(item.overall_risk)
```

### API Keys

#### `create_key(name, permissions=None) -> ApiKey`

```python
key = client.create_key("ci-bot", permissions=["scan", "report"])
print(key.key)   # secret — only visible on creation
```

#### `list_keys() -> list[ApiKey]`

```python
for k in client.list_keys():
    print(k.id, k.name, k.permissions)
```

#### `delete_key(key_id) -> None`

```python
client.delete_key("key-abc123")
```

### Webhooks

#### `create_webhook(url, events, secret=None) -> Webhook`

```python
hook = client.create_webhook(
    "https://example.com/faultline",
    events=["scan.complete", "scan.failed"],
    secret="my-hmac-secret",
)
print(hook.id, hook.secret)
```

#### `list_webhooks() -> list[Webhook]`

```python
for wh in client.list_webhooks():
    print(wh.id, wh.url, wh.events)
```

#### `delete_webhook(webhook_id) -> None`

```python
client.delete_webhook("wh-abc123")
```

#### `scan_deep(text, provider=None) -> dict`

Deep scan with multi-provider chain and evidence linking. Falls back through healthy providers via the circuit breaker.

```python
result = client.scan_deep("GPT-4 achieved 86.4% on MMLU.", provider="gemini")
print(result["overallRisk"])
for link in result["evidenceLinks"]:
    print(f"  {link['url']} (score: {link['score']})")
```

### Scan Diff

#### `scan_diff(before, after, provider=None) -> ScanDiffResult`

Compare two texts at the claim level — find new, removed, and changed claims.

```python
diff = client.scan_diff("old text", "new text", provider="mock")
print(diff.summary)           # 'Risk improved' | 'Risk worsened' | 'No change'
print(diff.trust_score_delta) # negative = improved
print(diff.new_claims)        # claims added in 'after'
print(diff.removed_claims)    # claims removed from 'before'
print(diff.inline_diff)       # per-claim added/removed/changed/unchanged
```

### EU AI Act Compliance

#### `compliance_gate(text, provider=None, project_name=None, threshold=None, strict=None) -> ComplianceGateResponse`

Scan text and evaluate EU AI Act compliance in a single call.

```python
response = client.compliance_gate("AI-generated text.", provider="mock", threshold=80, strict=True)
if not response.gate.passed:
    print(f"FAIL: {response.gate.non_compliant_count} non-compliant articles")
    for article in response.gate.articles:
        if not article.passed:
            print(f"  {article.article}: {article.status}")
```

#### `get_scan_compliance(scan_id, project_name=None, threshold=None, strict=None) -> ComplianceGateResponse`

Evaluate compliance for an existing scan result.

```python
resp = client.get_scan_compliance("scan-abc-123", threshold=80, strict=True)
print(resp.gate.passed, resp.gate.exit_code)
```

#### `compliance_diff(before_id, after_id, project_name=None) -> ComplianceDiffResult`

Compare compliance between two scans.

```python
diff = client.compliance_diff("scan-before", "scan-after")
print(diff.risk_trend)  # 'improved' | 'regressed' | 'unchanged'
print(diff.summary)     # {'improved': 2, 'regressed': 0, 'unchanged': 3}
```

#### `compliance_badge(scan_id, label=None) -> str`

Fetch an SVG compliance badge for embedding in READMEs.

```python
svg = client.compliance_badge("scan-abc-123")
with open("badge.svg", "w") as f:
    f.write(svg)
```

#### `compliance_history(project_name=None, limit=None, since=None) -> dict`

Query compliance gate evaluation history.

```python
history = client.compliance_history(project_name="my-app", limit=10)
for entry in history["entries"]:
    print(entry["passed"], entry["complianceScore"])
```

#### `compliance_trend(project_name) -> dict`

Get compliance score trend direction for a project.

```python
trend = client.compliance_trend("my-app")
print(trend["direction"])  # 'up' | 'down' | 'stable' | 'none'
```

#### `compliance_deadlines(days=None) -> list[ComplianceDeadline]`

List upcoming regulatory compliance deadlines.

```python
for d in client.compliance_deadlines(days=90):
    print(f"{d.name}: {d.days_until} days ({d.severity})")
```

### Claims

#### `claims_trending() -> dict`

Fetch trending claims, emerging patterns, and verdict changes.

```python
data = client.claims_trending()
for claim in data["trending"]:
    print(f"{claim['text']} (freq: {claim['frequency']})")
```

### GDPR

#### `gdpr_export(tenant_id) -> bytes`

Download a GDPR Article 15 data export ZIP for a tenant.

```python
zip_data = client.gdpr_export("tenant-abc")
with open("export.zip", "wb") as f:
    f.write(zip_data)
```

#### `gdpr_erase(tenant_id) -> GdprErasureResult`

Delete all data held for a tenant (Article 17 — Right to Erasure).

```python
result = client.gdpr_erase("tenant-abc")
print(result.deleted)  # {'scanEntries': 15, 'auditEntries': 42, ...}
```

### Usage and Dashboard

#### `get_usage() -> UsageResponse`

```python
usage = client.get_usage()
print(usage.key_id)
print(usage.usage)   # {'scans': 42, 'tokens': 18000}
```

#### `get_dashboard() -> DashboardResponse`

```python
dash = client.get_dashboard()
print(dash.scans)               # {'today': 5, 'week': 30, 'month': 120}
print(dash.risk_distribution)   # {'low': 80, 'medium': 25, ...}
```

## Error handling

All methods raise `FaultlineError` on non-2xx responses.

```python
from faultline_sdk import FaultlineError

try:
    result = client.scan("...")
except FaultlineError as exc:
    print(exc.status_code)   # int, e.g. 401, 429, 500
    print(exc.body)          # dict parsed from the JSON error body
    print(str(exc))          # human-readable message
```

## Models

| Class | Key fields |
|-------|-----------|
| `ScanResult` | `input`, `provider`, `overall_risk`, `claims`, `verifications`, `compliance_report` |
| `ScanDiffResult` | `before`, `after`, `new_claims`, `removed_claims`, `changed_verdicts`, `trust_score_delta`, `summary`, `inline_diff` |
| `Claim` | `id`, `text`, `type`, `importance` |
| `VerificationResult` | `claim_id`, `status`, `explanation`, `sources` |
| `Source` | `title`, `url` |
| `ComplianceReport` | `risk_tier`, `findings` |
| `ComplianceGateResponse` | `gate`, `report`, `scan_id` |
| `CiGateResult` | `passed`, `overall_risk`, `articles`, `non_compliant_count`, `exit_code` |
| `ComplianceDiffResult` | `articles`, `summary`, `risk_trend` |
| `ComplianceDeadline` | `id`, `name`, `regulation`, `deadline`, `days_until`, `severity` |
| `GdprErasureResult` | `tenant_id`, `deleted` |
| `BatchScanResponse` | `total`, `succeeded`, `failed`, `results`, `errors` |
| `BatchScanError` | `index`, `error` |
| `ApiKey` | `id`, `name`, `permissions`, `created_at`, `key` |
| `Webhook` | `id`, `url`, `events`, `created_at`, `secret` |
| `UsageResponse` | `key_id`, `usage` |
| `DashboardResponse` | `scans`, `risk_distribution`, `key_usage` |

## Development

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## License

MIT
