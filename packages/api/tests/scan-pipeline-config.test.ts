/**
 * FR-3 — Per-stage model routing (PipelineConfig)
 * N-220
 *
 * PC1  valid pipelineConfig (all three stages) → 200
 * PC2  invalid provider name in extractionProvider → 400
 * PC3  absent pipelineConfig → 200 (backward-compatible)
 * PC4  pipelineConfig with only one stage specified → 200
 * PC5  missing API key for specified provider → 503 provider_not_configured
 * PC6  pipelineConfig path calls scan exactly once (no circuit-breaker loop)
 * PC7  synthesisProvider accepted without error (no-op in current pipeline)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockScan = vi.hoisted(() => vi.fn());

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 80 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

const MOCK_SCAN_RESULT = {
  input: 'Test claim text.',
  provider: 'Mock Provider',
  claims: [{ id: 'c1', text: 'Test claim text', type: 'fact', importance: 3 }],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'Verified.', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postScan(
  server: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await server.inject({
    method: 'POST',
    url: '/scan',
    headers: { 'x-api-key': 'test-pc-key', 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('FR-3 — POST /scan pipelineConfig', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetCache();
    mockScan.mockResolvedValue(MOCK_SCAN_RESULT);
    process.env.FAULTLINE_API_KEY = 'test-pc-key';
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.clearAllMocks();
  });

  it('PC1: valid pipelineConfig with all three stages → 200', async () => {
    const { statusCode, body } = await postScan(server, {
      text: 'Test claim text.',
      provider: 'mock',
      pipelineConfig: {
        extractionProvider: 'mock',
        verificationProvider: 'mock',
        synthesisProvider: 'mock',
      },
    });
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty('overallRisk');
  });

  it('PC2: invalid provider name in pipelineConfig → 400', async () => {
    const { statusCode } = await postScan(server, {
      text: 'Test claim text.',
      pipelineConfig: { extractionProvider: 'invalid-provider' },
    });
    expect(statusCode).toBe(400);
  });

  it('PC3: absent pipelineConfig → 200 (backward-compatible)', async () => {
    const { statusCode, body } = await postScan(server, {
      text: 'Test claim text.',
      provider: 'mock',
    });
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty('overallRisk');
  });

  it('PC4: pipelineConfig with only extractionProvider → 200', async () => {
    const { statusCode, body } = await postScan(server, {
      text: 'Test claim text.',
      provider: 'mock',
      pipelineConfig: { extractionProvider: 'mock' },
    });
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty('overallRisk');
  });

  it('PC5: missing API key for specified provider → 503 provider_not_configured', async () => {
    mockScan.mockRejectedValueOnce(
      new Error('No API key found for "openai". Set OPENAI_API_KEY in your environment'),
    );
    const { statusCode, body } = await postScan(server, {
      text: 'Test claim text.',
      pipelineConfig: { extractionProvider: 'openai' },
    });
    expect(statusCode).toBe(503);
    expect(body).toMatchObject({ error: 'provider_not_configured', provider: 'openai' });
  });

  it('PC6: pipelineConfig path calls scan exactly once (no circuit-breaker loop)', async () => {
    await postScan(server, {
      text: 'Test claim text.',
      provider: 'mock',
      pipelineConfig: { extractionProvider: 'mock', verificationProvider: 'mock' },
    });
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('PC7: synthesisProvider accepted without error (no-op in current pipeline)', async () => {
    const { statusCode } = await postScan(server, {
      text: 'Test claim text.',
      provider: 'mock',
      pipelineConfig: { synthesisProvider: 'mock' },
    });
    expect(statusCode).toBe(200);
  });
});
