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
import { getNotificationStore, resetNotificationStore, sendWeeklySummaries } from '../src/store/notifications.js';
import { getTemplateStore, resetTemplateStore } from '../src/store/templates.js';
import { resetClaimIndex } from '../src/store/claims.js';
import { getScheduleStore, getScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';
import { dispatchWebhook, getWebhookDeliveryLog, resetWebhookDeliveryLog, sanitizeErrorText } from '../src/store/webhooks.js';
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
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn().mockResolvedValue('The Eiffel Tower was completed in 1889.') }));
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
  resetNotificationStore();
  resetScheduleStore();
  resetTemplateStore();
  resetClaimIndex();
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
    const job = getJobStore().create({ text: CLAIM_TEXT, provider: 'gemini', schedule: '*/5 * * * *', webhookUrl: 'https://job.example.com/hook', owner: { keyId: 'admin', caller: null } });
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

// ── Seat findings on 859a348 (Opus blind seat, codex fresh exec) ─────────────

describe('ownership holds for the whole delivery, on every route, for live keys only', () => {
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
    _setSleepFn(async () => {});
    await server.close();
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('WO-10. a retry is not sent once the webhook owner has left the tenant (checked before every attempt)', async () => {
    const a = tenantAdminKey('Tenant A');
    const b = getKeyStore().create('Moves to B', ['scan', 'admin']);
    getTenantStore().addKey(a.tenant.id, b.id);
    const bTenant = getTenantStore().create('Tenant B', []);
    const hook = getWebhookStore().create('https://b.example.com/hook', ['scan.complete'], 's', undefined, 3, 500,
      { keyId: b.id, caller: `${b.id}\u0000${b.id}` });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    _setSleepFn(async (ms) => {
      if (ms > 0) { getTenantStore().removeKey(a.tenant.id, b.id); getTenantStore().addKey(bTenant.id, b.id); }
    });
    await dispatchWebhook(hook, 'scan.complete', PLAIN_RESULT, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it('WO-11. a scan whose key is deleted while it runs sends nothing to its former tenant', async () => {
    const a = tenantAdminKey('Tenant A');
    const other = getKeyStore().create('Tenant A other', ['scan', 'admin']);
    getTenantStore().addKey(a.tenant.id, other.id);
    await register(server, other.key, 'https://a2.example.com/hook', ['scan.complete']);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockImplementationOnce(async () => { getKeyStore().delete(a.key.id); return PLAIN_RESULT as never; });
    await scanAs(server, a.key.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it('WO-12. a disabled or expired owner key\'s webhook receives nothing', async () => {
    const a = tenantAdminKey('Tenant A');
    const scanner = getKeyStore().create('Tenant A scanner', ['scan']);
    getTenantStore().addKey(a.tenant.id, scanner.id);
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);

    getKeyStore().validateById(a.key.id)!.disabled = true;
    await scanAs(server, scanner.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);

    getKeyStore().validateById(a.key.id)!.disabled = false;
    getKeyStore().validateById(a.key.id)!.expiresAt = '2020-01-01T00:00:00.000Z';
    await scanAs(server, scanner.key, { text: `${CLAIM_TEXT} again`, provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it('WO-13. a job\'s job.complete reaches its creator\'s tenant only', async () => {
    const a = tenantAdminKey('Tenant A');
    const b = tenantAdminKey('Tenant B');
    getWebhookStore().create('https://a.example.com/hook', ['job.complete'], 's', undefined, 3, 500, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    getWebhookStore().create('https://b.example.com/hook', ['job.complete'], 's', undefined, 3, 500, { keyId: b.key.id, caller: `${b.key.id}\u0000${b.key.id}` });
    const res = await server.inject({
      method: 'POST', url: '/jobs',
      headers: { 'x-api-key': a.key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock', schedule: '*/5 * * * *' }),
    });
    expect(res.statusCode).toBe(201);
    await getJobScheduler().triggerJob(JSON.parse(res.body).id);
    await flush();
    expect(deliveries().map((d) => d.url)).toEqual(['https://a.example.com/hook']);
  });

  it.each([
    ['batch', async (srv: FastifyInstance, key: string) => srv.inject({ method: 'POST', url: '/scan/batch', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ texts: [CLAIM_TEXT] }) })],
    ['deep', async (srv: FastifyInstance, key: string) => srv.inject({ method: 'POST', url: '/scan/deep', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock' }) })],
    ['cache hit', async (srv: FastifyInstance, key: string) => {
      await srv.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock' }) });
      vi.mocked(fetch).mockClear();
      const hit = await srv.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock' }) });
      expect(hit.headers['x-cache']).toBe('HIT');
      return hit;
    }],
  ])('WO-14. %s: tenant B\'s webhook receives nothing from tenant A\'s scan', async (_name, run) => {
    const a = tenantAdminKey('Tenant A');
    const b = tenantAdminKey('Tenant B');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    await register(server, b.key.key, 'https://b.example.com/hook', ['scan.complete']);
    const res = await run(server, a.key.key);
    expect(res.statusCode).toBe(200);
    await flush();
    const urls = deliveries().map((d) => d.url);
    expect(urls).toContain('https://a.example.com/hook');
    expect(urls).not.toContain('https://b.example.com/hook');
  });

  it('WO-15. registration response and listing carry neither owner key nor caller', async () => {
    const a = tenantAdminKey('Tenant A');
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': a.key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://a.example.com/hook', events: ['scan.complete'] }),
    });
    expect(res.body).not.toContain(a.key.id);
    const list = await server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': ADMIN } });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(a.key.id);
  });

  it('WO-16. another key cannot make a webhook send a payload signed with its secret', async () => {
    const a = tenantAdminKey('Tenant A');
    const b = getKeyStore().create('Tenant B scanner', ['scan']);
    const hook = await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    const res = await server.inject({ method: 'POST', url: `/webhooks/test/${hook.id}`, headers: { 'x-api-key': b.key, 'content-type': 'application/json' }, body: '{}' });
    expect(res.statusCode).toBe(404);
    await flush();
    expect(deliveries()).toEqual([]);
    const own = await server.inject({ method: 'POST', url: `/webhooks/test/${hook.id}`, headers: { 'x-api-key': a.key.key, 'content-type': 'application/json' }, body: '{}' });
    expect(own.statusCode).toBe(200);
  });

  it('WO-17. a scan.failed error loses any Google grounding Link and is capped', async () => {
    const a = tenantAdminKey('Tenant A');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.failed']);
    const owner = { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` };
    fireWebhookEvent('scan.failed', { error: `provider said: ${EXPLANATION} see ${GROUNDING_URI} ${'x'.repeat(600)}` }, owner);
    await flush();
    const sent = deliveries();
    expect(sent.length).toBe(1);
    expect(sent[0].raw).not.toContain('vertexaisearch');
    expect(((sent[0].body.data as { error: string }).error).length).toBeLessThanOrEqual(301);
  });
});

describe('notification settings belong to their key', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
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

  it('WN-1. key B cannot set, read, test or delete key A\'s notification settings or history', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    const hb = { 'x-api-key': b.key, 'content-type': 'application/json' };
    const put = await server.inject({ method: 'PUT', url: `/notifications/prefs/${a.id}`, headers: hb, body: JSON.stringify({ events: ['scan.completed'], webhookUrl: 'https://b.example.com/steal' }) });
    expect(put.statusCode).toBe(403);
    expect(getNotificationStore().getPrefs(a.id)).toBeFalsy();
    for (const [method, url] of [['GET', `/notifications/prefs/${a.id}`], ['DELETE', `/notifications/prefs/${a.id}`], ['POST', `/notifications/test/${a.id}`], ['GET', `/notifications/history?keyId=${a.id}`]] as const) {
      const res = await server.inject({ method, url, headers: { 'x-api-key': b.key } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    getNotificationStore().setPrefs(a.id, ['scan.completed'], 'https://a.example.com/n', null);
    const list = await server.inject({ method: 'GET', url: '/notifications/prefs', headers: { 'x-api-key': b.key } });
    expect(list.body).not.toContain(a.id);
    const own = await server.inject({ method: 'PUT', url: `/notifications/prefs/${b.id}`, headers: hb, body: JSON.stringify({ events: ['scan.completed'], webhookUrl: 'https://b.example.com/n' }) });
    expect([200, 201]).toContain(own.statusCode);
  });

  it('WN-2. a scheduled scan of Gemini-grounded verdicts notifies without the verdict-derived risk', async () => {
    const a = getKeyStore().create('A', ['scan']);
    getNotificationStore().setPrefs(a.id, ['scan.completed'], 'https://a.example.com/n', null);
    const s = getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT }, a.id);
    await getScheduleRunner().runSchedule(s);
    await flush();
    const sent = deliveries().filter((d) => d.url === 'https://a.example.com/n');
    expect(sent.length).toBe(1);
    expect(sent[0].body.grounded).toBe(true);
    expect(sent[0].body).not.toHaveProperty('overallRisk');
    expect(sent[0].raw).not.toContain(EXPLANATION);
  });

  it('WG-5. a compliance gate failure on grounded verdicts sends only that it failed', async () => {
    const { evaluateComplianceGate } = await import('@nxtg/faultline/cli/compliance-report.js');
    vi.mocked(evaluateComplianceGate).mockReturnValueOnce({ pass: false, articles: [{ article: 'Art. 13', status: 'non-compliant' }], nonCompliantCount: 1, totalArticles: 1, threshold: 60 } as never);
    const a = tenantAdminKey('Tenant A');
    getWebhookStore().create('https://a.example.com/hook', ['compliance.gate_failed'], 's', undefined, 3, 500, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    const res = await server.inject({ method: 'POST', url: '/scan/compliance-gate', headers: { 'x-api-key': a.key.key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'gemini', projectName: 'P1' }) });
    expect(res.statusCode).toBe(422);
    await flush();
    const sent = deliveries();
    expect(sent.length).toBe(1);
    const data = sent[0].body.data as Record<string, unknown>;
    expect(data.grounded).toBe(true);
    for (const k of ['overallRisk', 'complianceScore', 'failedArticles', 'nonCompliantCount']) expect(data).not.toHaveProperty(k);
  });

  it('WG-6. a result naming the provider as the engine does ("Google Gemini") is treated as grounded', () => {
    const real = { ...PLAIN_RESULT, provider: 'Google Gemini' };
    const out = webhookSafeData('scan.complete', real) as Record<string, unknown>;
    expect(out.grounded).toBe(true);
    expect(JSON.stringify(out)).not.toContain(CLAIM_TEXT);
  });
});

// ── Seat findings on 84cf8c8 (codex fresh exec) ─────────────────────────────

describe('round 3: scan ids, job and notification ownership, error text', () => {
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

  it('R3-1. the minimal grounded event names the scan, and the response carries the same scanId', async () => {
    const a = tenantAdminKey('Tenant A');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    const res = await scanAs(server, a.key.key, { text: CLAIM_TEXT, provider: 'gemini' });
    const scanId = JSON.parse(res.body).scanId;
    expect(typeof scanId).toBe('string');
    expect(scanId.length).toBeGreaterThan(5);
    await flush();
    const data = deliveries()[0].body.data as Record<string, unknown>;
    expect(data.scanId).toBe(scanId);
  });

  it('R3-2. a key lists and deletes only its own jobs', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    const created = await server.inject({ method: 'POST', url: '/jobs', headers: { 'x-api-key': a.key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock', schedule: '*/5 * * * *', webhookUrl: 'https://a.example.com/job' }) });
    const jobId = JSON.parse(created.body).id;
    const listB = await server.inject({ method: 'GET', url: '/jobs', headers: { 'x-api-key': b.key } });
    expect(listB.statusCode).toBe(200);
    expect(listB.body).not.toContain(CLAIM_TEXT);
    expect(listB.body).not.toContain('a.example.com');
    const delB = await server.inject({ method: 'DELETE', url: `/jobs/${jobId}`, headers: { 'x-api-key': b.key } });
    expect(delB.statusCode).toBe(404);
    expect(getJobStore().get(jobId)).not.toBeNull();
    const listA = await server.inject({ method: 'GET', url: '/jobs', headers: { 'x-api-key': a.key } });
    expect(listA.body).toContain(CLAIM_TEXT);
    const delA = await server.inject({ method: 'DELETE', url: `/jobs/${jobId}`, headers: { 'x-api-key': a.key } });
    expect(delA.statusCode).toBe(204);
  });

  it.each(['deleted', 'disabled', 'expired'])('R3-3. a job whose creator key is %s posts nothing to its webhookUrl', async (state) => {
    const a = getKeyStore().create('A', ['scan']);
    const job = getJobStore().create({ text: CLAIM_TEXT, provider: 'mock', schedule: '*/5 * * * *', webhookUrl: 'https://a.example.com/job', owner: { keyId: a.id, caller: `${a.id}\u0000${a.id}` } });
    if (state === 'deleted') getKeyStore().delete(a.id);
    if (state === 'disabled') getKeyStore().validateById(a.id)!.disabled = true;
    if (state === 'expired') getKeyStore().validateById(a.id)!.expiresAt = '2020-01-01T00:00:00.000Z';
    await getJobScheduler().triggerJob(job.id);
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it.each(['deleted', 'disabled', 'expired'])('R3-4. a %s key\'s scheduled-scan notifications are not sent', async (state) => {
    const a = getKeyStore().create('A', ['scan']);
    getNotificationStore().setPrefs(a.id, ['scan.completed'], 'https://a.example.com/n', null);
    const s = getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT }, a.id);
    if (state === 'deleted') getKeyStore().delete(a.id);
    if (state === 'disabled') getKeyStore().validateById(a.id)!.disabled = true;
    if (state === 'expired') getKeyStore().validateById(a.id)!.expiresAt = '2020-01-01T00:00:00.000Z';
    await getScheduleRunner().runSchedule(s);
    await flush();
    expect(deliveries().filter((d) => d.url === 'https://a.example.com/n')).toEqual([]);
  });

  it('R3-5. provider error text never reaches a caller URL; Faultline\'s own messages do', async () => {
    const a = tenantAdminKey('Tenant A');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.failed']);
    const owner = { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` };
    fireWebhookEvent('scan.failed', { error: `Gemini grounded response: ${EXPLANATION}` }, owner);
    fireWebhookEvent('scan.failed', { error: 'All providers circuit-broken.' }, owner);
    await flush();
    const errors = deliveries().map((d) => (d.body.data as { error: string }).error);
    expect(errors).toContain('Scan failed (provider error).');
    expect(errors).toContain('All providers circuit-broken.');
    expect(JSON.stringify(errors)).not.toContain(EXPLANATION);
  });

  it('R3-6. a scheduled scan that fails with provider text notifies a generic error', async () => {
    const a = getKeyStore().create('A', ['scan']);
    getNotificationStore().setPrefs(a.id, ['scan.failed'], 'https://a.example.com/n', null);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValueOnce(new Error(`Gemini grounded response: ${EXPLANATION} ${GROUNDING_URI}`));
    const s = getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT }, a.id);
    await getScheduleRunner().runSchedule(s);
    await flush();
    const sent = deliveries().filter((d) => d.url === 'https://a.example.com/n');
    expect(sent.length).toBe(1);
    expect(sent[0].raw).not.toContain(EXPLANATION);
    expect(sent[0].raw).not.toContain('vertexaisearch');
  });

  it('R3-7. a webhook whose owner key is gone receives no public events either', () => {
    const a = getKeyStore().create('A', ['scan', 'admin']);
    const hook = getWebhookStore().create('https://a.example.com/hook', ['compliance.deadline_approaching'], 's', undefined, 3, 500, { keyId: a.id, caller: `${a.id}\u0000${a.id}` });
    expect(webhookMayReceive(hook, 'public')).toBe(true);
    getKeyStore().delete(a.id);
    expect(webhookMayReceive(hook, 'public')).toBe(false);
  });
});

// ── Opus blind seat on 84cf8c8: survived mutants and leftovers ────────────────

function multipart(text: string): { body: Buffer; headers: Record<string, string> } {
  const b = 'OwnerScopeBoundary';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="t.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(`%PDF-1.4 ${text}`), Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

describe('every scan route passes the scan\'s owner', () => {
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

  it.each([
    ['pipelineConfig', 'scan.complete', async (srv: FastifyInstance, key: string) => srv.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', verificationProvider: 'mock', synthesisProvider: 'mock' } }) })],
    ['template', 'scan.complete', async (srv: FastifyInstance, key: string) => {
      const t = getTemplateStore().create('t', { provider: 'mock' } as never);
      return srv.inject({ method: 'POST', url: `/scan/template/${t.id}`, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT, provider: 'mock' }) });
    }],
    ['upload', 'scan.complete', async (srv: FastifyInstance, key: string) => {
      const m = multipart(CLAIM_TEXT);
      return srv.inject({ method: 'POST', url: '/scan/upload', headers: { 'x-api-key': key, ...m.headers }, payload: m.body });
    }],
    ['scan.failed', 'scan.failed', async (srv: FastifyInstance, key: string) => {
      const { scan } = await import('@nxtg/faultline/cli/scan.js');
      vi.mocked(scan).mockRejectedValue(new Error('provider down'));
      return srv.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: CLAIM_TEXT }) });
    }],
  ])('WO-18. %s: tenant B receives nothing from tenant A; tenant A does', async (_name, event, run) => {
    const a = tenantAdminKey('Tenant A');
    const b = tenantAdminKey('Tenant B');
    await register(server, a.key.key, 'https://a.example.com/hook', [event]);
    await register(server, b.key.key, 'https://b.example.com/hook', [event]);
    await run(server, a.key.key);
    await flush();
    const urls = deliveries().map((d) => d.url);
    expect(urls).toContain('https://a.example.com/hook');
    expect(urls).not.toContain('https://b.example.com/hook');
  });

  it('WO-19. a verdict flip in the shared claim index reaches no webhook, through a real scan', async () => {
    const a = tenantAdminKey('Tenant A');
    await register(server, a.key.key, 'https://a.example.com/hook', ['claim.verdict_changed']);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    const supported = { ...PLAIN_RESULT, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'x', sources: [] } } };
    vi.mocked(scan).mockResolvedValueOnce(supported as never).mockResolvedValueOnce(PLAIN_RESULT as never);
    await scanAs(server, a.key.key, { text: 'first input', provider: 'mock' });
    await scanAs(server, a.key.key, { text: 'second input', provider: 'mock' });
    await flush();
    expect(deliveries()).toEqual([]);
  });

  it('WG-7. a verdict carrying only Google Search Suggestions is treated as grounded', () => {
    const viaSuggestions = { ...PLAIN_RESULT, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPLANATION, sources: [], searchEntryPoint: { renderedContent: '<div/>' } } } };
    const out = webhookSafeData('scan.complete', viaSuggestions) as Record<string, unknown>;
    expect(out.grounded).toBe(true);
  });

  it('WO-20. webhook test history is admin only', async () => {
    const plain = getKeyStore().create('plain', ['scan']);
    const res = await server.inject({ method: 'GET', url: '/webhooks/test/history', headers: { 'x-api-key': plain.key } });
    expect(res.statusCode).toBe(403);
  });

  it('WO-21. a retry stops once the webhook is deleted', async () => {
    const a = tenantAdminKey('Tenant A');
    const hook = getWebhookStore().create('https://a.example.com/hook', ['scan.complete'], 's', undefined, 3, 500, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    _setSleepFn(async (ms) => { if (ms > 0) getWebhookStore().delete(hook.id); });
    await dispatchWebhook(hook, 'scan.complete', PLAIN_RESULT, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it('WN-3. each weekly-summary subscriber gets only its own summary', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    getNotificationStore().setPrefs(a.id, ['weekly.summary'], 'https://a.example.com/n', null);
    getNotificationStore().setPrefs(b.id, ['weekly.summary'], 'https://b.example.com/n', null);
    await sendWeeklySummaries();
    const toA = deliveries().filter((d) => d.url === 'https://a.example.com/n');
    const toB = deliveries().filter((d) => d.url === 'https://b.example.com/n');
    expect(toA.length).toBe(1);
    expect(toB.length).toBe(1);
    expect(toA[0].raw).not.toContain(b.id);
    expect(toB[0].raw).not.toContain(a.id);
  });
});

// ── Seat B on 43264e7 (transcript-blind Opus, CLX9): LOW-1 and LOW-2 ───────────

describe('fire-time filter and the schedule webhookUrl', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    resetWebhookDeliveryLog();
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

  it('WO-22. a non-owner webhook is not even dispatched: no delivery record, not just a refused send', async () => {
    const a = tenantAdminKey('Tenant A');
    const b = tenantAdminKey('Tenant B');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.complete']);
    const hookB = await register(server, b.key.key, 'https://b.example.com/hook', ['scan.complete']);
    await scanAs(server, a.key.key, { text: CLAIM_TEXT, provider: 'mock' });
    await flush();
    expect(getWebhookDeliveryLog().list(hookB.id)).toEqual([]);
    expect(getWebhookDeliveryLog().list().length).toBeGreaterThan(0);
  });

  it('SW-1. a schedule run posts to its own webhookUrl, without the notify email', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const s = getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT, webhookUrl: 'https://a.example.com/sched', notifyEmail: 'owner@example.com' } as never, a.id);
    await getScheduleRunner().runSchedule(s);
    await flush();
    const sent = deliveries().filter((d) => d.url === 'https://a.example.com/sched');
    expect(sent.length).toBe(1);
    expect(sent[0].body.event).toBe('scan.completed');
    expect(sent[0].body.scheduleId).toBe(s.id);
    expect(sent[0].raw).not.toContain('owner@example.com');
  });

  it('SW-2. grounded results reach the schedule webhookUrl as counts only; provider error text becomes generic', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockResolvedValueOnce(GROUNDED_RESULT as never).mockRejectedValueOnce(new Error(`Gemini said ${EXPLANATION} ${GROUNDING_URI}`));
    const s = getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT, webhookUrl: 'https://a.example.com/sched' } as never, a.id);
    await getScheduleRunner().runSchedule(s);
    await getScheduleRunner().runSchedule(s);
    await flush();
    const sent = deliveries().filter((d) => d.url === 'https://a.example.com/sched');
    expect(sent.length).toBe(2);
    expect(sent[0].body.grounded).toBe(true);
    expect(sent[0].body).not.toHaveProperty('overallRisk');
    for (const d of sent) {
      expect(d.raw).not.toContain(EXPLANATION);
      expect(d.raw).not.toContain('vertexaisearch');
    }
    expect(sent[1].body.error).toBe('Scan failed (provider error).');
  });

  it.each(['deleted', 'disabled'])('SW-3. a schedule whose owner key is %s posts nothing to its webhookUrl', async (state) => {
    const a = getKeyStore().create('A', ['scan']);
    const s = getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT, webhookUrl: 'https://a.example.com/sched' } as never, a.id);
    if (state === 'deleted') getKeyStore().delete(a.id); else getKeyStore().validateById(a.id)!.disabled = true;
    await getScheduleRunner().runSchedule(s);
    await flush();
    expect(deliveries().filter((d) => d.url === 'https://a.example.com/sched')).toEqual([]);
  });

  it('WO-23. a batch scan.failed reaches its own tenant only', async () => {
    const a = tenantAdminKey('Tenant A');
    const b = tenantAdminKey('Tenant B');
    await register(server, a.key.key, 'https://a.example.com/hook', ['scan.failed']);
    await register(server, b.key.key, 'https://b.example.com/hook', ['scan.failed']);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValue(new Error('provider down'));
    await server.inject({ method: 'POST', url: '/scan/batch', headers: { 'x-api-key': a.key.key, 'content-type': 'application/json' }, body: JSON.stringify({ texts: [CLAIM_TEXT] }) });
    await flush();
    const urls = deliveries().map((d) => d.url);
    expect(urls).toContain('https://a.example.com/hook');
    expect(urls).not.toContain('https://b.example.com/hook');
  });

  it('WO-24. a grounding link inside an allow-listed Faultline error is still removed', () => {
    const out = sanitizeErrorText(`All providers failed; last answer cited ${GROUNDING_URI} and https://example.org/ok`);
    expect(out).not.toContain('vertexaisearch');
    expect(out).toContain('[link removed]');
    expect(out).toContain('https://example.org/ok');
  });
});
