// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint, batch 4)
//
// Fourth targeted batch. Kills survivors via:
//   1. Multi-element finding arrays → kills some()→every() MethodExpression mutants
//   2. Negative assertions → kills condition→true ConditionalExpression mutants
//   3. Specific text substring assertions → kills StringLiteral mutants
//   4. BooleanLiteral flips on negated !findings.some() guards (Art.12)
//
// Coverage targets (by line band):
//   300–349: getRemediations Art.10 (46 survivors)
//   650–699: buildTestCategoryMappings Art.6 unacceptable riskLevel (43 survivors)
//   300–399: getRemediations Art.11/12/13/14/15/52 (additional kills)
//   1200–1249: renderCiGateOutput annex item icons + arithmetic (42 survivors)

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import {
  buildEuComplianceReport,
  evaluateComplianceGate,
  renderCiGateOutput,
  getRemediations,
} from '../cli/compliance-report.js';
import type { EuAiActComplianceReport } from '../cli/compliance-report.js';
import type { ScanResult } from '../cli/scan.js';
import type { ComplianceReport } from '../compliance/report_generator.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeComplianceReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    generatedAt: new Date().toISOString(),
    overallRiskLevel: 'low',
    euRiskSummary: {
      unacceptable: 0, high: 0, limited: 0, minimal: 2, totalClaims: 2, highestTier: 'minimal',
    },
    claimMappings: [],
    triggeredArticles: [],
    mitigations: [],
    confidenceDistribution: { high: 1, medium: 1, low: 0 },
    ...overrides,
  };
}

function makeScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    input: 'Test.',
    provider: 'Mock Provider',
    claims: [
      { id: 'c1', text: 'Claim one.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Claim two.', type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
      c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: makeComplianceReport(),
    ruleFindings: [],
    ...overrides,
  };
}

function makeMinimalReport(overrides: Partial<EuAiActComplianceReport> = {}): EuAiActComplianceReport {
  return {
    generatedAt: new Date().toISOString(),
    documentRef: `FP-TEST-${Date.now()}`,
    projectName: 'Test', provider: 'mock',
    overallRisk: 'low',
    articleEvidence: [],
    article50Disclosure: { status: 'not-applicable', note: '', voiceAudioDisclosure: '' },
    testCategoryMappings: [], complianceScore: 80,
    annexIIIChecklist: { applicable: false, passRate: 1, items: [] },
    summary: { compliantArticles: 0, nonCompliantArticles: 0, partialArticles: 0, gapArticles: 0, totalClaimsAnalyzed: 0, highRiskFindings: 0 },
    ...overrides,
  };
}

// ── Group H4a: getRemediations Art.10 — multi-element + negative + specific text ──

