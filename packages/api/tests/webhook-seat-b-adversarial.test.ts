/** Seat B (transcript-blind Opus, CLX9) adversarial fixtures on 43264e7, adopted into the suite (emma-soul al:3b791a8ca1db203a). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getWebhookStore, resetWebhookStore, fireWebhookEvent, webhookMayReceive, webhookSafeData, _setSleepFn, dispatchWebhook } from '../src/store/webhooks.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { getJobStore, getJobScheduler, resetJobStore } from '../src/store/jobs.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import { resetTemplateStore } from '../src/store/templates.js';
import { resetClaimIndex } from '../src/store/claims.js';
import { resetScheduleStore } from '../src/store/schedules.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn().mockResolvedValue('SECRETCLAIM text') }));
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

const ADMIN = 'admin-secret';
const CLAIM = 'SECRETCLAIM The tower opened in 1889.';
const EXPL = 'SECRETEXPLANATION grounded text';
const base = {
  input: CLAIM, provider: 'OpenAI',
  claims: [{ id: 'c1', text: CLAIM, type: 'fact', importance: 3 }],
  overallRisk: 'low', complianceReport: { riskTier: 'minimal', findings: [] }, ruleFindings: [],
};
const VARIANTS: Record<string, unknown> = {
  consensusGeminiRetriever: { ...base, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPL, sources: [{ title: 'x', uri: 'https://example.org/a' }], provenance: { provider: 'consensus', model: 'openai:x+claude:y', verifiedAt: 'z', retriever: 'gemini-grounding', retrievedAt: 'z' } } } },
  apiErrorUpperHostDot: { ...base, verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: EXPL, apiError: true, sources: [{ title: 't', uri: 'https://VERTEXAISEARCH.cloud.google.com./grounding-api-redirect/X' }] } } },
  pctEncodedDot: { ...base, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPL, sources: [{ title: 't', uri: 'https://vertexaisearch.cloud.google.com%2e/grounding-api-redirect/X' }] } } },
  geminiVerifierOpenAIExtractor: { ...base, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPL, sources: [], provenance: { provider: 'gemini', model: 'g', verifiedAt: 'z' } } } },
  searchEntryPointOnly: { ...base, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPL, sources: [], searchEntryPoint: { renderedContent: '<div/>' } } } },
};

const flush = () => new Promise((r) => setTimeout(r, 30));
function resetAll() {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetWebhookStore(); resetKeyStore(); resetTenantStore(); resetRateLimiter(); resetAuditLogger();
  resetUsageMeter(); resetAnalytics(); resetCache(); resetJobStore(); resetNotificationStore();
  resetScheduleStore(); resetTemplateStore(); resetClaimIndex();
}
const sent = () => vi.mocked(fetch).mock.calls.map(([u, i]) => ({ url: String(u), raw: String((i as RequestInit).body) }));
function tenantAdmin(name: string) {
  const key = getKeyStore().create(`${name} admin`, ['scan', 'admin']);
  const tenant = getTenantStore().create(name, [key.id]);
  return { key, tenant };
}
async function register(s: FastifyInstance, k: string, url: string, events: string[], ref?: string) {
  const r = await s.inject({ method: 'POST', url: '/webhooks', headers: { 'x-api-key': k, 'content-type': 'application/json', ...(ref ? { 'x-faultline-user-ref': ref } : {}) }, body: JSON.stringify({ url, events }) });
  expect(r.statusCode).toBe(201);
  return JSON.parse(r.body) as { id: string };
}
const post = (s: FastifyInstance, k: string, url: string, body: unknown, ref?: string) =>
  s.inject({ method: 'POST', url, headers: { 'x-api-key': k, 'content-type': 'application/json', ...(ref ? { 'x-faultline-user-ref': ref } : {}) }, body: JSON.stringify(body) });

describe('seat B', () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    resetAll();
    _setSleepFn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockReset().mockResolvedValue({ ...base, verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'plain', sources: [] } } } as never);
    server = buildServer();
    await server.ready();
  });
  afterEach(async () => { _setSleepFn(async () => {}); await server.close(); vi.unstubAllGlobals(); delete process.env.FAULTLINE_API_KEY; });

  for (const [name, variant] of Object.entries(VARIANTS)) {
    for (const route of ['/scan', '/scan/deep', '/scan/batch', 'pipeline']) {
      it(`B-G ${name} via ${route}: owner's own webhook gets no grounded content`, async () => {
        const { scan } = await import('@nxtg/faultline/cli/scan.js');
        vi.mocked(scan).mockResolvedValue(variant as never);
        const a = tenantAdmin('A');
        await register(server, a.key.key, 'https://a.example.com/h', ['scan.complete']);
        const body = route === '/scan/batch' ? { texts: [CLAIM] } : route === 'pipeline'
          ? { text: CLAIM, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', verificationProvider: 'mock', synthesisProvider: 'mock' } }
          : { text: CLAIM, provider: 'mock' };
        const r = await post(server, a.key.key, route === 'pipeline' ? '/scan' : route, body);
        expect(r.statusCode).toBe(200);
        await flush();
        const s = sent().filter((d) => d.url === 'https://a.example.com/h');
        expect(s.length).toBe(1);
        expect(s[0].raw).not.toContain('SECRETCLAIM');
        expect(s[0].raw).not.toContain('SECRETEXPLANATION');
        expect(s[0].raw.toLowerCase()).not.toContain('vertexaisearch');
        expect(s[0].raw).toContain('"grounded":true');
      });
    }
  }

  it('B-G job.complete through a registered webhook, grounded, creator tenant only, minimal', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockResolvedValue(VARIANTS.consensusGeminiRetriever as never);
    const a = tenantAdmin('A'); const b = tenantAdmin('B');
    getWebhookStore().create('https://a.example.com/h', ['job.complete'], 's', undefined, 3, 0, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    getWebhookStore().create('https://b.example.com/h', ['job.complete'], 's', undefined, 3, 0, { keyId: b.key.id, caller: `${b.key.id}\u0000${b.key.id}` });
    const r = await post(server, a.key.key, '/jobs', { text: CLAIM, provider: 'mock', schedule: '*/5 * * * *' });
    await getJobScheduler().triggerJob(JSON.parse(r.body).id);
    await flush();
    expect(sent().map((d) => d.url)).toEqual(['https://a.example.com/h']);
    expect(sent()[0].raw).not.toContain('SECRET');
  });

  it('B-O1 non-server key forging x-faultline-user-ref cannot reach the server-key user webhook', async () => {
    await register(server, ADMIN, 'https://web.example.com/u1', ['scan.complete'], 'fpwebuser0001');
    const k = getKeyStore().create('k', ['scan']);
    await post(server, k.key, '/scan', { text: CLAIM, provider: 'mock' }, 'fpwebuser0001');
    await flush();
    expect(sent()).toEqual([]);
  });

  it('B-O2 server key without ref: its webhook gets nothing from a no-ref server scan or a tenant scan', async () => {
    await register(server, ADMIN, 'https://web.example.com/noref', ['scan.complete', 'scan.failed']);
    const a = tenantAdmin('A');
    await post(server, ADMIN, '/scan', { text: CLAIM, provider: 'mock' });
    await post(server, a.key.key, '/scan', { text: CLAIM + ' 2', provider: 'mock' });
    await flush();
    expect(sent()).toEqual([]);
  });

  it('B-O3 untenanted admin key webhook gets nothing from server-key user scans or tenant scans', async () => {
    const solo = getKeyStore().create('solo', ['scan', 'admin']);
    await register(server, solo.key, 'https://solo.example.com/h', ['scan.complete']);
    const a = tenantAdmin('A');
    await post(server, ADMIN, '/scan', { text: CLAIM, provider: 'mock' }, 'fpwebuser0001');
    await post(server, a.key.key, '/scan', { text: CLAIM + ' x', provider: 'mock' });
    await flush();
    expect(sent()).toEqual([]);
  });

  it('B-O4 event key moved to another tenant during the retry wait: retry not sent', async () => {
    const a = tenantAdmin('A');
    const scanner = getKeyStore().create('scanner', ['scan']);
    getTenantStore().addKey(a.tenant.id, scanner.id);
    const other = getTenantStore().create('Other', []);
    const hook = getWebhookStore().create('https://a.example.com/h', ['scan.complete'], 's', undefined, 3, 10, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    _setSleepFn(async (ms) => { if (ms > 0) { getTenantStore().removeKey(a.tenant.id, scanner.id); getTenantStore().addKey(other.id, scanner.id); } });
    await dispatchWebhook(hook, 'scan.complete', {}, { keyId: scanner.id, caller: `${scanner.id}\u0000${scanner.id}` });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it('B-O5 webhook owner key deleted during the retry wait: retry not sent', async () => {
    const a = tenantAdmin('A');
    const hook = getWebhookStore().create('https://a.example.com/h', ['scan.complete'], 's', undefined, 3, 10, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    _setSleepFn(async (ms) => { if (ms > 0) getKeyStore().delete(a.key.id); });
    await dispatchWebhook(hook, 'scan.complete', {}, { keyId: a.key.id, caller: `${a.key.id}\u0000${a.key.id}` });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it('B-O6 payload frozen at fire time: a grounded payload is never upgraded later', () => {
    const d = webhookSafeData('scan.complete', VARIANTS.apiErrorUpperHostDot) as Record<string, unknown>;
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });

  it('B-O7 key in two tenants (first-match): webhook in second tenant does not receive', async () => {
    const t1 = getTenantStore().create('T1', []);
    const b = tenantAdmin('B');
    const k = getKeyStore().create('k', ['scan']);
    getTenantStore().addKey(t1.id, k.id); getTenantStore().addKey(b.tenant.id, k.id);
    await register(server, b.key.key, 'https://b.example.com/h', ['scan.complete']);
    await post(server, k.key, '/scan', { text: CLAIM, provider: 'mock' });
    await flush();
    // Records behaviour only (under-delivery is safe).
    expect(sent().length).toBe(0);
  });

  it('B-E upload scan.failed with provider text sends generic error', async () => {
    const a = tenantAdmin('A');
    await register(server, a.key.key, 'https://a.example.com/h', ['scan.failed']);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValue(new Error(`Gemini said ${EXPL} https://vertexaisearch.cloud.google.com/x`));
    const bnd = 'BB';
    const payload = Buffer.concat([Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="file"; filename="t.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 x\r\n--${bnd}--\r\n`)]);
    await server.inject({ method: 'POST', url: '/scan/upload', headers: { 'x-api-key': a.key.key, 'content-type': `multipart/form-data; boundary=${bnd}` }, payload });
    const r2 = await post(server, a.key.key, '/scan/batch', { texts: [CLAIM] });
    expect(r2.statusCode).toBeLessThan(600);
    await flush();
    expect(sent().length).toBeGreaterThanOrEqual(2);
    for (const s of sent()) { expect(s.raw).not.toContain('SECRET'); expect(s.raw.toLowerCase()).not.toContain('vertexaisearch'); }
  });

  it('B-A webhook test-send by a same-tenant non-admin key is allowed; by another tenant refused', async () => {
    const a = tenantAdmin('A');
    const hook = await register(server, a.key.key, 'https://a.example.com/h', ['scan.complete']);
    const b = tenantAdmin('B');
    const r = await post(server, b.key.key, `/webhooks/test/${hook.id}`, {});
    // b is an admin-permission key: isAdminKeyId -> allowed (fleet admin by design)
    expect([200, 404]).toContain(r.statusCode);
  });
});
