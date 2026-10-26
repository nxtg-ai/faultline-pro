/**
 * Every route that can reach a model provider runs the provider spend gate.
 *
 * The app is built with GraphQL on, so every route the server can register is
 * seen, and an onRoute hook collects them. Each route must either carry
 * `enforceProviderSpendCap` in its preHandler chain (GATED_ROUTES) or be on
 * PROVIDER_FREE_ROUTES, a commented list of routes that never call a provider.
 * A new route on neither list fails this test by name: decide which list it
 * belongs on before it ships.
 *
 * Then, for each gated route: with enforcement on, the month's budget spent and
 * a free key, the route answers 503 and no scan engine or provider function is
 * called. One paid-key request shows the gate still lets paid traffic through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetScanQueue, getScanQueue } from '../src/store/scan-queue.js';
import { resetJobStore, getJobStore } from '../src/store/jobs.js';
import { resetScheduleStore, getScheduleStore } from '../src/store/schedules.js';
import { recordProviderSpend, resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { enforceProviderSpendCap } from '../src/plugins/provider-spend-cap.js';
import type { ManagedScanCostEvent } from '../src/store/costs.js';
import { getProvider } from '@nxtg/faultline/providers/registry.js';
import { scan, extractForFullScan, verifyFullScan } from '@nxtg/faultline/cli/scan.js';

// Pass-through spies: a refused request must reach none of these.
vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return { ...actual, getProvider: vi.fn(actual.getProvider) };
});
vi.mock('@nxtg/faultline/cli/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/scan.js')>();
  return {
    ...actual,
    scan: vi.fn(actual.scan),
    extractForFullScan: vi.fn(actual.extractForFullScan),
    verifyFullScan: vi.fn(actual.verifyFullScan),
  };
});
const providerSpies = [
  vi.mocked(getProvider),
  vi.mocked(scan),
  vi.mocked(extractForFullScan),
  vi.mocked(verifyFullScan),
];
const scanSpy = vi.mocked(scan);

/**
 * Routes whose handler can cause a model provider call, now or later (the
 * queue, job and schedule routes create work that runs a scan in the
 * background). Each runs the gate after the key check.
 */
const GATED_ROUTES: readonly string[] = [
  'POST /scan',
  'POST /scan/template/:id',
  'GET /scan/stream',
  'POST /scan/stream',
  'POST /scan/full/estimate',
  'POST /scan/full',
  'POST /scan/deep',
  'POST /scan/diff',
  'POST /scan/batch',
  'POST /scan/bulk',
  'POST /scan/upload',
  'POST /scan/report',
  'POST /scan/eu-report',
  'POST /scan/compliance/:template',
  'POST /scan/compliance-gate',
  'POST /critique',
  'POST /admin/verify-claims',
  'POST /queue/scans',
  'POST /jobs',
  'POST /schedules',
  'POST /schedules/:id/trigger',
];

/**
 * Routes that never call a model provider, so they do not run the gate. Each
 * group says why. Moving a route here needs the same reason to hold for it.
 */
