// Validates: N-222 (POST /weakest — weakest-link analysis endpoint)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { vi } from 'vitest';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import { analyzeWeakestLinks, weakestRoutes } from '../src/routes/weakest.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn() }));

interface Claim {
  id: string;
  text: string;
  type: string;
  importance: number;
}

function makeClaim(id: string, text: string, importance = 3): Claim {
  return { id, text, type: 'fact', importance };
}

type ClaimStatus = 'supported' | 'contradicted' | 'mixed' | 'unverified' | 'loading' | 'skipped';

function makeVerification(claimId: string, status: ClaimStatus) {
  return { claimId, status, explanation: 'ok', sources: [] };
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
  server = Fastify({ logger: false });
  server.register(weakestRoutes);
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

describe('analyzeWeakestLinks — unit tests', () => {
  it('WK1: empty claims → weakestClaim null, rankedClaims empty, strengthScore 1, argumentStrength resilient, correct summary', () => {
    const result = analyzeWeakestLinks([], {}, {});
    expect(result.weakestClaim).toBeNull();
    expect(result.rankedClaims).toEqual([]);
    expect(result.strengthScore).toBe(1);
    expect(result.argumentStrength).toBe('resilient');
    expect(result.summary).toBe('No verified claims to analyze.');
  });

  it('WK2: single supported claim → fragilityScore < 0.3, argumentStrength resilient', () => {
    const claim = makeClaim('c1', 'The sky is blue');
    const ver = makeVerification('c1', 'supported');
    const result = analyzeWeakestLinks([claim], { c1: ver }, {});
    expect(result.rankedClaims[0].fragilityScore).toBeLessThan(0.3);
    expect(result.argumentStrength).toBe('resilient');
  });

  it('WK3: high-importance contradicted claim → fragilityScore ~0.8, argumentStrength critical', () => {
    const claim = makeClaim('c1', 'The moon is made of cheese', 5);
    const ver = makeVerification('c1', 'contradicted');
    const result = analyzeWeakestLinks([claim], { c1: ver }, {});
    // (1.0*0.6 + 0.5*0.4) * (5/5) = 0.8
    expect(result.rankedClaims[0].fragilityScore).toBeCloseTo(0.8, 5);
    expect(result.argumentStrength).toBe('critical');
  });

  it('WK4: mixed claims → weakestClaim is the contradicted one', () => {
    const c1 = makeClaim('c1', 'Supported claim');
    const c2 = makeClaim('c2', 'Contradicted claim');
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
    };
    const result = analyzeWeakestLinks([c1, c2], verifications, {});
    expect(result.weakestClaim?.claimId).toBe('c2');
  });

  it('WK5: importance 5 contradicted → higher fragilityScore than importance 1 contradicted', () => {
    const lowImportance = makeClaim('c1', 'Low importance', 1);
    const highImportance = makeClaim('c2', 'High importance', 5);
    const verifications = {
      c1: makeVerification('c1', 'contradicted'),
      c2: makeVerification('c2', 'contradicted'),
    };
    const result = analyzeWeakestLinks([lowImportance, highImportance], verifications, {});
    const low = result.rankedClaims.find((c: { claimId: string }) => c.claimId === 'c1')!;
    const high = result.rankedClaims.find((c: { claimId: string }) => c.claimId === 'c2')!;
    expect(high.fragilityScore).toBeGreaterThan(low.fragilityScore);
  });

  it('WK6: claim with high-confidence mapping has lower fragilityScore than default-confidence claim', () => {
    const c1 = makeClaim('c1', 'High-confidence contradicted claim', 3);
    const c2 = makeClaim('c2', 'Default-confidence contradicted claim', 3);
    const verifications = {
      c1: makeVerification('c1', 'contradicted'),
      c2: makeVerification('c2', 'contradicted'),
    };
    const complianceReport = {
      claimMappings: [{ claimId: 'c1', confidenceScore: 0.9 }],
    };
    const result = analyzeWeakestLinks([c1, c2], verifications, complianceReport);
    const highConf = result.rankedClaims.find((c: { claimId: string }) => c.claimId === 'c1')!;
    const defaultConf = result.rankedClaims.find((c: { claimId: string }) => c.claimId === 'c2')!;
    // c1: (1.0*0.6 + 0.1*0.4)*0.6 = 0.384; c2: (1.0*0.6 + 0.5*0.4)*0.6 = 0.48
    expect(defaultConf.fragilityScore).toBeGreaterThan(highConf.fragilityScore);
  });

  it('WK9: rankedClaims sorted descending by fragilityScore', () => {
    const claims = [
      makeClaim('c1', 'Supported claim'),
      makeClaim('c2', 'Mixed claim'),
      makeClaim('c3', 'Contradicted claim'),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'mixed'),
      c3: makeVerification('c3', 'contradicted'),
    };
    const result = analyzeWeakestLinks(claims, verifications, {});
    for (let i = 0; i < result.rankedClaims.length - 1; i++) {
      expect(result.rankedClaims[i].fragilityScore).toBeGreaterThanOrEqual(result.rankedClaims[i + 1].fragilityScore);
    }
  });

  it('WK10: claims with no verification entry are excluded from rankedClaims', () => {
    const c1 = makeClaim('c1', 'Verified claim');
    const c2 = makeClaim('c2', 'Unverified claim — no entry in verifications');
    const verifications = { c1: makeVerification('c1', 'supported') };
    const result = analyzeWeakestLinks([c1, c2], verifications, {});
    expect(result.rankedClaims).toHaveLength(1);
    expect(result.rankedClaims[0].claimId).toBe('c1');
  });
});

describe('POST /weakest — HTTP tests', () => {
  it('WK7: valid body → 200 with WeakestLinkAnalysis shape', async () => {
    const claim = makeClaim('c1', 'The sky is blue');
    const ver = makeVerification('c1', 'supported');

    const res = await server.inject({
      method: 'POST',
      url: '/weakest',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [claim], verifications: { c1: ver }, complianceReport: {} }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('weakestClaim');
    expect(body).toHaveProperty('rankedClaims');
    expect(body).toHaveProperty('argumentStrength');
    expect(body).toHaveProperty('strengthScore');
    expect(body).toHaveProperty('summary');
    expect(typeof body.strengthScore).toBe('number');
    expect(['resilient', 'stable', 'fragile', 'critical']).toContain(body.argumentStrength);
  });

  it('WK8: missing body fields → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/weakest',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [] }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('WK8b: no api-key → 401', async () => {
    const claim = makeClaim('c1', 'claim');
    const res = await server.inject({
      method: 'POST',
      url: '/weakest',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [claim], verifications: {}, complianceReport: {} }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('WK11: empty claims array → 200, weakestClaim null, strengthScore 1', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/weakest',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [], verifications: {}, complianceReport: {} }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.weakestClaim).toBeNull();
    expect(body.strengthScore).toBe(1);
    expect(body.summary).toBe('No verified claims to analyze.');
  });
});
