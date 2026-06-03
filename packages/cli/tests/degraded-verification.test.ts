/**
 * Degraded-verification signal — integrity guard.
 *
 * Origin: 2026-06-02. A quota-exhausted Gemini key returned HTTP 429 on every
 * verifyClaim() call; geminiService.ts swallowed it to status:'unverified', so
 * the live product reported confident-but-false "unverified" verdicts (presence
 * != truth, inside the product whose pitch IS presence != truth). The fix adds
 * VerificationResult.apiError + ScanResult.degraded/verificationErrors so an
 * un-run verification can never silently masquerade as a real verdict.
 *
 * These tests pin that contract: apiError verifications MUST surface as degraded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerificationResult } from '../types.js';

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim:   vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name:    'degraded-test-provider',
    modelId: 'degraded-v1',
    extractClaims:             mockExtractClaims,
    verifyClaim:               mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { scan } from '../cli/scan.js';

function vr(
  status: VerificationResult['status'],
  claimId: string,
  apiError?: boolean,
): VerificationResult {
  return { claimId, status, explanation: `test:${status}`, sources: [], ...(apiError ? { apiError: true } : {}) };
}

function makeClaims(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Verifiable claim number ${i + 1} about the subject matter here.`,
    type: 'fact' as const,
    importance: 3,
  }));
}

describe('scan — degraded verification signal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flags degraded=true and counts verificationErrors when a verification has apiError (e.g. 429 quota)', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(3));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('unverified', 'c1', true))   // quota 429 swallowed to unverified
      .mockResolvedValueOnce(vr('supported', 'c2'))
      .mockResolvedValueOnce(vr('unverified', 'c3', true));  // 429 again
    const r = await scan('Quota-exhausted scan.', 'mock');
    expect(r.degraded).toBe(true);
    expect(r.verificationErrors).toBe(2);
  });

  it('is NOT degraded when every verification is a real verdict (no apiError)', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('supported', 'c1'))
      .mockResolvedValueOnce(vr('unverified', 'c2'));        // a REAL 'unverified' verdict, not an error
    const r = await scan('Healthy scan.', 'mock');
    expect(r.degraded).toBe(false);
    expect(r.verificationErrors).toBe(0);
  });

  it('distinguishes a real unverified verdict from an api-error unverified', async () => {
    // Both report status:'unverified' — only apiError tells them apart. This is
    // the exact masquerade the fix prevents.
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('unverified', 'c1'))         // genuinely no support found
      .mockResolvedValueOnce(vr('unverified', 'c2', true));  // never checked (429)
    const r = await scan('Mixed unverified scan.', 'mock');
    expect(r.verificationErrors).toBe(1);
    expect(r.degraded).toBe(true);
  });
});
