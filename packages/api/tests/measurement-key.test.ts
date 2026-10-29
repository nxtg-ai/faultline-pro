// Validates: measurement key separation (CHANGELOG [Unreleased], docs/provider-spend-cap.md "The measurement key")
/**
 * FAULTLINE_MEASUREMENT_KEY: the key internal measurement runs use.
 *
 *  - auth: it authenticates as keyId 'measurement'; an empty or unset value
 *    never matches; a value equal to FAULTLINE_API_KEY is refused as a
 *    measurement key, with one fixed startup warning that never holds the value;
 *  - the allowlist: every registered route except POST /admin/verify-claims and
 *    GET /usage refuses it with 403, enumerated from Fastify's own route table;
 *  - x-user-tier from it is ignored by every tier resolver;
 *  - its spend rows (cost store, scan-cost log row, provider-spend ledger) carry
 *    tier 'measurement';
 *  - the fleet spend cap never refuses it.
 *
 * The Gemini SDK is mocked at the module boundary, so no network call is made.
 * Keys are built at runtime from parts; none is a real or key-shaped literal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 't', uri: 'https://example.com/a' } }] } }],
        text: JSON.stringify({ status: 'supported', explanation: 'e' }),
      }),
    };
  },
}));

import { buildServer } from '../src/server.js';
import {
  MEASUREMENT_KEY_ID,
  MEASUREMENT_ROUTES,
  isAdminKeyId,
  isAdminRequest,
  requireAdmin,
  requireApiKey,
  warnIfMeasurementKeyCollides,
} from '../src/plugins/auth.js';
import { isServerKeyId, resolveEntitledTier } from '../src/plugins/consensus-entitlement.js';
import { resolveSpendCapTier, providerBudgetRefuses } from '../src/plugins/provider-spend-cap.js';
import { resolveTier as resolveRateTier } from '../src/plugins/ratelimit.js';
import { getCostStore, loadScanCostLog, resolveTier, resolveTierFromRequest, scanCostLogRow } from '../src/store/costs.js';
import type { ManagedScanCostEvent } from '../src/store/costs.js';
import { recordProviderSpend, resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger } from '../src/store/grounding-allowance.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';

const ADMIN_KEY = ['test', 'admin', 'part', String(Date.now())].join('-');
const MEASUREMENT_KEY = ['test', 'measure', 'part', String(process.pid)].join('-');

/** The allowlist, written out here on purpose: widening the constant must fail this file. */
const EXPECTED_ALLOWLIST = ['GET /usage', 'POST /admin/verify-claims'];

const ENV_KEYS = [
  'FAULTLINE_API_KEY',
  'FAULTLINE_MEASUREMENT_KEY',
  'GEMINI_API_KEY',
  'FAULTLINE_GROUNDING_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
  'FAULTLINE_CUSTOMER_KEYS',
  'FAULTLINE_GRAPHQL',
];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance | undefined;

async function start(): Promise<FastifyInstance> {
  server = buildServer();
  await server.ready();
  return server;
}

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function verify(app: FastifyInstance, key: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/admin/verify-claims',
    headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
    payload: { claims: [{ id: '0', text: 'The Eiffel Tower is in Paris.' }], provider: 'gemini' },
  });
}

