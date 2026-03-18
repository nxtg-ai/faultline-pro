/**
 * E2E Smoke Test — Full API Surface
 *
 * Exercises the complete enterprise API flow in sequence:
 * create key → scan → batch → upload → report → usage → audit →
 * webhook registration + dispatch → rate limit enforcement → teardown
 *
 * One shared server instance. State (keyId, webhookId) flows between tests.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter, setCustomLimit } from '../src/store/ratelimit.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'AI generated the universe in 2023.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'AI generated the universe in 2023.', type: 'fact', importance: 4 }],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [{ title: 'Source A', url: 'https://example.com' }] },
    },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [], euRiskSummary: { totalClaims: 1, highestTier: 'minimal', unacceptable: 0, high: 0, limited: 0, minimal: 1 } },
    ruleFindings: [],
  }),
}));

vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: vi.fn().mockResolvedValue('AI generated the universe in 2023.'),
}));

// ─── Multipart helper (reused from upload.test.ts pattern) ─────────────────

const BOUNDARY = 'E2EBoundary99';

function buildMultipart(
  boundary: string,
  file: { fieldname: string; filename: string; mimetype: string; data: Buffer },
): Buffer {
  const crlf = '\r\n';
  return Buffer.concat([
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"${crlf}Content-Type: ${file.mimetype}${crlf}${crlf}`),
    file.data,
    Buffer.from(`${crlf}--${boundary}--${crlf}`),
  ]);
}

function fakePdfPayload() {
  return buildMultipart(BOUNDARY, {
    fieldname: 'file',
    filename: 'smoke.pdf',
    mimetype: 'application/pdf',
    data: Buffer.from('%PDF-1.4 smoke test content'),
  });
}

// ─── Shared state ──────────────────────────────────────────────────────────

let server: FastifyInstance;
let scanKeyId: string;
let scanKeySecret: string;
let webhookId: string;

const ADMIN = 'admin-secret';
const JSON_HDR = { 'content-type': 'application/json' };

function adminHeaders() {
  return { 'x-api-key': ADMIN, ...JSON_HDR };
}

function scanHeaders() {
  return { 'x-api-key': scanKeySecret, ...JSON_HDR };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  resetCache();
  server = buildServer();
  await server.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

// ─── Flow ──────────────────────────────────────────────────────────────────

describe('E2E smoke — full API surface', () => {

  it('S1. GET /health → 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('S2. POST /keys → 201, captures scan-only key', async () => {
    const res = await server.inject({
      method: 'POST', url: '/keys',
      headers: adminHeaders(),
      body: JSON.stringify({ name: 'smoke-key', permissions: ['scan'] }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.key).toMatch(/^[0-9a-f]{64}$/);
    scanKeyId = body.id;
    scanKeySecret = body.key;
  });

  it('S3. GET /keys → 200, list includes new key (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys', headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((k: { id: string }) => k.id === scanKeyId)).toBe(true);
  });

  it('S4. POST /scan with scan-only key → 200', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: scanHeaders(),
      body: JSON.stringify({ text: 'AI generated the universe in 2023.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
    expect(body.claims.length).toBeGreaterThan(0); // Gate 2
  });

  it('S5. POST /scan/batch with 2 texts → 200, total=2, succeeded=2', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/batch',
      headers: scanHeaders(),
      body: JSON.stringify({ texts: ['Claim one.', 'Claim two.'], provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results.length).toBe(2); // Gate 2
    expect(body.results[0].overallRisk).toBeDefined();
  });

  it('S6. POST /scan/upload with mock PDF → 200', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/upload',
      headers: {
        'x-api-key': scanKeySecret,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: fakePdfPayload(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
  });

  it('S7. POST /scan/report → 200, content-type application/pdf', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report',
      headers: scanHeaders(),
      body: JSON.stringify({ text: 'AI generated the universe in 2023.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.length).toBeGreaterThan(100); // Gate 2: actual PDF bytes
  });

  it('S8. GET /usage → 200, count > 0 after scans (Gate 2)', async () => {
    const res = await server.inject({
      method: 'GET', url: '/usage',
      headers: scanHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keyId).toBe(scanKeyId);
    const today = new Date().toISOString().split('T')[0];
    expect(body.usage[today]).toBeGreaterThan(0);
  });

  it('S9. GET /dashboard → 200, scans.today > 0 (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/dashboard', headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scans.today).toBeGreaterThan(0);
    expect(body.riskDistribution).toBeDefined();
  });

  it('S10. Audit log has entries from prior scans (Gate 2)', () => {
    const entries = getAuditLogger().getEntries();
    expect(entries.length).toBeGreaterThan(0);
    const scanEntry = entries.find(e => e.endpoint === '/scan');
    expect(scanEntry).toBeDefined();
    expect(scanEntry!.statusCode).toBe(200);
    expect(scanEntry!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('S11. POST /webhooks → 201, captures webhookId', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: adminHeaders(),
      body: JSON.stringify({ url: 'https://ci.example.com/hook', events: ['scan.complete'], secret: 'smoke-secret' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    webhookId = body.id;
  });

  it('S12. GET /webhooks → 200, list includes registered webhook (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks', headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((w: { id: string }) => w.id === webhookId)).toBe(true);
    expect(list[0].secret).toBeUndefined(); // secret stripped from list
  });

  it('S13. POST /scan fires webhook → fetch called with correct event', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await server.inject({
      method: 'POST', url: '/scan',
      headers: scanHeaders(),
      body: JSON.stringify({ text: 'Webhook trigger scan.', provider: 'mock' }),
    });

    // Give fire-and-forget dispatch time to complete.
    // dispatchWebhook calls _sleep(0) = setTimeout(0) before fetch; setImmediate
    // fires before setTimeout, so we must wait past the setTimeout queue.
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ci.example.com/hook');
    const payload = JSON.parse(init.body as string);
    expect(payload.event).toBe('scan.complete');
    expect(init.headers).toHaveProperty('X-Faultline-Signature');
    vi.unstubAllGlobals();
  });

  it('S14. DELETE /webhooks/:id → 204', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `/webhooks/${webhookId}`,
      headers: { 'x-api-key': ADMIN },
    });
    expect(res.statusCode).toBe(204);
  });

  it('S15. Rate limit: 429 when quota exhausted', async () => {
    setCustomLimit(scanKeyId, 0);
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: scanHeaders(),
      body: JSON.stringify({ text: 'Over limit.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('S16. DELETE /keys/:id → 204', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `/keys/${scanKeyId}`,
      headers: { 'x-api-key': ADMIN },
    });
    expect(res.statusCode).toBe(204);
  });

  it('S17. Deleted key → 401 on subsequent scan', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: scanHeaders(),
      body: JSON.stringify({ text: 'Should fail.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('S18. Admin key still works after deleting child key', async () => {
    const res = await server.inject({
      method: 'GET', url: '/keys',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});
