// Validates: hosted MCP endpoint contract (POST /mcp): every POST /scan gate applies
// NEXUS: hosted remote MCP, same verify_claims tool, every POST /scan gate applies
//
// The verify_claims tool on POST /mcp scans through the API's own POST /scan,
// in-process, with the caller's key. These tests prove the gates hold on that
// path with real metered customer keys. Every provider the engine resolves is
// a fixture answering as the engine's own 'gemini' instance
// (helpers/engine-stand-in.ts), so its sourced verdicts are billable and every
// provider call is counted. No real provider is called.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { ENGINE_PROVIDER, ONE_SOURCE, placeholderProviderKey } from './helpers/engine-stand-in.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';

const control = { extractCalls: 0, verifyCalls: 0 };

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
  return engineStandInRegistry(await importOriginal(), () => ({
    name: 'Hosted MCP fixture',
    modelId: 'fixture-v1',
    extractClaims: async (text: string): Promise<Claim[]> => {
      control.extractCalls += 1;
      return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
        .map((s, i) => ({ id: `c${i + 1}`, text: s, type: 'fact' as const, importance: 5 }));
    },
    verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
      control.verifyCalls += 1;
      return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: ONE_SOURCE } as VerificationResult;
    },
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }));
});

const SERVER_KEY = 'mcp-gates-server-key-0123456789';
const ACCEPT = 'application/json, text/event-stream';
const TEXT = 'The Eiffel Tower is in Paris. Water boils at 100 degrees Celsius at sea level.';
const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'FAULTLINE_API_KEY', 'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER',
  'FAULTLINE_KEY_IDEMPOTENCY_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_HISTORY_DIR',
  'FAULTLINE_USAGE_CAP', 'FAULTLINE_CAP_FREE',
];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;
/** Every inner request the server saw, with its headers, in order. */
const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-mcp-gates-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_CLAIM_METER = '1';
  process.env.GEMINI_API_KEY = placeholderProviderKey();
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  process.env.FAULTLINE_HISTORY_DIR = join(dir, 'history');
  Object.assign(control, { extractCalls: 0, verifyCalls: 0 });
  seen.length = 0;
  resetClaimMeter();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetProviderSpendLedger();
  resetCircuitBreaker();
  app = buildServer();
  app.addHook('onRequest', async (request) => {
    seen.push({ url: request.url, headers: { ...request.headers } });
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 1;
function callTool(key: string, args: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: ACCEPT, 'x-api-key': key, ...extraHeaders },
    payload: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'verify_claims', arguments: args } }),
  });
}

function toolResult(res: { statusCode: number; body: string }) {
  expect(res.statusCode).toBe(200);
  const json = JSON.parse(res.body);
  expect(json.error).toBeUndefined();
  return json.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}

function meteredKey(name: string, claimCap: number) {
  return getKeyStore().create(name, ['scan', 'pro'], undefined, { claimCap, metered: true });
}

