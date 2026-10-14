/**
 * Webhook delivery is scoped to the scan's owner, and a Gemini-grounded result
 * reaches no webhook (emma-soul al:3dd437daabb68ad9, GoPMO 1.18.11.3).
 *
 * Before this change fireWebhookEvent sent every event to every webhook
 * subscribed to it, whatever its tenant: tenant B's webhook received tenant A's
 * claims, verdicts and sources. And a grounded result went to the webhook in
 * full, though Google's terms let Grounded Results be shown only to the end
 * user who submitted the prompt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getWebhookStore,
  resetWebhookStore,
  fireWebhookEvent,
  webhookMayReceive,
  webhookSafeData,
  _setSleepFn,
} from '../src/store/webhooks.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { getJobStore, getJobScheduler, resetJobStore } from '../src/store/jobs.js';
import type { FastifyInstance } from 'fastify';

const CLAIM_TEXT = 'The Eiffel Tower was completed in 1889.';
const EXPLANATION = 'Multiple sources confirm completion in March 1889.';
const GROUNDING_URI = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf';

const PLAIN_RESULT = {
  input: CLAIM_TEXT,
  provider: 'mock',
  claims: [{ id: 'c1', text: CLAIM_TEXT, type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: EXPLANATION, sources: [] } },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

// What a real Gemini verdict looks like: provenance bound at the call site,
// sources that are Google grounding Links.
const GROUNDED_RESULT = {
  ...PLAIN_RESULT,
  provider: 'gemini',
  verifications: {
    c1: {
      claimId: 'c1',
      status: 'supported',
      explanation: EXPLANATION,
      sources: [{ title: 'toureiffel.paris', uri: GROUNDING_URI }],
      provenance: { provider: 'gemini', model: 'gemini-2.5-flash', verifiedAt: '2026-10-14T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-14T00:00:00.000Z' },
    },
  },
};

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

const ADMIN = 'admin-secret';
const flush = () => new Promise((r) => setTimeout(r, 30));

function resetAll() {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetWebhookStore();
  resetKeyStore();
  resetTenantStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
  resetJobStore();
}

/** URLs fetch was called with, and the parsed bodies. */
function deliveries(): Array<{ url: string; body: Record<string, unknown>; raw: string }> {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => {
    const raw = String((init as RequestInit).body);
    return { url: String(url), body: JSON.parse(raw), raw };
  });
}

/** A keystore key with admin permission (so it may register webhooks) inside a new tenant. */
function tenantAdminKey(name: string) {
  const key = getKeyStore().create(`${name} admin`, ['scan', 'admin']);
  const tenant = getTenantStore().create(name, [key.id]);
  return { key, tenant };
}

async function register(server: FastifyInstance, apiKey: string, url: string, events: string[], userRef?: string) {
  const res = await server.inject({
    method: 'POST', url: '/webhooks',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(userRef ? { 'x-faultline-user-ref': userRef } : {}) },
    body: JSON.stringify({ url, events }),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { id: string };
}

async function scanAs(server: FastifyInstance, apiKey: string, body: Record<string, unknown>, userRef?: string) {
  const res = await server.inject({
    method: 'POST', url: '/scan',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(userRef ? { 'x-faultline-user-ref': userRef } : {}) },
    body: JSON.stringify(body),
  });
  expect(res.statusCode).toBe(200);
  return res;
}

