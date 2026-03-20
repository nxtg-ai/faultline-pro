import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { buildServer } from '../src/server.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getBulkJobStore, resetBulkJobStore } from '../src/store/bulk-jobs.js';
import { resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(),
}));

const SCAN_RESULT = {
  input: 'test claim text',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'claim one', type: 'fact', importance: 3 },
    { id: 'c2', text: 'claim two', type: 'fact', importance: 2 },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] },
    c2: { claimId: 'c2', status: 'unverified', explanation: 'no source', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: {},
  ruleFindings: [],
};

const HIGH_RISK_RESULT = {
  ...SCAN_RESULT,
  overallRisk: 'high',
};

// Build a test ZIP buffer with two .txt files
function makeZipBuffer(files: { name: string; content: string }[]): Buffer {
  const zip = new AdmZip();
  for (const f of files) {
    zip.addFile(f.name, Buffer.from(f.content));
  }
  return zip.toBuffer();
}

// Build a multipart body with the archive field
function makeMultipartBody(
  boundary: string,
  zipBuffer: Buffer,
): Buffer {
  const crlf = '\r\n';
  return Buffer.concat([
    Buffer.from(
      `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="archive"; filename="test.zip"${crlf}` +
        `Content-Type: application/zip${crlf}${crlf}`,
    ),
    zipBuffer,
    Buffer.from(`${crlf}--${boundary}--${crlf}`),
  ]);
}

const BOUNDARY = 'TestBulkBoundary9876';

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = 'test-key';
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
  resetBulkJobStore();
  vi.mocked(scan).mockReset();
  vi.mocked(scan).mockResolvedValue(SCAN_RESULT as never);
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
  delete process.env.FAULTLINE_API_KEY;
});

const authHeaders = () => ({
  'x-api-key': 'test-key',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
});

// ─── HTTP endpoint tests ───────────────────────────────────────────────────