describe('N-210 H4a — getRemediations Art.10 multi-element + negative + specific text', () => {
  it('H4a-1: bias multi-element findings → bias audit present (kills some→every)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 bias finding(s) detected.', 'unrelated data finding']);
    // some([bias, unrelated]).includes('bias') = true; every = false → kills some→every
    expect(rems.some(r => r.includes('bias audit'))).toBe(true);
  });

  it('H4a-2: no bias keyword in findings → bias audit ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['3 high-importance claims unverified.', 'data governance issue']);
    expect(rems.some(r => r.includes('bias audit'))).toBe(false);
  });

  it('H4a-3: bias specific text Art. 10(2)(f) (kills StringLiteral)', () => {
    const rems = getRemediations('Article 10', 'non-compliant',
      ['1 bias finding(s) detected.', 'unrelated finding']);
    expect(rems.some(r => r.includes('Art. 10(2)(f)'))).toBe(true);
  });

  it('H4a-4: bias specific text document methodology (kills StringLiteral)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 bias finding(s) detected.', 'unrelated finding']);
    expect(rems.some(r => r.includes('Document bias detection methodology'))).toBe(true);
  });

  it('H4a-5: PII multi-element findings → special category present (kills some→every)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 PII finding(s) detected.', 'unrelated data finding']);
    expect(rems.some(r => r.includes('special category'))).toBe(true);
  });

  it('H4a-6: no PII keyword → special category ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 bias finding(s) detected.', 'unrelated finding']);
    expect(rems.some(r => r.includes('special category'))).toBe(false);
  });

  it('H4a-7: PII specific text GDPR compliance (kills StringLiteral)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 PII finding(s) detected.', 'unrelated finding']);
    expect(rems.some(r => r.includes('GDPR compliance'))).toBe(true);
  });

  it('H4a-8: contradicted multi-element → training data quality present (kills some→every)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 contradicted claim(s).', 'unrelated data finding about governance']);
    expect(rems.some(r => r.includes('training data quality'))).toBe(true);
  });

  it('H4a-9: no contradicted keyword → training data quality ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 bias finding(s) detected.', 'unverified claim issue']);
    // Neither contains 'contradicted'
    expect(rems.some(r => r.includes('training data quality'))).toBe(false);
  });

  it('H4a-10: contradicted specific text Art. 10(3) (kills StringLiteral)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 contradicted claim(s).', 'unrelated finding']);
    expect(rems.some(r => r.includes('Art. 10(3)'))).toBe(true);
  });

  it('H4a-11: unverified multi-element → data completeness present (kills some→every)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 high-importance claim(s) unverified.', 'bias finding detected here']);
    // some([unverified, bias]).includes('unverified') = true; every = false
    expect(rems.some(r => r.includes('data completeness'))).toBe(true);
  });

  it('H4a-12: no unverified keyword → data completeness ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 bias finding(s) detected.', 'PII processing issue']);
    expect(rems.some(r => r.includes('data completeness'))).toBe(false);
  });

  it('H4a-13: unverified specific text training data coverage (kills StringLiteral)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 high-importance claim(s) unverified.', 'unrelated finding']);
    expect(rems.some(r => r.includes('training data coverage'))).toBe(true);
  });

  it('H4a-14: fallback absent when keyword branches triggered (kills fallback condition→true)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['1 contradicted claim(s).']);
    // At least one branch fires → rems.length > 0 → fallback NOT added
    expect(rems.some(r => r.includes('data governance practices'))).toBe(false);
  });

  it('H4a-15: fallback present when no keyword matches (kills fallback condition→false)', () => {
    const rems = getRemediations('Article 10', 'partial',
      ['Some generic data quality issue.']);
    expect(rems.some(r => r.includes('data governance practices'))).toBe(true);
  });
});

// ── Group H4b: getRemediations Art.11 — multi-element + negative + specific text ──

describe('N-210 H4b — getRemediations Art.11 multi-element + negative + specific text', () => {
  it('H4b-1: insufficient multi-element → verification explanations present (kills some→every)', () => {
    const rems = getRemediations('Article 11', 'partial',
      ['documentation insufficient — coverage 40%', 'unrelated finding about sources']);
    expect(rems.some(r => r.includes('verification explanations'))).toBe(true);
  });

  it('H4b-2: no insufficient keyword → verification explanations ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 11', 'partial',
      ['source citations missing from some outputs', 'generic doc issue']);
    expect(rems.some(r => r.includes('verification explanations'))).toBe(false);
  });

  it('H4b-3: insufficient specific text Art. 11(1)(a) (kills StringLiteral)', () => {
    const rems = getRemediations('Article 11', 'gap',
      ['documentation insufficient — coverage 20%', 'unrelated finding']);
    expect(rems.some(r => r.includes('Art. 11(1)(a)'))).toBe(true);
  });

  it('H4b-4: sources multi-element → source citations present (kills some→every)', () => {
    const rems = getRemediations('Article 11', 'partial',
      ['documentation lacks sources for some outputs', 'other documentation issue']);
    expect(rems.some(r => r.includes('source citations'))).toBe(true);
  });

  it('H4b-5: no sources keyword → source citations ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 11', 'partial',
      ['documentation insufficient — coverage 40%', 'generic issue']);
    expect(rems.some(r => r.includes('source citations'))).toBe(false);
  });

  it('H4b-6: always-push technical documentation present regardless (kills StringLiteral)', () => {
    const rems = getRemediations('Article 11', 'partial', []);
    expect(rems.some(r => r.includes('technical documentation'))).toBe(true);
  });

  it('H4b-7: always-push contains system design keyword (kills StringLiteral)', () => {
    const rems = getRemediations('Article 11', 'gap', ['No explanations found.']);
    expect(rems.some(r => r.includes('system design'))).toBe(true);
  });
});

// ── Group H4c: getRemediations Art.12 — negated !some() guards ────────────────

