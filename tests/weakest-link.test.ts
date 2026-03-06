import { describe, it, expect } from 'vitest';
import type { Claim, VerificationResult, ClaimStatus } from '../types';
import type { ComplianceReport } from '../compliance/report_generator';
import {
  analyzeWeakestLinks,
  VERDICT_SCORES,
  type ClaimFragility,
  type WeakestLinkAnalysis,
} from '../analysis/weakest-link';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    text: 'Test claim text.',
    type: 'fact',
    importance: 3,
    ...overrides,
  };
}

function makeTestVerification(
  claimId: string,
  status: ClaimStatus = 'supported',
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    claimId,
    status,
    explanation: 'Test explanation.',
    sources: [],
    ...overrides,
  };
}

function makeEmptyComplianceReport(
  claimMappings: ComplianceReport['claimMappings'] = [],
): ComplianceReport {
  return {
    generatedAt: new Date().toISOString(),
    overallRiskLevel: 'low',
    euRiskSummary: {
      unacceptable: 0,
      high: 0,
      limited: 0,
      minimal: 0,
      totalClaims: 0,
      highestTier: 'minimal',
    },
    claimMappings,
    triggeredArticles: [],
    mitigations: [],
    confidenceDistribution: { high: 0, medium: 0, low: 0 },
  };
}

// ---------------------------------------------------------------------------
// 1. VERDICT_SCORES
// ---------------------------------------------------------------------------

describe('VERDICT_SCORES', () => {
  it('should assign contradicted the highest score (1.0)', () => {
    expect(VERDICT_SCORES.contradicted).toBe(1.0);
  });

  it('should assign supported the lowest score (0.0)', () => {
    expect(VERDICT_SCORES.supported).toBe(0.0);
  });

  it('should assign mixed a score of 0.6', () => {
    expect(VERDICT_SCORES.mixed).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// 2. Empty inputs
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - empty inputs', () => {
  const report = makeEmptyComplianceReport();

  it('should return null weakestClaim when no claims provided', () => {
    const result = analyzeWeakestLinks([], {}, report);
    expect(result.weakestClaim).toBeNull();
    expect(result.rankedClaims).toHaveLength(0);
    expect(result.argumentStrength).toBe('resilient');
    expect(result.strengthScore).toBe(1.0);
  });

  it('should return empty ranking when claims exist but no verifications', () => {
    const claims = [makeTestClaim({ id: 'c1' }), makeTestClaim({ id: 'c2' })];
    const result = analyzeWeakestLinks(claims, {}, report);
    expect(result.weakestClaim).toBeNull();
    expect(result.rankedClaims).toHaveLength(0);
    expect(result.argumentStrength).toBe('resilient');
    expect(result.strengthScore).toBe(1.0);
  });

  it('should include loading-status claims in ranking', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'loading') };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims).toHaveLength(1);
    expect(result.rankedClaims[0].status).toBe('loading');
  });

  it('should include skipped-status claims in ranking', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'skipped') };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims).toHaveLength(1);
    expect(result.rankedClaims[0].status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// 3. Sorting
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - sorting', () => {
  it('should rank contradicted high-importance claim first', () => {
    const claims = [
      makeTestClaim({ id: 'c1', text: 'Supported claim', importance: 5 }),
      makeTestClaim({ id: 'c2', text: 'Contradicted claim', importance: 5 }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'supported'),
      c2: makeTestVerification('c2', 'contradicted'),
    };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].claimId).toBe('c2');
  });

  it('should rank supported claim with lowest fragility', () => {
    const claims = [
      makeTestClaim({ id: 'c1', text: 'Supported claim', importance: 3 }),
      makeTestClaim({ id: 'c2', text: 'Mixed claim', importance: 3 }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'supported'),
      c2: makeTestVerification('c2', 'mixed'),
    };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    const lastClaim = result.rankedClaims[result.rankedClaims.length - 1];
    expect(lastClaim.claimId).toBe('c1');
  });

  it('should sort claims descending by fragilityScore', () => {
    const claims = [
      makeTestClaim({ id: 'c1', importance: 3 }),
      makeTestClaim({ id: 'c2', importance: 5 }),
      makeTestClaim({ id: 'c3', importance: 1 }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'mixed'),
      c2: makeTestVerification('c2', 'contradicted'),
      c3: makeTestVerification('c3', 'unverified'),
    };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims).toHaveLength(3); // CRUCIBLE Gate 2: non-empty before sort check
    for (let i = 0; i < result.rankedClaims.length - 1; i++) {
      expect(result.rankedClaims[i].fragilityScore).toBeGreaterThanOrEqual(
        result.rankedClaims[i + 1].fragilityScore,
      );
    }
  });

  it('should preserve relative order for equal fragilityScore (stable sort)', () => {
    // Two claims with identical parameters produce identical fragility scores
    const claims = [
      makeTestClaim({ id: 'c1', text: 'First claim', importance: 3 }),
      makeTestClaim({ id: 'c2', text: 'Second claim', importance: 3 }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'mixed'),
      c2: makeTestVerification('c2', 'mixed'),
    };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].claimId).toBe('c1');
    expect(result.rankedClaims[1].claimId).toBe('c2');
  });

  it('should set weakestClaim to the first item in rankedClaims', () => {
    const claims = [
      makeTestClaim({ id: 'c1', importance: 2 }),
      makeTestClaim({ id: 'c2', importance: 5 }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'contradicted'),
      c2: makeTestVerification('c2', 'contradicted'),
    };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.weakestClaim).toEqual(result.rankedClaims[0]);
    expect(result.weakestClaim!.claimId).toBe('c2');
  });
});

