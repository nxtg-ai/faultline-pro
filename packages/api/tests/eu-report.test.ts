import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const MOCK_HIGH_RISK_RESULT = {
  input: 'AI predicts recidivism with 95% accuracy.',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'AI predicts recidivism with 95% accuracy.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'This is better than human judges.', type: 'interpretation', importance: 4 },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'unverified', explanation: 'No peer review.', sources: [] },
    c2: { claimId: 'c2', status: 'contradicted', explanation: 'Studies disagree.', sources: [{ title: 'COMPAS Study', uri: 'https://example.com/compas' }] },
  },
  overallRisk: 'critical',
  complianceReport: { riskTier: 'unacceptable', findings: ['High-risk classification applies'] },
  ruleFindings: [],
};

const MOCK_LOW_RISK_RESULT = {
  input: 'The sky is blue.',
  provider: 'mock',
  claims: [{ id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 2 }],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'Observable.', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

describe('POST /scan/eu-report', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'eu-test-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 200 with PDF content-type for low risk scan', async () => {
    mockScan.mockResolvedValueOnce(MOCK_LOW_RISK_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The sky is blue.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('returns PDF for high-risk / critical scan', async () => {
    mockScan.mockResolvedValueOnce(MOCK_HIGH_RISK_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'AI predicts recidivism.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('Content-Disposition includes eu-ai-act-report filename', async () => {
    mockScan.mockResolvedValueOnce(MOCK_LOW_RISK_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.', provider: 'mock' }),
    });
    expect(res.headers['content-disposition']).toContain('eu-ai-act-report');
  });

  it('response body is non-empty buffer (valid PDF)', async () => {
    mockScan.mockResolvedValueOnce(MOCK_LOW_RISK_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test claim.', provider: 'mock' }),
    });
    expect(res.rawPayload.length).toBeGreaterThan(0);
    // PDF magic bytes: %PDF
    expect(res.rawPayload.slice(0, 4).toString()).toBe('%PDF');
  });

  it('returns 503 when server has no API key configured', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const server2 = buildServer();
    const res = await server2.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.' }),
    });
    await server2.close();
    expect(res.statusCode).toBe(503);
  });

  it('returns 401 when x-api-key header is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for missing text', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ provider: 'mock' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts optional projectName', async () => {
    mockScan.mockResolvedValueOnce(MOCK_LOW_RISK_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test claim.', provider: 'mock', projectName: 'My AI Project' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('PDF size is reasonable (> 5KB for high-risk multi-claim report)', async () => {
    mockScan.mockResolvedValueOnce(MOCK_HIGH_RISK_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Complex high-risk AI output.', provider: 'mock' }),
    });
    expect(res.rawPayload.length).toBeGreaterThan(5000);
  });

  it('handles scan with no claims gracefully', async () => {
    mockScan.mockResolvedValueOnce({
      ...MOCK_LOW_RISK_RESULT,
      claims: [],
      verifications: {},
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan/eu-report',
      headers: { 'x-api-key': 'eu-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Vague text.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});
