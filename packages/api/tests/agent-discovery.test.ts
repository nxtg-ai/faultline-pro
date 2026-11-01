// Validates: GoPMO 1.18.11.7.9 (make Faultline discoverable by agents)
//
// Exit clauses, one block each:
//  - server.json for the official MCP Registry: remote-only, one Streamable HTTP
//    remote at https://faultline-api.fly.dev/mcp, an X-API-Key header that is
//    required and secret, a publisher name under nxtg.ai; valid against the
//    registry's own schema (vendored, 2025-12-11).
//  - GET /openapi.json is served, with no key, and matches the live routes both ways.
//  - GET /llms.txt is served for the API, with no key.
//  - GET /pricing is public and shows only the ruled per-claim price and caps,
//    and states plainly whether an unverified verdict bills, from the engine's
//    own isBillableVerdict.
//  - No strategy content on any of them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { FastifyInstance, RouteOptions } from 'fastify';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';
import { buildServer } from '../src/server.js';
import { DEFAULT_CLAIM_CAP, MIN_CLAIM_CAP, MAX_CLAIM_CAP } from '../src/lib/key-issuance.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(here, '../../..');

/** Words that mark strategy, competitor or margin talk; none may appear on a public discovery surface. */
const STRATEGY_TERMS = [
  'competitor', 'promptfoo', 'acquired', 'not owned by an ai lab', 'only ai safety',
  'margin', 'cogs', 'break-even', 'breakeven', 'roadmap', 'gtm', 'go-to-market',
  'positioning', 'moat', 'revenue', 'runway', 'underwater', 'strategy',
];

function strategyHits(text: string): string[] {
  const lower = text.toLowerCase();
  return STRATEGY_TERMS.filter((t) => lower.includes(t));
}