describe('N-210 H4c — getRemediations Art.12 negated !some() guards', () => {
  it('H4c-1: Provider recorded in findings → "Record AI system provider" ABSENT (kills BooleanLiteral flip)', () => {
    const rems = getRemediations('Article 12', 'partial',
      ['Provider recorded: Mock Provider v1.0', 'rule finding: bias-check']);
    // !some(includes 'Provider recorded') = !true = false → NOT pushed
    expect(rems.some(r => r.includes('Record AI system provider'))).toBe(false);
  });

  it('H4c-2: Provider recorded in one of multiple findings → Record absent (kills some→every)', () => {
    // some=true (first matches), every=false (second doesn't) → !every=true (mutated: IS pushed)
    const rems = getRemediations('Article 12', 'partial',
      ['Provider recorded: Mock Provider v1.0', 'unrelated monitoring finding']);
    expect(rems.some(r => r.includes('Record AI system provider'))).toBe(false);
  });

  it('H4c-3: no Provider recorded → "Record AI system provider" IS present (kills condition→false)', () => {
    const rems = getRemediations('Article 12', 'gap',
      ['Provider information missing from scan.', 'No rule findings.']);
    expect(rems.some(r => r.includes('Record AI system provider'))).toBe(true);
  });

  it('H4c-4: rule finding in findings → "monitoring rules" ABSENT (kills BooleanLiteral flip)', () => {
    const rems = getRemediations('Article 12', 'partial',
      ['Provider recorded: Mock Provider', 'rule finding: bias-detection triggered']);
    // !some(includes 'rule finding') = !true = false → NOT pushed
    expect(rems.some(r => r.includes('monitoring rules'))).toBe(false);
  });

  it('H4c-5: rule finding in one of multiple findings → monitoring absent (kills some→every)', () => {
    const rems = getRemediations('Article 12', 'partial',
      ['rule finding: anomaly-detect triggered', 'provider data unavailable']);
    expect(rems.some(r => r.includes('monitoring rules'))).toBe(false);
  });

  it('H4c-6: no rule finding → "monitoring rules" IS present (kills condition→false)', () => {
    const rems = getRemediations('Article 12', 'gap',
      ['Provider recorded: Mock Provider', 'No monitoring hooks registered.']);
    expect(rems.some(r => r.includes('monitoring rules'))).toBe(true);
  });

  it('H4c-7: always-push event logging present regardless (kills StringLiteral)', () => {
    const rems = getRemediations('Article 12', 'partial',
      ['Provider recorded: Mock', 'rule finding: x']);
    expect(rems.some(r => r.includes('event logging'))).toBe(true);
  });

  it('H4c-8: always-push specific text Art. 12 lifecycle (kills StringLiteral)', () => {
    const rems = getRemediations('Article 12', 'gap', []);
    expect(rems.some(r => r.includes('AI system lifecycle per Art. 12'))).toBe(true);
  });
});

// ── Group H4d: getRemediations Art.13 — multi-element + negative + specific text ──

describe('N-210 H4d — getRemediations Art.13 multi-element + negative + specific text', () => {
  it('H4d-1: unverified multi-element → source attribution present (kills some→every)', () => {
    const rems = getRemediations('Article 13', 'partial',
      ['2 unverified/mixed claim(s) found.', 'unrelated transparency finding']);
    expect(rems.some(r => r.includes('source attribution'))).toBe(true);
  });

  it('H4d-2: mixed keyword only (|| left operand absent) → source attribution present (kills ||→&&)', () => {
    const rems = getRemediations('Article 13', 'partial',
      ['3 mixed-evidence claim(s) detected.', 'unrelated finding']);
    // 'mixed' matches but 'unverified' does NOT → || passes, && fails → kills ||→&&
    expect(rems.some(r => r.includes('source attribution'))).toBe(true);
  });

  it('H4d-3: no unverified or mixed keyword → source attribution ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 13', 'partial',
      ['No claims extracted from this content.', 'generic transparency gap']);
    expect(rems.some(r => r.includes('source attribution'))).toBe(false);
  });

  it('H4d-4: unverified multi-element → confidence scoring present (kills some→every)', () => {
    const rems = getRemediations('Article 13', 'partial',
      ['2 unverified claim(s).', 'unrelated finding']);
    expect(rems.some(r => r.includes('confidence scoring'))).toBe(true);
  });

  it('H4d-5: "No claims extracted" multi-element → verifiable factual present (kills some→every)', () => {
    const rems = getRemediations('Article 13', 'gap',
      ['No claims extracted.', 'transparency documentation missing']);
    expect(rems.some(r => r.includes('verifiable factual statements'))).toBe(true);
  });

  it('H4d-6: no "No claims extracted" keyword → verifiable factual ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 13', 'partial',
      ['2 unverified claim(s) detected.', 'generic issue']);
    expect(rems.some(r => r.includes('verifiable factual statements'))).toBe(false);
  });

  it('H4d-7: always-push capabilities present regardless (kills StringLiteral)', () => {
    const rems = getRemediations('Article 13', 'partial', []);
    expect(rems.some(r => r.includes('capabilities'))).toBe(true);
  });

  it('H4d-8: always-push specific text intended purpose (kills StringLiteral)', () => {
    const rems = getRemediations('Article 13', 'gap', ['No claims.']);
    expect(rems.some(r => r.includes('intended purpose'))).toBe(true);
  });
});

