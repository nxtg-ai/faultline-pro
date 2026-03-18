# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.2.0] - 2026-03-18

### Added

**N-15 Rate Limiting + Usage Dashboards**
- Per-key rate limits: free 10/day, pro 1,000/day, admin 10,000/day
- `GET /dashboard` endpoint returning scan counts (today/week/month), risk distribution, and per-key usage breakdown
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on all scan responses
- 40 new tests (`ratelimit.test.ts`, `dashboard.test.ts`): 1050 → 1090

**N-12 Enterprise Features**
- `KeyStore`: `POST /keys`, `GET /keys`, `DELETE /keys/:id` with scoped permissions (`scan`, `report`, `upload`, `admin`, `pro`)
- `AuditLogger`: `onResponse` hook recording SHA-256 input hash on every scan response
- `UsageMeter`: daily per-key scan count tracking; `GET /usage` endpoint
- 70 new tests: 980 → 1050

**N-11 Multimodal Upload (PDF/OCR)**
- `POST /scan/upload` multipart endpoint for PDF and image files
- `faultline scan --file document.pdf` / `faultline scan --file screenshot.png` CLI flag
- Text extraction via `pdf-parse` (PDF) and `tesseract.js` (images/OCR)
- 20 new tests: 960 → 980

---

## [0.1.5] - 2026-03-15

### Added

**Post-N-14 Hardening**
- Resolved all npm audit vulnerabilities (0 vulnerabilities)
- `packages/api/README.md` created with endpoint reference and deployment guide
- CRUCIBLE Gates 1–5 audit completed; hollow assertions strengthened
- 14 new tests: 946 → 960

**N-14 Compliance Reports (PDF)**
- `POST /scan/report` generates an EU AI Act compliance PDF via `pdfkit`
- Response includes `Content-Disposition: attachment` with scan date in filename
- End-to-end test asserts PDF magic bytes (`%PDF`)

**N-13 Cloud Platform MVP**
- `packages/api/` Fastify v5 REST API with `POST /scan` and `GET /health`
- `x-api-key` authentication on all routes
- Docker and Fly.io deployment support

**N-18 React Workspace Split**
- npm workspaces monorepo: `packages/cli/` (pure Node.js) and `packages/web/` (React + Vite)
- `packages/cli/` published as `@nxtg/faultline` with zero React dependencies

---

## [0.1.0] - 2026-03-05

### Added

**N-16 Perplexity Provider**
- Real-time web search claim verification via Perplexity API
- Search gap callout surfaced in CLI output when evidence is insufficient

**N-10 npm Package + GitHub Action**
- `@nxtg/faultline` published to npm
- `nxtg-ai/faultline-action@v1` GitHub Action for CI integration

**N-04 SARIF + VS Code Integration**
- SARIF output format (`--output-format sarif` / `--sarif`) with `relatedLocations`, `uriBaseId`, and `codeFlows`
- Compatible with VS Code Problems panel and GitHub Code Scanning

**N-05 Rules Engine**
- YAML-defined rule system with built-in rule sets: PII detection, bias indicators, toxicity flags
- `faultline rules` command lists all active rules

**N-06 Confidence Calibration**
- Per-claim confidence scores (0.0–1.0)
- Tier-based thresholds to distinguish signal from noise
