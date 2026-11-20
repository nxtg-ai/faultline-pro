// Validates: FR-4 (GoPMO 1.18.11.5.21): the /scan/stream complete event carries complianceReport and ruleFindings.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

// Synthetic text: two checkable claims and an email address, so the PII rule fires.
const SCAN_TEXT = 'The Eiffel Tower is located in Berlin. Water boils at 150 degrees Celsius. Contact jane.doe@example.com for details.';

function parseSSE(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as Record<string, unknown>);
}

function completeOf(body: string): Record<string, unknown> {
  const complete = parseSSE(body).find((e) => e['type'] === 'complete');
  expect(complete).toBeDefined();
  return complete as Record<string, unknown>;
}

function stripVolatile(report: unknown): unknown {
  const { generatedAt: _generatedAt, ...rest } = report as Record<string, unknown>;
  return rest;
}

let server: FastifyInstance;

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = 'test-secret';
  server = buildServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

describe('/scan/stream complete event: complianceReport and ruleFindings (FR-4)', () => {
  it('GET: complete carries a compliance report that maps every claim', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const complete = completeOf(res.body);
    const report = complete['complianceReport'] as Record<string, unknown>;
    expect(report).toBeDefined();
    expect(typeof report['generatedAt']).toBe('string');
    const mappings = report['claimMappings'] as unknown[];
    expect(Array.isArray(mappings)).toBe(true);
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings.length).toBe(complete['claimCount']);
    expect((report['euRiskSummary'] as Record<string, unknown>)['totalClaims']).toBe(complete['claimCount']);
  });

  it('GET: complete carries the rule findings for the scanned text', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const findings = completeOf(res.body)['ruleFindings'] as Array<Record<string, unknown>>;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).toContain('jane.doe@example.com');
  });

  it('POST: complete carries both fields too', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: { text: SCAN_TEXT, provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    const complete = completeOf(res.body);
    expect(((complete['complianceReport'] as Record<string, unknown>)['claimMappings'] as unknown[]).length).toBeGreaterThan(0);
    expect((complete['ruleFindings'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('matches POST /scan for the same text (same shape, same findings)', async () => {
    const streamed = completeOf((await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    })).body);
    const scanRes = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: { text: SCAN_TEXT, provider: 'mock' },
    });
    expect(scanRes.statusCode).toBe(200);
    const scan = scanRes.json() as Record<string, unknown>;
    expect(streamed['ruleFindings']).toEqual(scan['ruleFindings']);
    expect(stripVolatile(streamed['complianceReport'])).toEqual(stripVolatile(scan['complianceReport']));
  });
});