describe('webhook delivery is scoped to the scan owner', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    _setSleepFn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockReset().mockResolvedValue(PLAIN_RESULT as never);
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('WO-1. tenant B\'s webhook receives nothing from tenant A\'s scan; tenant A\'s does', async () => {
    const a = tenantAdminKey('Tenant A');
    const b = tenantAdminKey('Tenant B');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    await register(server, b.key.key, 'https://b.example.com/hook', ['scan.complete']);

    await scanAs(server, a.key.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();

    const sent = deliveries();
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe('https://a.example.com/hook');
    expect(sent.some((d) => d.url.startsWith('https://b.example.com'))).toBe(false);
    expect(sent.some((d) => d.raw.includes(CLAIM_TEXT) && d.url.startsWith('https://b.'))).toBe(false);
  });

  it('WO-2. another key in the same tenant counts as the owner', async () => {
    const a = tenantAdminKey('Tenant A');
    const second = getKeyStore().create('Tenant A scanner', ['scan']);
    getTenantStore().addKey(a.tenant.id, second.id);
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);

    await scanAs(server, second.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries().map((d) => d.url)).toEqual(['https://a.example.com/hook']);
  });

  it('WO-3. tenancy is read at send time: a key moved out of the tenant after registering stops receiving', async () => {
    const a = tenantAdminKey('Tenant A');
    const scanner = getKeyStore().create('Tenant A scanner', ['scan']);
    getTenantStore().addKey(a.tenant.id, scanner.id);
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    getTenantStore().removeKey(a.tenant.id, a.key.id);

    await scanAs(server, scanner.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it('WO-4. a deleted owner key\'s webhook receives nothing, even from its old tenant', async () => {
    const a = tenantAdminKey('Tenant A');
    const scanner = getKeyStore().create('Tenant A scanner', ['scan']);
    getTenantStore().addKey(a.tenant.id, scanner.id);
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    getKeyStore().delete(a.key.id);

    await scanAs(server, scanner.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it('WO-5. two keys outside any tenant do not share webhooks', async () => {
    const one = getKeyStore().create('Solo one', ['scan', 'admin']);
    const two = getKeyStore().create('Solo two', ['scan', 'admin']);
    await register(server, one.key, 'https://one.example.com/hook', ['scan.complete']);

    await scanAs(server, two.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);

    await scanAs(server, one.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries().map((d) => d.url)).toEqual(['https://one.example.com/hook']);
  });

  it('WO-6. behind the server key, delivery is per faultline-web user; no user ref means no delivery', async () => {
    await register(server, ADMIN, 'https://web.example.com/hook-u1', ['scan.complete'], 'fpwebuser0001');
    await register(server, ADMIN, 'https://web.example.com/hook-noref', ['scan.complete']);

    await scanAs(server, ADMIN, { text: CLAIM_TEXT, provider: 'mock' }, 'fpwebuser0002');
    await scanAs(server, ADMIN, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);

    await scanAs(server, ADMIN, { text: CLAIM_TEXT, provider: 'mock' }, 'fpwebuser0001');
    await flush();
    expect(deliveries().map((d) => d.url)).toEqual(['https://web.example.com/hook-u1']);
  });

  it('WO-7. a webhook created with no owner receives scan events from no one, public events from the calendar', () => {
    const hook = getWebhookStore().create('https://legacy.example.com/hook', ['scan.complete', 'compliance.deadline_approaching']);
    expect(webhookMayReceive(hook, { keyId: 'admin', caller: 'admin\u0000fpwebuser0001' })).toBe(false);
    expect(webhookMayReceive(hook, null)).toBe(false);
    expect(webhookMayReceive(hook, 'public')).toBe(true);
  });

  it('WO-8. claim.verdict_changed (shared claim index, no single owner) reaches no webhook', async () => {
    getWebhookStore().create('https://a.example.com/hook', ['claim.verdict_changed'], undefined, undefined, 3, 500,
      { keyId: 'admin', caller: 'admin\u0000fpwebuser0001' });
    fireWebhookEvent('claim.verdict_changed', { claim: CLAIM_TEXT }, null);
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it('WO-9. the registration response and listing do not show the owner caller', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': ADMIN, 'content-type': 'application/json', 'x-faultline-user-ref': 'fpwebuser0001' },
      body: JSON.stringify({ url: 'https://web.example.com/hook', events: ['scan.complete'] }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('fpwebuser0001');
    const list = await server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': ADMIN } });
    expect(list.body).not.toContain('fpwebuser0001');
  });
});

describe('a Gemini-grounded result reaches no webhook', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    _setSleepFn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockReset().mockResolvedValue(GROUNDED_RESULT as never);
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_API_KEY;
  });

  function assertMinimal(body: Record<string, unknown>, raw: string) {
    const data = body.data as Record<string, unknown>;
    expect(data.grounded).toBe(true);
    expect(data.status).toBe('complete');
    expect(data.claimCount).toBe(1);
    expect(data.checkedCount).toBe(1);
    for (const key of ['claims', 'verifications', 'sources', 'input', 'overallRisk', 'explanation']) {
      expect(data).not.toHaveProperty(key);
    }
    expect(raw).not.toContain(CLAIM_TEXT);
    expect(raw).not.toContain(EXPLANATION);
    expect(raw).not.toContain('vertexaisearch');
    expect(raw).not.toContain('toureiffel');
    expect(raw).not.toContain('supported');
  }

  it('WG-1. the owner\'s own webhook gets a minimal event: status and counts, no grounded content', async () => {
    const a = tenantAdminKey('Tenant A');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);

    const res = await scanAs(server, a.key.key, { text: CLAIM_TEXT, provider: 'gemini' });
    // The submitter still gets the full result in the response.
    expect(res.body).toContain(EXPLANATION);
    await flush();

    const sent = deliveries();
    expect(sent.length).toBe(1);
    expect(sent[0].body.event).toBe('scan.complete');
    assertMinimal(sent[0].body, sent[0].raw);
  });

  it('WG-2. detected from the verdict, not only the request: a grounding Link in sources is enough', () => {
    const viaSources = {
      ...PLAIN_RESULT,
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPLANATION, sources: [{ title: 't', uri: GROUNDING_URI }] } },
    };
    const out = webhookSafeData('scan.complete', viaSources) as Record<string, unknown>;
    expect(out.grounded).toBe(true);
    expect(JSON.stringify(out)).not.toContain(CLAIM_TEXT);
  });

  it('WG-3. a non-grounded result is sent unchanged', () => {
    expect(webhookSafeData('scan.complete', PLAIN_RESULT)).toBe(PLAIN_RESULT);
  });

  it('WG-4. a scheduled job posting to its own webhookUrl sends the minimal event for a grounded result', async () => {
    const job = getJobStore().create({ text: CLAIM_TEXT, provider: 'gemini', schedule: '*/5 * * * *', webhookUrl: 'https://job.example.com/hook' });
    await getJobScheduler().triggerJob(job.id);
    await flush();

    const sent = deliveries();
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe('https://job.example.com/hook');
    expect(sent[0].body.event).toBe('job.complete');
    expect(sent[0].body.jobId).toBe(job.id);
    expect(sent[0].body.grounded).toBe(true);
    expect(sent[0].raw).not.toContain(CLAIM_TEXT);
    expect(sent[0].raw).not.toContain('vertexaisearch');
    expect(sent[0].raw).not.toContain(EXPLANATION);
  });
});
