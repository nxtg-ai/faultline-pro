# CLAUDE.md — Faultline

Faultline is a forensic AI claim-verification platform. It extracts atomic claims from model output, verifies those claims against evidence, and produces structured risk and compliance artifacts.

## Development Commands

```bash
npm install
npm run dev
npm run build
npm test
```

## Product Architecture

Core work should preserve the public product pipeline:
1. extract claims into structured records;
2. verify claims against supported evidence sources;
3. synthesize risk and confidence outputs;
4. generate user-facing remediation or reporting artifacts.

## Development Rules

- Treat claim forensics as a high-rigor path. Prefer specific assertions over shallow truthiness tests.
- Test counts and coverage should not regress without explicit justification.
- Keep provider behavior observable and fail safely when evidence or provider access is unavailable.
- Preserve the documented public API and CLI contracts.
- Keep release metadata, tags, changelog entries, and published package versions aligned.

## Public / Private Boundary

This is a public repository. Do not commit private portfolio state, internal directives, agent handoffs, machine topology, local absolute paths, private memory/retrieval configuration, internal growth playbooks, credentials, production tokens, or generated reports containing private-source data.

Use synthetic fixtures and generic company/project names in tests and documentation. Public documentation should describe product behavior and reproducible public examples only.

## Security

- Never commit `.env` files or credentials.
- Treat provider keys and customer evidence as sensitive data.
- Keep security and compliance examples free of real customer information.
- Generated audit artifacts should stay local unless intentionally scrubbed for public release.
