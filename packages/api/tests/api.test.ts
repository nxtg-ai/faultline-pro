import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

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
    expect(body.ruleFindings).toBeDefined();
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
    vi.mocked(scan).mockRejectedValueOnce(new Error('Provider API key missing'));

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