const PROVIDER_FREE_ROUTES: readonly string[] = [
  // GraphQL: the endpoint serves reads and key admin too. The `scan` and
  // `scanBatch` resolvers run the same budget check themselves before the scan.
  'GET /graphql',
  'POST /graphql',

  // Service status, docs, changelog and CORS preflight: static or counters only.
  'GET /health',
  'GET /health/deep',
  'GET /status',
  'GET /status.json',
  'GET /metrics',
  'GET /changelog',
  'GET /changelog.json',
  'GET /changelog.md',
  'GET /docs',
  'GET /docs/',
  'GET /docs/json',
  'GET /docs/yaml',
  'GET /docs/static/*',
  'GET /docs/static/index.html',
  'GET /docs/static/swagger-initializer.js',
  'OPTIONS *',

  // Usage, spend, costs and rate limits: read stored counters.
  'GET /usage',
  'GET /costs',
  'GET /costs/percentiles',
  'GET /rate-limits',
  'GET /rate-limits.json',
  'GET /analytics',
  'GET /analytics/overview',
  'GET /dashboard',
  'GET /mission-control',
  'GET /mission-control/status',
  'GET /telemetry',
  'GET /telemetry/dashboard',
  'GET /telemetry/privacy',
  'GET /telemetry/status',
  'GET /npm/downloads',
  'GET /npm/downloads/:package',
  'GET /npm/trend/:package',
  'POST /npm/poll', // npm registry download counts, not a model provider

  // Keys, orgs and tenants: key and account administration.
  'GET /keys',
  'GET /keys/:id',
  'GET /keys/:id/rotation-status',
  'GET /keys/dormant',
  'GET /keys/expiring-soon',
  'GET /keys/usage',
  'GET /keys/usage/view',
  'POST /keys',
  'POST /keys/:id/rotate',
  'POST /keys/bulk-delete',
  'POST /keys/bulk-disable',
  'POST /keys/bulk-enable',
  'PATCH /keys/:id',
  'PATCH /keys/:id/disable',
  'PATCH /keys/:id/enable',
  'DELETE /keys/:id',
  'GET /orgs',
  'GET /orgs/:id',
  'GET /orgs/:id/invites',
  'GET /orgs/:id/keys',
  'GET /orgs/:id/members',
  'GET /orgs/:id/usage',
  'POST /orgs',
  'POST /orgs/:id/keys',
  'POST /orgs/:id/members/invite',
  'POST /orgs/invites/:token/accept',
  'PATCH /orgs/:id',
  'PATCH /orgs/:id/members/:memberId/role',
  'DELETE /orgs/:id',
  'DELETE /orgs/:id/keys/:keyId',
  'DELETE /orgs/:id/members/:memberId',
  'GET /tenants',
  'GET /tenants/:id',
  'GET /tenants/:id/export',
  'GET /tenants/:id/usage',
  'POST /tenants',
  'POST /tenants/:id/keys',
  'DELETE /tenants/:id',
  'DELETE /tenants/:id/data',
  'DELETE /tenants/:id/keys/:keyId',

  // Stored scans, claims and history: read or delete what is already stored.
  'GET /claims',
  'GET /claims/:id/attribution',
  'GET /claims/:id/explain', // built from the stored verdict, no new call
  'GET /claims/stats',
  'GET /claims/trending',
  'GET /claims/view',
  'GET /scans/:id/approvals',
  'GET /scans/search',
  'GET /scans/stale',
  'GET /scans/stale/view',
  'GET /scans/timeline',
  'GET /scans/timeline/view',
  'GET /scans/usage',
  'DELETE /scans/stale',
  'POST /scans/:id/approve',
  'GET /scan/:id/graph',
  'GET /scan/:id/compliance',
  'GET /scan/:id/compliance/badge',
  'GET /scan/report/pdf/:id',
  'GET /scan/full/:jobId', // polls a job the gated POST /scan/full started
  'POST /scan/full/:jobId/stop', // stops a job; starts nothing
  'GET /audit/log',
  'GET /audit/log/export',
  'GET /audit/log/manifest',
  'GET /audit/log/stats',
  'POST /export',

  // Computed from results the caller supplies or from stored scans.
  'POST /scan/compare',
  'POST /scan/compliance-diff',
  'POST /scan/report/pdf',
  'POST /scan/risk-register',
  'POST /weakest',
  'POST /compliance/scan-check',
  'POST /rules/:id/test', // regex rules run locally
  'POST /rules/apply',

  // Compliance catalogues and history.
  'GET /compliance/dashboard',
  'GET /compliance/deadlines',
  'GET /compliance/export',
  'GET /compliance/history',
  'GET /compliance/trend',
  'POST /compliance/deadlines/notify',
  'GET /templates/compliance',
  'POST /templates/compliance',
  'DELETE /templates/compliance/:id',

  // Scan templates and rules: stored configuration.
  'GET /templates',
  'POST /templates',
  'DELETE /templates/:id',
  'GET /rules',
  'GET /rules/:id',
  'GET /rules/examples',
  'POST /rules',
  'PATCH /rules/:id',
  'DELETE /rules/:id',

  // Queue, jobs and schedules: read, cancel, edit or delete. The routes that
  // create or fire a run are gated, and the run itself checks the budget again.
  'GET /queue',
  'GET /queue/scans',
  'GET /queue/scans/:id',
  'GET /queue/status',
  'DELETE /queue/scans/:id',
  'GET /jobs',
  'GET /jobs/:id/progress',
  'DELETE /jobs/:id',
  'GET /schedules',
  'GET /schedules/:id',
  'GET /schedules/:id/history',
  'GET /schedules/view',
  'PATCH /schedules/:id',
  'DELETE /schedules/:id',

  // Cache and cache warm-up: the warm-up run routes are retired (410).
  'GET /cache/stats',
  'DELETE /cache',
  'GET /cache/warmup',
  'GET /cache/warmup/:id',
  'GET /cache/warmup/:id/history',
  'GET /cache/warmup/suggestions',
  'GET /cache/warmup/summary',
  'POST /cache/warmup',
  'POST /cache/warmup/run',
  'POST /cache/warmup/:id/run',
  'PATCH /cache/warmup/:id',
  'DELETE /cache/warmup/:id',

  // Provider registry: registers, enables or disables; reads health counters.
  'GET /providers/health',
  'GET /providers/health/view',
  'POST /providers/register',
  'POST /providers/:name/disable',
  'POST /providers/:name/enable',

  // Plugin marketplace: catalogue entries, not provider calls.
  'GET /plugins/:id',
  'GET /plugins/search',
  'POST /plugins/install',
  'POST /plugins/publish',

  // Webhooks and notifications: deliveries to the caller's own endpoints.
  'GET /webhooks',
  'GET /webhooks/:id/deliveries',
  'GET /webhooks/deliveries',
  'GET /webhooks/deliveries/view',
  'GET /webhooks/test',
  'GET /webhooks/test/history',
  'POST /webhooks',
  'POST /webhooks/test',
  'POST /webhooks/test/:id',
  'DELETE /webhooks/:id',
  'GET /notifications',
  'GET /notifications/events',
  'GET /notifications/history',
  'GET /notifications/prefs',
  'GET /notifications/prefs/:keyId',
  'POST /notifications/test/:keyId',
  'PUT /notifications/prefs/:keyId',
  'DELETE /notifications/prefs/:keyId',

  // HTML shell: it calls the gated routes with the viewer's key.
  'GET /playground',
];

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Every registered route as `METHOD /url` (HEAD listed as its GET), with whether it runs the gate. */
async function collectRoutes(): Promise<Map<string, boolean>> {
  const saved = process.env.FAULTLINE_GRAPHQL;
  process.env.FAULTLINE_GRAPHQL = 'on';
  const app = buildServer();
  const routes = new Map<string, boolean>();
  app.addHook('onRoute', (route: RouteOptions) => {
    const gated = asList<unknown>(route.preHandler).includes(enforceProviderSpendCap);
    for (const method of asList(route.method)) {
      const key = `${method === 'HEAD' ? 'GET' : method} ${route.url}`;
      routes.set(key, (routes.get(key) ?? false) || gated);
    }
  });
  try {
    await app.ready();
  } finally {
    await app.close();
    if (saved === undefined) delete process.env.FAULTLINE_GRAPHQL;
    else process.env.FAULTLINE_GRAPHQL = saved;
  }
  return routes;
}

