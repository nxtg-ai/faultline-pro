// Validates: hosted MCP endpoint contract (POST /mcp)
// NEXUS: hosted remote MCP, same verify_claims tool, every POST /scan gate applies
//
// POST /mcp speaks the MCP Streamable HTTP transport, stateless, with JSON
// responses. These tests drive it two ways: as raw Streamable HTTP request
// bodies through fastify inject (with the Accept header the SDK requires), and
// with the SDK's own client over a listening socket. The scans run on the
// engine's built-in 'mock' provider, through the API's own POST /scan.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer as buildStdioMcpServer } from '@nxtg/faultline-mcp/src/server.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetClaimMeter } from '../src/store/claim-meter.js';
import { MCP_ALLOWED_ORIGINS_ENV, isMcpOriginAllowed, mcpAllowedOrigins } from '../src/routes/mcp.js';

const SERVER_KEY = 'mcp-hosted-server-key-0123456789';
const MEASUREMENT_KEY = 'mcp-hosted-measurement-key-0123456789';
const ACCEPT = 'application/json, text/event-stream';
const PROTOCOL_VERSION = '2025-06-18';
const TEXT = 'The Eiffel Tower is in Paris. Water boils at 100 degrees Celsius at sea level.';

const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_MEASUREMENT_KEY', MCP_ALLOWED_ORIGINS_ENV, 'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_HISTORY_DIR', 'NODE_ENV',
];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;
const routes: RouteOptions[] = [];

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-mcp-hosted-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_MEASUREMENT_KEY = MEASUREMENT_KEY;
  delete process.env[MCP_ALLOWED_ORIGINS_ENV];
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  // If the hosted tool wrote an audit record, it would land here.
  process.env.FAULTLINE_HISTORY_DIR = join(dir, 'history');
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetCircuitBreaker();
  resetProviderSpendLedger();
  resetClaimMeter();
  routes.length = 0;
  app = buildServer();
  app.addHook('onRoute', (route) => { routes.push(route); });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 1;
function rpc(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

const INITIALIZE = () => rpc('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'hosted-mcp-test', version: '0.0.0' },
});

function postMcp(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'x-api-key': SERVER_KEY,
      ...headers,
    },
    payload: JSON.stringify(body),
  });
}

/** The single tool result from a tools/call response. */
function toolResult(res: { statusCode: number; body: string }) {
  expect(res.statusCode).toBe(200);
  const json = JSON.parse(res.body);
  expect(json.error).toBeUndefined();
  return json.result as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
}