// ── Group H4e: getRemediations Art.14 — specific text (unconditional pushes) ──

describe('N-210 H4e — getRemediations Art.14 specific text assertions', () => {
  it('H4e-1: human-in-the-loop text present (kills StringLiteral)', () => {
    const rems = getRemediations('Article 14', 'partial', ['Some finding.']);
    expect(rems.some(r => r.includes('human-in-the-loop'))).toBe(true);
  });

  it('H4e-2: oversight procedures text present (kills StringLiteral)', () => {
    const rems = getRemediations('Article 14', 'partial', []);
    expect(rems.some(r => r.includes('oversight procedures'))).toBe(true);
  });

  it('H4e-3: escalation paths text present (kills StringLiteral)', () => {
    const rems = getRemediations('Article 14', 'gap', []);
    expect(rems.some(r => r.includes('escalation paths'))).toBe(true);
  });

  it('H4e-4: exactly 2 remediations for Art.14 (validates unconditional structure)', () => {
    const rems = getRemediations('Article 14', 'partial', ['3 interpretation claims.']);
    expect(rems.length).toBe(2);
  });
});

// ── Group H4f: getRemediations Art.15 — multi-element + negative + specific text ──

describe('N-210 H4f — getRemediations Art.15 multi-element + negative + specific text', () => {
  it('H4f-1: contradicted multi-element → accuracy investigation present (kills some→every)', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['40% claims contradicted — accuracy requirement failed.', 'unrelated robustness issue']);
    expect(rems.some(r => r.includes('contradicted claims'))).toBe(true);
  });

  it('H4f-2: no contradicted keyword → accuracy investigation ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 15', 'partial',
      ['1 unverified claim(s) — robustness incomplete.', 'injection pattern detected']);
    expect(rems.some(r => r.includes('contradicted claims'))).toBe(false);
  });

  it('H4f-3: contradicted specific text Art. 15(1) (kills StringLiteral)', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['30% claims contradicted.', 'other finding']);
    expect(rems.some(r => r.includes('Art. 15(1)'))).toBe(true);
  });

  it('H4f-4: robustness multi-element → robustness testing present (kills some→every)', () => {
    const rems = getRemediations('Article 15', 'partial',
      ['robustness assessment required.', 'unrelated accuracy finding']);
    expect(rems.some(r => r.includes('robustness testing'))).toBe(true);
  });

  it('H4f-5: unverified-only (|| right operand) → robustness testing present (kills ||→&&)', () => {
    // 'unverified' matches but 'robustness' does NOT in the finding text
    const rems = getRemediations('Article 15', 'partial',
      ['1 unverified claim(s) detected.', 'accuracy issue here']);
    // || passes, && would fail → kills ||→&&
    expect(rems.some(r => r.includes('robustness testing'))).toBe(true);
  });

  it('H4f-6: no robustness/unverified keyword → robustness testing ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 15', 'partial',
      ['injection pattern detected.', 'contradicted claim found here']);
    expect(rems.some(r => r.includes('robustness testing'))).toBe(false);
  });

  it('H4f-7: injection multi-element → prompt injection defenses present (kills some→every)', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['1 injection/attack pattern(s) detected.', 'unrelated robustness issue']);
    expect(rems.some(r => r.includes('prompt injection defenses'))).toBe(true);
  });

  it('H4f-8: cybersecurity-only (|| right operand) → injection defenses present (kills ||→&&)', () => {
    // 'cybersecurity' matches but 'injection' does NOT in the finding text
    const rems = getRemediations('Article 15', 'non-compliant',
      ['cybersecurity gap identified.', 'unrelated accuracy issue']);
    expect(rems.some(r => r.includes('prompt injection defenses'))).toBe(true);
  });

  it('H4f-9: no injection/cybersecurity keyword → injection defenses ABSENT (kills condition→true)', () => {
    const rems = getRemediations('Article 15', 'partial',
      ['robustness assessment required.', 'unverified claims present']);
    expect(rems.some(r => r.includes('prompt injection defenses'))).toBe(false);
  });

  it('H4f-10: injection specific text Art. 15(3) (kills StringLiteral)', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['1 injection pattern detected.', 'unrelated finding']);
    expect(rems.some(r => r.includes('Art. 15(3)'))).toBe(true);
  });

  it('H4f-11: OWASP Agentic AI text present (kills StringLiteral)', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['injection detected.', 'other finding']);
    expect(rems.some(r => r.includes('OWASP'))).toBe(true);
  });

  it('H4f-12: fallback absent when contradicted branch triggered (kills fallback condition→true)', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['30% claims contradicted.']);
    expect(rems.some(r => r.includes('accuracy metrics'))).toBe(false);
  });

  it('H4f-13: fallback present when no keyword matches (kills fallback condition→false)', () => {
    const rems = getRemediations('Article 15', 'partial',
      ['Some generic accuracy finding.']);
    expect(rems.some(r => r.includes('accuracy metrics'))).toBe(true);
  });
});

