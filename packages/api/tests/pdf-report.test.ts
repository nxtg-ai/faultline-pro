import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { generatePdfReport } from '../src/store/pdf-report.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetScanStore();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

const MINIMAL_SCAN = {
  input: 'The company reported revenue growth of 40% in Q3.',
  provider: 'gemini',
  overallRisk: 'medium',
  scannedAt: '2026-03-19T12:00:00Z',
  claims: [
    { id: 'c1', text: 'Revenue grew 40% in Q3.', type: 'fact', importance: 4 },
    { id: 'c2', text: 'This is excellent performance.', type: 'opinion', importance: 2 },
  ],
  verifications: {
    c1: {
      claimId: 'c1', status: 'mixed', explanation: 'Some sources confirm, others dispute.',
      sources: [{ title: 'Reuters', uri: 'https://reuters.com/article' }],
    },
    c2: {
      claimId: 'c2', status: 'skipped', explanation: 'Opinion claim — not verifiable.',
      sources: [],
    },
  },
};

const FULL_SCAN = {
  ...MINIMAL_SCAN,
  overallRisk: 'high',
  claims: [
    { id: 'c1', text: 'Revenue grew 40% in Q3.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'Profits hit record highs.', type: 'fact', importance: 5 },
    { id: 'c3', text: 'They are the best company in the industry.', type: 'opinion', importance: 2 },
    { id: 'c4', text: 'GDP grew 3% last year.', type: 'fact', importance: 3 },
    { id: 'c5', text: 'Market share increased dramatically.', type: 'fact', importance: 4 },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'contradicted', explanation: 'Contradicted by Q3 filings.', sources: [{ title: 'SEC Filing', uri: 'https://sec.gov' }] },
    c2: { claimId: 'c2', status: 'contradicted', explanation: 'No record highs found.', sources: [] },
    c3: { claimId: 'c3', status: 'skipped', explanation: 'Opinion.', sources: [] },
    c4: { claimId: 'c4', status: 'supported', explanation: 'GDP data confirmed.', sources: [{ title: 'IMF', uri: 'https://imf.org' }] },
    c5: { claimId: 'c5', status: 'mixed', explanation: 'Partial evidence found.', sources: [] },
  },
};

// ── generatePdfReport (unit) ──────────────────────────────────────────────────

describe('generatePdfReport', () => {
  it('returns a Buffer', async () => {
    const buf = await generatePdfReport(MINIMAL_SCAN);
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('returns non-empty Buffer', async () => {
    const buf = await generatePdfReport(MINIMAL_SCAN);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('starts with PDF magic bytes %PDF-', async () => {
    const buf = await generatePdfReport(MINIMAL_SCAN);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('generates larger report for multi-claim scan', async () => {
    const small = await generatePdfReport(MINIMAL_SCAN);
    const large = await generatePdfReport(FULL_SCAN);
    expect(large.length).toBeGreaterThan(small.length);
  });

  it('does not throw on empty claims', async () => {
    const buf = await generatePdfReport({ ...MINIMAL_SCAN, claims: [], verifications: {} });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('handles missing scannedAt gracefully', async () => {
    const { scannedAt: _, ...noDate } = MINIMAL_SCAN;
    const buf = await generatePdfReport(noDate as Parameters<typeof generatePdfReport>[0]);
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('handles critical risk level', async () => {
    const buf = await generatePdfReport({ ...MINIMAL_SCAN, overallRisk: 'critical' });
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('handles very long input text', async () => {
    const longInput = 'Word '.repeat(500);
    const buf = await generatePdfReport({ ...MINIMAL_SCAN, input: longInput });
    expect(buf).toBeInstanceOf(Buffer);
  });
});

// ── HTTP: POST /scan/report/pdf ───────────────────────────────────────────────

describe('POST /scan/report/pdf', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/report/pdf', payload: MINIMAL_SCAN });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 200 with application/pdf content-type', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report/pdf',
      headers: { 'x-api-key': 'admin-secret' },
      payload: MINIMAL_SCAN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('response starts with PDF magic bytes', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report/pdf',
      headers: { 'x-api-key': 'admin-secret' },
      payload: MINIMAL_SCAN,
    });
    expect(res.rawPayload.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('returns Content-Disposition attachment header', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report/pdf',
      headers: { 'x-api-key': 'admin-secret' },
      payload: MINIMAL_SCAN,
    });
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.pdf');
  });

  it('returns 404 for unknown scanId', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report/pdf',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { scanId: 'no-such-scan' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('generates PDF from scanId when stored scan exists', async () => {
    const stored = getScanStore().record('admin', MINIMAL_SCAN.input, {
      overallRisk: MINIMAL_SCAN.overallRisk,
      provider:    MINIMAL_SCAN.provider,
      claims:      MINIMAL_SCAN.claims,
      verifications: MINIMAL_SCAN.verifications,
    });
    const res = await server.inject({
      method: 'POST', url: '/scan/report/pdf',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { scanId: stored.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});

// ── HTTP: GET /scan/report/pdf/:id ────────────────────────────────────────────

describe('GET /scan/report/pdf/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown scan id', async () => {
    const res = await server.inject({
      method: 'GET', url: '/scan/report/pdf/no-such-id',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns PDF for known scan id', async () => {
    const stored = getScanStore().record('admin', MINIMAL_SCAN.input, {
      overallRisk: MINIMAL_SCAN.overallRisk,
      provider:    MINIMAL_SCAN.provider,
      claims:      MINIMAL_SCAN.claims,
      verifications: MINIMAL_SCAN.verifications,
    });
    const res = await server.inject({
      method: 'GET', url: `/scan/report/pdf/${stored.id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.slice(0, 5).toString()).toBe('%PDF-');
  });
});
