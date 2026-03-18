# Terraform Provider: Faultline

The Faultline Terraform provider brings AI claim verification into your infrastructure-as-code workflow. It lets you:

- **Manage API keys** declaratively — create, track, and rotate keys as Terraform resources
- **Gate deployments on content safety** — scan release notes, changelogs, or any text during `terraform plan` and fail if risk is critical

---

## What It Does

| Construct | Type | Purpose |
|-----------|------|---------|
| `faultline_api_key` | Resource | Provision and lifecycle-manage Faultline API keys |
| `faultline_scan` | Data Source | Run a claim verification scan and expose the risk level |

The scan data source is designed for **scan-gated deployments**: use Terraform's `check` block to assert that content risk is acceptable before allowing `apply` to proceed.

---

## Requirements

- Terraform >= 1.6 (for `check` block support)
- A running Faultline API instance or access to `https://api.faultline.nxtg.ai`
- A Faultline API key with `admin` permission (for key management) or `scan` permission (for data source only)

---

## Installation

### From the Terraform Registry (once published)

```hcl
terraform {
  required_providers {
    faultline = {
      source  = "nxtg-ai/faultline"
      version = "~> 0.1"
    }
  }
}
```

Run `terraform init` — Terraform will download the provider automatically.

### Local development build

```bash
cd packages/terraform-provider
make install          # builds and copies to ~/.terraform.d/plugins/
```

Then add a `dev_overrides` block to `~/.terraformrc`:

```hcl
provider_installation {
  dev_overrides {
    "nxtg-ai/faultline" = "/path/to/terraform-provider-faultline/binary"
  }
  direct {}
}
```

---

## Authentication

The provider requires an API key. Set it via:

**Environment variable (recommended for CI):**

```bash
export FAULTLINE_API_KEY=fl_live_xxxxxxxxxxxxx
```

**Provider block (for explicit configuration):**

```hcl
provider "faultline" {
  api_key = var.faultline_api_key
}
```

Never hardcode API keys in `.tf` files. Use `var.faultline_api_key` sourced from a secrets manager, or set `TF_VAR_faultline_api_key` in your CI environment.

---

## Provider Configuration

```hcl
provider "faultline" {
  api_key  = var.faultline_api_key                   # Required. Also: FAULTLINE_API_KEY env var.
  base_url = "https://api.faultline.nxtg.ai"         # Optional. Default: http://localhost:3000
}
```

| Attribute | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `api_key` | string | Yes | — | API key for authentication. Sensitive. |
| `base_url` | string | No | `http://localhost:3000` | Faultline API base URL. |

---

## Example: API Key Lifecycle Management

Provision a dedicated key for each environment:

```hcl
resource "faultline_api_key" "staging" {
  name        = "Staging CI Scanner"
  permissions = ["scan", "report"]
}

resource "faultline_api_key" "production" {
  name        = "Production Read-Only Scanner"
  permissions = ["scan"]
}

# Pass the key to your application via a secrets manager
resource "aws_ssm_parameter" "faultline_key" {
  name  = "/myapp/faultline-api-key"
  type  = "SecureString"
  value = faultline_api_key.production.key
}
```

Key attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | string (computed) | UUID assigned by Faultline |
| `name` | string (required) | Human-readable label |
| `permissions` | list(string) (optional) | Defaults to `["scan"]` |
| `key` | string (computed, sensitive) | Raw API key value |
| `created_at` | string (computed) | ISO-8601 creation timestamp |

Note: `name` and `permissions` changes trigger a destroy-then-create cycle. The old key is deleted before the new one is created.

---

## Example: Scan-Gated Deployment

Prevent deploying infrastructure if your release notes contain critical-risk AI-generated content:

```hcl
data "faultline_scan" "release_notes" {
  text     = file("${path.module}/RELEASE-NOTES.md")
  provider = "gemini"    # or "openai", "claude", "perplexity", "mock"
}

output "release_notes_risk" {
  value = data.faultline_scan.release_notes.overall_risk
}

check "release_notes_safety" {
  assert {
    condition     = data.faultline_scan.release_notes.overall_risk != "critical"
    error_message = "Release notes contain critical-risk AI-generated content. Remediate before deploying."
  }
}
```

When `overall_risk` is `"critical"`, `terraform plan` will report a check failure and `terraform apply` will be blocked.

Data source attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `text` | string (required) | Text to scan |
| `provider` | string (optional) | AI provider. Default: `"mock"` |
| `id` | string (computed) | SHA-256 of input text |
| `overall_risk` | string (computed) | `"low"`, `"medium"`, `"high"`, or `"critical"` |
| `claims_count` | number (computed) | Number of extracted claims |

---

## Development

```bash
make build     # Compile the provider binary
make install   # Build + copy to local Terraform plugin directory
make test      # Run Go tests (go test ./...)
make fmt       # Format all Go source (go fmt ./...)
make lint      # Run golangci-lint (requires golangci-lint installed)
```

### Running acceptance tests

Acceptance tests make real API calls. Set the following before running:

```bash
export FAULTLINE_API_KEY=fl_test_xxxxxxxxxxxxx
export FAULTLINE_BASE_URL=http://localhost:3000
TF_ACC=1 go test ./internal/provider/ -v -timeout 120s
```

---

## Contributing

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) at the repo root. All PRs require passing tests and `make fmt` clean output.

---

## License

MIT — see [LICENSE](../../../LICENSE) at the repo root.
