import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Extracted content from file',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'Extracted claim', type: 'fact', importance: 4 }],
    verifications: {
      c1: { claimId: 'c1', status: 'unverified', explanation: 'No source found.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      riskTier: 'minimal',
      findings: [],
      euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 0 },
    },
    ruleFindings: [],
  }),
}));

vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: vi.fn().mockResolvedValue('Extracted content from file'),
}));

// Build a multipart/form-data body manually
function buildMultipart(
  boundary: string,
  fields: { name: string; value: string }[],
  file?: { fieldname: string; filename: string; mimetype: string; data: Buffer },
): Buffer {
  const crlf = '\r\n';
  const parts: Buffer[] = [];

  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}Content-Disposition: form-data; name="${field.name}"${crlf}${crlf}${field.value}${crlf}`,
      ),
    );
  }

  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"${crlf}Content-Type: ${file.mimetype}${crlf}${crlf}`,
      ),
    );
    parts.push(file.data);
    parts.push(Buffer.from(crlf));
  }

  parts.push(Buffer.from(`--${boundary}--${crlf}`));
  return Buffer.concat(parts);
}

const BOUNDARY = 'TestBoundary12345';

function pdfBody() {
  return buildMultipart(BOUNDARY, [], {
    fieldname: 'file',
    filename: 'test.pdf',
    mimetype: 'application/pdf',
    data: Buffer.from('%PDF-1.4 fake content'),
  });
}

function imageBody() {
  return buildMultipart(BOUNDARY, [], {
    fieldname: 'file',
    filename: 'screenshot.png',
    mimetype: 'image/png',
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
}

function multipartHeaders() {
  return {
    'x-api-key': 'test-secret-key',
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

describe('POST /scan/upload', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'test-secret-key';
    server = buildServer();
    await server.ready();
    // Reset mocks to defaults
    const { extractTextFromBuffer } = await import('@nxtg/faultline/cli/extract.js');
    vi.mocked(extractTextFromBuffer).mockResolvedValue('Extracted content from file');
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockResolvedValue({
      input: 'Extracted content from file',
      provider: 'mock',
      claims: [{ id: 'c1', text: 'Extracted claim', type: 'fact', importance: 4 }],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'No source found.', sources: [] },
      },
      overallRisk: 'low',
      complianceReport: {
        riskTier: 'minimal',
        findings: [],
        euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 0 },
      },
      ruleFindings: [],
    });
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('200 PDF upload → ScanResult with claims', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Gate 2: non-empty claims
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBeGreaterThan(0);
  });

  it('200 image upload → ScanResult', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: imageBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
  });

  it('401 missing x-api-key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 wrong x-api-key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: {
        'x-api-key': 'wrong-key',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('503 when FAULTLINE_API_KEY not set', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(503);
  });

  it('400 no file field in multipart', async () => {
    const body = buildMultipart(BOUNDARY, [{ name: 'provider', value: 'mock' }]);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('No file field');
  });

  it('400 unsupported MIME type (text/plain)', async () => {
    const body = buildMultipart(BOUNDARY, [], {
      fieldname: 'file',
      filename: 'doc.txt',
      mimetype: 'text/plain',
      data: Buffer.from('plain text content'),
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Unsupported file type');
  });

  it('500 when extract throws (corrupt PDF)', async () => {
    const { extractTextFromBuffer } = await import('@nxtg/faultline/cli/extract.js');
    vi.mocked(extractTextFromBuffer).mockRejectedValueOnce(
      new Error('PDF contains no extractable text.'),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('PDF contains no extractable text');
  });

  it('500 when scan throws after successful extract', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValueOnce(new Error('Provider API failure'));
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('Provider API failure');
  });

  it('200 with optional provider field', async () => {
    const body = buildMultipart(BOUNDARY, [{ name: 'provider', value: 'mock' }], {
      fieldname: 'file',
      filename: 'test.pdf',
      mimetype: 'application/pdf',
      data: Buffer.from('%PDF-1.4 fake content'),
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it('400 when file exceeds 10MB size limit', async () => {
    const largeData = Buffer.alloc(11 * 1024 * 1024, 0x41); // 11MB of 'A'
    const body = buildMultipart(BOUNDARY, [], {
      fieldname: 'file',
      filename: 'large.pdf',
      mimetype: 'application/pdf',
      data: largeData,
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('10MB');
  });

  it('response includes overallRisk field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/upload',
      headers: multipartHeaders(),
      payload: pdfBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
    expect(['low', 'medium', 'high', 'critical']).toContain(body.overallRisk);
  });
});
