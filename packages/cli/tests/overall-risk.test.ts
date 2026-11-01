/**
 * The overall risk band: an unverified claim means its risk was not checked,
 * so it is never read as low risk.
 *
 * Validates: the risk rule in packages/cli/lib/overall-risk.ts, through the
 * function itself and through each engine scan path that returns overallRisk
 * (quick scan, full scan, verifyFullScan), on the stock mock provider. The mock
 * cites no source, so every verdict it gives reads unverified.
 */
import { describe, it, expect } from 'vitest';
import { calculateRisk, type OverallRisk } from '../lib/overall-risk.js';
import { scan, extractForFullScan, verifyFullScan } from '../cli/scan.js';
import type { ClaimStatus, VerificationResult } from '../types.js';

function verdicts(...statuses: ClaimStatus[]): Record<string, VerificationResult> {
  const out: Record<string, VerificationResult> = {};
  statuses.forEach((status, i) => {
    out[`c${i + 1}`] = { claimId: `c${i + 1}`, status, explanation: status, sources: [] };
  });
  return out;
}

function repeat(status: ClaimStatus, n: number): ClaimStatus[] {
  return Array.from({ length: n }, () => status);
}

describe('calculateRisk — unverified is never low', () => {
  const table: Array<[string, ClaimStatus[], OverallRisk]> = [
    // The new rule
    ['all unverified (one claim)', ['unverified'], 'high'],
    ['all unverified (four claims)', repeat('unverified', 4), 'high'],
    ['one of four unverified, rest supported', ['unverified', 'supported', 'supported', 'supported'], 'medium'],
    ['two of four unverified (exactly half)', ['unverified', 'unverified', 'supported', 'supported'], 'high'],
    ['two of five unverified (under half)', ['unverified', 'unverified', 'supported', 'supported', 'supported'], 'medium'],
    ['three of five unverified (over half)', ['unverified', 'unverified', 'unverified', 'supported', 'supported'], 'high'],
    ['one unverified of nine', ['unverified', ...repeat('supported', 8)], 'medium'],
    // Contradicted and mixed keep their outcome; unverified never lowers a band
    ['unverified plus one contradicted', ['unverified', 'unverified', 'unverified', 'contradicted'], 'high'],
    ['one unverified plus one contradicted', ['unverified', 'contradicted', 'supported', 'supported'], 'high'],
    ['unverified plus three contradicted', ['unverified', 'contradicted', 'contradicted', 'contradicted'], 'critical'],
    ['all unverified but three contradicted', [...repeat('unverified', 5), ...repeat('contradicted', 3)], 'critical'],
    ['one unverified plus one mixed', ['unverified', 'mixed', 'supported', 'supported'], 'medium'],
    ['half unverified plus one mixed', ['unverified', 'unverified', 'mixed', 'supported'], 'high'],
    ['one unverified plus three mixed', ['unverified', 'mixed', 'mixed', 'mixed', 'supported', 'supported', 'supported'], 'high'],
    // Unchanged outcomes with no unverified claim
    ['zero claims', [], 'low'],
    ['all supported', repeat('supported', 4), 'low'],
    ['one mixed', ['mixed', 'supported'], 'medium'],
    ['three mixed', repeat('mixed', 3), 'high'],
    ['one contradicted', ['contradicted', 'supported'], 'high'],
    ['three contradicted', repeat('contradicted', 3), 'critical'],
  ];

  it.each(table)('%s → %s', (_name, statuses, expected) => {
    expect(Object.keys(verdicts(...statuses))).toHaveLength(statuses.length);
    expect(calculateRisk(verdicts(...statuses))).toBe(expected);
  });

  it('an unverified provider error counts as unverified', () => {
    const v = verdicts('unverified', 'supported', 'supported', 'supported');
    v.c1.apiError = true;
    expect(calculateRisk(v)).toBe('medium');
  });
});

describe('every engine scan path applies the rule (mock provider → unverified)', () => {
  const TEXT = 'The Eiffel Tower is in Paris. Water boils at 100 degrees Celsius at sea level.';

  it('quick scan: all unverified → high', async () => {
    const result = await scan(TEXT, 'mock');
    const statuses = Object.values(result.verifications).map((v) => v.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 'unverified')).toBe(true);
    expect(result.overallRisk).toBe('high');
    expect(result.complianceReport.overallRiskLevel).toBe('high');
  });

  it("full scan (scan mode 'full'): all unverified → high", async () => {
    const result = await scan(TEXT, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });
    const statuses = Object.values(result.verifications).map((v) => v.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 'unverified')).toBe(true);
    expect(result.overallRisk).toBe('high');
  });

  it('verifyFullScan: all unverified → high', async () => {
    const est = await extractForFullScan(TEXT, 'mock');
    expect(est.factClaims).toBeGreaterThan(0);
    const result = await verifyFullScan(est.claims, { providerName: 'mock', text: TEXT });
    const statuses = Object.values(result.verifications).map((v) => v.status);
    expect(statuses.length).toBe(est.factClaims);
    expect(statuses.every((s) => s === 'unverified')).toBe(true);
    expect(result.overallRisk).toBe('high');
  });

  it('a scan with zero claims stays low', async () => {
    const result = await scan('', 'mock');
    expect(Object.keys(result.verifications)).toHaveLength(0);
    expect(result.overallRisk).toBe('low');
  });
});
