import { describe, it, expect } from 'vitest';
import type { Claim, VerificationResult, AnalysisState } from '../types';
import { mapClaimToRiskCategory } from '../compliance/eu_ai_act';
import { generateComplianceReport } from '../compliance/report_generator';

// --- Helpers ---

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return { id: 'c1', text: 'Test claim', type: 'fact', importance: 3, ...overrides };
}

function makeVerification(
  claimId: string,
  status: VerificationResult['status'] = 'supported',
): VerificationResult {
  return { claimId, status, explanation: `${status} explanation`, sources: [] };
}

// --- Confidence Score Tests ---

describe('Confidence Scoring: mapClaimToRiskCategory', () => {
  describe('numeric confidenceScore values', () => {
    it('should return 0.95 for unacceptable risk (prohibited pattern)', () => {
      const claim = makeClaim({ text: 'Social scoring system for citizens' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('unacceptable');
      expect(result.confidenceScore).toBe(0.95);
    });

    it('should return 0.9 for escalated high-risk (contradicted + high importance)', () => {
      const claim = makeClaim({ text: 'Biometric identification required', importance: 4 });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'contradicted'));
      expect(result.riskLevel).toBe('high');
      expect(result.confidenceScore).toBe(0.9);
    });

    it('should return 0.7 for non-escalated high-risk domain', () => {
      const claim = makeClaim({ text: 'Education scoring AI system' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('high');
      expect(result.confidenceScore).toBe(0.7);
    });

    it('should return 0.85 for limited risk with contradicted status', () => {
      const claim = makeClaim({ text: 'General claim about weather' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'contradicted'));
      expect(result.riskLevel).toBe('limited');
      expect(result.confidenceScore).toBe(0.85);
    });

    it('should return 0.6 for limited risk with mixed status', () => {
      const claim = makeClaim({ text: 'General claim about weather' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'mixed'));
      expect(result.riskLevel).toBe('limited');
      expect(result.confidenceScore).toBe(0.6);
    });

    it('should return 0.3 for minimal risk', () => {
      const claim = makeClaim({ text: 'The sky is blue' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('minimal');
      expect(result.confidenceScore).toBe(0.3);
    });
  });

  describe('confidenceScore is always 0.0-1.0', () => {
    it('should be between 0 and 1 for unacceptable', () => {
      const result = mapClaimToRiskCategory(
        makeClaim({ text: 'Mass surveillance biometric system' }),
        makeVerification('c1'),
      );
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(1);
    });

    it('should be between 0 and 1 for minimal', () => {
      const result = mapClaimToRiskCategory(
        makeClaim({ text: 'Water is wet' }),
        makeVerification('c1'),
      );
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(1);
    });
  });
});

describe('Confidence Distribution: generateComplianceReport', () => {
  const claims: Claim[] = [
    makeClaim({ id: 'c1', text: 'Social scoring for citizens', importance: 5 }),     // unacceptable → 0.95 → high
    makeClaim({ id: 'c2', text: 'Biometric identification used', importance: 4 }),    // high (contradicted) → 0.9 → high
    makeClaim({ id: 'c3', text: 'Education scoring system', importance: 3 }),          // high (supported) → 0.7 → medium
    makeClaim({ id: 'c4', text: 'The weather is nice today', importance: 3 }),         // minimal (supported) → 0.3 → low
  ];

  const verifications: Record<string, VerificationResult> = {
    c1: makeVerification('c1', 'supported'),
    c2: makeVerification('c2', 'contradicted'),
    c3: makeVerification('c3', 'supported'),
    c4: makeVerification('c4', 'supported'),
  };

  it('should include confidenceDistribution in the report', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    expect(report.confidenceDistribution).toBeDefined();
    expect(report.confidenceDistribution).toHaveProperty('high');
    expect(report.confidenceDistribution).toHaveProperty('medium');
    expect(report.confidenceDistribution).toHaveProperty('low');
  });

  it('should correctly count high confidence (>=0.8)', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    // c1=0.95 (high), c2=0.9 (high) → 2 high
    expect(report.confidenceDistribution.high).toBe(2);
  });

  it('should correctly count medium confidence (0.5-0.8)', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    // c3=0.7 (medium) → 1 medium
    expect(report.confidenceDistribution.medium).toBe(1);
  });

  it('should correctly count low confidence (<0.5)', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    // c4=0.3 (low) → 1 low
    expect(report.confidenceDistribution.low).toBe(1);
  });

  it('should return all zeros for empty claims', () => {
    const report = generateComplianceReport([], {}, 'low');
    expect(report.confidenceDistribution).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it('distribution counts should sum to total claim mappings', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    const { high, medium, low } = report.confidenceDistribution;
    expect(high + medium + low).toBe(report.claimMappings.length);
  });
});

describe('Threshold Filtering: generateComplianceReport with minConfidence', () => {
  const claims: Claim[] = [
    makeClaim({ id: 'c1', text: 'Social scoring for citizens', importance: 5 }),     // 0.95
    makeClaim({ id: 'c2', text: 'Education scoring system', importance: 3 }),          // 0.7
    makeClaim({ id: 'c3', text: 'The weather is nice today', importance: 3 }),         // 0.3
  ];

  const verifications: Record<string, VerificationResult> = {
    c1: makeVerification('c1', 'supported'),
    c2: makeVerification('c2', 'supported'),
    c3: makeVerification('c3', 'supported'),
  };

  it('should not filter when minConfidence is undefined', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    expect(report.claimMappings.length).toBe(3);
  });

  it('should not filter when minConfidence is 0', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 0);
    expect(report.claimMappings.length).toBe(3);
  });

  it('should filter out claims below minConfidence=0.5', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 0.5);
    // c3 (0.3) filtered out
    expect(report.claimMappings.length).toBe(2);
    expect(report.claimMappings.every(m => m.confidenceScore >= 0.5)).toBe(true);
  });

  it('should filter out claims below minConfidence=0.8', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 0.8);
    // c2 (0.7) and c3 (0.3) filtered out
    expect(report.claimMappings.length).toBe(1);
    expect(report.claimMappings[0].claimId).toBe('c1');
  });

  it('should filter out all claims when minConfidence=1.0', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 1.0);
    expect(report.claimMappings.length).toBe(0);
  });

  it('confidence distribution should reflect pre-filter counts', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 0.8);
    // Distribution is computed BEFORE filtering
    expect(report.confidenceDistribution.high).toBe(1);  // c1=0.95
    expect(report.confidenceDistribution.medium).toBe(1); // c2=0.7
    expect(report.confidenceDistribution.low).toBe(1);    // c3=0.3
  });

  it('risk summary should reflect post-filter counts', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 0.5);
    // After filtering: c1 (unacceptable) + c2 (high) remain, c3 (minimal) filtered out
    expect(report.euRiskSummary.totalClaims).toBe(2);
  });
});
