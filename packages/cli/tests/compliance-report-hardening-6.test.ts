// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint, batch 6)
//
// Sixth targeted batch. Key targets:
//   Band 700-799: art9-14 fallback texts (ArrayDeclaration→[], condition→true/false)
//                 + requirement StringLiteral mutations
//   Band 1050-1099: annexIIIChecklist requirement strings + evidence template literals
//   Band 1200-1259: renderCiGateOutput header labels + toUpperCase() MethodExpression
//                   + totalArticles-nonCompliantCount arithmetic + fail-block conditionals
//
// Pattern: each group has:
//   - Fallback assertion (clean scan → fallback text present, kills ArrayDeclaration→[] and condition→true)
//   - Active finding assertion (populated scan → actual text present, kills condition→false)
//   - Requirement string assertion (kills StringLiteral on requirement field)

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import {
  buildEuComplianceReport,
  renderCiGateOutput,
} from '../cli/compliance-report.js';
import type { EuAiActComplianceReport, CiGateResult } from '../cli/compliance-report.js';
import type { ScanResult } from '../cli/scan.js';
import type { ComplianceReport } from '../compliance/report_generator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeComplianceReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    generatedAt: new Date().toISOString(),
    overallRiskLevel: 'low',
    euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 2, totalClaims: 2, highestTier: 'minimal' },
    claimMappings: [], triggeredArticles: [], mitigations: [],
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
    documentRef: `FP-B6-${Date.now()}`,
    projectName: 'Test Project', provider: 'mock',
    overallRisk: 'low',
    articleEvidence: [],
    article50Disclosure: { status: 'not-applicable', note: '', voiceAudioDisclosure: '' },
    testCategoryMappings: [], complianceScore: 85,
    annexIIIChecklist: { applicable: false, passRate: 1, items: [] },
    summary: { compliantArticles: 0, nonCompliantArticles: 0, partialArticles: 0, gapArticles: 0, totalClaimsAnalyzed: 0, highRiskFindings: 0 },
    ...overrides,
  };
}

function makeGate(overrides: Partial<CiGateResult> = {}): CiGateResult {
  return {
    pass: true,
    overallRisk: 'low',
    articles: [],
    nonCompliantCount: 0,
    totalArticles: 3,
    exitCode: 0,
    complianceScore: 85,
    threshold: 0,
    art6ConformityRequired: false,
    ...overrides,
  };
}

// ── Group H6a: Art.9 fallback text + requirement ──────────────────────────────
// Fallback: 'No risk management findings. All claims verified within acceptable thresholds.'

describe('N-210 H6a — Art.9 fallback text + requirement', () => {
  it('H6a-1: clean scan → Art.9 fallback fires (kills ArrayDeclaration→[] + condition→true)', () => {
    // No contradictions, no bias/injection, overallRisk=low → art9Findings empty → fallback
    const report = buildEuComplianceReport(makeScan());
    const art9 = report.articleEvidence.find(a => a.article.includes('Article 9'))!;
    expect(art9.findings.length).toBeGreaterThan(0);
    expect(art9.findings[0]).toContain('All claims verified within acceptable thresholds');
  });

  it('H6a-2: Art.9 requirement contains lifecycle risk management text (kills StringLiteral)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art9 = report.articleEvidence.find(a => a.article.includes('Article 9'))!;
    expect(art9.requirement).toContain('continuous risk management system');
    expect(art9.requirement).toContain('identification, analysis, estimation');
  });

  it('H6a-3: high-risk scan → Art.9 active finding, not fallback (kills condition→false)', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const art9 = report.articleEvidence.find(a => a.article.includes('Article 9'))!;
    expect(art9.findings.some(f => f.includes('Annex III conformity assessment required'))).toBe(true);
    expect(art9.findings.some(f => f.includes('All claims verified within acceptable thresholds'))).toBe(false);
  });
});

// ── Group H6b: Art.10 fallback text + requirement ─────────────────────────────
// Fallback: 'No data governance findings. Training data quality indicators within acceptable thresholds.'