// ── Group H4g: buildTestCategoryMappings — unacceptable riskLevel + annex refs ──

describe('N-210 H4g — buildTestCategoryMappings unacceptable riskLevel + Art.6 findings', () => {
  it('H4g-1: claimMappings with riskLevel unacceptable → Art.6 testCategoryMapping present (kills riskLevel check)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometric categorisation.', verificationStatus: 'supported', riskLevel: 'unacceptable',
          category: { level: 'unacceptable', title: 'Prohibited', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometric categorisation'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6Mapping = report.testCategoryMappings.find(
      m => m.euArticle && m.euArticle.includes('Article 6'),
    );
    expect(art6Mapping).toBeDefined();
  });

  it('H4g-2: claimMappings riskLevel medium → no Art.6 testCategoryMapping (kills riskLevel→true)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Some pattern.', verificationStatus: 'supported', riskLevel: 'limited',
          category: { level: 'limited', title: 'Limited', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['some pattern'], confidence: 'medium', confidenceScore: 0.5,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6Mapping = report.testCategoryMappings.find(
      m => m.euArticle && m.euArticle.includes('Article 6'),
    );
    expect(art6Mapping).toBeUndefined();
  });

  it('H4g-3: unacceptable riskLevel → Art.6 mapping status is partial (kills status StringLiteral)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Emotion recognition.', verificationStatus: 'supported', riskLevel: 'unacceptable',
          category: { level: 'unacceptable', title: 'Prohibited', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['emotion recognition'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6Mapping = report.testCategoryMappings.find(
      m => m.euArticle && m.euArticle.includes('Article 6'),
    );
    expect(art6Mapping?.status).toBe('partial');
  });

  it('H4g-4: annexRefs ≤ 3 unique patterns → no "(and more)" in Art.6 finding (kills > 3 comparison)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometrics employment education.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometrics', 'employment', 'education'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(e => e.article.includes('Article 6'));
    expect(art6?.findings[0]).not.toContain('(and more)');
  });

  it('H4g-5: annexRefs > 3 unique patterns → "(and more)" in Art.6 finding (kills > 3 comparison)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Healthcare AI system.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometrics', 'employment', 'education', 'healthcare'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(e => e.article.includes('Article 6'));
    expect(art6?.findings[0]).toContain('(and more)');
  });

  it('H4g-6: Art.6 finding text contains Annex III (kills StringLiteral in finding push)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometric categorisation.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometric categorisation'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(e => e.article.includes('Article 6'));
    expect(art6?.findings[0]).toContain('Annex III high-risk domain');
  });

  it('H4g-7: Art.6 finding text contains Art. 49 reference (kills StringLiteral in second finding)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometric categorisation.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometric categorisation'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(e => e.article.includes('Article 6'));
    expect(art6?.findings[1]).toContain('Art. 49');
  });

  it('H4g-8: no high-risk claimMappings → Art.6 status not-applicable (kills art6Status condition)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art6 = report.articleEvidence.find(e => e.article.includes('Article 6'));
    expect(art6?.status).toBe('not-applicable');
  });

  it('H4g-9: Art.6 remediation references Art. 49 when Annex III found (kills StringLiteral at remediation push)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometric categorisation.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometric categorisation'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(e => e.article.includes('Article 6'));
    expect(art6?.remediations?.some(r => r.includes('Article 49'))).toBe(true);
  });
});

