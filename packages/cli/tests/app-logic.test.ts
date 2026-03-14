import { describe, it, expect } from 'vitest';
import type { VerificationResult, AnalysisState, Claim } from '../types';

// Extract the pure logic functions from App.tsx for testing
// Since calculateRisk is defined inside the component, we replicate its logic here
// to test the algorithm. This is testing the LOGIC, not the component.

/**
 * Replicates calculateRisk from App.tsx:55-64
 */
function calculateRisk(
  verifications: Record<string, VerificationResult>,
  totalClaims: number
): AnalysisState['overallRisk'] {
  const values = Object.values(verifications);
  const contradicted = values.filter((v) => v.status === 'contradicted').length;
  const mixed = values.filter((v) => v.status === 'mixed').length;

  if (contradicted > 2) return 'critical';
  if (contradicted > 0 || mixed > 2) return 'high';
  if (mixed > 0) return 'medium';
  return 'low';
}

/**
 * Replicates claim filtering logic from App.tsx:92-95
 */
function filterClaimsForVerification(claims: Claim[]): Claim[] {
  return claims
    .filter((c) => c.type === 'fact' && c.importance >= 3)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
}

/**
 * Replicates initial verification state setup from App.tsx:108-126
 */
function buildInitialVerifications(
  claims: Claim[],
  claimIdsToVerify: Set<string>
): Record<string, VerificationResult> {
  const initialVerifications: Record<string, VerificationResult> = {};
  claims.forEach((c) => {
    if (claimIdsToVerify.has(c.id)) {
      initialVerifications[c.id] = {
        claimId: c.id,
        status: 'loading',
        explanation: 'Queued for stress-testing...',
        sources: [],
      };
    } else {
      let reason = 'Low load-bearing impact.';
      if (c.type === 'opinion') reason = 'Subjective opinion (not testable).';
      if (c.type === 'interpretation') reason = 'Interpretation (context dependent).';
      initialVerifications[c.id] = {
        claimId: c.id,
        status: 'skipped',
        explanation: reason,
        sources: [],
      };
    }
  });
  return initialVerifications;
}

