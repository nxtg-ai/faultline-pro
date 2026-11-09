// Validates: emma-soul ruling Dx3 d41fa0c1 (GoPMO 1.18.15.1.11, option A): below
// Enterprise, a caller-named provider is replaced by Gemini on every hosted route,
// so a scan's text goes only to the providers the privacy page names for the plan.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetCache } from '../src/store/cache.js';
import { getTemplateStore } from '../src/store/templates.js';
import type { FastifyInstance } from 'fastify';

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn().mockResolvedValue('Extracted text.') }));

const GOOD_RESULT = {
  input: 'test',
  provider: 'Google Gemini',
  claims: [{ id: 'c1', text: 'test', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: 'ok', sources: [] } },
  overallRisk: 'low',
  complianceReport: {},
  ruleFindings: [],
};

const SERVER_KEY = 'server-key';
let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  resetKeyStore();
  resetRateLimiter();
  resetCircuitBreaker();
  resetCache();
  mockScan.mockReset().mockResolvedValue(GOOD_RESULT);
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

const proKey = () => getKeyStore().create('Pro', ['pro', 'scan']).key;
const personalKey = () => getKeyStore().create('Personal', ['scan']).key;
const json = (key: string, extra: Record<string, string> = {}) => ({ 'x-api-key': key, 'content-type': 'application/json', ...extra });
const providersCalled = () => mockScan.mock.calls.map((c) => c[1]);

describe('provider entitlement: below Enterprise a named provider becomes Gemini', () => {
  it.each(['openai', 'claude', 'perplexity'])('a Pro key that names %s on POST /scan is scanned on Gemini', async (named) => {
    const res = await server.inject({ method: 'POST', url: '/scan', headers: json(proKey()), body: JSON.stringify({ text: 'test', provider: named }) });
    expect(res.statusCode).toBe(200);
    expect(providersCalled()).toEqual(['gemini']);
  });

  it('a Personal key that names openai is scanned on Gemini', async () => {
    await server.inject({ method: 'POST', url: '/scan', headers: json(personalKey()), body: JSON.stringify({ text: 'test', provider: 'openai' }) });
    expect(providersCalled()).toEqual(['gemini']);
  });

  it('a spoofed x-user-tier: enterprise on a keystore key buys no provider choice', async () => {
    await server.inject({ method: 'POST', url: '/scan', headers: json(proKey(), { 'x-user-tier': 'enterprise' }), body: JSON.stringify({ text: 'test', provider: 'openai' }) });
    expect(providersCalled()).toEqual(['gemini']);
  });

  it('per-stage pipelineConfig providers are replaced too', async () => {
    await server.inject({
      method: 'POST', url: '/scan', headers: json(proKey()),
      body: JSON.stringify({ text: 'test', pipelineConfig: { extractionProvider: 'openai', verificationProvider: 'claude' } }),
    });
    expect(mockScan).toHaveBeenCalledTimes(1);
    const pipelineConfig = mockScan.mock.calls[0][6] as Record<string, unknown>;
    expect(pipelineConfig.extractionProvider).toBe('gemini');
    expect(pipelineConfig.verificationProvider).toBe('gemini');
  });

  it('the mock provider is kept: it sends text nowhere', async () => {
    await server.inject({ method: 'POST', url: '/scan', headers: json(proKey()), body: JSON.stringify({ text: 'test', provider: 'mock' }) });
    expect(providersCalled()).toEqual(['mock']);
  });

  it('server key forwarding a Pro user: a named provider becomes Gemini', async () => {
    await server.inject({ method: 'POST', url: '/scan', headers: json(SERVER_KEY, { 'x-user-tier': 'pro' }), body: JSON.stringify({ text: 'test', provider: 'openai' }) });
    expect(providersCalled()).toEqual(['gemini']);
  });

  it('server key forwarding an Enterprise user keeps the named provider', async () => {
    await server.inject({ method: 'POST', url: '/scan', headers: json(SERVER_KEY, { 'x-user-tier': 'enterprise' }), body: JSON.stringify({ text: 'test', provider: 'openai' }) });
    expect(providersCalled()).toEqual(['openai']);
  });

  it('POST /scan/deep and POST /scan/batch apply the same rule', async () => {
    const key = proKey();
    await server.inject({ method: 'POST', url: '/scan/deep', headers: json(key), body: JSON.stringify({ text: 'deep text', provider: 'claude' }) });
    await server.inject({ method: 'POST', url: '/scan/batch', headers: json(key), body: JSON.stringify({ texts: ['batch text'], provider: 'openai' }) });
    expect(providersCalled()).toEqual(['gemini', 'gemini']);
  });

  it('GET /scan/stream: a provider on the query string becomes Gemini', async () => {
    await server.inject({ method: 'GET', url: '/scan/stream?text=Stream%20text.&provider=openai', headers: { 'x-api-key': proKey() } });
    expect(mockScan).toHaveBeenCalled();
    expect(new Set(providersCalled())).toEqual(new Set(['gemini']));
  });

  it('POST /scan/upload: a provider form field becomes Gemini', async () => {
    const boundary = 'EntitlementBoundary';
    const crlf = '\r\n';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="provider"${crlf}${crlf}openai${crlf}`),
      Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="a.pdf"${crlf}Content-Type: application/pdf${crlf}${crlf}`),
      Buffer.from('%PDF-1.4 fake content'),
      Buffer.from(`${crlf}--${boundary}--${crlf}`),
    ]);
    const res = await server.inject({
      method: 'POST', url: '/scan/upload', payload,
      headers: { 'x-api-key': proKey(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    expect(providersCalled()).toEqual(['gemini']);
  });

  it('POST /scan/template/:id: a template that names openai scans on Gemini below Enterprise', async () => {
    const key = getKeyStore().create('Pro', ['pro', 'scan']);
    const template = getTemplateStore().create('t', { provider: 'openai' }, key.id);
    const res = await server.inject({ method: 'POST', url: `/scan/template/${template.id}`, headers: json(key.key), body: JSON.stringify({ text: 'test' }) });
    expect(res.statusCode).toBe(200);
    expect(providersCalled()).toEqual(['gemini']);
  });
});