// ── Group H4h: renderCiGateOutput annex item icons + arithmetic ───────────────

describe('N-210 H4h — renderCiGateOutput annex item icons and arithmetic', () => {
  function makeAnnexReport(items: EuAiActComplianceReport['annexIIIChecklist']['items'], passRate = 0.5): EuAiActComplianceReport {
    return makeMinimalReport({
      overallRisk: 'high',
      annexIIIChecklist: { applicable: true, passRate, items },
      articleEvidence: [
        {
          article: 'Article 9 – Risk Management System',
          requirement: 'R', status: 'partial',
          findings: ['High risk.'], remediations: [],
          evidenceCount: 0, sourceCount: 0, strengthScore: 0,
        },
      ],
    });
  }

  it('H4h-1: annex item status pass → [PASS] icon in output (kills status StringLiteral)', () => {
    const report = makeAnnexReport([
      { id: 'a-9', article: 'Art. 9', requirement: 'Risk management', status: 'pass', evidence: 'e' },
    ]);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('[PASS]');
    expect(output).toContain('Art. 9');
  });

  it('H4h-2: annex item status fail → [FAIL] icon in output (kills status StringLiteral)', () => {
    const report = makeAnnexReport([
      { id: 'a-10', article: 'Art. 10', requirement: 'Data governance', status: 'fail', evidence: 'e' },
    ]);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('[FAIL]');
  });

  it('H4h-3: annex item status partial → [PART] icon in output (kills status StringLiteral)', () => {
    const report = makeAnnexReport([
      { id: 'a-11', article: 'Art. 11', requirement: 'Technical doc', status: 'partial', evidence: 'e' },
    ]);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('[PART]');
  });

  it('H4h-4: passRate 0.75 → 75% shown in output (kills * 100 arithmetic)', () => {
    const report = makeAnnexReport([
      { id: 'a-9', article: 'Art. 9', requirement: 'Risk', status: 'pass', evidence: 'e' },
    ], 0.75);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('75%');
  });

  it('H4h-5: passRate 0.50 → 50% shown in output (kills * 100 arithmetic)', () => {
    const report = makeAnnexReport([
      { id: 'a-9', article: 'Art. 9', requirement: 'Risk', status: 'fail', evidence: 'e' },
    ], 0.50);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('50%');
  });

  it('H4h-6: pass rate text label present (kills StringLiteral for "Pass rate:" label)', () => {
    const report = makeAnnexReport([
      { id: 'a-9', article: 'Art. 9', requirement: 'Risk', status: 'pass', evidence: 'e' },
    ], 1.0);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Pass rate:');
  });
});

// ── Group H4i: getRemediations Art.6 — Annex III branch ──────────────────────

describe('N-210 H4i — getRemediations Art.6 Annex III branch', () => {
  it('H4i-1: Annex III in findings → conformity assessment remediation present (kills condition)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['1 claim(s) reference Annex III high-risk domain.', 'other finding']);
    expect(rems.some(r => r.includes('conformity assessment'))).toBe(true);
  });

  it('H4i-2: Annex III multi-element → conformity assessment present (kills some→every)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['Annex III domain detected.', 'content touches high-risk area']);
    // some=true (first has Annex III), every=false (second doesn't) → kills some→every
    expect(rems.some(r => r.includes('conformity assessment'))).toBe(true);
  });

  it('H4i-3: Annex III finding → Article 49 database registration mentioned (kills StringLiteral)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['Annex III domain.', 'other finding']);
    expect(rems.some(r => r.includes('Article 49'))).toBe(true);
  });

  it('H4i-4: Annex III finding → Chapter 3 obligations mentioned (kills StringLiteral)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['Annex III domain.', 'other finding']);
    expect(rems.some(r => r.includes('Chapter 3'))).toBe(true);
  });

  it('H4i-5: no Annex III keyword → fallback remediation present (kills condition→true)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['Some classification finding.', 'other issue']);
    expect(rems.some(r => r.includes('Annex III classification criteria'))).toBe(true);
  });

  it('H4i-6: no Annex III keyword → conformity assessment absent (kills fallback condition→false)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['Some classification finding.']);
    expect(rems.some(r => r.includes('EU database'))).toBe(false);
  });

  it('H4i-7: fallback absent when Annex III triggers (kills fallback rems.length===0 condition→true)', () => {
    const rems = getRemediations('Article 6', 'partial',
      ['Annex III domain.']);
    expect(rems.some(r => r.includes('Annex III classification criteria'))).toBe(false);
  });
});
