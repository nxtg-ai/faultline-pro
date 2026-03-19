/**
 * i18n integration tests — verify the API server:
 *   1. Does not crash with any Accept-Language header value.
 *   2. Returns non-empty error bodies for all supported (and unsupported) langs.
 *   3. Returns the exact English string when no Accept-Language is provided.
 *
 * The Spanish and French message catalogues are stubs that return English
 * strings, so all non-empty assertions pass regardless of locale. The exact-
 * match assertions use 'en' as the expected value (the canonical string that
 * all stubs also return).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetTemplateStore } from '../src/store/templates.js';
import { resetProviderRegistry } from '../src/store/providers.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'test',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'test', type: 'fact', importance: 3 }],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      riskTier: 'minimal',
      findings: [],
      euRiskSummary: {
        totalClaims: 1,
        highestTier: 'minimal',
        unacceptable: 0,
        high: 0,
        limited: 0,
        minimal: 1,
      },
    },
    ruleFindings: [],
  }),
}));

vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: vi.fn().mockResolvedValue('test'),
}));

function resetAllStores(): void {
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  resetCache();
  resetTemplateStore();
  resetProviderRegistry();
  resetCircuitBreaker();
}

describe('API i18n — Accept-Language handling', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAllStores();
    process.env.FAULTLINE_API_KEY = 'test-admin-key';
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // ---------------------------------------------------------------------------
  // 401 path — POST /scan without x-api-key
  // ---------------------------------------------------------------------------

  it('1. POST /scan without api key + Accept-Language: es → 401, body.error non-empty (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'es',
      },
      body: JSON.stringify({ text: 'Some AI generated text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('2. POST /scan without api key + Accept-Language: fr → 401, body.error non-empty (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'fr',
      },
      body: JSON.stringify({ text: 'Some AI generated text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('3. POST /scan without api key + no Accept-Language → 401, exact English error string', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some AI generated text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('Unauthorized. Provide a valid x-api-key header.');
  });

  it('4. POST /scan without api key + Accept-Language: de → falls back to en, body.error non-empty (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'de',
      },
      body: JSON.stringify({ text: 'Some AI generated text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('5. POST /scan without api key + Accept-Language: es-MX,es;q=0.9,en;q=0.8 → 401, body.error non-empty (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'es-MX,es;q=0.9,en;q=0.8',
      },
      body: JSON.stringify({ text: 'Some AI generated text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 200 path — Accept-Language must not break success response
  // ---------------------------------------------------------------------------

  it('6. Successful scan with Accept-Language header returns 200 without error field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-admin-key',
        'accept-language': 'es',
      },
      body: JSON.stringify({ text: 'Some AI generated text.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 401 path — POST /templates without x-api-key
  // ---------------------------------------------------------------------------

  it('7. POST /templates without api key + Accept-Language: fr → 401, body.error non-empty (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/templates',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'fr',
      },
      body: JSON.stringify({ name: 'Test Template' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 403 path — GET /keys without api key (not admin)
  // ---------------------------------------------------------------------------

  it('8. GET /keys without api key + Accept-Language: es → 403, body.error non-empty (Gate 2)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'accept-language': 'es' },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Edge cases — malformed / invalid Accept-Language header
  // ---------------------------------------------------------------------------

  it('9. Accept-Language: invalid-header → 401, body.error non-empty (no crash, Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'accept-language': '!!!invalid-header!!!',
      },
      body: JSON.stringify({ text: 'Some AI generated text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Regression — Accept-Language must not alter 200 scan result structure
  // ---------------------------------------------------------------------------

  it('10. Accept-Language header does not affect 200 scan result structure', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-admin-key',
        'accept-language': 'fr,en;q=0.8',
      },
      body: JSON.stringify({ text: 'Some AI generated text.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      claims: unknown[];
      overallRisk: string;
      verifications: Record<string, unknown>;
    };
    // Gate 2: assert key structural fields are present and non-empty where expected
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBeGreaterThan(0);
    expect(typeof body.overallRisk).toBe('string');
    expect(body.overallRisk.length).toBeGreaterThan(0);
    expect(typeof body.verifications).toBe('object');
  });
});