describe('N-210 H6b — Art.10 fallback text + requirement', () => {
  it('H6b-1: clean scan → Art.10 fallback fires (kills ArrayDeclaration→[] + condition→true)', () => {
    // No bias/PII ruleFindings, no contradictions, importance-4 claim is supported → art10Findings empty
    const report = buildEuComplianceReport(makeScan());
    const art10 = report.articleEvidence.find(a => a.article.includes('Article 10'))!;
    expect(art10.findings.length).toBeGreaterThan(0);
    expect(art10.findings[0]).toContain('acceptable thresholds');
    expect(art10.findings[0]).toContain('No data governance findings');
  });

  it('H6b-2: Art.10 requirement contains training/validation data text (kills StringLiteral)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art10 = report.articleEvidence.find(a => a.article.includes('Article 10'))!;
    expect(art10.requirement).toContain('Training, validation, and testing data sets shall be');
    expect(art10.requirement).toContain('bias detection');
  });

  it('H6b-3: contradicted claim → Art.10 active finding, not fallback (kills condition→false)', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
      },
    }));
    const art10 = report.articleEvidence.find(a => a.article.includes('Article 10'))!;
    expect(art10.findings.some(f => f.includes('contradicted claim'))).toBe(true);
    expect(art10.findings.some(f => f.includes('No data governance findings'))).toBe(false);
  });
});

// ── Group H6c: Art.11 fallback text + requirement ─────────────────────────────
// Fallback: 'Technical documentation assessment: no claims to evaluate.'

describe('N-210 H6c — Art.11 fallback text + requirement', () => {
  it('H6c-1: zero-claims scan → Art.11 fallback fires (kills ArrayDeclaration→[] + condition→true)', () => {
    // claims=[] → claimsWithExplanation=0, claimsWithSources=0, claims.length=0 → fallback
    const report = buildEuComplianceReport(makeScan({ claims: [], verifications: {} }));
    const art11 = report.articleEvidence.find(a => a.article.includes('Article 11'))!;
    expect(art11.findings.length).toBeGreaterThan(0);
    expect(art11.findings[0]).toContain('no claims to evaluate');
  });

  it('H6c-2: Art.11 requirement contains technical documentation text (kills StringLiteral)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art11 = report.articleEvidence.find(a => a.article.includes('Article 11'))!;
    expect(art11.requirement).toContain('Technical documentation shall be drawn up before the AI system');
    expect(art11.requirement).toContain('design specifications');
  });

  it('H6c-3: scan with explanations → Art.11 active finding, not fallback (kills condition→false)', () => {
    // Default scan: c1 has explanation='OK.' → claimsWithExplanation=[c1] → active finding fires
    const report = buildEuComplianceReport(makeScan());
    const art11 = report.articleEvidence.find(a => a.article.includes('Article 11'))!;
    expect(art11.findings.some(f => f.includes('verification explanations'))).toBe(true);
    expect(art11.findings.some(f => f.includes('no claims to evaluate'))).toBe(false);
  });
});

// ── Group H6d: Art.12 fallback text + requirement ─────────────────────────────
// Fallback: 'Record-keeping assessment: no logging evidence found.'

describe('N-210 H6d — Art.12 fallback text + requirement', () => {
  it('H6d-1: no-provider no-claims scan → Art.12 fallback fires (kills ArrayDeclaration→[] + condition→true)', () => {
    // provider='' (falsy), claims=[], ruleFindings=[] → art12Findings=[] → fallback
    const report = buildEuComplianceReport(
      makeScan({ provider: '', claims: [], verifications: {}, ruleFindings: [] }),
    );
    const art12 = report.articleEvidence.find(a => a.article.includes('Article 12'))!;
    expect(art12.findings.length).toBeGreaterThan(0);
    expect(art12.findings[0]).toContain('no logging evidence found');
  });

  it('H6d-2: Art.12 requirement contains automatic recording text (kills StringLiteral)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art12 = report.articleEvidence.find(a => a.article.includes('Article 12'))!;
    expect(art12.requirement).toContain('automatic recording of events');
    expect(art12.requirement).toContain('traceability of system functioning');
  });

  it('H6d-3: provider present + claims → Art.12 active findings, not fallback (kills condition→false)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art12 = report.articleEvidence.find(a => a.article.includes('Article 12'))!;
    expect(art12.findings.some(f => f.includes('Provider recorded:'))).toBe(true);
    expect(art12.findings.some(f => f.includes('no logging evidence found'))).toBe(false);
  });
});