// ---------------------------------------------------------------------------
// 4. confidenceScore fallback
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - confidenceScore fallback', () => {
  it('should use confidenceScore from claimMappings when available', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'supported') };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'supported',
        riskLevel: 'minimal',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.9,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].confidenceScore).toBe(0.9);
  });

  it('should default to 0.5 when claim is not in claimMappings', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'supported') };
    const report = makeEmptyComplianceReport(); // no claimMappings
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].confidenceScore).toBe(0.5);
  });

  it('should use different confidenceScores for different claims', () => {
    const claims = [
      makeTestClaim({ id: 'c1' }),
      makeTestClaim({ id: 'c2' }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'mixed'),
      c2: makeTestVerification('c2', 'mixed'),
    };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'mixed',
        riskLevel: 'limited',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.8,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    const c1 = result.rankedClaims.find((c) => c.claimId === 'c1')!;
    const c2 = result.rankedClaims.find((c) => c.claimId === 'c2')!;
    expect(c1.confidenceScore).toBe(0.8);
    expect(c2.confidenceScore).toBe(0.5); // fallback
  });
});

// ---------------------------------------------------------------------------
// 5. argumentStrength
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - argumentStrength', () => {
  it('should return critical for contradicted importance=5, confidence=0', () => {
    const claims = [makeTestClaim({ id: 'c1', importance: 5 })];
    const verifications = { c1: makeTestVerification('c1', 'contradicted') };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'contradicted',
        riskLevel: 'limited',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.0,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    // verdictScore=1.0, uncertainty=1.0, importanceFactor=1.0
    // fragility = (1.0*0.6 + 1.0*0.4) * 1.0 = 1.0
    expect(result.argumentStrength).toBe('critical');
  });

  it('should return fragile for contradicted importance=3, confidence=0.5', () => {
    const claims = [makeTestClaim({ id: 'c1', importance: 3 })];
    const verifications = { c1: makeTestVerification('c1', 'contradicted') };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'contradicted',
        riskLevel: 'limited',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'medium',
        confidenceScore: 0.5,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    // verdictScore=1.0, uncertainty=0.5, importanceFactor=0.6
    // fragility = (1.0*0.6 + 0.5*0.4) * 0.6 = 0.8 * 0.6 = 0.48
    expect(result.argumentStrength).toBe('fragile');
  });

  it('should return resilient or stable for supported importance=3, confidence=0.8', () => {
    const claims = [makeTestClaim({ id: 'c1', importance: 3 })];
    const verifications = { c1: makeTestVerification('c1', 'supported') };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'supported',
        riskLevel: 'minimal',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.8,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    // verdictScore=0.0, uncertainty=0.2, importanceFactor=0.6
    // fragility = (0.0*0.6 + 0.2*0.4) * 0.6 = 0.08 * 0.6 = 0.048
    expect(['resilient', 'stable']).toContain(result.argumentStrength);
  });

  it('should return resilient when no claims are provided', () => {
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks([], {}, report);
    expect(result.argumentStrength).toBe('resilient');
  });
});

