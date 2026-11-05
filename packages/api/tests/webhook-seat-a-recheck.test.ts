/** Seat A (transcript-blind Opus) recheck fixtures on 20dbfa0, adopted into the suite. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { buildServer } from '../src/server.js';
import { resetWebhookStore, _setSleepFn, GENERIC_SCAN_ERROR } from '../src/store/webhooks.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetTenantStore } from '../src/store/tenants.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import { getScheduleStore, getScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';
import { getBulkJobStore, resetBulkJobStore } from '../src/store/bulk-jobs.js';
import type { FastifyInstance } from 'fastify';

const CLAIM_TEXT = 'The Eiffel Tower was completed in 1889.';
const EXPLANATION = 'Multiple sources confirm completion in March 1889.';
const GROUNDING_URI = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf';
const PLAIN = {
  input: CLAIM_TEXT, provider: 'mock',
  claims: [{ id: 'c1', text: CLAIM_TEXT, type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPLANATION, sources: [] } },
  overallRisk: 'high', complianceReport: { riskTier: 'minimal', findings: [] }, ruleFindings: [],
};
const GROUNDED = {
  ...PLAIN, provider: 'Google Gemini',
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPLANATION, sources: [{ title: 't', uri: GROUNDING_URI }] } },
};

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));

const ADMIN = 'admin-secret';
const flush = () => new Promise((r) => setTimeout(r, 50));
const posts = (url: string) => vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === url);

describe('review-a recheck 20dbfa0', () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    resetWebhookStore(); resetKeyStore(); resetTenantStore(); resetRateLimiter();
    resetNotificationStore(); resetScheduleStore(); resetBulkJobStore();
    _setSleepFn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockReset().mockResolvedValue(PLAIN as never);
    server = buildServer();
    await server.ready();
  });
  afterEach(async () => { await server.close(); vi.unstubAllGlobals(); delete process.env.FAULTLINE_API_KEY; });

  it('RA-D1. bulk progress: no key 401, other key 404, creator 200, admin 200, legacy ownerless job 404 for non-admin', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    const zip = new AdmZip(); zip.addFile('doc.txt', Buffer.from(CLAIM_TEXT));
    const boundary = '----x';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="a.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      zip.toBuffer(), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = await server.inject({ method: 'POST', url: '/scan/bulk?provider=mock', headers: { 'x-api-key': a.key, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(created.statusCode).toBe(202);
    const id = JSON.parse(created.body).jobId;
    const get = (h: Record<string, string>) => server.inject({ method: 'GET', url: `/jobs/${id}/progress`, headers: h });
    expect((await get({})).statusCode).toBe(401);
    const other = await get({ 'x-api-key': b.key });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain('doc.txt');
    expect((await get({ 'x-api-key': a.key })).statusCode).toBe(200);
    expect((await get({ 'x-api-key': ADMIN })).statusCode).toBe(200);
    const legacy = getBulkJobStore().create(1);
    const leg = await server.inject({ method: 'GET', url: `/jobs/${legacy.id}/progress`, headers: { 'x-api-key': a.key } });
    expect(leg.statusCode).toBe(404);
  });

  function schedule(keyId: string) {
    return getScheduleStore().create({ name: 'nightly', cron: '0 9 * * *', text: CLAIM_TEXT, webhookUrl: 'https://a.example.com/s' } as never, keyId);
  }

  it.each(['deleted', 'disabled', 'expired'])('RA-S1. schedule webhookUrl of a %s key gets no POST', async (state) => {
    const a = getKeyStore().create('A', ['scan']);
    const s = schedule(a.id);
    if (state === 'deleted') getKeyStore().delete(a.id);
    if (state === 'disabled') getKeyStore().validateById(a.id)!.disabled = true;
    if (state === 'expired') getKeyStore().validateById(a.id)!.expiresAt = '2020-01-01T00:00:00.000Z';
    await getScheduleRunner().runSchedule(s);
    await flush();
    expect(posts('https://a.example.com/s')).toEqual([]);
  });

  it('RA-S2. grounded run: no overallRisk, no claim text, no notifyEmail; plain run keeps overallRisk', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const s = schedule(a.id);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockResolvedValue(GROUNDED as never);
    await getScheduleRunner().runSchedule(s);
    await flush();
    const p = posts('https://a.example.com/s');
    expect(p.length).toBe(1);
    const body = JSON.parse(String((p[0][1] as RequestInit).body));
    expect(body.grounded).toBe(true);
    expect(body).not.toHaveProperty('overallRisk');
    expect(body).not.toHaveProperty('notifyEmail');
    expect(JSON.stringify(body)).not.toContain(EXPLANATION);
    expect(JSON.stringify(body)).not.toContain('vertexaisearch');
    expect((p[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('RA-S3. failed run with provider text: generic error to the schedule webhook', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const s = schedule(a.id);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValue(new Error(`model said ${EXPLANATION} ${GROUNDING_URI}`));
    await getScheduleRunner().runSchedule(s);
    await flush();
    const p = posts('https://a.example.com/s');
    expect(p.length).toBe(1);
    expect(JSON.parse(String((p[0][1] as RequestInit).body)).error).toBe(GENERIC_SCAN_ERROR);
  });

  it('RA-S4. a redirecting schedule webhook is POSTed once and the Location is never requested', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const s = schedule(a.id);
    vi.mocked(fetch).mockImplementation(async (u) => String(u) === 'https://a.example.com/s'
      ? new Response(null, { status: 307, headers: { location: 'https://evil.example.org/x' } })
      : new Response('ok', { status: 200 }));
    await getScheduleRunner().runSchedule(s);
    await flush();
    expect(posts('https://a.example.com/s').length).toBe(1);
    expect(posts('https://evil.example.org/x').length).toBe(0);
  });

  it('RA-S5. another key cannot PATCH a schedule to point its webhookUrl elsewhere', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    const s = schedule(a.id);
    const r = await server.inject({ method: 'PATCH', url: `/schedules/${s.id}`, headers: { 'x-api-key': b.key, 'content-type': 'application/json' }, body: JSON.stringify({ webhookUrl: 'https://evil.example.org/h' }) });
    expect(r.statusCode).not.toBe(200);
    expect(getScheduleStore().get(s.id)?.webhookUrl).toBe('https://a.example.com/s');
  });
});