// ── Group H6e: Art.13 fallback text + requirement ─────────────────────────────
// Fallback: 'No transparency gaps detected.'
// Fires when all claims are 'contradicted' (not supported/unverified/mixed)

describe('N-210 H6e — Art.13 fallback text + requirement', () => {
  it('H6e-1: all-contradicted scan → Art.13 fallback fires (kills ArrayDeclaration→[] + condition→true)', () => {
    // contradicted claims are not supportedClaims/unverifiedClaims → art13Findings empty → fallback
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Refuted.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Refuted.', sources: [] },
      },
    }));
    const art13 = report.articleEvidence.find(a => a.article.includes('Article 13'))!;
    expect(art13.findings.length).toBeGreaterThan(0);
    expect(art13.findings[0]).toBe('No transparency gaps detected.');
  });

  it('H6e-2: Art.13 requirement contains transparency text (kills StringLiteral)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(a => a.article.includes('Article 13'))!;
    expect(art13.requirement).toContain('sufficiently transparent to enable users');
    expect(art13.requirement).toContain('logic behind significant outputs');
  });

  it('H6e-3: supported claims → Art.13 active finding, not fallback (kills condition→false)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(a => a.article.includes('Article 13'))!;
    expect(art13.findings.some(f => f.includes('verified fact claim'))).toBe(true);
    expect(art13.findings.some(f => f.includes('No transparency gaps detected'))).toBe(false);
  });
});

// ── Group H6f: Art.14 fallback text + requirement ─────────────────────────────
// Fallback: 'No human oversight requirements triggered by this scan.'
// Fires when no interpretation claims and no mixed-status verifications

describe('N-210 H6f — Art.14 fallback text + requirement', () => {
  it('H6f-1: clean scan (fact type, supported) → Art.14 fallback fires (kills ArrayDeclaration→[])', () => {
    // interpretationClaims=0, mixedClaims=0 → art14Findings empty → fallback
    const report = buildEuComplianceReport(makeScan());
    const art14 = report.articleEvidence.find(a => a.article.includes('Article 14'))!;
    expect(art14.findings.length).toBeGreaterThan(0);
    expect(art14.findings[0]).toContain('No human oversight requirements triggered');
  });

  it('H6f-2: Art.14 requirement contains natural-persons oversight text (kills StringLiteral)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art14 = report.articleEvidence.find(a => a.article.includes('Article 14'))!;
    expect(art14.requirement).toContain('natural persons to effectively oversee and intervene');
    expect(art14.requirement).toContain('fundamental rights');
  });

  it('H6f-3: interpretation claim → Art.14 active finding, not fallback (kills condition→false)', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [
        { id: 'c1', text: 'I interpret this data as bullish.', type: 'interpretation', importance: 3 },
        { id: 'c2', text: 'Facts show growth.', type: 'fact', importance: 2 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
      },
    }));
    const art14 = report.articleEvidence.find(a => a.article.includes('Article 14'))!;
    expect(art14.findings.some(f => f.includes('interpretation claim(s) detected'))).toBe(true);
    expect(art14.findings.some(f => f.includes('No human oversight requirements triggered'))).toBe(false);
  });
});

// ── Group H6g: Annex III checklist requirement strings ────────────────────────
// Tests StringLiteral mutations on the static requirement fields for each annex item.
// Uses a high-risk scan so annexApplicable=true and all 8 items are present.

