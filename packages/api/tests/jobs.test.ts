import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getJobStore, getJobScheduler, resetJobStore, resetJobScheduler, parseIntervalMs } from '../src/store/jobs.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

const mockFetch = vi.fn();

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(),
}));

const SCAN_RESULT = {
  input: 'AI test claim',
  provider: 'mock',
  claims: [{ id: 'c1', text: 'test', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] } },
  overallRisk: 'low',
  complianceReport: {},
  ruleFindings: [],
};

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = 'admin';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  resetCache();
  resetCircuitBreaker();
  resetJobStore();
  resetJobScheduler();
  vi.mocked(scan).mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(scan).mockResolvedValue(SCAN_RESULT as any);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
  delete process.env.FAULTLINE_API_KEY;
});

const hdrs = () => ({ 'x-api-key': 'admin', 'content-type': 'application/json' });

describe('POST /jobs', () => {
  it('J1. POST /jobs → 201 with valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('J2. Response has id, text, schedule, nextRunAt, status active, runCount 0', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
    });
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.text).toBe('AI generated claim');
    expect(body.schedule).toBe('*/5 * * * *');
    expect(body.nextRunAt).toBeDefined();
    expect(body.status).toBe('active');
    expect(body.runCount).toBe(0);
  });

  it('J3. nextRunAt is a valid ISO string (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
    });
    const { nextRunAt } = JSON.parse(res.body);
    expect(new Date(nextRunAt).toISOString()).toBe(nextRunAt);
  });

  it('J4. POST /jobs with missing text → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ schedule: '*/5 * * * *' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('J5. POST /jobs with missing schedule → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ text: 'AI generated claim' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /jobs', () => {
  it('J6. GET /jobs → 200 returns empty array initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/jobs', headers: hdrs() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('J7. GET /jobs → 200 after create returns array with length 1 (Gate 2)', async () => {
    await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
    });
    const res = await server.inject({ method: 'GET', url: '/jobs', headers: hdrs() });
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('J8. GET /jobs entry has correct text and schedule', async () => {
    await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: hdrs(),
      body: JSON.stringify({ text: 'My specific claim', schedule: '*/10 * * * *' }),
    });
    const res = await server.inject({ method: 'GET', url: '/jobs', headers: hdrs() });
    const list = JSON.parse(res.body);
    expect(list[0].text).toBe('My specific claim');
    expect(list[0].schedule).toBe('*/10 * * * *');
  });
});

describe('DELETE /jobs', () => {
  it('J9. DELETE /jobs/:id → 204', async () => {
    const created = JSON.parse(
      (await server.inject({
        method: 'POST',
        url: '/jobs',
        headers: hdrs(),
        body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
      })).body,
    );
    const res = await server.inject({
      method: 'DELETE',
      url: `/jobs/${created.id}`,
      headers: { 'x-api-key': 'admin' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('J10. After delete, GET /jobs returns empty array', async () => {
    const created = JSON.parse(
      (await server.inject({
        method: 'POST',
        url: '/jobs',
        headers: hdrs(),
        body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
      })).body,
    );
    await server.inject({ method: 'DELETE', url: `/jobs/${created.id}`, headers: { 'x-api-key': 'admin' } });
    const res = await server.inject({ method: 'GET', url: '/jobs', headers: hdrs() });
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('J11. DELETE /jobs/nonexistent → 404', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/jobs/nonexistent-id',
      headers: { 'x-api-key': 'admin' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBeDefined();
  });
});

describe('Auth', () => {
  it('J12. POST /jobs without api-key → 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'AI generated claim', schedule: '*/5 * * * *' }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Scheduler', () => {
  it('J13. triggerJob(id) — scan called once', async () => {
    const job = getJobStore().create({ text: 'AI claim', schedule: '*/5 * * * *' });
    await getJobScheduler().triggerJob(job.id);
    expect(vi.mocked(scan)).toHaveBeenCalledTimes(1);
  });

  it('J14. After triggerJob, job.lastRunAt is not null (Gate 2)', async () => {
    const job = getJobStore().create({ text: 'AI claim', schedule: '*/5 * * * *' });
    await getJobScheduler().triggerJob(job.id);
    const updated = getJobStore().get(job.id);
    expect(updated?.lastRunAt).not.toBeNull();
  });

  it('J15. After triggerJob, job.runCount === 1 (Gate 2 — exact count)', async () => {
    const job = getJobStore().create({ text: 'AI claim', schedule: '*/5 * * * *' });
    await getJobScheduler().triggerJob(job.id);
    const updated = getJobStore().get(job.id);
    expect(updated?.runCount).toBe(1);
  });

  it('J16. After triggerJob with webhookUrl set — mockFetch called with the webhookUrl', async () => {
    vi.stubGlobal('fetch', mockFetch);
    const job = getJobStore().create({
      text: 'AI claim',
      schedule: '*/5 * * * *',
      webhookUrl: 'https://example.com/job-hook',
    });
    await getJobScheduler().triggerJob(job.id);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/job-hook',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('parseIntervalMs', () => {
  it('J17. parseIntervalMs("*/5 * * * *") returns 5 * 60_000', () => {
    expect(parseIntervalMs('*/5 * * * *')).toBe(5 * 60_000);
  });

  it('J18. parseIntervalMs("* * * * *") returns 60_000', () => {
    expect(parseIntervalMs('* * * * *')).toBe(60_000);
  });
});