describe('POST /mcp: the POST /scan gates hold', () => {
  it('a metered key at its claim cap gets the 402 as a tool error, and no provider is called', async () => {
    const zero = meteredKey('zero', 0);
    const result = toolResult(await callTool(zero.key, { text: TEXT, provider: ENGINE_PROVIDER }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/402/);
    expect(result.content[0].text).toMatch(/claim_cap_reached/);
    expect(result.content[0].text).toMatch(/TOOL FAILURE, not a verdict/);
    expect(result.structuredContent).toBeUndefined();
    expect(control.extractCalls).toBe(0);
    expect(control.verifyCalls).toBe(0);
    expect(getClaimMeter().totals().used).toBe(0);
    // The refusal came from POST /scan itself, with the caller's key.
    const inner = seen.filter((r) => r.url === '/scan');
    expect(inner.length).toBe(1);
    expect(inner[0].headers['x-api-key']).toBe(zero.key);
  });

  it('the monthly quota applies: a key at its monthly cap gets the 402 as a tool error, and no provider is called', async () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_FREE = '1';
    const free = getKeyStore().create('free-monthly', ['scan']);
    getUsageMeter().increment(free.id);
    const result = toolResult(await callTool(free.key, { text: TEXT, provider: ENGINE_PROVIDER }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/402/);
    expect(result.content[0].text).toMatch(/Monthly scan quota exceeded/);
    expect(control.extractCalls).toBe(0);
    expect(control.verifyCalls).toBe(0);
  });

  it('a POST /scan refusal reads the same on both routes for the same key', async () => {
    const zero = meteredKey('zero-direct', 0);
    const direct = await app.inject({
      method: 'POST', url: '/scan',
      headers: { 'content-type': 'application/json', 'x-api-key': zero.key },
      payload: { text: TEXT, provider: ENGINE_PROVIDER },
    });
    expect(direct.statusCode).toBe(402);
    const result = toolResult(await callTool(zero.key, { text: TEXT, provider: ENGINE_PROVIDER }));
    expect(result.content[0].text).toContain(direct.body.slice(0, 120));
  });

  it('a metered key with headroom is billed through the claim meter; the result carries billing and overall_risk', async () => {
    const roomy = meteredKey('roomy', 1_000);
    const result = toolResult(await callTool(roomy.key, { text: TEXT, provider: ENGINE_PROVIDER }));
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent!;
    expect(out.claims_total).toBe(2);
    expect(out.overall_risk).toEqual(expect.any(String));
    expect(out.risk_score).toEqual(expect.any(Number));
    expect(out.billing).toEqual(expect.objectContaining({ billedClaims: 2, unbilled: [] }));
    expect(control.verifyCalls).toBe(2);
    expect(getClaimMeter().totals().used).toBe(2);
    // POST /scan's own onResponse hook counted the scan toward the key's monthly quota.
    expect(getUsageMeter().getMonthlyCount(roomy.id)).toBe(1);
  });

  it('the per-key burst limit applies: past it, the tool reports the 429 and nothing more is scanned', async () => {
    const free = getKeyStore().create('free-burst', ['scan']);
    let limited: ReturnType<typeof toolResult> | undefined;
    for (let i = 0; i < 15 && !limited; i += 1) {
      const r = toolResult(await callTool(free.key, { text: `Claim number ${i} is true.`, provider: ENGINE_PROVIDER }));
      if (r.isError && /429/.test(r.content[0].text)) limited = r;
    }
    expect(limited, 'the burst limit was reached through /mcp').toBeDefined();
    // The tool error carries /scan's own 429 body and says it is not a verdict.
    expect(limited!.content[0].text).toMatch(/resetEpoch/);
    expect(limited!.content[0].text).toMatch(/NOT a verdict/);
    const before = control.extractCalls;
    const again = toolResult(await callTool(free.key, { text: 'One more claim is true.', provider: ENGINE_PROVIDER }));
    expect(again.isError).toBe(true);
    expect(control.extractCalls).toBe(before);
  });

  it('only the caller key and content type reach POST /scan: x-user-tier is never forwarded', async () => {
    const roomy = meteredKey('tiered', 1_000);
    toolResult(await callTool(roomy.key, { text: TEXT, provider: ENGINE_PROVIDER }, { 'x-user-tier': 'enterprise', 'x-forwarded-for': '10.0.0.1' }));
    const inner = seen.filter((r) => r.url === '/scan');
    expect(inner.length).toBe(1);
    expect(inner[0].headers['x-api-key']).toBe(roomy.key);
    expect(inner[0].headers['x-user-tier']).toBeUndefined();
    expect(inner[0].headers['x-forwarded-for']).toBeUndefined();
  });

  it('a consensus request cannot be smuggled in: the tool takes no pipelineConfig', async () => {
    const roomy = meteredKey('no-consensus', 1_000);
    const res = await callTool(roomy.key, { text: TEXT, provider: ENGINE_PROVIDER, pipelineConfig: { consensus: true } });
    const result = toolResult(res);
    // Unknown arguments are dropped by the tool's input schema; the inner body has text and provider only.
    expect(result.isError).toBeFalsy();
    expect(control.verifyCalls).toBe(2);
  });
});
