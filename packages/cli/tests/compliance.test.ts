import { describe, it, expect, vi } from 'vitest';
import type { Claim, VerificationResult } from '../types';
import {
  mapClaimToRiskCategory,
  EU_RISK_CATEGORIES,
  type EURiskLevel,
} from '../compliance/eu_ai_act';
import {
  generateComplianceReport,
  type ComplianceReport,
} from '../compliance/report_generator';

// --- Helpers ---

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    text: 'The Earth orbits the Sun.',
    type: 'fact',
    importance: 3,
    ...overrides,
  };
}

function makeVerification(
  claimId: string,
  status: VerificationResult['status'] = 'supported',
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

// ================================================================
// EU AI Act risk mapping
// ================================================================

describe('EU AI Act Risk Mapping', () => {
  describe('EU_RISK_CATEGORIES constants', () => {
    it('should define all four risk tiers', () => {
      expect(EU_RISK_CATEGORIES.unacceptable).toBeDefined();
      expect(EU_RISK_CATEGORIES.high).toBeDefined();
      expect(EU_RISK_CATEGORIES.limited).toBeDefined();
      expect(EU_RISK_CATEGORIES.minimal).toHaveProperty('title');
    });

    it('each category should have articles and required actions', () => {
      const tiers: EURiskLevel[] = ['unacceptable', 'high', 'limited', 'minimal'];
      for (const tier of tiers) {
        const cat = EU_RISK_CATEGORIES[tier];
        expect(cat.articles.length).toBeGreaterThan(0);
        expect(cat.requiredActions.length).toBeGreaterThan(0);
        expect(cat.title).toBeTruthy();
        expect(cat.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('mapClaimToRiskCategory — unacceptable', () => {
    it('should flag social scoring as unacceptable', () => {
      const claim = makeClaim({ text: 'The system uses social scoring to rank citizens.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('unacceptable');
      expect(result.matchedPatterns).toContain('Article 5(1)(c)');
    });

    it('should flag mass surveillance as unacceptable', () => {
      const claim = makeClaim({ text: 'Deploys real-time biometric identification in public spaces.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('unacceptable');
    });

    it('should flag emotion recognition in workplace as unacceptable', () => {
      const claim = makeClaim({ text: 'Uses emotion recognition in the workplace to monitor staff.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('unacceptable');
    });
  });

  describe('mapClaimToRiskCategory — high risk', () => {
    it('should flag biometric claims as high risk', () => {
      const claim = makeClaim({ text: 'The facial recognition system identifies suspects.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('high');
      expect(result.matchedPatterns.some(p => p.includes('Annex III'))).toBe(true);
    });

    it('should flag education/admission claims as high risk', () => {
      const claim = makeClaim({ text: 'AI scores student admission applications.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('high');
    });

    it('should flag employment/hiring claims as high risk', () => {
      const claim = makeClaim({ text: 'Automated recruitment screening filters candidates.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('high');
    });

    it('should flag credit scoring claims as high risk', () => {
      const claim = makeClaim({ text: 'AI determines credit scoring for loan applicants.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('high');
    });

    it('should flag law enforcement claims as high risk', () => {
      const claim = makeClaim({ text: 'Predictive policing algorithms deployed citywide.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1'));
      expect(result.riskLevel).toBe('high');
    });

    it('should set high confidence for contradicted high-importance claims in high-risk domain', () => {
      const claim = makeClaim({
        text: 'The recruitment tool is unbiased.',
        importance: 5,
      });
      const verification = makeVerification('c1', 'contradicted');
      const result = mapClaimToRiskCategory(claim, verification);
      expect(result.riskLevel).toBe('high');
      expect(result.confidence).toBe('high');
    });

    it('should set medium confidence for supported claims in high-risk domain', () => {
      const claim = makeClaim({ text: 'The hiring algorithm is tested for bias.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'supported'));
      expect(result.riskLevel).toBe('high');
      expect(result.confidence).toBe('medium');
    });
  });

  describe('mapClaimToRiskCategory — limited risk', () => {
    it('should map contradicted generic claims to limited risk', () => {
      const claim = makeClaim({ text: 'Paris has 15 million residents.' });
      const verification = makeVerification('c1', 'contradicted');
      const result = mapClaimToRiskCategory(claim, verification);
      expect(result.riskLevel).toBe('limited');
      expect(result.matchedPatterns).toContain('Article 50 (AI-generated content)');
    });

    it('should map mixed generic claims to limited risk', () => {
      const claim = makeClaim({ text: 'GDP grew 3% last quarter.' });
      const verification = makeVerification('c1', 'mixed');
      const result = mapClaimToRiskCategory(claim, verification);
      expect(result.riskLevel).toBe('limited');
    });

    it('should have high confidence for contradicted claims', () => {
      const claim = makeClaim({ text: 'Wrong fact.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'contradicted'));
      expect(result.confidence).toBe('high');
    });

    it('should have medium confidence for mixed claims', () => {
      const claim = makeClaim({ text: 'Ambiguous fact.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'mixed'));
      expect(result.confidence).toBe('medium');
    });
  });

  describe('mapClaimToRiskCategory — minimal risk', () => {
    it('should map supported generic claims to minimal risk', () => {
      const claim = makeClaim({ text: 'Water boils at 100C at sea level.' });
      const verification = makeVerification('c1', 'supported');
      const result = mapClaimToRiskCategory(claim, verification);
      expect(result.riskLevel).toBe('minimal');
      expect(result.matchedPatterns).toEqual([]);
    });

    it('should map unverified generic claims to minimal risk', () => {
      const claim = makeClaim({ text: 'Some obscure trivia.' });
      const result = mapClaimToRiskCategory(claim, makeVerification('c1', 'unverified'));
      expect(result.riskLevel).toBe('minimal');
    });
  });
});

// ================================================================
// Compliance report generator
// ================================================================

describe('Compliance Report Generator', () => {
  it('should generate a report with correct structure', () => {
    const claims = [makeClaim()];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = generateComplianceReport(claims, verifications, 'low');

    expect(report.generatedAt).toBeTruthy();
    expect(report.overallRiskLevel).toBe('low');
    expect(report.euRiskSummary).toBeDefined();
    expect(report.claimMappings).toHaveLength(1);
    expect(report.triggeredArticles).toBeDefined();
    expect(Array.isArray(report.mitigations)).toBe(true);
  });

  it('should count risk tiers correctly', () => {
    const claims = [
      makeClaim({ id: 'c1', text: 'The social scoring system ranks people.' }),
      makeClaim({ id: 'c2', text: 'Facial recognition deployed at airport.' }),
      makeClaim({ id: 'c3', text: 'Paris is big.' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'supported'),
      c3: makeVerification('c3', 'contradicted'),
    };
    const report = generateComplianceReport(claims, verifications, 'high');

    expect(report.euRiskSummary.unacceptable).toBe(1);
    expect(report.euRiskSummary.high).toBe(1);
    expect(report.euRiskSummary.limited).toBe(1);
    expect(report.euRiskSummary.totalClaims).toBe(3);
    expect(report.euRiskSummary.highestTier).toBe('unacceptable');
  });

  it('should set highestTier to minimal when all claims are minimal', () => {
    const claims = [makeClaim({ id: 'c1', text: 'Water is H2O.' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = generateComplianceReport(claims, verifications, 'low');
    expect(report.euRiskSummary.highestTier).toBe('minimal');
  });

  it('should aggregate triggered articles from multiple claims', () => {
    const claims = [
      makeClaim({ id: 'c1', text: 'AI hiring tool screens applicants.' }),
      makeClaim({ id: 'c2', text: 'Automated recruitment reduces cost.' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'supported'),
    };
    const report = generateComplianceReport(claims, verifications, 'medium');

    // Both claims match employment/hiring → same Annex III ref
    const empArticle = report.triggeredArticles.find(a => a.article.includes('Annex III §4'));
    expect(empArticle).toBeDefined();
    expect(empArticle!.claimIds).toContain('c1');
    expect(empArticle!.claimIds).toContain('c2');
  });

  it('should skip claims without verification results', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
    ];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = generateComplianceReport(claims, verifications, 'low');
    expect(report.claimMappings).toHaveLength(1);
    expect(report.euRiskSummary.totalClaims).toBe(1);
  });

  it('should generate mitigations for unacceptable tier', () => {
    const claims = [makeClaim({ id: 'c1', text: 'Uses social scoring for access control.' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = generateComplianceReport(claims, verifications, 'critical');
    expect(report.mitigations.some(m => m.includes('CRITICAL'))).toBe(true);
    expect(report.mitigations.some(m => m.includes('Article 5'))).toBe(true);
  });

  it('should generate mitigations for high-risk tier', () => {
    const claims = [makeClaim({ id: 'c1', text: 'AI determines credit scoring eligibility.' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = generateComplianceReport(claims, verifications, 'high');
    expect(report.mitigations.some(m => m.includes('risk management'))).toBe(true);
  });

  it('should generate mitigations for limited-risk tier', () => {
    const claims = [makeClaim({ id: 'c1', text: 'Wrong fact about population.' })];
    const verifications = { c1: makeVerification('c1', 'contradicted') };
    const report = generateComplianceReport(claims, verifications, 'medium');
    expect(report.mitigations.some(m => m.includes('Article 50'))).toBe(true);
  });

  it('should handle empty claims array', () => {
    const report = generateComplianceReport([], {}, 'low');
    expect(report.euRiskSummary.totalClaims).toBe(0);
    expect(report.euRiskSummary.highestTier).toBe('minimal');
    expect(report.mitigations.some(m => m.includes('No verified claims'))).toBe(true);
  });

  it('should generate minimal-risk mitigation when all claims are safe', () => {
    const claims = [makeClaim({ id: 'c1', text: 'The sky is blue.' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = generateComplianceReport(claims, verifications, 'low');
    expect(report.mitigations.some(m => m.includes('voluntary codes'))).toBe(true);
  });
});