describe('POST /mcp: Streamable HTTP, stateless, JSON responses', () => {
  it('answers initialize with the faultline server info and no session id', async () => {
    const res = await postMcp(INITIALIZE());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['mcp-session-id']).toBeUndefined();
    const json = JSON.parse(res.body);
    expect(json.result.serverInfo).toEqual({ name: 'faultline', version: expect.any(String) });
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it('acknowledges the initialized notification with 202 and no body', async () => {
    const res = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('lists exactly one tool, verify_claims', async () => {
    const res = await postMcp(rpc('tools/list'));
    expect(res.statusCode).toBe(200);
    const tools = JSON.parse(res.body).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }>;
    expect(tools.map((t) => t.name)).toEqual(['verify_claims']);
    expect(Object.keys(tools[0].inputSchema.properties).sort()).toEqual(['max_claims', 'provider', 'text']);
    expect(tools[0].inputSchema.required).toEqual(['text']);
  });

  it('calls verify_claims through POST /scan: overall_risk and the billing field are in the result', async () => {
    const res = await postMcp(rpc('tools/call', { name: 'verify_claims', arguments: { text: TEXT, provider: 'mock' } }));
    const result = toolResult(res);
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.mode).toBe('hosted');
    expect(out.provider).toBe('Mock Provider');
    expect(Array.isArray(out.claims)).toBe(true);
    expect((out.claims as unknown[]).length).toBeGreaterThan(0);
    expect(out.claims_total).toBe((out.claims as unknown[]).length);
    expect(['low', 'medium', 'high', 'critical']).toContain(out.overall_risk);
    // The billing field POST /scan adds to every result (lib/billing.ts).
    // The mock provider cites no source, so the zero-source rule bills none of its claims.
    expect(out.billing).toEqual(expect.objectContaining({ billedClaims: 0, unbilled: expect.any(Array) }));
    expect((out.billing as { unbilled: Array<{ reason: string }> }).unbilled.length).toBe(out.claims_total);
    expect((out.billing as { unbilled: Array<{ reason: string }> }).unbilled.every((u) => u.reason === 'no_source')).toBe(true);
    // The text content is the same object, for clients that read text only.
    expect(JSON.parse(result.content[0].text)).toEqual(out);
    // A server never writes callers' text to its own disk.
    expect(out.audit_ref).toBeUndefined();
    expect(out.audit_skipped).toMatch(/not written by this server/);
    expect(existsSync(join(dir, 'history'))).toBe(false);
  });

  it('gives the same overall risk and billing as POST /scan does for the same text and key', async () => {
    const direct = await app.inject({
      method: 'POST', url: '/scan',
      headers: { 'content-type': 'application/json', 'x-api-key': SERVER_KEY },
      payload: { text: TEXT, provider: 'mock' },
    });
    expect(direct.statusCode).toBe(200);
    const scan = JSON.parse(direct.body);
    resetCache();
    const out = toolResult(await postMcp(rpc('tools/call', { name: 'verify_claims', arguments: { text: TEXT, provider: 'mock' } }))).structuredContent!;
    expect(out.overall_risk).toBe(scan.overallRisk);
    expect(out.billing).toEqual(scan.billing);
    expect(out.claims_total).toBe(scan.claims.length);
  });

  it('a body POST /scan refuses (text over its 50,000 character limit) comes back as a tool error, not a verdict', async () => {
    const result = toolResult(await postMcp(rpc('tools/call', { name: 'verify_claims', arguments: { text: 'a'.repeat(50_001), provider: 'mock' } })));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/400/);
    expect(result.content[0].text).toMatch(/TOOL FAILURE, not a verdict/);
  });

  it('refuses a request without the Accept header the transport requires (406)', async () => {
    const res = await postMcp(INITIALIZE(), { accept: 'application/json' });
    expect(res.statusCode).toBe(406);
    expect(JSON.parse(res.body).jsonrpc).toBe('2.0');
  });

  it('a body over the limit gets 413 with a JSON-RPC error body', async () => {
    const res = await postMcp(rpc('tools/call', { name: 'verify_claims', arguments: { text: 'a'.repeat(app.initialConfig.bodyLimit + 1) } }));
    expect(res.statusCode).toBe(413);
    const json = JSON.parse(res.body);
    expect(json).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: expect.any(String) }, id: null });
  });

  it('has the same body limit as POST /scan', () => {
    const limitOf = (method: string, url: string) => {
      const route = routes.find((r) => r.url === url && (Array.isArray(r.method) ? r.method : [r.method]).includes(method));
      expect(route, `${method} ${url} is registered`).toBeDefined();
      return route!.bodyLimit ?? app.initialConfig.bodyLimit;
    };
    expect(limitOf('POST', '/mcp')).toBe(limitOf('POST', '/scan'));
  });
});

describe('POST /mcp: the key check', () => {
  it('401 with no key, as a JSON-RPC error, before any MCP processing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', accept: ACCEPT },
      payload: JSON.stringify(INITIALIZE()),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    const json = JSON.parse(res.body);
    expect(json).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: expect.stringMatching(/x-api-key/) }, id: null });
    // No MCP processing happened: no initialize result.
    expect(json.result).toBeUndefined();
  });

  it('401 with an invalid key', async () => {
    const res = await postMcp(INITIALIZE(), { 'x-api-key': 'not-a-real-key' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
  });

  it('401 even for a malformed body when there is no key (the key check runs first)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', accept: ACCEPT },
      payload: '{"not":"json-rpc"}',
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses the measurement key (its allowlist excludes /mcp)', async () => {
    const res = await postMcp(INITIALIZE(), { 'x-api-key': MEASUREMENT_KEY });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: expect.stringMatching(/measurement key/) }, id: null });
  });
});