describe('POST /scan/bulk', () => {
  it('BK1: returns 202 with a jobId', async () => {
    const zipBuffer = makeZipBuffer([
      { name: 'doc1.txt', content: 'The moon landing happened in 1969.' },
      { name: 'doc2.txt', content: 'Chocolate improves cognition.' },
    ]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    const json = res.json<{ jobId: string }>();
    expect(typeof json.jobId).toBe('string');
    expect(json.jobId.length).toBeGreaterThan(0);
  });

  it('BK4: job starts as pending or running immediately after POST', async () => {
    const zipBuffer = makeZipBuffer([
      { name: 'a.txt', content: 'AI generated text here.' },
    ]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    const job = getBulkJobStore().get(jobId);
    expect(job).toBeDefined();
    expect(['pending', 'running', 'done']).toContain(job!.status);
  });

  it('BK11: returns 401 without api key', async () => {
    const zipBuffer = makeZipBuffer([{ name: 'doc.txt', content: 'hello' }]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });

  it('BK12: empty ZIP creates job with done status and 0 totalFiles', async () => {
    const zip = new AdmZip();
    const zipBuffer = zip.toBuffer();
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();

    // Wait for any background work to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    const progressRes = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = progressRes.json<{ status: string; totalFiles: number }>();
    expect(job.status).toBe('done');
    expect(job.totalFiles).toBe(0);
  });
});

describe('GET /jobs/:id/progress', () => {
  it('BK2: returns job with status/totalFiles/processedFiles/progressPercent', async () => {
    const zipBuffer = makeZipBuffer([
      { name: 'file1.txt', content: 'Some claim.' },
    ]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });

    expect(res.statusCode).toBe(200);
    const job = res.json<{
      status: string;
      totalFiles: number;
      processedFiles: number;
      progressPercent: number;
    }>();
    expect(typeof job.status).toBe('string');
    expect(typeof job.totalFiles).toBe('number');
    expect(typeof job.processedFiles).toBe('number');
    expect(typeof job.progressPercent).toBe('number');
  });

  it('BK3: returns 404 for unknown job id', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/jobs/does-not-exist/progress',
    });
    expect(res.statusCode).toBe(404);
  });

  it('BK5: after processing completes, job status is done', async () => {
    const zipBuffer = makeZipBuffer([
      { name: 'doc1.txt', content: 'The moon landing happened in 1969.' },
      { name: 'doc2.txt', content: 'Chocolate improves cognition.' },
    ]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{ status: string }>();
    expect(job.status).toBe('done');
  });

  it('BK6: results array has one entry per file in ZIP', async () => {
    const zipBuffer = makeZipBuffer([
      { name: 'a.txt', content: 'Claim A.' },
      { name: 'b.txt', content: 'Claim B.' },
    ]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{ results: unknown[] }>();
    expect(job.results).toHaveLength(2);
  });

  it('BK7: progressPercent is between 0 and 100', async () => {
    const zipBuffer = makeZipBuffer([{ name: 'x.md', content: 'Some markdown claim.' }]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{ progressPercent: number }>();
    expect(job.progressPercent).toBeGreaterThanOrEqual(0);
    expect(job.progressPercent).toBeLessThanOrEqual(100);
  });

  it('BK8: summary.overallTrustScore is a number between 0 and 100', async () => {
    const zipBuffer = makeZipBuffer([{ name: 'doc.txt', content: 'A claim.' }]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{ summary: { overallTrustScore: number } }>();
    expect(typeof job.summary.overallTrustScore).toBe('number');
    expect(job.summary.overallTrustScore).toBeGreaterThanOrEqual(0);
    expect(job.summary.overallTrustScore).toBeLessThanOrEqual(100);
  });

  it('BK9: summary.worstOffenders is an array', async () => {
    vi.mocked(scan).mockResolvedValue(HIGH_RISK_RESULT as never);

    const zipBuffer = makeZipBuffer([
      { name: 'risky.txt', content: 'Highly risky claim.' },
    ]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{ summary: { worstOffenders: unknown[] } }>();
    expect(Array.isArray(job.summary.worstOffenders)).toBe(true);
  });

  it('BK10: summary.riskDistribution has risk-level keys', async () => {
    const zipBuffer = makeZipBuffer([{ name: 'doc.txt', content: 'A claim.' }]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{ summary: { riskDistribution: Record<string, number> } }>();
    const keys = Object.keys(job.summary.riskDistribution);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(['low', 'medium', 'high', 'critical']).toContain(k);
    }
  });

  it('BK13: results entries have filename, status, overallRisk fields', async () => {
    const zipBuffer = makeZipBuffer([{ name: 'test.txt', content: 'A simple claim.' }]);
    const body = makeMultipartBody(BOUNDARY, zipBuffer);

    const postRes = await server.inject({
      method: 'POST',
      url: '/scan/bulk',
      headers: authHeaders(),
      payload: body,
    });
    const { jobId } = postRes.json<{ jobId: string }>();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await server.inject({
      method: 'GET',
      url: `/jobs/${jobId}/progress`,
    });
    const job = res.json<{
      results: Array<{ filename: string; status: string; overallRisk?: string }>;
    }>();
    expect(job.results.length).toBeGreaterThan(0);
    const first = job.results[0];
    expect(typeof first.filename).toBe('string');
    expect(typeof first.status).toBe('string');
    expect(typeof first.overallRisk).toBe('string');
  });
});

// ─── BulkJobStore unit tests ───────────────────────────────────────────────

describe('BulkJobStore unit tests', () => {
  it('BK14: recordFileResult increments processedFiles', () => {
    resetBulkJobStore();
    const store = getBulkJobStore();
    const job = store.create(3);
    expect(job.processedFiles).toBe(0);

    store.recordFileResult(job.id, { filename: 'a.txt', status: 'done', overallRisk: 'low' });
    expect(store.get(job.id)!.processedFiles).toBe(1);

    store.recordFileResult(job.id, { filename: 'b.txt', status: 'done', overallRisk: 'medium' });
    expect(store.get(job.id)!.processedFiles).toBe(2);
  });

  it('BK15: complete sets completedAt', () => {
    resetBulkJobStore();
    const store = getBulkJobStore();
    const job = store.create(1);
    store.recordFileResult(job.id, { filename: 'a.txt', status: 'done', overallRisk: 'low' });
    store.complete(job.id);

    const completed = store.get(job.id)!;
    expect(completed.status).toBe('done');
    expect(typeof completed.completedAt).toBe('string');
    expect(completed.completedAt!.length).toBeGreaterThan(0);
  });
});
