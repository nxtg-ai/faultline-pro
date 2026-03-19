# Faultline Pro API — Deployment Guide

## Prerequisites

- Node 20+
- Docker (for containerized deploy)
- [Fly.io CLI](https://fly.io/docs/flyctl/install/) (`flyctl`) **or** Railway CLI

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAULTLINE_API_KEY` | Yes | Master admin API key |
| `GEMINI_API_KEY` | Yes (or any provider) | Google Gemini API key |
| `OPENAI_API_KEY` | Optional | OpenAI provider |
| `ANTHROPIC_API_KEY` | Optional | Claude provider |
| `PERPLEXITY_API_KEY` | Optional | Perplexity provider |
| `PORT` | Optional | Server port (default: 3000) |
| `NODE_ENV` | Optional | Set to `production` |

At least one provider key is required for scan endpoints to work. `FAULTLINE_API_KEY` gates all authenticated routes.

## Local Docker Build + Run

```bash
# From repo root
docker build -t faultline-api .
docker run -p 3000:3000 \
  -e FAULTLINE_API_KEY=your-secret-key \
  -e GEMINI_API_KEY=your-gemini-key \
  faultline-api
```

Verify: `curl http://localhost:3000/health`

## Fly.io Deploy

### First deploy

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Create app (first time only)
fly apps create faultline-api --org personal

# Set secrets
fly secrets set \
  FAULTLINE_API_KEY=your-secret-key \
  GEMINI_API_KEY=your-gemini-key \
  --app faultline-api

# Deploy
fly deploy --config packages/api/fly.toml
```

### Subsequent deploys

```bash
fly deploy --config packages/api/fly.toml
```

### Verify

```bash
curl https://faultline-api.fly.dev/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "faultline-api",
  "version": "0.2.0",
  "subsystems": { "...": "..." },
  "providers": { "...": "..." }
}
```

## Railway Deploy

### One-command deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize (first time)
railway init

# Set env vars
railway variables set FAULTLINE_API_KEY=your-secret-key
railway variables set GEMINI_API_KEY=your-gemini-key

# Deploy
railway up
```

Add a `railway.json` at repo root if needed:
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": { "startCommand": "node --import tsx/esm packages/api/src/index.ts", "healthcheckPath": "/health" }
}
```

## Health Check

After any deploy, verify all subsystems:

```bash
curl https://your-app.fly.dev/health
curl https://your-app.fly.dev/health/deep
```

The `/health` endpoint returns `status: ok` when the API is ready. The `/health/deep` endpoint shows per-provider configuration status.

## Rate Limits (Production)

| Tier | Limit |
|------|-------|
| Free | 10 requests/minute |
| Pro | 100 requests/minute |
| Admin | 10,000 requests/minute |

Tiers are determined by the permissions on the API key (see `POST /keys`).

## CORS

Allowed origins in production:
- `https://faultline.nxtg.ai`
- `https://*.nxtg.ai`
- `http://localhost:*` (development only)

All other origins are blocked with a CORS error.