describe('1.18.11.7.9 server.json for the MCP Registry', () => {
  // Read leniently so a missing file fails each clause on its own (red-before).
  let raw = '{}';
  try { raw = readFileSync(resolve(REPO_ROOT, 'server.json'), 'utf8'); } catch { /* missing */ }
  const doc = JSON.parse(raw) as Record<string, any>;

  it('MR1. validates against the registry server.schema.json (2025-12-11)', () => {
    const schema = JSON.parse(readFileSync(resolve(here, 'fixtures/mcp-server.schema.2025-12-11.json'), 'utf8'));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(doc.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  });

  it('MR2. is remote-only: no packages entry', () => {
    expect(doc).not.toHaveProperty('packages');
  });

  it('MR3. has exactly one remote, Streamable HTTP at https://faultline-api.fly.dev/mcp', () => {
    expect(Array.isArray(doc.remotes)).toBe(true);
    expect(doc.remotes).toHaveLength(1);
    expect(doc.remotes[0].type).toBe('streamable-http');
    expect(doc.remotes[0].url).toBe('https://faultline-api.fly.dev/mcp');
  });

  it('MR4. asks for an X-API-Key header that is required and secret', () => {
    const headers = doc.remotes[0].headers as Array<Record<string, unknown>>;
    expect(headers).toHaveLength(1);
    expect(headers[0].name).toBe('X-API-Key');
    expect(headers[0].isRequired).toBe(true);
    expect(headers[0].isSecret).toBe(true);
    expect(typeof headers[0].description).toBe('string');
  });

  it('MR5. the publisher namespace is nxtg.ai in reverse-DNS form (DNS or HTTP auth)', () => {
    expect(doc.name).toMatch(/^ai\.nxtg\/[a-zA-Z0-9._-]+$/);
  });

  it('MR6. carries no strategy content', () => {
    expect(strategyHits(raw)).toEqual([]);
  });
});

describe('1.18.11.7.9 public discovery routes', () => {
  let server: FastifyInstance;
  const routes: RouteOptions[] = [];

  beforeAll(async () => {
    process.env.FAULTLINE_API_KEY = 'discovery-test-key';
    server = buildServer();
    server.addHook('onRoute', (route) => { routes.push(route); });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  describe('the server.json remote is served', () => {
    it('SJ1. POST /mcp (the remote URL path) is a live route that asks for X-API-Key', async () => {
      const doc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'server.json'), 'utf8'));
      const path = new URL(doc.remotes[0].url).pathname;
      expect(path).toBe('/mcp');
      const res = await server.inject({
        method: 'POST', url: path,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /openapi.json', () => {
    it('OA1. is served with no key as an OpenAPI 3 document', async () => {
      const res = await server.inject({ method: 'GET', url: '/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const spec = res.json();
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.info.title).toBe('Faultline API');
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    });

    it('OA2. is the same document the API docs serve', async () => {
      const a = (await server.inject({ method: 'GET', url: '/openapi.json' })).json();
      const b = (await server.inject({ method: 'GET', url: '/docs/json' })).json();
      expect(a).toEqual(b);
    });

    it('OA3. lists every live route, and every listed operation is a live route', async () => {
      const spec = (await server.inject({ method: 'GET', url: '/openapi.json' })).json();
      const toPath = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const live = new Set<string>();
      for (const r of routes) {
        if ((r.schema as { hide?: boolean } | undefined)?.hide) continue;
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) {
          if (m === 'HEAD' || m === 'OPTIONS') continue;
          live.add(`${m.toLowerCase()} ${toPath(r.url)}`);
        }
      }
      expect(live.size).toBeGreaterThan(100);
      const listed = new Set<string>();
      for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
        for (const m of Object.keys(ops)) {
          if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) listed.add(`${m} ${path}`);
        }
      }
      expect([...live].filter((k) => !listed.has(k))).toEqual([]);
      expect([...listed].filter((k) => !live.has(k))).toEqual([]);
      for (const k of ['get /openapi.json', 'get /llms.txt', 'get /pricing', 'post /scan']) {
        expect(listed.has(k)).toBe(true);
      }
    });

    it('OA4. carries no strategy content', async () => {
      const res = await server.inject({ method: 'GET', url: '/openapi.json' });
      expect(strategyHits(res.body)).toEqual([]);
    });
  });

  describe('GET /llms.txt', () => {
    it('LL1. is served with no key as plain text about this API', async () => {
      const res = await server.inject({ method: 'GET', url: '/llms.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body.startsWith('# Faultline API')).toBe(true);
      for (const s of ['https://faultline-api.fly.dev', 'x-api-key', '/openapi.json', '/pricing', 'POST /scan', 'POST /mcp']) {
        expect(res.body).toContain(s);
      }
    });

    it('LL2. carries no strategy content', async () => {
      const res = await server.inject({ method: 'GET', url: '/llms.txt' });
      expect(strategyHits(res.body)).toEqual([]);
    });
  });

  describe('GET /pricing', () => {
    it('PR1. is served with no key as HTML with no script', async () => {
      const res = await server.inject({ method: 'GET', url: '/pricing' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).not.toMatch(/<script/i);
    });

    it('PR2. shows the ruled price per billable claim and the caps from key-issuance', async () => {
      const body = (await server.inject({ method: 'GET', url: '/pricing' })).body;
      const n = (x: number) => x.toLocaleString('en-US');
      expect(body).toContain('0.10 USD');
      expect(body).toContain(`${n(MIN_CLAIM_CAP)} claims`);
      expect(body).toContain(`${n(MAX_CLAIM_CAP)} claims`);
      expect(body).toContain(`${n(DEFAULT_CLAIM_CAP)} claims`);
      expect(body).toContain('10 USD');
      expect(body).toContain('1,000 USD');
      expect(body).toContain('100 USD');
    });

    it('PR3. states plainly whether a claim with an unverified verdict bills, as the engine decides', async () => {
      const body = (await server.inject({ method: 'GET', url: '/pricing' })).body;
      const unverifiedBills = isBillableVerdict({
        status: 'unverified',
        sources: [{ uri: 'https://example.com/' }],
        provenance: { retriever: 'gemini-grounding' },
      });
      const sentence = unverifiedBills
        ? 'A claim with an unverified verdict is billed.'
        : 'A claim with an unverified verdict is not billed.';
      expect(body).toContain(sentence);
      const opposite = unverifiedBills
        ? 'A claim with an unverified verdict is not billed.'
        : 'A claim with an unverified verdict is billed.';
      expect(body).not.toContain(opposite);
    });

    it('PR4. shows only the price and caps: no plan tiers, no per-scan prices', async () => {
      const body = (await server.inject({ method: 'GET', url: '/pricing' })).body;
      expect(body).not.toMatch(/\/mo\b|per scan|\$\d/i);
      expect(body).not.toMatch(/Personal|Enterprise|Free plan|Pro plan/);
    });

    it('PR5. carries no strategy content', async () => {
      // The stylesheet is not content (CSS 'margin' is not a margin claim).
      const body = (await server.inject({ method: 'GET', url: '/pricing' })).body.replace(/<style>[\s\S]*?<\/style>/, '');
      expect(body).not.toContain('<style>');
      expect(strategyHits(body)).toEqual([]);
    });
  });
});