describe('provider spend gate: route coverage', () => {
  it('the two lists do not overlap and have no duplicates', () => {
    expect(GATED_ROUTES.length).toBeGreaterThan(0);
    expect(PROVIDER_FREE_ROUTES.length).toBeGreaterThan(0);
    expect(new Set(GATED_ROUTES).size).toBe(GATED_ROUTES.length);
    expect(new Set(PROVIDER_FREE_ROUTES).size).toBe(PROVIDER_FREE_ROUTES.length);
    const both = GATED_ROUTES.filter((r) => PROVIDER_FREE_ROUTES.includes(r));
    expect(both, 'routes on both lists').toEqual([]);
  });

  it('every registered route is gated or on the provider-free list', async () => {
    const routes = await collectRoutes();
    expect(routes.size).toBeGreaterThan(100);

    const problems: string[] = [];
    for (const [route, gated] of routes) {
      if (GATED_ROUTES.includes(route)) {
        if (!gated) problems.push(`${route} is on GATED_ROUTES but has no enforceProviderSpendCap preHandler`);
      } else if (PROVIDER_FREE_ROUTES.includes(route)) {
        if (gated) problems.push(`${route} runs the gate; move it from PROVIDER_FREE_ROUTES to GATED_ROUTES`);
      } else {
        problems.push(
          `${route} is a new route on neither list: add enforceProviderSpendCap after the key check `
          + 'and list it in GATED_ROUTES, or list it in PROVIDER_FREE_ROUTES with the reason it never calls a provider',
        );
      }
    }
    // Stale entries: a listed route the server no longer registers.
    for (const route of [...GATED_ROUTES, ...PROVIDER_FREE_ROUTES]) {
      if (!routes.has(route)) problems.push(`${route} is listed but not registered; remove it from the list`);
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Each gated route refuses a free key once the budget is spent.
// ---------------------------------------------------------------------------

const SERVER_KEY = 'server-key-spend-cap-coverage';
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

/** Enforcement on, cap $1, $1.50 spent. */
function exhaustBudget(): void {
  process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
  process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
  recordProviderSpend(costEvent(1.5));
}

interface RouteRequest {
  method: 'GET' | 'POST';
  url: string;
  payload?: Record<string, unknown> | string;
  contentType?: string;
  headers?: Record<string, string>;
  /** requireAdmin refuses a keystore key first, so the server key (no tier header, counted as free) is sent. */
  adminOnly?: boolean;
}

const text = 'The Eiffel Tower is in Paris.';
const multipartBody = '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n'
  + 'Content-Type: text/plain\r\n\r\nThe sky is blue.\r\n--x--\r\n';

/** A request each gated route accepts past schema validation, so a refusal is the gate. */
const REQUESTS: Record<string, RouteRequest> = {
  'POST /scan': { method: 'POST', url: '/scan', payload: { text, provider: 'mock' } },
  'POST /scan/template/:id': { method: 'POST', url: '/scan/template/no-such-template', payload: { text } },
  'GET /scan/stream': { method: 'GET', url: `/scan/stream?text=${encodeURIComponent(text)}&provider=mock` },
  'POST /scan/stream': { method: 'POST', url: '/scan/stream', payload: { text, provider: 'mock' } },
  'POST /scan/full/estimate': { method: 'POST', url: '/scan/full/estimate', payload: { text, provider: 'mock' } },
  'POST /scan/full': {
    method: 'POST', url: '/scan/full', payload: { estimateId: 'no-such-estimate' },
    headers: { 'idempotency-key': 'idem-spend-coverage' },
  },
  'POST /scan/deep': { method: 'POST', url: '/scan/deep', payload: { text, provider: 'mock' } },
  'POST /scan/diff': { method: 'POST', url: '/scan/diff', payload: { before: text, after: 'The Eiffel Tower is in Rome.', provider: 'mock' } },
  'POST /scan/batch': { method: 'POST', url: '/scan/batch', payload: { texts: [text], provider: 'mock' } },
  'POST /scan/bulk': { method: 'POST', url: '/scan/bulk?provider=mock', payload: multipartBody, contentType: 'multipart/form-data; boundary=x' },
  'POST /scan/upload': { method: 'POST', url: '/scan/upload', payload: multipartBody, contentType: 'multipart/form-data; boundary=x' },
  'POST /scan/report': { method: 'POST', url: '/scan/report', payload: { text, provider: 'mock' } },
  'POST /scan/eu-report': { method: 'POST', url: '/scan/eu-report', payload: { text, provider: 'mock' } },
  'POST /scan/compliance/:template': { method: 'POST', url: '/scan/compliance/hipaa', payload: { text, provider: 'mock' } },
  'POST /scan/compliance-gate': { method: 'POST', url: '/scan/compliance-gate', payload: { text, provider: 'mock' } },
  'POST /critique': {
    method: 'POST', url: '/critique',
    payload: { claims: [{ id: 'c1', text: 'The Eiffel Tower is in Berlin.' }], verifications: {}, text: 'The Eiffel Tower is in Berlin.', provider: 'openai' },
  },
  'POST /admin/verify-claims': {
    method: 'POST', url: '/admin/verify-claims',
    payload: { claims: [{ id: '1', text }], provider: 'mock' }, adminOnly: true,
  },
  'POST /queue/scans': { method: 'POST', url: '/queue/scans', payload: { text, provider: 'mock' } },
  'POST /jobs': { method: 'POST', url: '/jobs', payload: { text, provider: 'mock', schedule: '*/5 * * * *' } },
  'POST /schedules': { method: 'POST', url: '/schedules', payload: { name: 'nightly', cron: '0 9 * * 1', text, provider: 'mock' } },
  'POST /schedules/:id/trigger': { method: 'POST', url: '/schedules/no-such-schedule/trigger' },
};

function send(req: RouteRequest, key: string) {
  const hasBody = req.payload !== undefined;
  return server.inject({
    method: req.method,
    url: req.url,
    headers: {
      'x-api-key': key,
      ...(hasBody ? { 'content-type': req.contentType ?? 'application/json' } : {}),
      ...req.headers,
    },
    ...(hasBody ? { payload: req.payload } : {}),
  });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-spend-coverage-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetScanQueue();
  resetJobStore();
  resetScheduleStore();
  for (const spy of providerSpies) spy.mockClear();
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

describe('provider spend gate: each gated route refuses a free key with no provider call', () => {
  it('has a request for every gated route', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual([...GATED_ROUTES].sort());
  });

  for (const route of GATED_ROUTES) {
    it(`${route}: 503 for a free key, no provider call`, async () => {
      exhaustBudget();
      const req = REQUESTS[route];
      const key = req.adminOnly ? SERVER_KEY : getKeyStore().create('Free Key', ['scan']).key;
      const res = await send(req, key);

      expect(res.statusCode, `${route} (body: ${res.body.slice(0, 200)})`).toBe(503);
      const body = res.json() as Record<string, unknown>;
      expect(String(body.error)).toMatch(/provider budget exhausted/i);
      expect(body.capUsd).toBe(1);
      for (const spy of providerSpies) expect(spy).not.toHaveBeenCalled();
      // Nothing was queued or created for a background run either.
      expect(getScanQueue().getStats().total).toBe(0);
      expect(getJobStore().size).toBe(0);
      expect(getScheduleStore().list()).toHaveLength(0);
    });
  }

  it('a paid key still scans: POST /scan/deep answers 200 and runs the scan', async () => {
    exhaustBudget();
    const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await send(REQUESTS['POST /scan/deep'], pro.key);
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.body).not.toMatch(/provider budget exhausted/i);
    expect(scanSpy).toHaveBeenCalled();
  });
});
