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
| `Claim` | `id`, `text`, `type`, `importance` |
| `VerificationResult` | `claim_id`, `status`, `explanation`, `sources` |
| `Source` | `title`, `url` |
| `ComplianceReport` | `risk_tier`, `findings` |
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