describe('N-210 H6g — annexIIIChecklist requirement strings', () => {
  function highRiskReport(): EuAiActComplianceReport {
    return buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
  }

  it('H6g-1: annex-iii-0 (Art.6) requirement contains conformity assessment text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-0')!;
    expect(item.requirement).toContain('conformity assessment obligation determined');
    expect(item.requirement).toContain('Annex III domain match');
  });

  it('H6g-2: annex-iii-1 (Art.9) requirement contains continuous identification text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-1')!;
    expect(item.requirement).toContain('continuous identification, analysis, evaluation');
    expect(item.requirement).toContain('treatment of risks');
  });

  it('H6g-3: annex-iii-2 (Art.10) requirement contains bias examination text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-2')!;
    expect(item.requirement).toContain('bias examination');
    expect(item.requirement).toContain('training data quality, completeness');
  });

  it('H6g-4: annex-iii-3 (Art.11) requirement contains post-market monitoring text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-3')!;
    expect(item.requirement).toContain('post-market monitoring');
    expect(item.requirement).toContain('sufficient for conformity assessment');
  });

  it('H6g-5: annex-iii-4 (Art.12) requirement contains automatic logging text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-4')!;
    expect(item.requirement).toContain('automatic logging of events');
    expect(item.requirement).toContain('AI system operation');
  });

  it('H6g-6: annex-iii-5 (Art.13) requirement contains AI output interpretation text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-5')!;
    expect(item.requirement).toContain('interpret and use AI output appropriately');
  });

  it('H6g-7: annex-iii-6 (Art.14) requirement contains effective oversight text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-6')!;
    expect(item.requirement).toContain('effective oversight by natural persons');
    expect(item.requirement).toContain('during operation');
  });

  it('H6g-8: annex-iii-7 (Art.15) requirement contains intended purpose text', () => {
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-7')!;
    expect(item.requirement).toContain('appropriate to intended purpose');
    expect(item.requirement).toContain('Accuracy, robustness');
  });
});

// ── Group H6h: annexIIIChecklist evidence template strings ────────────────────
// Tests 'Article N status: ...' evidence template for key annex items.
// Kills StringLiteral mutations on 'Article N status: ' prefix.

describe('N-210 H6h — annexIIIChecklist evidence template strings', () => {
  function highRiskReport(): EuAiActComplianceReport {
    return buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
  }

  it('H6h-1: annex-iii-0 evidence = "Article 6 status: not-applicable" (kills StringLiteral prefix)', () => {
    // No highRiskMappings → art6Status=not-applicable
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-0')!;
    expect(item.evidence).toContain('Article 6 status:');
    expect(item.evidence).toContain('not-applicable');
  });

  it('H6h-2: annex-iii-1 evidence = "Article 9 status: partial" (overallRisk=high adds art9 finding)', () => {
    // high-risk scan → art9Status=partial → evidence has 'partial'
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-1')!;
    expect(item.evidence).toContain('Article 9 status:');
    expect(item.evidence).toContain('partial');
  });

  it('H6h-3: annex-iii-2 evidence = "Article 10 status: compliant" (no art10 findings)', () => {
    // No bias/PII/contradictions → art10Status=compliant
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-2')!;
    expect(item.evidence).toContain('Article 10 status:');
    expect(item.evidence).toContain('compliant');
  });

  it('H6h-4: annex-iii-7 evidence = "Article 15 status: compliant" (no accuracy/robustness issues)', () => {
    // No contradictions, no injection → art15Status=compliant
    const report = highRiskReport();
    const item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-7')!;
    expect(item.evidence).toContain('Article 15 status:');
    expect(item.evidence).toContain('compliant');
  });
});

// ── Group H6i: renderCiGateOutput header strings + arithmetic ─────────────────
// Tests StringLiteral survivors, MethodExpression (toUpperCase), ArithmeticOperator (-→+),
// and ConditionalExpression survivors in the renderCiGateOutput function.