// ---------------------------------------------------------------------------
// 6. strengthScore
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - strengthScore', () => {
  it('should return 1.0 when no claims are provided', () => {
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks([], {}, report);
    expect(result.strengthScore).toBe(1.0);
  });

  it('should return close to 1.0 for all-supported high-confidence claims', () => {
    const claims = [
      makeTestClaim({ id: 'c1', importance: 3 }),
      makeTestClaim({ id: 'c2', importance: 2 }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'supported'),
      c2: makeTestVerification('c2', 'supported'),
    };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'supported',
        riskLevel: 'minimal',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.95,
      },
      {
        claimId: 'c2',
        claimText: 'Test',
        verificationStatus: 'supported',
        riskLevel: 'minimal',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.9,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.strengthScore).toBeGreaterThan(0.95);
  });

  it('should return less than 0.5 for contradicted high-importance claims', () => {
    const claims = [makeTestClaim({ id: 'c1', importance: 5 })];
    const verifications = { c1: makeTestVerification('c1', 'contradicted') };
    const report = makeEmptyComplianceReport([
      {
        claimId: 'c1',
        claimText: 'Test',
        verificationStatus: 'contradicted',
        riskLevel: 'limited',
        category: {} as any,
        matchedPatterns: [],
        confidence: 'high',
        confidenceScore: 0.0,
      },
    ]);
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.strengthScore).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 7. summary
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - summary', () => {
  it('should return no-claims message when no claims provided', () => {
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks([], {}, report);
    expect(result.summary).toBe('No verified claims to analyze.');
  });

  it('should include claim text, status, and importance in summary', () => {
    const claims = [makeTestClaim({ id: 'c1', text: 'Earth is flat', importance: 4 })];
    const verifications = { c1: makeTestVerification('c1', 'contradicted') };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.summary).toContain('Earth is flat');
    expect(result.summary).toContain('contradicted');
    expect(result.summary).toContain('importance 4/5');
  });

  it('should truncate claim text at 80 characters with ellipsis', () => {
    const longText = 'A'.repeat(100);
    const claims = [makeTestClaim({ id: 'c1', text: longText })];
    const verifications = { c1: makeTestVerification('c1', 'mixed') };
    const report = makeEmptyComplianceReport();
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.summary).toContain('A'.repeat(80) + '...');
    expect(result.summary).not.toContain('A'.repeat(81));
  });
});

// ---------------------------------------------------------------------------
// 8. fragilityReason
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - fragilityReason', () => {
  const report = makeEmptyComplianceReport();

  it('should contain "Contradicted" for contradicted claims', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'contradicted') };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].fragilityReason).toContain('Contradicted');
  });

  it('should contain "Mixed evidence" for mixed claims', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'mixed') };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].fragilityReason).toContain('Mixed evidence');
  });

  it('should contain "No corroborating" for unverified claims', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'unverified') };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].fragilityReason).toContain('No corroborating');
  });

  it('should contain "Supported" for supported claims', () => {
    const claims = [makeTestClaim({ id: 'c1' })];
    const verifications = { c1: makeTestVerification('c1', 'supported') };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims[0].fragilityReason).toContain('Supported');
  });
});

// ---------------------------------------------------------------------------
// 9. Claims without verifications excluded
// ---------------------------------------------------------------------------

describe('analyzeWeakestLinks - claims without verifications excluded', () => {
  const report = makeEmptyComplianceReport();

  it('should exclude claims with no matching verification from rankedClaims', () => {
    const claims = [
      makeTestClaim({ id: 'c1' }),
      makeTestClaim({ id: 'c2' }),
    ];
    const verifications = {
      c1: makeTestVerification('c1', 'supported'),
      // c2 has no verification
    };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims).toHaveLength(1);
    expect(result.rankedClaims[0].claimId).toBe('c1');
  });

  it('should only include verified claims in results', () => {
    const claims = [
      makeTestClaim({ id: 'c1' }),
      makeTestClaim({ id: 'c2' }),
      makeTestClaim({ id: 'c3' }),
    ];
    const verifications = {
      c2: makeTestVerification('c2', 'contradicted'),
    };
    const result = analyzeWeakestLinks(claims, verifications, report);
    expect(result.rankedClaims).toHaveLength(1);
    expect(result.rankedClaims[0].claimId).toBe('c2');
    expect(result.weakestClaim!.claimId).toBe('c2');
  });
});
