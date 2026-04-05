import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

// Reset cache before every test so cached results from prior tests don't interfere
beforeEach(() => { resetCache(); });

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'GPT-4 is 92% accurate on medical diagnoses.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'GPT-4 is 92% accurate', type: 'fact', importance: 4 }],
    verifications: {
      c1: { claimId: 'c1', status: 'unverified', explanation: 'No source found.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

// Mock compliance-report utilities — scan handler calls these after scan() resolves
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

describe('GET /health', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 200 with status ok', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('faultline-api');
  });

  it('returns a version field', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body);
    expect(body.version).toBeDefined();
    expect(typeof body.version).toBe('string');
  });

  it('does not require an api key', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /scan', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-secret-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 200 with scan result for valid request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'GPT-4 is 92% accurate on medical diagnoses.' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
    expect(Array.isArray(body.claims)).toBe(true);
    // Gate 2: assert non-empty (mock returns 1 claim)
    expect(body.claims.length).toBeGreaterThan(0);
    expect(Array.isArray(body.ruleFindings)).toBe(true);
  });

  it('accepts optional provider field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 when x-api-key header is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when x-api-key header is wrong', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when text field is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when text is empty string', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('strips unknown body fields and returns 200 (Fastify removes additional properties)', async () => {
    // Fastify's AJV is configured with removeAdditional: 'all' by default —
    // unknown fields are stripped before the handler runs, not rejected.
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'valid text', unknownField: 'oops' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 when server has no FAULTLINE_API_KEY configured', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'any-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 500 when scan throws an error', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    // With failover, all 5 providers must fail to produce a 500.
    vi.mocked(scan)
      .mockRejectedValueOnce(new Error('Provider API key missing'))
      .mockRejectedValueOnce(new Error('Provider API key missing'))
      .mockRejectedValueOnce(new Error('Provider API key missing'))
      .mockRejectedValueOnce(new Error('Provider API key missing'))
      .mockRejectedValueOnce(new Error('Provider API key missing'));

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Provider API key missing');
  });
});

describe('POST /scan/report', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-secret-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 200 with application/pdf content-type', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'GPT-4 is 92% accurate on medical diagnoses.' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('returns a non-empty PDF body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'GPT-4 is 92% accurate on medical diagnoses.' }),
    });
    expect(res.rawPayload.length).toBeGreaterThan(1000);
  });

  it('includes a content-disposition attachment header', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.pdf');
  });

  it('accepts optional projectName field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.', projectName: 'ACME Audit Q1' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 when x-api-key is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when text is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ projectName: 'test' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when x-api-key is wrong', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'bad-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Unauthorized');
  });

  it('returns 503 when FAULTLINE_API_KEY is not set', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'any-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('not configured');
  });

  it('returns 500 when scan throws', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValueOnce(new Error('Provider failure'));

    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Provider failure');
  });

  it('returns 400 for invalid provider enum', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.', provider: 'invalid-provider' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when text exceeds 50000 characters', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(50001) }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('strips unknown body fields and returns 200', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.', unknownField: 'ignored' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('PDF response starts with PDF magic bytes', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(200);
    // PDF files begin with %PDF
    expect(res.rawPayload.slice(0, 4).toString()).toBe('%PDF');
  });

  it('content-disposition filename includes the scan date', async () => {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const res = await server.inject({
      method: 'POST',
      url: '/scan/report',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.headers['content-disposition']).toContain(today);
  });
});

describe('POST /scan — additional coverage', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-secret-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 400 for text exceeding 50000 characters', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(50001) }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid provider enum value', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some text.', provider: 'unknown-llm' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 with error message when scan throws a non-Error object', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    // With failover, all 5 providers must fail to produce a 500.
    vi.mocked(scan)
      .mockRejectedValueOnce('plain string error')
      .mockRejectedValueOnce('plain string error')
      .mockRejectedValueOnce('plain string error')
      .mockRejectedValueOnce('plain string error')
      .mockRejectedValueOnce('plain string error');

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('plain string error');
  });

  it('includes verifications map in response', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'GPT-4 is 92% accurate on medical diagnoses.' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verifications).toBeDefined();
    expect(typeof body.verifications).toBe('object');
  });

  it('includes complianceReport in response', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.complianceReport).toBeDefined();
    expect(typeof body.complianceReport.riskTier).toBe('string');
  });

  // CS1: POST /scan response includes complianceScore as a number 0–100
  // Validates: N-200 (inline compliance score on scan response)
  it('CS1: POST /scan response includes complianceScore as a number 0–100', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'GPT-4 is 92% accurate on medical diagnoses.' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.complianceScore).toBe('number');
    expect(body.complianceScore).toBeGreaterThanOrEqual(0);
    expect(body.complianceScore).toBeLessThanOrEqual(100);
  });

  // CS2: POST /scan response includes compliancePass as boolean
  // Validates: N-200 (inline compliance score on scan response)
  it('CS2: POST /scan response includes compliancePass as boolean', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'GPT-4 is 92% accurate on medical diagnoses.' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.compliancePass).toBe('boolean');
  });
});
