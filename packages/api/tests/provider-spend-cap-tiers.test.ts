// Validates: N-230 (fleet provider-spend cap; scope narrowed to free and anonymous traffic)
/**
 * Who the fleet provider-spend cap refuses once the month's budget is spent.
 *
 * Free and anonymous traffic is refused with 503. Paid tiers pass this gate:
 * their own per-key caps bound them. The tier comes from the trusted resolver,
 * so `x-user-tier` counts only from the server's own key; a free keystore key
 * that sends `x-user-tier: pro` is still refused. The server's own key with no
 * tier header (absent or empty) counts as free for this gate: the web front end
 * sends some calls that way, and such a caller cannot be told apart from free
 * traffic.
 *
 * One test per route that carries the gate. Each route's request body is valid
 * for that route, so a refusal is the gate and not schema validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { recordProviderSpend, resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resolveSpendCapTier, SPEND_CAP_TIERS } from '../src/plugins/provider-spend-cap.js';
import type { ManagedScanCostEvent } from '../src/store/costs.js';
import { getProvider } from '@nxtg/faultline/providers/registry.js';

// A pass-through spy, so a test can prove a refused call never reached a provider.
vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return { ...actual, getProvider: vi.fn(actual.getProvider) };
});
const getProviderSpy = vi.mocked(getProvider);

const SERVER_KEY = 'server-key-spend-cap-tiers';
const ENV_KEYS = [
  'FAULTLINE_API_KEY',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_USAGE_CAP',
];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;

function costEvent(costUsd: number): ManagedScanCostEvent {
  return {
    scanId: 'prior-scan', ts: new Date().toISOString(), tier: 'free', keyMode: 'managed',
    provider: 'openai', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 1,
    groundingCalls: 0, costUsd, latencyMs: 1,
  };
}

/** Cap $1, $1.50 spent: the budget is exhausted. */
function exhaustBudget(): void {
  process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
  recordProviderSpend(costEvent(1.5));
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-spend-tiers-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  getProviderSpy.mockClear();
  server = buildServer();
});
afterEach(async () => {
  await server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RouteCase {
  name: string;
  method: 'GET' | 'POST';
  url: string;
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** requireAdmin routes refuse a non-admin keystore key before this gate. */
  adminOnly?: boolean;
}

const failedCritique = {
  claims: [{ id: 'c1', text: 'The Eiffel Tower is in Berlin.' }],
  verifications: {},
  text: 'The Eiffel Tower is in Berlin.',
  provider: 'openai',
};

const ROUTES: RouteCase[] = [
  { name: 'POST /scan', method: 'POST', url: '/scan', payload: { text: 'The sky is blue.', provider: 'mock' } },
  { name: 'POST /scan/template/:id', method: 'POST', url: '/scan/template/no-such-template', payload: { text: 'The sky is blue.' } },
  { name: 'GET /scan/stream', method: 'GET', url: `/scan/stream?text=${encodeURIComponent('The sky is blue.')}&provider=mock` },
  { name: 'POST /scan/stream', method: 'POST', url: '/scan/stream', payload: { text: 'The sky is blue.', provider: 'mock' } },
  { name: 'POST /critique', method: 'POST', url: '/critique', payload: failedCritique },
  { name: 'POST /scan/full/estimate', method: 'POST', url: '/scan/full/estimate', payload: { text: 'The sky is blue.', provider: 'mock' } },
  {
    name: 'POST /scan/full', method: 'POST', url: '/scan/full',
    payload: { estimateId: 'no-such-estimate' }, headers: { 'idempotency-key': 'idem-spend-tiers' },
  },
  {
    name: 'POST /admin/verify-claims', method: 'POST', url: '/admin/verify-claims',
    payload: { claims: [{ id: '1', text: 'The sky is blue.' }], provider: 'mock' }, adminOnly: true,
  },
];

function send(route: RouteCase, key: string, extraHeaders: Record<string, string> = {}) {
  return server.inject({
    method: route.method,
    url: route.url,
    headers: {
      'x-api-key': key,
      ...(route.payload ? { 'content-type': 'application/json' } : {}),
      ...route.headers,
      ...extraHeaders,
    },
    ...(route.payload ? { payload: route.payload } : {}),
  });
}

/** The 503 the gate sends, nothing else that returns 503. */
function expectBudgetRefusal(res: { statusCode: number; json: () => Record<string, unknown> }, label: string): void {
  expect(res.statusCode, label).toBe(503);
  const body = res.json();
  expect(Object.keys(body).length, label).toBeGreaterThan(0);
  expect(String(body.error), label).toMatch(/provider budget exhausted/i);
  expect(body.capUsd, label).toBe(1);
}

function expectPassed(res: { statusCode: number; body: string }, label: string): void {
  expect(res.statusCode, `${label} (body: ${res.body.slice(0, 200)})`).not.toBe(503);
  expect(res.body, label).not.toMatch(/provider budget exhausted/i);
}

describe('resolveSpendCapTier', () => {
  it('reads the trusted tier: header only from the server key, keystore keys by permission', () => {
    const free = getKeyStore().create('Free Key', ['scan']);
    const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const admin = getKeyStore().create('Admin Key', ['admin', 'scan']);
    expect(getKeyStore().size).toBe(3);

    expect(resolveSpendCapTier(undefined)).toBe('anon');
    expect(resolveSpendCapTier('')).toBe('anon');
    expect(resolveSpendCapTier('admin')).toBe('free'); // no tier header: counted as free
    expect(resolveSpendCapTier('admin', '')).toBe('free');
    expect(resolveSpendCapTier('admin', [])).toBe('free');
    expect(resolveSpendCapTier('admin', 'enterprise')).toBe('enterprise');
    expect(resolveSpendCapTier('admin', 'free')).toBe('free');
    expect(resolveSpendCapTier('admin', 'anon')).toBe('anon');
    expect(resolveSpendCapTier('admin', 'pro')).toBe('pro');
    expect(resolveSpendCapTier('admin', 'widget')).toBe('free'); // unknown value fails closed
    expect(resolveSpendCapTier(free.id)).toBe('free');
    expect(resolveSpendCapTier(free.id, 'pro')).toBe('free');
    expect(resolveSpendCapTier(free.id, 'enterprise')).toBe('free');
    expect(resolveSpendCapTier(pro.id)).toBe('pro');
    expect(resolveSpendCapTier(pro.id, 'free')).toBe('pro');
    expect(resolveSpendCapTier(admin.id)).toBe('enterprise');
    expect(resolveSpendCapTier('no-such-key')).toBe('free');
  });

  it('scopes the gate to the free and anonymous tiers', () => {
    expect(SPEND_CAP_TIERS.length).toBeGreaterThan(0);
    expect([...SPEND_CAP_TIERS]).toEqual(['free', 'anon']);
  });
});

describe('fleet provider-spend cap: free and anonymous traffic only', () => {
  for (const route of ROUTES) {
    it(`${route.name}: refuses free and spoofed-free callers, passes paid and internal callers`, async () => {
      exhaustBudget();
      process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
      const free = getKeyStore().create('Free Key', ['scan']);
      const admin = getKeyStore().create('Admin Key', ['admin', 'scan']);
      expect(getKeyStore().size).toBe(2);

      // The server key forwarding a free or anonymous plan is refused.
      expectBudgetRefusal(await send(route, SERVER_KEY, { 'x-user-tier': 'free' }), 'server key, x-user-tier: free');
      expectBudgetRefusal(await send(route, SERVER_KEY, { 'x-user-tier': 'anon' }), 'server key, x-user-tier: anon');
      // The server key forwarding a paid plan passes.
      expectPassed(await send(route, SERVER_KEY, { 'x-user-tier': 'pro' }), 'server key, x-user-tier: pro');
      // The server key with no tier header cannot be told apart from free traffic.
      expectBudgetRefusal(await send(route, SERVER_KEY), 'server key, no header');
      expectBudgetRefusal(await send(route, SERVER_KEY, { 'x-user-tier': '' }), 'server key, empty header');
      // An admin keystore key passes; a header from it is ignored.
      expectPassed(await send(route, admin.key, { 'x-user-tier': 'free' }), 'admin keystore key');

      if (!route.adminOnly) {
        const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
        expectBudgetRefusal(await send(route, free.key), 'free keystore key');
        // Spoof: a free keystore key cannot buy its way past the cap with the header.
        for (const spoof of ['pro', 'enterprise', 'personal', 'userkey']) {
          expectBudgetRefusal(await send(route, free.key, { 'x-user-tier': spoof }), `free key spoofing ${spoof}`);
        }
        expectPassed(await send(route, pro.key), 'pro keystore key');
      }
    });
  }

  it('server key, no x-user-tier, POST /critique: refused with 503 and the provider is never called', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    const route = ROUTES.find((r) => r.url === '/critique')!;
    expect(route).toBeDefined();
    expectBudgetRefusal(await send(route, SERVER_KEY), 'server key, no header, /critique');
    expect(getProviderSpy).not.toHaveBeenCalled();
  });

  it('server key, no x-user-tier, POST /scan: refused with 503', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    expectBudgetRefusal(await send(ROUTES[0], SERVER_KEY), 'server key, no header, /scan');
    expect(getProviderSpy).not.toHaveBeenCalled();
  });

  it('server key, empty x-user-tier: refused with 503', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    expectBudgetRefusal(await send(ROUTES[0], SERVER_KEY, { 'x-user-tier': '' }), 'server key, empty header, /scan');
    const critique = ROUTES.find((r) => r.url === '/critique')!;
    expectBudgetRefusal(await send(critique, SERVER_KEY, { 'x-user-tier': '' }), 'server key, empty header, /critique');
    expect(getProviderSpy).not.toHaveBeenCalled();
  });

  it('server key, x-user-tier: pro: passes the gate', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    expectPassed(await send(ROUTES[0], SERVER_KEY, { 'x-user-tier': 'pro' }), 'server key, pro, /scan');
    const critique = ROUTES.find((r) => r.url === '/critique')!;
    expectPassed(await send(critique, SERVER_KEY, { 'x-user-tier': 'pro' }), 'server key, pro, /critique');
  });

  it('free keystore key sending x-user-tier: pro: refused with 503', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    const free = getKeyStore().create('Free Key', ['scan']);
    expect(getKeyStore().size).toBe(1);
    expectBudgetRefusal(await send(ROUTES[0], free.key, { 'x-user-tier': 'pro' }), 'free key spoofing pro');
    expect(getProviderSpy).not.toHaveBeenCalled();
  });

  it('with enforcement off, every caller passes an exhausted budget', async () => {
    exhaustBudget(); // FAULTLINE_PROVIDER_SPEND_CAP not set
    const free = getKeyStore().create('Free Key', ['scan']);
    expect(getKeyStore().size).toBe(1);
    const route = ROUTES[0];
    expectPassed(await send(route, free.key), 'free keystore key');
    expectPassed(await send(route, SERVER_KEY, { 'x-user-tier': 'free' }), 'server key, x-user-tier: free');
    expectPassed(await send(route, SERVER_KEY, { 'x-user-tier': 'anon' }), 'server key, x-user-tier: anon');
  });

  it('with budget left, every caller passes', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '100';
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    recordProviderSpend(costEvent(0.42));
    const free = getKeyStore().create('Free Key', ['scan']);
    expect(getKeyStore().size).toBe(1);
    const route = ROUTES[0];
    expectPassed(await send(route, free.key), 'free keystore key');
    expectPassed(await send(route, SERVER_KEY, { 'x-user-tier': 'free' }), 'server key, x-user-tier: free');
    expectPassed(await send(route, SERVER_KEY, { 'x-user-tier': 'anon' }), 'server key, x-user-tier: anon');
  });

  it('GET /usage (admin) names the tiers the cap applies to', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '100';
    recordProviderSpend(costEvent(0.42));
    const res = await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': SERVER_KEY } });
    expect(res.statusCode).toBe(200);
    const budget = res.json().providerBudget;
    expect(budget).toBeDefined();
    expect(budget.appliesTo.length).toBeGreaterThan(0);
    expect(budget.appliesTo).toEqual(['free', 'anon']);
    expect(budget.capUsd).toBe(100);
  });
});