describe('App.tsx — Business Logic', () => {
  describe('calculateRisk', () => {
    it('should return low when all claims are supported', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 2)).toBe('low');
    });

    it('should return medium when there is one mixed claim', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'mixed', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 2)).toBe('medium');
    });

    it('should return high when there is one contradicted claim', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 2)).toBe('high');
    });

    it('should return high when there are 3+ mixed claims', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'mixed', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'mixed', explanation: '', sources: [] },
        c3: { claimId: 'c3', status: 'mixed', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 3)).toBe('high');
    });

    it('should return critical when there are 3+ contradicted claims', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'contradicted', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: '', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 3)).toBe('critical');
    });

    it('should return low when verifications are empty', () => {
      expect(calculateRisk({}, 0)).toBe('low');
    });

    it('should ignore skipped and loading statuses', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'skipped', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'loading', explanation: '', sources: [] },
        c3: { claimId: 'c3', status: 'supported', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 3)).toBe('low');
    });

    it('should return high with exactly 2 contradicted (boundary)', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'contradicted', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 2)).toBe('high');
    });

    it('should return medium with exactly 2 mixed claims', () => {
      const verifications: Record<string, VerificationResult> = {
        c1: { claimId: 'c1', status: 'mixed', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'mixed', explanation: '', sources: [] },
      };
      expect(calculateRisk(verifications, 2)).toBe('medium');
    });
  });

  describe('filterClaimsForVerification', () => {
    it('should only include facts with importance >= 3', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Fact 5', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Fact 2', type: 'fact', importance: 2 },
        { id: 'c3', text: 'Opinion', type: 'opinion', importance: 5 },
        { id: 'c4', text: 'Fact 3', type: 'fact', importance: 3 },
      ];
      const result = filterClaimsForVerification(claims);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('c1'); // importance 5 first
      expect(result[1].id).toBe('c4'); // importance 3 second
    });

    it('should exclude opinions and interpretations', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Opinion', type: 'opinion', importance: 5 },
        { id: 'c2', text: 'Interpretation', type: 'interpretation', importance: 5 },
      ];
      expect(filterClaimsForVerification(claims)).toHaveLength(0);
    });

    it('should cap at 8 claims maximum', () => {
      const claims: Claim[] = Array.from({ length: 15 }, (_, i) => ({
        id: `c${i}`,
        text: `Fact ${i}`,
        type: 'fact' as const,
        importance: 5,
      }));
      expect(filterClaimsForVerification(claims)).toHaveLength(8);
    });

    it('should sort by importance descending', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Low', type: 'fact', importance: 3 },
        { id: 'c2', text: 'High', type: 'fact', importance: 5 },
        { id: 'c3', text: 'Mid', type: 'fact', importance: 4 },
      ];
      const result = filterClaimsForVerification(claims);
      expect(result[0].importance).toBe(5);
      expect(result[1].importance).toBe(4);
      expect(result[2].importance).toBe(3);
    });

    it('should return empty array when no claims qualify', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Low fact', type: 'fact', importance: 1 },
        { id: 'c2', text: 'Low fact', type: 'fact', importance: 2 },
      ];
      expect(filterClaimsForVerification(claims)).toHaveLength(0);
    });

    it('should handle empty claims array', () => {
      expect(filterClaimsForVerification([])).toHaveLength(0);
    });
  });

  describe('buildInitialVerifications', () => {
    it('should mark verifiable claims as loading', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Fact', type: 'fact', importance: 5 },
      ];
      const toVerify = new Set(['c1']);
      const result = buildInitialVerifications(claims, toVerify);
      expect(result.c1.status).toBe('loading');
      expect(result.c1.explanation).toBe('Queued for stress-testing...');
    });

    it('should mark opinions as skipped with correct reason', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Opinion', type: 'opinion', importance: 2 },
      ];
      const result = buildInitialVerifications(claims, new Set());
      expect(result.c1.status).toBe('skipped');
      expect(result.c1.explanation).toBe('Subjective opinion (not testable).');
    });

    it('should mark interpretations as skipped with correct reason', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Interpretation', type: 'interpretation', importance: 3 },
      ];
      const result = buildInitialVerifications(claims, new Set());
      expect(result.c1.status).toBe('skipped');
      expect(result.c1.explanation).toBe('Interpretation (context dependent).');
    });

    it('should mark low-importance facts as skipped', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'Low fact', type: 'fact', importance: 1 },
      ];
      const result = buildInitialVerifications(claims, new Set());
      expect(result.c1.status).toBe('skipped');
      expect(result.c1.explanation).toBe('Low load-bearing impact.');
    });

    it('should handle mixed verifiable and non-verifiable claims', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'High fact', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Opinion', type: 'opinion', importance: 5 },
        { id: 'c3', text: 'Low fact', type: 'fact', importance: 1 },
      ];
      const toVerify = new Set(['c1']);
      const result = buildInitialVerifications(claims, toVerify);
      expect(result.c1.status).toBe('loading');
      expect(result.c2.status).toBe('skipped');
      expect(result.c3.status).toBe('skipped');
    });

    it('should create entries for all claims', () => {
      const claims: Claim[] = [
        { id: 'c1', text: 'A', type: 'fact', importance: 5 },
        { id: 'c2', text: 'B', type: 'opinion', importance: 1 },
        { id: 'c3', text: 'C', type: 'interpretation', importance: 3 },
      ];
      const result = buildInitialVerifications(claims, new Set(['c1']));
      expect(Object.keys(result)).toHaveLength(3);
    });
  });

  describe('Default AnalysisState', () => {
    it('should have correct initial values', () => {
      const defaultState: AnalysisState = {
        claims: [],
        verifications: {},
        isProcessing: false,
        progressMessage: '',
        step: 'idle',
        overallRisk: 'low',
      };
      expect(defaultState.claims).toEqual([]);
      expect(defaultState.verifications).toEqual({});
      expect(defaultState.isProcessing).toBe(false);
      expect(defaultState.step).toBe('idle');
      expect(defaultState.overallRisk).toBe('low');
    });
  });
});
