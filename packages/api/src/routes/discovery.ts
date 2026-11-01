/**
 * Agent discovery surfaces (GoPMO 1.18.11.7.9). All public, all static:
 *
 *   GET /openapi.json  the OpenAPI document @fastify/swagger builds from the live routes
 *   GET /llms.txt      a plain-text guide to this API for language models and agents
 *   GET /pricing       the per-claim price and the monthly claim caps
 *
 * They describe the product only. The price and caps come from
 * lib/key-issuance.ts, and whether an unverified verdict bills comes from the
 * engine's own isBillableVerdict, so the page cannot drift from what is billed.
 */
import type { FastifyInstance } from 'fastify';
import { isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';
import { DEFAULT_CLAIM_CAP, MIN_CLAIM_CAP, MAX_CLAIM_CAP } from '../lib/key-issuance.js';

/** The ruled price: 0.10 USD per billable claim (lib/key-issuance.ts, docs/INTEGRATION.md §1). */
export const USD_PER_BILLABLE_CLAIM = 0.1;

const BASE_URL = 'https://faultline-api.fly.dev';

function claims(n: number): string {
  return `${n.toLocaleString('en-US')} claims`;
}

function usd(n: number): string {
  const whole = Number.isInteger(n);
  return `${n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} USD`;
}

/** What the engine decides for an unverified verdict that otherwise has every billable mark. */
export function unverifiedVerdictBills(): boolean {
  return isBillableVerdict({
    status: 'unverified',
    sources: [{ uri: 'https://example.com/' }],
    provenance: { retriever: 'gemini-grounding' },
  });
}

function unverifiedSentence(): string {
  return unverifiedVerdictBills()
    ? 'A claim with an unverified verdict is billed.'
    : 'A claim with an unverified verdict is not billed.';
}

export function renderLlmsTxt(): string {
  return `# Faultline API

> Faultline extracts the factual claims in a piece of AI-generated text, checks each claim against live web sources, and returns a verdict per claim (supported, contradicted, mixed or unverified) with the sources it used.

Base URL: ${BASE_URL}
Authentication: send your API key in the \`x-api-key\` header on every request except the public pages listed below.

## Machine-readable description

- OpenAPI 3 document: ${BASE_URL}/openapi.json (the same document as ${BASE_URL}/docs/json)
- Interactive API docs: ${BASE_URL}/docs
- This file: ${BASE_URL}/llms.txt

## Main endpoints

- POST /scan: body \`{ "text": "..." }\`. Extracts claims and verifies each one. Returns the claims, a verdict per claim with sources, an overall risk band, and a \`billing\` field naming which claims were billed and why the others were not.
- GET /scan/stream and POST /scan/stream: the same scan as Server-Sent Events, one \`claim_verified\` event per claim, then \`complete\`.
- POST /scan/full, then GET /scan/full/{jobId}: a long document as a background job you poll.
- POST /mcp: hosted MCP server (Streamable HTTP, stateless) with the \`verify_claims\` tool; send the same \`x-api-key\` header.
- GET /usage: your key's usage this month, including its claim cap position when the key is metered.
- GET /health: service status and version (public).

## Verdicts

- supported, contradicted, mixed: always carry at least one source a reader can open.
- unverified: no source the claim can be checked against was found, or the check failed. Its risk was not checked; it is never read as low risk.

## Pricing

- ${usd(USD_PER_BILLABLE_CLAIM)} per billable claim. Details: ${BASE_URL}/pricing
- A claim is billable when its verdict is supported, contradicted or mixed and carries at least one source the engine retrieved. ${unverifiedSentence()}

## Errors

- 401 or 403: missing or invalid \`x-api-key\`.
- 402 \`claim_cap_reached\`: your key's monthly claim cap cannot cover the request; nothing was verified.
- 429: per-minute rate limit.
`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPricingHtml(): string {
  const price = usd(USD_PER_BILLABLE_CLAIM);
  const row = (label: string, n: number) =>
    `<tr><th scope="row">${escHtml(label)}</th><td>${claims(n)}</td><td>${usd(n * USD_PER_BILLABLE_CLAIM)} a month</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Faultline API pricing</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #ffffff; --muted: #555; --line: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eaeaea; --bg: #121212; --muted: #aaa; --line: #333; } }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; }
  .price { font-size: 2rem; font-weight: 700; margin: 16px 0 4px; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }
  .plain { font-weight: 700; }
</style>
</head>
<body>
<main>
  <h1>Faultline API pricing</h1>
  <p class="price">${price} per billable claim</p>
  <p class="muted">Only claims with a billable verdict are billed.</p>

  <h2>Monthly claim cap</h2>
  <p>Each API key has a cap on billable claims per calendar month (UTC). A request the cap cannot cover is refused with <code>402 claim_cap_reached</code> and nothing is verified or billed.</p>
  <table>
    <thead><tr><th scope="col"></th><th scope="col">Claims</th><th scope="col">Most you can be billed</th></tr></thead>
    <tbody>
      ${row('Lowest cap', MIN_CLAIM_CAP)}
      ${row('Default cap', DEFAULT_CLAIM_CAP)}
      ${row('Highest cap', MAX_CLAIM_CAP)}
    </tbody>
  </table>

  <h2>What bills</h2>
  <p>A claim is billable when its verdict is supported, contradicted or mixed and it carries at least one source the engine retrieved.</p>
  <p class="plain">${escHtml(unverifiedSentence())}</p>
  <p>Claims with no source, claims where the provider failed or timed out, and claims never sent for checking are not billed either. Every result has a <code>billing</code> field that lists each claim that was not billed and the reason.</p>
</main>
</body>
</html>
`;
}

export async function discoveryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/openapi.json', {
    config: { access: 'public' },
    schema: { tags: ['Monitoring'], summary: 'OpenAPI 3 document for this API, built from the live routes' },
  }, async (_request, reply) => {
    reply.type('application/json; charset=utf-8');
    return fastify.swagger();
  });

  const llms = renderLlmsTxt();
  fastify.get('/llms.txt', {
    config: { access: 'public' },
    schema: { tags: ['Monitoring'], summary: 'Plain-text guide to this API for language models and agents' },
  }, async (_request, reply) => {
    reply.type('text/plain; charset=utf-8');
    return llms;
  });

  const pricing = renderPricingHtml();
  fastify.get('/pricing', {
    config: { access: 'public' },
    schema: { tags: ['Monitoring'], summary: 'Per-claim price and monthly claim caps (HTML)' },
  }, async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return pricing;
  });
}
