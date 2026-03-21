/**
 * N-118 — Mutation hardening for cli/scan.ts
 *
 * Targets surviving mutants from initial Stryker run (26.75% score):
 *   - calculateRisk() boundary conditions (lines 25-28): contradicted/mixed thresholds
 *   - scan() structural invariants (lines 101, 127-129, 141): API key guard, loop, truncation
 *   - aggregateResults() highestRisk ordering (line 276): riskCounts[r] > 0
 *
 * Tests MH1–MH15. All run through the scan() / batchScan() public API using a
 * mocked provider registry so we can control verifyClaim() return values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VerificationResult } from '../types.js';

// ── Mock setup ────────────────────────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() so the fns are available inside the factory
const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim:   vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name:    'hardening-provider',
    modelId: 'hardening-v1',
    extractClaims:             mockExtractClaims,
    verifyClaim:               mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { scan, batchScan } from '../cli/scan.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function vr(status: VerificationResult['status'], claimId: string): VerificationResult {
  return { claimId, status, explanation: `test:${status}`, sources: [] };
}

function makeClaims(n: number, importance = 3) {
  return Array.from({ length: n }, (_, i) => ({
    id:         `c${i + 1}`,
    text:       `Verifiable claim number ${i + 1} about the subject matter here.`,
    type:       'fact' as const,
    importance,
  }));
}

// ── calculateRisk() boundary tests (MH1–MH7) ─────────────────────────────────
//
// All tests call scan() with 'mock' providerName (skips API-key guard).
// The mocked provider returns the exact statuses we need to probe each boundary.

describe('scan — calculateRisk boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  // MH1: 3 contradicted → critical
  // Kills mutant: `contradicted > 2` → `contradicted > 3`
  it('MH1: returns critical when 3 claims are contradicted', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(3));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('contradicted', 'c1'))
      .mockResolvedValueOnce(vr('contradicted', 'c2'))
      .mockResolvedValueOnce(vr('contradicted', 'c3'));
    const r = await scan('Three contradicted claims.', 'mock');
    expect(r.overallRisk).toBe('critical');
  });

  // MH2: exactly 2 contradicted → high (NOT critical)
  // Kills mutant: `contradicted > 2` → `contradicted >= 2`
  it('MH2: returns high when exactly 2 claims are contradicted', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(3));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('contradicted', 'c1'))
      .mockResolvedValueOnce(vr('contradicted', 'c2'))
      .mockResolvedValueOnce(vr('supported',    'c3'));
    const r = await scan('Two contradicted one supported.', 'mock');
    expect(r.overallRisk).toBe('high');
  });

  // MH3: 1 contradicted, 0 mixed → high
  // Kills mutant: `contradicted > 0 || mixed > 2` → `contradicted > 0 && mixed > 2`
  it('MH3: returns high when 1 claim is contradicted and none are mixed', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('contradicted', 'c1'))
      .mockResolvedValueOnce(vr('supported',    'c2'));
    const r = await scan('One contradicted claim.', 'mock');
    expect(r.overallRisk).toBe('high');
  });

  // MH4: 3 mixed, 0 contradicted → high
  // Kills mutant: `mixed > 2` → `mixed > 3`
  it('MH4: returns high when 3 claims are mixed and none contradicted', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(3));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('mixed', 'c1'))
      .mockResolvedValueOnce(vr('mixed', 'c2'))
      .mockResolvedValueOnce(vr('mixed', 'c3'));
    const r = await scan('Three mixed claims.', 'mock');
    expect(r.overallRisk).toBe('high');
  });

  // MH5: exactly 2 mixed, 0 contradicted → medium (NOT high)
  // Kills mutant: `mixed > 2` → `mixed >= 2`
  it('MH5: returns medium when exactly 2 claims are mixed', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(3));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('mixed',     'c1'))
      .mockResolvedValueOnce(vr('mixed',     'c2'))
      .mockResolvedValueOnce(vr('supported', 'c3'));
    const r = await scan('Two mixed claims.', 'mock');
    expect(r.overallRisk).toBe('medium');
  });

  // MH6: 1 mixed, 0 contradicted → medium (NOT low)
  // Kills mutant: `mixed > 0` → `mixed > 1`
  it('MH6: returns medium when 1 claim is mixed', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('mixed',     'c1'))
      .mockResolvedValueOnce(vr('supported', 'c2'));
    const r = await scan('One mixed claim.', 'mock');
    expect(r.overallRisk).toBe('medium');
  });

  // MH7: all supported → low
  // Baseline: confirms the low branch is reachable and correct
  it('MH7: returns low when all claims are supported', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('supported', 'c1'))
      .mockResolvedValueOnce(vr('supported', 'c2'));
    const r = await scan('Two supported claims.', 'mock');
    expect(r.overallRisk).toBe('low');
  });
});

// ── scan() structural invariants (MH8–MH13) ──────────────────────────────────

describe('scan — structural invariants', () => {
  beforeEach(() => vi.clearAllMocks());

  // MH8: input truncated to 200 chars
  // Kills mutant: `text.substring(0, 200)` → `text` (or 199/201 off-by-one)
  it('MH8: truncates result.input to exactly 200 characters', async () => {
    const longText = 'X'.repeat(300);
    mockExtractClaims.mockResolvedValue([]);
    const r = await scan(longText, 'mock');
    expect(r.input).toHaveLength(200);
    expect(r.input).toBe('X'.repeat(200));
  });

  // MH9: short input is preserved verbatim
  it('MH9: preserves result.input unchanged when shorter than 200 chars', async () => {
    const shortText = 'Short verifiable claim text.';
    mockExtractClaims.mockResolvedValue([]);
    const r = await scan(shortText, 'mock');
    expect(r.input).toBe(shortText);
  });

  // MH10: every claim in toVerify appears in verifications (loop exhaustion)
  // Kills mutant: `i < toVerify.length` → `i <= toVerify.length - 1` no-ops, or off-by-one
  it('MH10: records a verification entry for every filtered claim', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(5));
    mockVerifyClaim.mockResolvedValue(vr('supported', 'cx'));
    const r = await scan('Five claims.', 'mock');
    expect(Object.keys(r.verifications)).toHaveLength(5);
    for (let i = 1; i <= 5; i++) {
      expect(r.verifications[`c${i}`]).toBeDefined();
    }
  });

  // MH11: verification statuses are keyed by claim id and faithfully stored
  it('MH11: keys verifications by claim id with correct status', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim
      .mockResolvedValueOnce(vr('supported',    'c1'))
      .mockResolvedValueOnce(vr('contradicted', 'c2'));
    const r = await scan('Two claims.', 'mock');
    expect(r.verifications['c1'].status).toBe('supported');
    expect(r.verifications['c2'].status).toBe('contradicted');
  });

  // MH12: non-mock provider throws when API key is absent
  // Kills mutant: `resolvedProvider !== 'mock'` → `false`
  // With mutant, block is skipped, apiKey stays '', getProvider is called (mocked), no throw.
  it('MH12: throws for non-mock provider when API key env var is missing', async () => {
    const orig = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    try {
      await expect(scan('Some text.', 'gemini')).rejects.toThrow(/No API key/);
    } finally {
      if (orig !== undefined) process.env['GEMINI_API_KEY'] = orig;
    }
  });

  // MH13: mock provider bypasses API-key check (scan succeeds with no env var)
  it('MH13: succeeds with mock provider even when no API key is set', async () => {
    const orig = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    try {
      mockExtractClaims.mockResolvedValue([]);
      await expect(scan('Some text.', 'mock')).resolves.toBeDefined();
    } finally {
      if (orig !== undefined) process.env['GEMINI_API_KEY'] = orig;
    }
  });
});

// ── aggregateResults() highestRisk ordering (MH14–MH15) ─────────────────────
//
// batchScan() → scan() per-file → aggregateResults().
// The mutant `riskCounts[r] > 0` → `riskCounts[r] >= 0` makes find() always
// return 'critical' (first element, always >= 0). Tests verify the real ordering.

describe('batchScan — aggregateResults highestRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  // MH14: only medium-risk scans → highestRisk = 'medium', not 'critical'
  // Kills mutant: riskCounts[r] > 0 → riskCounts[r] >= 0
  it('MH14: highestRisk is medium when no critical/high scans exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-hs-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'Mixed evidence claim text here in detail.');
      writeFileSync(join(dir, 'b.txt'), 'Further mixed evidence about the subject.');
      mockExtractClaims.mockResolvedValue(makeClaims(1));
      mockVerifyClaim.mockResolvedValue(vr('mixed', 'c1'));
      const r = await batchScan(dir, 'mock');
      expect(r.summary.highestRisk).toBe('medium');
      expect(r.summary.riskCounts.critical).toBe(0);
      expect(r.summary.riskCounts.high).toBe(0);
      expect(r.summary.riskCounts.medium).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // MH15: only low-risk scans → highestRisk = 'low'
  it('MH15: highestRisk is low when all scans return supported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-lo-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'Supported verifiable claim text here.');
      mockExtractClaims.mockResolvedValue(makeClaims(1));
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      expect(r.summary.highestRisk).toBe('low');
      expect(r.summary.riskCounts.critical).toBe(0);
      expect(r.summary.riskCounts.high).toBe(0);
      expect(r.summary.riskCounts.medium).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
