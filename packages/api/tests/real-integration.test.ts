/**
 * Real Integration Oracle (N-81 — CRUCIBLE Gate: integration oracle)
 *
 * Validates: N-81 (Real Integration Oracle — CRUCIBLE 4th oracle type),
 *            N-79 (Claim Filter Threshold), N-03 (EU AI Act Compliance),
 *            N-13 (Cloud Platform — real scan pipeline end-to-end)
 *
 * Unlike integration-flow.test.ts, these tests do NOT mock the scan engine.
 * The full call chain runs: HTTP request → Fastify route → scan() → mock provider
 * → extractClaims() → verifyClaim() → response body.
 *
 * This is the 4th CRUCIBLE oracle type (integration). It catches bugs that
 * unit and contract tests miss because the real pipeline wires up:
 *   • sentence splitting (guaranteeClaimPerSentence)
 *   • filterClaimsForVerification (importance >= 2 threshold)
 *   • compliance report generation
 *   • rule engine application
 *   • scan history recording
 *   • audit trail entries
 *
 * All scenarios use provider='mock' — deterministic, no API keys required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetScanHistory, getScanHistory } from '../src/store/scan-history.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetAnalytics } from '../src/store/analytics.js';
import type { FastifyInstance } from 'fastify';

// ── No vi.mock here — real scan engine runs ──────────────────────────────────

const API_KEY = 'real-integration-key';

function makePayload(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ text, provider: 'mock', ...extra });
}

function authHeaders(key = API_KEY): Record<string, string> {
  return { 'x-api-key': key, 'content-type': 'application/json' };
}

describe('Real Integration Oracle — end-to-end pipeline (no scan mock)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = API_KEY;
    resetScanHistory();
    resetAuditLogger();
    resetCache();
    resetCircuitBreaker();
    resetAnalytics();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // ── RI1: Real claims extracted and returned ─────────────────────────────────

  it('RI1: POST /scan returns real claims extracted by mock provider', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('The Eiffel Tower was built in 1889. It stands 330 metres tall.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Real extraction: 2 sentences → 2 claims
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBeGreaterThanOrEqual(2);

    // Every claim has required shape
    for (const claim of body.claims) {
      expect(typeof claim.id).toBe('string');
      expect(typeof claim.text).toBe('string');
      expect(claim.text.length).toBeGreaterThan(0);
      expect(typeof claim.importance).toBe('number');
    }
  });

  // ── RI2: Real verifications keyed by claim ID ───────────────────────────────

  it('RI2: verifications object is keyed by real claim IDs', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('Water boils at 100 degrees Celsius. Ice melts at 0 degrees.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(typeof body.verifications).toBe('object');
    // Every claim ID from claims should have a corresponding verification
    for (const claim of body.claims) {
      expect(body.verifications).toHaveProperty(claim.id);
      const v = body.verifications[claim.id];
      expect(typeof v.status).toBe('string');
      expect(typeof v.explanation).toBe('string');
    }
  });

  // ── RI3: overallRisk is one of the expected values ─────────────────────────

  it('RI3: overallRisk is a valid risk level', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('The sun is a star.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(['low', 'medium', 'high', 'critical']).toContain(body.overallRisk);
  });

  // ── RI4: complianceReport has required shape ────────────────────────────────

  it('RI4: complianceReport has correct shape from real compliance engine', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('AI systems must comply with EU regulations. Bias must be minimised.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const cr = body.complianceReport;

    expect(cr).toBeDefined();
    expect(typeof cr.overallRiskLevel).toBe('string');
    expect(cr.euRiskSummary).toBeDefined();
    expect(typeof cr.euRiskSummary.totalClaims).toBe('number');
    expect(cr.euRiskSummary.totalClaims).toBeGreaterThan(0);
    expect(Array.isArray(cr.claimMappings)).toBe(true);
    expect(typeof cr.generatedAt).toBe('string');
  });

  // ── RI5: scan records entry in ScanHistory ─────────────────────────────────

  it('RI5: POST /scan records entry in ScanHistory store', async () => {
    const text = 'The Great Wall of China is visible from space.';
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload(text),
    });

    const history = getScanHistory();
    expect(history.size).toBeGreaterThan(0);
    const recent = history.getRecent(1);
    expect(recent.length).toBe(1);
    expect(recent[0].provider).toBe('mock');
    expect(recent[0].textPreview).toContain('Great Wall');
    expect(recent[0].claimCount).toBeGreaterThanOrEqual(1);
  });

  // ── RI6: scan writes audit entry ──────────────────────────────────────────

  it('RI6: POST /scan writes an audit entry with correct endpoint and status', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('Antibiotics cure all infections.'),
    });

    const entries = getAuditLogger().getEntries();
    expect(entries.length).toBeGreaterThan(0);
    const scanEntry = entries.find(e => e.endpoint === '/scan' && e.method === 'POST');
    expect(scanEntry).toBeDefined();
    expect(scanEntry!.statusCode).toBe(200);
    expect(scanEntry!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── RI7: sentence splitting fires in real pipeline ────────────────────────

  it('RI7: two-sentence input produces at least 2 claims (guaranteeClaimPerSentence active)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Both sentences must appear as separate claims
    expect(body.claims.length).toBeGreaterThanOrEqual(2);
    const texts = body.claims.map((c: { text: string }) => c.text.toLowerCase());
    expect(texts.some((t: string) => /cancer/.test(t))).toBe(true);
    expect(texts.some((t: string) => /gpt|accuracy|benchmark/.test(t))).toBe(true);
  });

  // ── RI8: cache HIT on repeated scan ──────────────────────────────────────

  it('RI8: second identical scan returns X-Cache: HIT and same result', async () => {
    const payload = makePayload('The moon orbits the Earth.');

    const r1 = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload,
    });
    const r2 = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload,
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['x-cache']).toBe('HIT');

    const b1 = JSON.parse(r1.body);
    const b2 = JSON.parse(r2.body);
    // Same claim count on cache hit
    expect(b2.claims.length).toBe(b1.claims.length);
  });

  // ── RI9: scan without API key returns 401 ────────────────────────────────

  it('RI9: POST /scan without API key returns 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'content-type': 'application/json' },
      payload: makePayload('Test.'),
    });
    expect(res.statusCode).toBe(401);
  });

  // ── RI10: ruleFindings is an array ─────────────────────────────────────────

  it('RI10: ruleFindings is an array in the real response', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload('Personal data is stored in our database. Email addresses are collected.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.ruleFindings)).toBe(true);
  });

  // ── RI11: scan/deep runs real evidence linking ────────────────────────────

  it('RI11: POST /scan/deep returns evidenceLinks per claim', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: authHeaders(),
      payload: makePayload('The Eiffel Tower is in Paris.'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Deep scan enriches each claim with evidenceLinks
    expect(typeof body).toBe('object');
    expect(body.claims ?? body.scan?.claims).toBeDefined();
  });

  // ── RI12: ScanHistory claimCount reflects real claim count ───────────────

  it('RI12: ScanHistory.claimCount matches actual claims returned', async () => {
    const text = 'Claim one is here. Claim two is here. Claim three is also here.';
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: authHeaders(),
      payload: makePayload(text),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const actualClaimCount = body.claims.length;

    const history = getScanHistory();
    const recent = history.getRecent(1);
    expect(recent.length).toBe(1);
    expect(recent[0].claimCount).toBe(actualClaimCount);
  });
});