describe('N-210 H6i — renderCiGateOutput header strings and arithmetic', () => {
  it('H6i-1: pass gate → output contains full PASS header (kills "PASS" StringLiteral)', () => {
    const output = renderCiGateOutput(makeGate({ pass: true }), makeMinimalReport());
    expect(output).toContain('EU AI Act Compliance Gate — PASS');
  });

  it('H6i-2: fail gate → output contains full FAIL header (kills "FAIL" StringLiteral)', () => {
    const output = renderCiGateOutput(makeGate({ pass: false, exitCode: 1 }), makeMinimalReport());
    expect(output).toContain('EU AI Act Compliance Gate — FAIL');
  });

  it('H6i-3: overallRisk=low → output contains "Overall Risk: LOW" (kills toUpperCase + StringLiteral)', () => {
    // toUpperCase→toLowerCase would give 'Overall Risk: low'
    const output = renderCiGateOutput(
      makeGate({ overallRisk: 'low' }),
      makeMinimalReport({ overallRisk: 'low' }),
    );
    expect(output).toContain('Overall Risk: LOW');
    expect(output).not.toContain('Overall Risk: low');
  });

  it('H6i-4: overallRisk=high → output contains "Overall Risk: HIGH" (double-kills toUpperCase)', () => {
    const output = renderCiGateOutput(
      makeGate({ overallRisk: 'high', pass: false, exitCode: 1 }),
      makeMinimalReport({ overallRisk: 'high' }),
    );
    expect(output).toContain('Overall Risk: HIGH');
  });

  it('H6i-5: threshold=0 → no threshold label; score label present (kills threshold>0 condition)', () => {
    const output = renderCiGateOutput(
      makeGate({ complianceScore: 72, threshold: 0 }),
      makeMinimalReport({ complianceScore: 72 }),
    );
    expect(output).toContain('Score:        72/100');
    // threshold=0 → condition fires → no label; mutation threshold>=0 would add it even with 0
    expect(output).not.toContain('threshold:');
  });

  it('H6i-6: threshold=70 → score line shows threshold label (kills threshold StringLiteral + condition)', () => {
    const output = renderCiGateOutput(
      makeGate({ complianceScore: 80, threshold: 70 }),
      makeMinimalReport({ complianceScore: 80 }),
    );
    expect(output).toContain('(threshold: 70)');
  });

  it('H6i-7: projectName in output (kills "Project:      " StringLiteral)', () => {
    const output = renderCiGateOutput(
      makeGate(),
      makeMinimalReport({ projectName: 'MyAI System Alpha' }),
    );
    expect(output).toContain('Project:      MyAI System Alpha');
  });

  it('H6i-8: documentRef in output (kills "Document:     " StringLiteral)', () => {
    const output = renderCiGateOutput(
      makeGate(),
      makeMinimalReport({ documentRef: 'DOCREF-XYZ-001' }),
    );
    expect(output).toContain('Document:     DOCREF-XYZ-001');
  });

  it('H6i-9: 7 articles, 2 non-compliant → "5/7 passing" (kills -→+ ArithmeticOperator)', () => {
    // Mutation -→+: would produce 7+2=9 → "9/7 passing"
    const output = renderCiGateOutput(
      makeGate({ totalArticles: 7, nonCompliantCount: 2, pass: false, exitCode: 1 }),
      makeMinimalReport({ overallRisk: 'low' }),
    );
    expect(output).toContain('Articles: 5/7 passing');
    expect(output).not.toContain('9/7 passing');
  });

  it('H6i-10: nonCompliantCount=3 → fail block shows count (kills nonCompliantCount>0 condition)', () => {
    const output = renderCiGateOutput(
      makeGate({ nonCompliantCount: 3, pass: false, exitCode: 1, totalArticles: 5 }),
      makeMinimalReport({ overallRisk: 'low' }),
    );
    // Line 1247: if (gate.nonCompliantCount > 0) → push '3 non-compliant article(s) found.'
    expect(output).toContain('3 non-compliant article(s) found');
  });

  it('H6i-11: nonCompliantCount=0, pass → nonCompliant message absent (kills condition→true)', () => {
    // With mutation nonCompliantCount>0→true, this block fires even with count=0
    const output = renderCiGateOutput(makeGate(), makeMinimalReport());
    expect(output).not.toContain('non-compliant article(s) found');
  });

  it('H6i-12: overallRisk=high in fail → "gate fails on high/critical risk" line present', () => {
    // Line 1249: if (report.overallRisk === 'high' || report.overallRisk === 'critical')
    const output = renderCiGateOutput(
      makeGate({ overallRisk: 'high', pass: false, exitCode: 1, nonCompliantCount: 0 }),
      makeMinimalReport({ overallRisk: 'high' }),
    );
    expect(output).toContain('gate fails on high/critical risk');
  });

  it('H6i-13: threshold>0 and score below → "is below threshold" message present', () => {
    // Line 1252: if (gate.threshold > 0 && report.complianceScore < gate.threshold)
    const output = renderCiGateOutput(
      makeGate({ threshold: 75, complianceScore: 60, pass: false, exitCode: 1, nonCompliantCount: 0 }),
      makeMinimalReport({ overallRisk: 'low', complianceScore: 60 }),
    );
    expect(output).toContain('is below threshold 75');
  });
});
