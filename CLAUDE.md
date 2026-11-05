# CLAUDE.md — Faultline

Faultline is a forensic AI claim-verification product. It extracts atomic claims from AI-generated text, verifies each against live web evidence, and returns a risk scorecard. Positioning line: "We check the receipts on AI output."

This repo is the monorepo (`faultline-pro`, npm workspaces `packages/*`).

## Packages

| Path | What it is |
|---|---|
| `packages/cli` | `@nxtg/faultline`, the published CLI and the scan engine (extract, verify, synthesize, consensus, providers, compliance, rules) |
| `packages/api` | Fastify v5 REST API, deployed on Fly. Not published to npm |
| `packages/mcp` | MCP server with a `verify_claims` tool |
| `packages/terraform-provider` | Go Terraform provider |
| `packages/web` | The original React/Vite visualization app |
| `sdks/python` | Python client source |

## Development Commands

```bash
npm install                      # install all workspaces
npm test                         # vitest run, every package
npx vitest run                   # inside a package dir to run just that package
npx tsc --noEmit                 # typecheck
npm run version-parity           # repo, npm and deployed versions agree
npm run dev --workspace=packages/api   # API on http://localhost:3010
node packages/cli/bin/faultline.js scan --input doc.txt --provider mock   # CLI from source
cd sdks/python && python3 -m pytest -q          # Python SDK tests
```

## Architecture

Four-phase pipeline in `packages/cli`: **Extract** (atomic claims), **Verify** (per-claim verdict and confidence against retrieved sources), **Synthesize** (risk scorecard, weakest link, EU AI Act mapping), **Refine** (critique and improved prompt).

- Grounding is chosen per request: Google grounding, or Parallel Search followed by a Gemini judge with no Google tool (`FAULTLINE_GROUNDING`, see `docs/grounding-providers.md`).
- The CLI picks its transport by credential: `FAULTLINE_API_KEY` means the hosted API; otherwise it runs in-process on the caller's own provider key. With neither, it reports that nothing was checked. It never invents a verdict.
- The API wraps the same engine and adds gates in front of a scan: a per-key rate limit (429), a monthly scan quota (402), a fleet provider-spend cap (503) and the consensus entitlement (403). See `docs/provider-spend-cap.md` and `docs/usage-cap.md`.

## Development Rules

- Claim forensics is a high-rigor path. Prefer specific assertions over shallow truthiness tests; data-producing tests assert a non-empty result.
- Test counts must not decrease without a stated reason. Mutation testing (Stryker) guards the critical paths; see `docs/mutation-testing.md`.
- A number in a doc comes from a run or a cited file. Say "not re-measured since <date>" rather than guess.
- Fail safely when evidence or provider access is unavailable: an unverified claim is reported as unverified, never as a verdict.
- Never use the caller-supplied `x-user-tier` header for a money or entitlement decision on its own.
- Docs, README and CHANGELOG move in the same change as the code.
- Releases: bumping `packages/cli/package.json` means a tag, a GitHub release, the publish workflow (OIDC trusted publishing, never a local `npm publish`) and a CHANGELOG roll, with `packages/api` on the same version.

## Public / Private Boundary

This is a public repository. Do not commit private portfolio state, internal directives, agent handoffs, machine topology, local absolute paths, private memory or retrieval configuration, internal growth playbooks, credentials, production tokens, or generated reports containing private-source data. `.asif/`, `.claude/` and internal playbooks are ignored by `.gitignore`.

Use synthetic fixtures and generic company and project names in tests and documentation.

## Security

- Never commit `.env` files or credentials.
- Treat provider keys and customer evidence as sensitive data.
- Keep security and compliance examples free of real customer information.