function exhaustBudget(): void {
  process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
  process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
  recordProviderSpend({
    scanId: 'prior-scan', ts: new Date().toISOString(), tier: 'free', keyMode: 'managed',
    provider: 'gemini', modelId: 'gemini-2.5-flash', inputTokens: 1, outputTokens: 1,
    groundingCalls: 0, costUsd: 1.5, latencyMs: 1,
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-measurement-key-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = ADMIN_KEY;
  process.env.FAULTLINE_MEASUREMENT_KEY = MEASUREMENT_KEY;
  process.env.GEMINI_API_KEY = ['test', 'gemini'].join('-');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  getCostStore().reset();
  server = undefined;
});

afterEach(async () => {
  if (server) await server.close();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('measurement key: auth', () => {
  it('authenticates as keyId measurement on GET /usage, with its own tier and the budget and allowance an operator reads', async () => {
    const app = await start();
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': MEASUREMENT_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keyId).toBe(MEASUREMENT_KEY_ID);
    expect(body.keyId).toBe('measurement');
    expect(body.quota.tier).toBe('measurement');
    expect(body.providerBudget).toBeDefined();
    expect(body.providerBudget.appliesTo).toEqual(['free', 'anon']);
    expect(body.groundingAllowance).toBeDefined();
    expect(typeof body.groundingAllowance.groundedPrompts).toBe('number');
    // Fleet-wide refunds stay admin only.
    expect(body.fullScanRefunds).toBeUndefined();
  });

  it('is accepted by POST /admin/verify-claims', async () => {
    const app = await start();
    const res = await verify(app, MEASUREMENT_KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
  });

  it('never matches when FAULTLINE_MEASUREMENT_KEY is empty or unset', async () => {
    const probe = ['test', 'probe', 'part'].join('-');
    for (const value of ['', undefined]) {
      if (value === undefined) delete process.env.FAULTLINE_MEASUREMENT_KEY;
      else process.env.FAULTLINE_MEASUREMENT_KEY = value;
      const app = await start();
      const usage = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': probe } });
      expect(usage.statusCode).toBe(401);
      const empty = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': '' } });
      expect(empty.statusCode).toBe(401);
      const admin = await verify(app, probe);
      expect(admin.statusCode).toBe(403);
      await app.close();
      server = undefined;
    }
  });

  it('with no server key and an empty measurement key, the API reports no key configured (503)', async () => {
    delete process.env.FAULTLINE_API_KEY;
    process.env.FAULTLINE_MEASUREMENT_KEY = '';
    const app = await start();
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': ['any', 'value'].join('-') } });
    expect(res.statusCode).toBe(503);
  });

  it('works when it is the only env key configured', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const app = await start();
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': MEASUREMENT_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json().keyId).toBe('measurement');
  });

  it('a measurement key equal to FAULTLINE_API_KEY is refused as a measurement key: it stays the server key, and startup warns once without the value', async () => {
    process.env.FAULTLINE_MEASUREMENT_KEY = ADMIN_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = await start();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toMatch(/FAULTLINE_MEASUREMENT_KEY equals FAULTLINE_API_KEY/);
    expect(message).not.toContain(ADMIN_KEY);

    const usage = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': ADMIN_KEY } });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().keyId).toBe('admin');
    // Not limited to the allowlist: it is the admin key.
    const keys = await app.inject({ method: 'GET', url: '/keys', headers: { 'x-api-key': ADMIN_KEY } });
    expect(keys.statusCode).toBe(200);
  });

  it('warnIfMeasurementKeyCollides warns only on a collision, with a fixed message', () => {
    const seen: string[] = [];
    expect(warnIfMeasurementKeyCollides((m) => seen.push(m))).toBe(false);
    process.env.FAULTLINE_MEASUREMENT_KEY = '';
    expect(warnIfMeasurementKeyCollides((m) => seen.push(m))).toBe(false);
    process.env.FAULTLINE_MEASUREMENT_KEY = ADMIN_KEY;
    expect(warnIfMeasurementKeyCollides((m) => seen.push(m))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(ADMIN_KEY);
  });

  it('is neither the server key nor an admin key', () => {
    expect(isServerKeyId(MEASUREMENT_KEY_ID)).toBe(false);
    expect(isAdminKeyId(MEASUREMENT_KEY_ID)).toBe(false);
    const request = { headers: { 'x-api-key': MEASUREMENT_KEY } } as unknown as Parameters<typeof isAdminRequest>[0];
    expect(isAdminRequest(request)).toBe(false);
  });

  it('a keystore admin credential with the same value as the measurement key is still only the measurement key', async () => {
    const twin = getKeyStore().create('Twin Admin', ['admin', 'scan']);
    process.env.FAULTLINE_MEASUREMENT_KEY = twin.key;
    const request = { headers: { 'x-api-key': twin.key } } as unknown as Parameters<typeof isAdminRequest>[0];
    expect(isAdminRequest(request)).toBe(false);

    const app = await start();
    const usage = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': twin.key } });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().keyId).toBe('measurement');
    const keys = await app.inject({ method: 'GET', url: '/keys', headers: { 'x-api-key': twin.key } });
    expect(keys.statusCode).toBe(403);
    const auditLog = await app.inject({ method: 'GET', url: '/audit/log', headers: { 'x-api-key': twin.key } });
    expect(auditLog.statusCode).toBe(403);

    // The prehandlers decide the same on their own, without the server hook.
    const bare = Fastify();
    bare.get('/usage', { preHandler: requireApiKey }, async (req) => ({ keyId: req.keyId }));
    bare.post('/admin/verify-claims', { preHandler: requireAdmin }, async (req) => ({ keyId: req.keyId }));
    bare.get('/admin/stats', { preHandler: requireAdmin }, async (req) => ({ keyId: req.keyId }));
    await bare.ready();
    const bareUsage = await bare.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': twin.key } });
    expect(bareUsage.json().keyId).toBe('measurement');
    const bareVerify = await bare.inject({ method: 'POST', url: '/admin/verify-claims', headers: { 'x-api-key': twin.key } });
    expect(bareVerify.json().keyId).toBe('measurement');
    const bareStats = await bare.inject({ method: 'GET', url: '/admin/stats', headers: { 'x-api-key': twin.key } });
    expect(bareStats.statusCode).toBe(403);
    await bare.close();
  });
});

describe('measurement key: the key compare never throws', () => {
  // Same string length, different UTF-8 byte length.
  const shortServerKey = ['ab', 'cd'].join('');
  const wideMeasurementKey = 'é'.repeat(4);
  const wideProbe = 'ü'.repeat(4);

  it('buildServer() starts when the two env keys have equal string length but unequal byte length', async () => {
    process.env.FAULTLINE_API_KEY = shortServerKey;
    process.env.FAULTLINE_MEASUREMENT_KEY = wideMeasurementKey;
    expect(shortServerKey.length).toBe(wideMeasurementKey.length);
    expect(Buffer.byteLength(shortServerKey)).not.toBe(Buffer.byteLength(wideMeasurementKey));
    expect(warnIfMeasurementKeyCollides(() => undefined)).toBe(false);
    const app = await start();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('a non-ASCII header of the same string length as the server key gets 401, not 500', async () => {
    process.env.FAULTLINE_API_KEY = shortServerKey;
    process.env.FAULTLINE_MEASUREMENT_KEY = wideMeasurementKey;
    const app = await start();
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': wideProbe } });
    expect(res.statusCode).toBe(401);
    const request = { headers: { 'x-api-key': wideProbe } } as unknown as Parameters<typeof isAdminRequest>[0];
    expect(isAdminRequest(request)).toBe(false);
  });

  it('equal values still match', async () => {
    process.env.FAULTLINE_API_KEY = shortServerKey;
    process.env.FAULTLINE_MEASUREMENT_KEY = MEASUREMENT_KEY;
    const app = await start();
    const admin = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': shortServerKey } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().keyId).toBe('admin');
    const measurement = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': MEASUREMENT_KEY } });
    expect(measurement.statusCode).toBe(200);
    expect(measurement.json().keyId).toBe('measurement');
    process.env.FAULTLINE_MEASUREMENT_KEY = wideMeasurementKey;
    const request = { headers: { 'x-api-key': wideMeasurementKey } } as unknown as Parameters<typeof isAdminRequest>[0];
    expect(isAdminRequest(request)).toBe(false);
    process.env.FAULTLINE_MEASUREMENT_KEY = shortServerKey;
    expect(warnIfMeasurementKeyCollides(() => undefined)).toBe(true);
  });
});

interface RouteRow { method: string; url: string }

/** Every route of a built server, HEAD included (it is a separate route to Fastify). */
async function enumerate(app: FastifyInstance): Promise<RouteRow[]> {
  const rows = new Map<string, RouteRow>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) rows.set(`${method} ${route.url}`, { method, url: route.url });
  });
  await app.ready();
  return [...rows.values()].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
}

const fill = (url: string) => url.replace(/:[A-Za-z]+/g, 'x1').replace(/\*/g, 'x1');

describe('measurement key: one explicit route allowlist', () => {
  it('the allowlist is exactly POST /admin/verify-claims and GET /usage', () => {
    expect([...MEASUREMENT_ROUTES].sort()).toEqual(EXPECTED_ALLOWLIST);
  });

  it('every registered route outside the allowlist refuses it with 403, public routes included', async () => {
    process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
    process.env.FAULTLINE_GRAPHQL = 'on';
    const app = buildServer();
    server = app;
    const routes = await enumerate(app);
    // The table is the whole API, not a handful of rows.
    expect(routes.length).toBeGreaterThan(100);
    const allowed = new Set(EXPECTED_ALLOWLIST);
    const outside = routes.filter((r) => !allowed.has(`${r.method} ${r.url}`));
    expect(outside.length).toBe(routes.length - EXPECTED_ALLOWLIST.length);
    expect(outside.some((r) => r.url === '/graphql')).toBe(true);
    expect(outside.some((r) => r.url.startsWith('/admin/') || r.url === '/keys')).toBe(true);

    const notRefused: string[] = [];
    for (const r of outside) {
      const res = await app.inject({
        method: r.method as 'GET',
        url: fill(r.url),
        headers: { 'x-api-key': MEASUREMENT_KEY, 'content-type': 'application/json', 'x-user-tier': 'enterprise' },
        ...(r.method === 'GET' || r.method === 'HEAD' || r.method === 'OPTIONS' ? {} : { payload: '{}' }),
      });
      if (res.statusCode !== 403) notRefused.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(notRefused).toEqual([]);
    // Nothing on a refused route spent anything.
    expect(spendRows()).toEqual([]);
  });

  it('both allowlisted routes let it through the key check (schema 400 and 200, never 401/403)', async () => {
    const app = await start();
    const verifyRes = await app.inject({
      method: 'POST', url: '/admin/verify-claims',
      headers: { 'x-api-key': MEASUREMENT_KEY, 'content-type': 'application/json' }, payload: '{}',
    });
    expect(verifyRes.statusCode).toBe(400);
    const usage = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': MEASUREMENT_KEY } });
    expect(usage.statusCode).toBe(200);
  });

  it('an unmatched URL refuses it with 403, not 404', async () => {
    const app = await start();
    const res = await app.inject({ method: 'GET', url: '/no-such-route', headers: { 'x-api-key': MEASUREMENT_KEY } });
    expect(res.statusCode).toBe(403);
  });

  it('requireApiKey and requireAdmin check the same allowlist on their own, without the server hook', async () => {
    const app = Fastify();
    app.get('/usage', { preHandler: requireApiKey }, async (request) => ({ keyId: request.keyId }));
    app.get('/scans', { preHandler: requireApiKey }, async (request) => ({ keyId: request.keyId }));
    app.post('/admin/verify-claims', { preHandler: requireAdmin }, async (request) => ({ keyId: request.keyId }));
    app.get('/admin/stats', { preHandler: requireAdmin }, async (request) => ({ keyId: request.keyId }));
    await app.ready();
    const call = (method: 'GET' | 'POST', url: string) => app.inject({ method, url, headers: { 'x-api-key': MEASUREMENT_KEY } });

    const usage = await call('GET', '/usage');
    expect(usage.statusCode).toBe(200);
    expect(usage.json().keyId).toBe('measurement');
    const adminVerify = await call('POST', '/admin/verify-claims');
    expect(adminVerify.statusCode).toBe(200);
    expect(adminVerify.json().keyId).toBe('measurement');
    expect((await call('GET', '/scans')).statusCode).toBe(403);
    expect((await call('GET', '/admin/stats')).statusCode).toBe(403);
    await app.close();
  });
});

describe('measurement key: x-user-tier from it is ignored', () => {
  it('every tier resolver gives it the measurement label, whatever header it sends', () => {
    for (const header of [undefined, '', 'enterprise', 'pro', 'free', 'measurement', ['enterprise']]) {
      expect(resolveEntitledTier(MEASUREMENT_KEY_ID, header)).toBe('measurement');
      expect(resolveSpendCapTier(MEASUREMENT_KEY_ID, header)).toBe('measurement');
      expect(resolveTierFromRequest(MEASUREMENT_KEY_ID, header)).toBe('measurement');
    }
    expect(resolveTier(MEASUREMENT_KEY_ID)).toBe('measurement');
    expect(resolveRateTier(MEASUREMENT_KEY_ID)).toBe('measurement');
  });

  it('no caller can forward the measurement label: the server key and a keystore key sending it get no measurement tier', () => {
    expect(resolveEntitledTier('admin', 'measurement')).toBe('free');
    expect(resolveSpendCapTier('admin', 'measurement')).toBe('free');
    expect(resolveTierFromRequest('admin', 'measurement')).toBe('enterprise');
    const key = getKeyStore().create('Free Key', ['scan']);
    expect(resolveTierFromRequest(key.id, 'measurement')).toBe('personal');
    expect(resolveEntitledTier(key.id, 'measurement')).toBe('personal');
  });

  it('a consensus request from it is refused on the route, even with x-user-tier enterprise', async () => {
    const app = await start();
    const res = await app.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': MEASUREMENT_KEY, 'x-user-tier': 'enterprise', 'content-type': 'application/json' },
      payload: { text: 'The Eiffel Tower is in Paris.', pipelineConfig: { consensus: true } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).not.toBe('consensus_not_in_plan');
  });
});

describe('measurement key: spend rows carry tier measurement', () => {
  it('admin verify writes cost-store, scan-cost-log and provider-spend rows labelled measurement', async () => {
    const app = await start();
    const res = await verify(app, MEASUREMENT_KEY, { 'x-user-tier': 'enterprise' });
    expect(res.statusCode).toBe(200);

    const events = getCostStore().getManagedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe('measurement');
    expect(events[0].kind).toBe('admin-verify');
    expect(JSON.parse(scanCostLogRow(events[0])).user_tier).toBe('measurement');

    const rows = spendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe('measurement');
    expect(Number(rows[0].costUsd)).toBeGreaterThan(0);
  });

  it('the same call on the admin key is labelled enterprise, so the two can be told apart', async () => {
    const app = await start();
    expect((await verify(app, ADMIN_KEY)).statusCode).toBe(200);
    expect((await verify(app, MEASUREMENT_KEY)).statusCode).toBe(200);
    const tiers = spendRows().map((row) => row.tier);
    expect(tiers).toEqual(['enterprise', 'measurement']);
  });
});

describe('measurement key: scan-cost log rows survive a reload', () => {
  const event = (scanId: string, tier: ManagedScanCostEvent['tier']): ManagedScanCostEvent => ({
    scanId, ts: new Date().toISOString(), tier, keyMode: 'managed', provider: 'gemini', modelId: 'gemini-2.5-flash',
    inputTokens: 100, outputTokens: 20, groundingCalls: 1, costUsd: 0.04, latencyMs: 10, kind: 'admin-verify',
  });

  it('hydrating a log with one enterprise row and one measurement row keeps both, with their tiers', () => {
    const logPath = join(tmpDir, 'scan-costs.ndjson');
    // The rows the server writes (appendScanCostLog is a no-op under Vitest, so they are written here).
    writeFileSync(logPath, [event('enterprise-row', 'enterprise'), event('measurement-row', 'measurement')].map(scanCostLogRow).join('\n') + '\n');
    const loaded = loadScanCostLog(logPath);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => [e.scanId, e.tier])).toEqual([['enterprise-row', 'enterprise'], ['measurement-row', 'measurement']]);
    getCostStore().hydrate(loaded);
    expect(getCostStore().getManagedEvents().map((e) => e.tier)).toEqual(['enterprise', 'measurement']);
  });

  it('a row with an unknown tier is still dropped', () => {
    const logPath = join(tmpDir, 'scan-costs.ndjson');
    const rows = [event('kept', 'measurement'), { ...event('dropped', 'free'), tier: 'not-a-tier' as ManagedScanCostEvent['tier'] }];
    writeFileSync(logPath, rows.map(scanCostLogRow).join('\n') + '\n');
    expect(loadScanCostLog(logPath).map((e) => e.scanId)).toEqual(['kept']);
  });

  it('x-user-tier: measurement is still not forwardable', () => {
    expect(resolveTierFromRequest('admin', 'measurement')).toBe('enterprise');
    expect(resolveTierFromRequest('admin', ['measurement'])).toBe('enterprise');
  });
});

describe('measurement key: the fleet spend cap never refuses it', () => {
  it('passes the exhausted cap on POST /admin/verify-claims, while a free-labelled call is refused', async () => {
    exhaustBudget();
    const app = await start();
    const res = await verify(app, MEASUREMENT_KEY);
    expect(res.statusCode).toBe(200);
    expect(spendRows().filter((row) => row.tier === 'measurement')).toHaveLength(1);

    // Control: the gate is live. A keystore admin key is an operator key and passes,
    // so the control is a free tier through the background-work check.
    expect(providerBudgetRefuses('free')).toBe(true);
    expect(providerBudgetRefuses('measurement')).toBe(false);
  });
});