describe('/mcp: methods other than POST', () => {
  for (const method of ['GET', 'DELETE'] as const) {
    it(`${method} answers 405 with Allow: POST`, async () => {
      const res = await app.inject({ method, url: '/mcp', headers: { 'x-api-key': SERVER_KEY, accept: ACCEPT } });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
      expect(JSON.parse(res.body).jsonrpc).toBe('2.0');
    });
  }
});

describe('/mcp: Origin validation (DNS rebinding)', () => {
  it('the allowlist is empty by default and is read from the env var', () => {
    expect(mcpAllowedOrigins({})).toEqual([]);
    expect(isMcpOriginAllowed('https://faultline.nxtg.ai', {})).toBe(false);
    const env = { [MCP_ALLOWED_ORIGINS_ENV]: ' https://a.example , https://b.example/ ' };
    expect(mcpAllowedOrigins(env)).toEqual(['https://a.example', 'https://b.example']);
    expect(isMcpOriginAllowed('https://b.example', env)).toBe(true);
    expect(isMcpOriginAllowed('https://c.example', env)).toBe(false);
  });

  it('a disallowed Origin gets 403, even with a valid key, and no MCP processing', async () => {
    const res = await postMcp(INITIALIZE(), { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.error.message).toMatch(/Origin not allowed/);
    expect(json.result).toBeUndefined();
  });

  it('a present but empty Origin is not "no Origin": 403, no MCP processing', async () => {
    const res = await postMcp(INITIALIZE(), { origin: '' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).result).toBeUndefined();
  });

  it('a disallowed Origin gets 403 before the key check (no key: still 403, not 401)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', accept: ACCEPT, origin: 'http://localhost:3000' },
      payload: JSON.stringify(INITIALIZE()),
    });
    expect(res.statusCode).toBe(403);
  });

  it('the main CORS allowlist does not admit an origin to /mcp (default empty)', async () => {
    const res = await postMcp(INITIALIZE(), { origin: 'https://faultline.nxtg.ai' });
    expect(res.statusCode).toBe(403);
  });

  it('an allowlisted Origin is served, with CORS headers for that origin', async () => {
    process.env[MCP_ALLOWED_ORIGINS_ENV] = 'https://inspector.example';
    const res = await postMcp(INITIALIZE(), { origin: 'https://inspector.example' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://inspector.example');
    expect(JSON.parse(res.body).result.serverInfo.name).toBe('faultline');
  });

  it('a preflight from an allowlisted Origin is answered; from any other, refused', async () => {
    process.env[MCP_ALLOWED_ORIGINS_ENV] = 'https://inspector.example';
    const ok = await app.inject({
      method: 'OPTIONS', url: '/mcp',
      headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key,content-type' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://inspector.example');
    expect(String(ok.headers['access-control-allow-headers'])).toMatch(/x-api-key/);
    const refused = await app.inject({
      method: 'OPTIONS', url: '/mcp',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('no Origin (a server-to-server client) is allowed, in production too', async () => {
    process.env.NODE_ENV = 'production';
    const res = await postMcp(INITIALIZE());
    expect(res.statusCode).toBe(200);
  });
});

describe('the hosted and stdio tools are one definition', () => {
  it('hosted tools/list equals the stdio server tools/list', async () => {
    const hosted = JSON.parse((await postMcp(rpc('tools/list'))).body).result;

    const stdio = buildStdioMcpServer();
    const client = new Client({ name: 'parity', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await stdio.connect(serverSide);
    await client.connect(clientSide);
    try {
      const local = await client.listTools();
      expect(hosted.tools.length).toBe(1);
      expect(hosted).toEqual(JSON.parse(JSON.stringify(local)));
    } finally {
      await client.close();
      await stdio.close();
    }
  });
});

describe('an MCP client over HTTP', () => {
  it('the SDK client connects with an x-api-key header, lists and calls the tool', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const client = new Client({ name: 'remote-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'x-api-key': SERVER_KEY } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['verify_claims']);
      const result = await client.callTool({ name: 'verify_claims', arguments: { text: TEXT, provider: 'mock' } });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as Record<string, unknown>;
      expect((out.claims as unknown[]).length).toBeGreaterThan(0);
      expect(out.overall_risk).toEqual(expect.any(String));
      expect(out.billing).toBeDefined();
    } finally {
      await client.close();
    }
  });
});
