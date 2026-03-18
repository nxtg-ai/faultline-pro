import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn() }));

interface Claim {
  id: string;
  text: string;
  type: string;
  importance: number;
}

function makeClaim(id: string, text: string): Claim {
  return { id, text, type: 'fact', importance: 3 };
}

function makeVerification(claimId: string, status: string) {
  return { claimId, status, explanation: 'ok', sources: [] };
}

function makeScanResult(claims: Claim[], verifications: Record<string, unknown>, risk: string) {
  return { input: 'test', provider: 'mock', claims, verifications, overallRisk: risk, complianceReport: {}, ruleFindings: [] };
}

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
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

describe('POST /scan/compare', () => {
  it('1. returns 200 with identical scans', async () => {
    const claim = makeClaim('c1', 'The sky is blue');
    const ver = makeVerification('c1', 'supported');
    const scan = makeScanResult([claim], { c1: ver }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: scan, after: scan }),
    });

    expect(res.statusCode).toBe(200);
  });

  it('2. identical scans → newClaims: [], removedClaims: [], changedVerdicts: [], trustScoreDelta: 0, summary: "No change"', async () => {
    const claim = makeClaim('c1', 'The sky is blue');
    const ver = makeVerification('c1', 'supported');
    const scan = makeScanResult([claim], { c1: ver }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: scan, after: scan }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims).toEqual([]);
    expect(body.removedClaims).toEqual([]);
    expect(body.changedVerdicts).toEqual([]);
    expect(body.trustScoreDelta).toBe(0);
    expect(body.summary).toBe('No change');
  });

  it('3. claim added in after → appears in newClaims with length === 1', async () => {
    const claimBefore = makeClaim('c1', 'Claim one');
    const claimAfter1 = makeClaim('c1', 'Claim one');
    const claimAfter2 = makeClaim('c2', 'Claim two new');
    const before = makeScanResult([claimBefore], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([claimAfter1, claimAfter2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'unverified'),
    }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims.length).toBe(1);
  });

  it('4. new claim has correct text field', async () => {
    const claimBefore = makeClaim('c1', 'Claim one');
    const claimAfter1 = makeClaim('c1', 'Claim one');
    const claimAfter2 = makeClaim('c2', 'Claim two new');
    const before = makeScanResult([claimBefore], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([claimAfter1, claimAfter2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'unverified'),
    }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims[0].text).toBe('Claim two new');
  });

  it('5. claim removed from after → appears in removedClaims with length === 1', async () => {
    const c1 = makeClaim('c1', 'Claim one');
    const c2 = makeClaim('c2', 'Claim two removed');
    const before = makeScanResult([c1, c2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'supported'),
    }, 'low');
    const after = makeScanResult([makeClaim('c1', 'Claim one')], { c1: makeVerification('c1', 'supported') }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.removedClaims.length).toBe(1);
  });

  it('6. verdict change (supported → refuted) → appears in changedVerdicts with length === 1', async () => {
    const claimText = 'AI is infallible';
    const c1b = makeClaim('c1', claimText);
    const c1a = makeClaim('c1', claimText);
    const before = makeScanResult([c1b], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([c1a], { c1: makeVerification('c1', 'refuted') }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.changedVerdicts.length).toBe(1);
  });

  it('7. changed verdict has correct before and after status strings', async () => {
    const claimText = 'AI is infallible';
    const c1b = makeClaim('c1', claimText);
    const c1a = makeClaim('c1', claimText);
    const before = makeScanResult([c1b], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([c1a], { c1: makeVerification('c1', 'refuted') }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.changedVerdicts[0].before).toBe('supported');
    expect(body.changedVerdicts[0].after).toBe('refuted');
  });

  it('8. risk improved (high → low) → trustScoreDelta === -2, summary === "Risk improved"', async () => {
    const c1b = makeClaim('c1', 'some claim');
    const c1a = makeClaim('c1', 'some claim');
    const before = makeScanResult([c1b], { c1: makeVerification('c1', 'supported') }, 'high');
    const after  = makeScanResult([c1a], { c1: makeVerification('c1', 'supported') }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.trustScoreDelta).toBe(-2);
    expect(body.summary).toBe('Risk improved');
  });

  it('9. risk worsened (low → high) → trustScoreDelta === 2, summary === "Risk worsened"', async () => {
    const c1b = makeClaim('c1', 'some claim');
    const c1a = makeClaim('c1', 'some claim');
    const before = makeScanResult([c1b], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([c1a], { c1: makeVerification('c1', 'supported') }, 'high');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.trustScoreDelta).toBe(2);
    expect(body.summary).toBe('Risk worsened');
  });

  it('10. trustScoreDelta === 0 → summary === "No change"', async () => {
    const c1b = makeClaim('c1', 'some claim');
    const c1a = makeClaim('c1', 'some claim');
    const before = makeScanResult([c1b], { c1: makeVerification('c1', 'supported') }, 'medium');
    const after  = makeScanResult([c1a], { c1: makeVerification('c1', 'supported') }, 'medium');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.trustScoreDelta).toBe(0);
    expect(body.summary).toBe('No change');
  });

  it('11. multiple new claims → newClaims.length matches count', async () => {
    const before = makeScanResult([], {}, 'low');
    const after  = makeScanResult(
      [makeClaim('c1', 'First new claim'), makeClaim('c2', 'Second new claim'), makeClaim('c3', 'Third new claim')],
      {
        c1: makeVerification('c1', 'supported'),
        c2: makeVerification('c2', 'unverified'),
        c3: makeVerification('c3', 'refuted'),
      },
      'medium',
    );

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims.length).toBe(3);
  });

  it('12. claim matching is case-insensitive (same claim text with different casing treated as same claim)', async () => {
    const claimBefore = makeClaim('c1', 'The sky is blue');
    const claimAfter  = makeClaim('c1', 'the sky is blue');
    const before = makeScanResult([claimBefore], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([claimAfter],  { c1: makeVerification('c1', 'supported') }, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims).toEqual([]);
    expect(body.removedClaims).toEqual([]);
  });

  it('13. POST /scan/compare without api-key → 401', async () => {
    const scan = makeScanResult([], {}, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: scan, after: scan }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('14. POST /scan/compare missing after field → 400', async () => {
    const scan = makeScanResult([], {}, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: scan }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('15. POST /scan/compare missing before field → 400', async () => {
    const scan = makeScanResult([], {}, 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compare',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ after: scan }),
    });

    expect(res.statusCode).toBe(400);
  });
});
