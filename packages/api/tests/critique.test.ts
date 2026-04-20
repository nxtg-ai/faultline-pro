// Validates: N-222 (POST /critique — critique and improved-prompt endpoint)
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
import { buildCritiqueAnalysis, extractFailedClaims, FAILED_STATUSES } from '../src/routes/critique.js';
import type { FastifyInstance } from 'fastify';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn() }));

function makeClaim(id: string, text = 'Some claim text'): Claim {
  return { id, text, type: 'fact', importance: 3 };
}

function makeVerification(claimId: string, status: VerificationResult['status']): VerificationResult {
  return { claimId, status, explanation: 'test', sources: [] };
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

describe('FAILED_STATUSES / extractFailedClaims (unit)', () => {
  it('FAILED_STATUSES contains contradicted, mixed, unverified but not supported or skipped', () => {
    expect(FAILED_STATUSES.has('contradicted')).toBe(true);
    expect(FAILED_STATUSES.has('mixed')).toBe(true);
    expect(FAILED_STATUSES.has('unverified')).toBe(true);
    expect(FAILED_STATUSES.has('supported')).toBe(false);
    expect(FAILED_STATUSES.has('skipped')).toBe(false);
  });

  it('extractFailedClaims excludes claims with no verification entry', () => {
    const claims = [makeClaim('c1'), makeClaim('c2')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'contradicted'),
      // c2 has no verification entry
    };
    const result = extractFailedClaims(claims, verifications);
    expect(result.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('buildCritiqueAnalysis (unit)', () => {
  it('CT1: all claims supported → hasCritique: false, empty strings', () => {
    const claims = [makeClaim('c1'), makeClaim('c2')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'supported'),
    };

    const result = buildCritiqueAnalysis(claims, verifications, { critique: '', improvedPrompt: '' });

    expect(result.hasCritique).toBe(false);
    expect(result.critique).toBe('');
    expect(result.improvedPrompt).toBe('');
    expect(result.failedCount).toBe(0);
  });

  it('CT2: one failed claim → hasCritique: true, failedCount: 1', () => {
    const claims = [makeClaim('c1'), makeClaim('c2')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
    };

    const result = buildCritiqueAnalysis(
      claims, verifications,
      { critique: 'c2 is wrong', improvedPrompt: 'Fix c2' },
    );

    expect(result.hasCritique).toBe(true);
    expect(result.failedCount).toBe(1);
  });

  it('CT3: totalVerified is count of all keys in verifications (Object.keys)', () => {
    const claims = [
      makeClaim('c1'), makeClaim('c2'), makeClaim('c3'), makeClaim('c4'), makeClaim('c5'),
    ];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
      c3: makeVerification('c3', 'mixed'),
      c4: makeVerification('c4', 'unverified'),
      c5: makeVerification('c5', 'skipped'),
    };

    const result = buildCritiqueAnalysis(
      claims, verifications,
      { critique: 'some critique', improvedPrompt: 'improved' },
    );

    // totalVerified = Object.keys(verifications).length = 5 (all entries, regardless of status)
    expect(result.totalVerified).toBe(5);
  });

  it('CT4: failedClaims excludes supported claims; includes contradicted and unverified', () => {
    const claims = [makeClaim('c1'), makeClaim('c2'), makeClaim('c3')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
      c3: makeVerification('c3', 'unverified'),
    };

    const result = buildCritiqueAnalysis(
      claims, verifications,
      { critique: 'failures', improvedPrompt: 'fix them' },
    );

    const ids = result.failedClaims.map((c) => c.id);
    expect(ids).not.toContain('c1');
    expect(ids).toContain('c2');
    expect(ids).toContain('c3');
  });

  it('CT5: critiqueResult strings pass through to response unchanged', () => {
    const claims = [makeClaim('c1')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'contradicted'),
    };

    const result = buildCritiqueAnalysis(
      claims, verifications,
      { critique: 'Specific critique content', improvedPrompt: 'Specific improved prompt' },
    );

    expect(result.critique).toBe('Specific critique content');
    expect(result.improvedPrompt).toBe('Specific improved prompt');
  });

  it('CT8: failedCount matches failedClaims.length', () => {
    const claims = [makeClaim('c1'), makeClaim('c2'), makeClaim('c3')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'contradicted'),
      c2: makeVerification('c2', 'mixed'),
      c3: makeVerification('c3', 'supported'),
    };

    const result = buildCritiqueAnalysis(
      claims, verifications,
      { critique: 'critique text', improvedPrompt: 'improved' },
    );

    expect(result.failedCount).toBe(result.failedClaims.length);
  });

  it('CT9: skipped claims are not in failedClaims (outside FAILED_STATUSES)', () => {
    const claims = [makeClaim('c1'), makeClaim('c2')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'skipped'),
      c2: makeVerification('c2', 'supported'),
    };

    const result = buildCritiqueAnalysis(claims, verifications, { critique: '', improvedPrompt: '' });

    expect(result.failedClaims).toHaveLength(0);
    expect(result.hasCritique).toBe(false);
  });
});

describe('POST /critique (HTTP)', () => {
  it('CT6: returns 200 with mock provider and correct critique text', async () => {
    const claims = [makeClaim('c1'), makeClaim('c2')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
    };

    const res = await server.inject({
      method: 'POST',
      url: '/critique',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ claims, verifications, text: 'Some AI text', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasCritique).toBe(true);
    expect(body.critique).toBe('Mock assessment: stable.');
    expect(body.improvedPrompt).toBe('No changes needed.');
  });

  it('CT7: missing text field → 400', async () => {
    const claims = [makeClaim('c1')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'contradicted'),
    };

    const res = await server.inject({
      method: 'POST',
      url: '/critique',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ claims, verifications }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without api-key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/critique',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [], verifications: {}, text: 'test' }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('all claims supported via HTTP → hasCritique: false, totalVerified = verifications count', async () => {
    const claims = [makeClaim('c1')];
    const verifications: Record<string, VerificationResult> = {
      c1: makeVerification('c1', 'supported'),
    };

    const res = await server.inject({
      method: 'POST',
      url: '/critique',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ claims, verifications, text: 'Some text', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasCritique).toBe(false);
    expect(body.critique).toBe('');
    expect(body.improvedPrompt).toBe('');
    expect(body.totalVerified).toBe(1);
  });
});
