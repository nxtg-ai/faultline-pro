// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint)
// Gate 6 target: 80% mutation score on lines 1–1661
//
// These tests target the ConditionalExpression and EqualityOperator survivors
// Stryker identified in buildEuComplianceReport() and getRemediations():
//
//   art9Status:  art9Findings.length === 0  /  overallRisk === 'critical'  /  contradictedClaims.length > 2
//   art10Status: biasFindings.length > 0  /  contradictedClaims.length > 2
//   art11Status: claims.length === 0  /  docCoverage >= 0.7  /  docCoverage >= 0.3
//   art12Status: art12Score >= 2  /  art12Score === 1
//   art13Status: !hasTransparencyGap && supportedClaims.length > 0
//               unverifiedClaims.length > 0 && supportedClaims.length > 0
//   art15Status: injectionFindings.length > 0  /  contradictionRate > 0.3
//               contradictedClaims.length > 0  /  claims.length === 0
//   getRemediations Art. 9: each .some() keyword guard
//   annexApplicable: overallRisk high/critical  /  art6StatusVal partial
//   gpaiProvider / art53 / art50 boolean gates

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import { buildEuComplianceReport, getRemediations } from '../cli/compliance-report.js';
import type { ScanResult } from '../cli/scan.js';
import type { ComplianceReport } from '../compliance/report_generator.js';
import type { Claim, VerificationResult } from '../types.js';

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
    input: 'Water boils at 100°C.',
    provider: 'Mock Provider',
    claims: [
      { id: 'c1', text: 'Claim one.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Claim two.', type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
      c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: makeComplianceReport(),
    ruleFindings: [],
    ...overrides,
  };
}

/** Build N fact claims with the given base ID prefix. */
function makeClaims(n: number, prefix = 'h', importance = 3): Claim[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    text: `Claim ${i + 1}.`,
    type: 'fact' as const,
    importance,
  }));
}

/** Build verifications for a set of claims; listed IDs get 'contradicted' or 'unverified'. */
function makeVerifs(
  claims: Claim[],
  contradictedIds: string[] = [],
  unverifiedIds: string[] = [],
): Record<string, VerificationResult> {
  return Object.fromEntries(claims.map(c => [
    c.id,
    {
      claimId: c.id,
      status: (contradictedIds.includes(c.id) ? 'contradicted' :
               unverifiedIds.includes(c.id) ? 'unverified' : 'supported') as VerificationResult['status'],
      explanation: 'Test.',
      sources: [],
    },
  ]));
}

/** Build verifications with controlled explanation / source presence (for art11 doc-coverage). */
function makeVerifsWithDocs(
  claims: Claim[],
  withExplanation: string[],
  withSources: string[],
): Record<string, VerificationResult> {
  return Object.fromEntries(claims.map(c => [
    c.id,
    {
      claimId: c.id,
      status: 'supported' as const,
      explanation: withExplanation.includes(c.id) ? 'Has explanation.' : '',
      sources: withSources.includes(c.id) ? [{ uri: 'http://ex.com', title: 'Source' }] : [],
    },
  ]));
}

// ── Group 1: art9Status boundaries ────────────────────────────────────────────

describe('N-210 G1 — art9Status boundary conditions', () => {
  it('G1-1: compliant when zero findings (all supported, risk low)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.status).toBe('compliant');
  });

  it('G1-2: partial when exactly 1 contradicted claim and risk low', () => {
    const claims = makeClaims(3, 'g1');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g11']),
      overallRisk: 'low',
    }));
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.status).toBe('partial');
  });

  it('G1-3: partial when exactly 2 contradicted claims, risk low (boundary: 2 is NOT > 2)', () => {
    const claims = makeClaims(5, 'g1b');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g1b1', 'g1b2']),
      overallRisk: 'low',
    }));
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    // contradictedClaims.length = 2, overallRisk !== 'critical' → 'partial'
    expect(art9?.status).toBe('partial');
  });

  it('G1-4: non-compliant when 3 contradicted claims, risk low (3 > 2)', () => {
    const claims = makeClaims(5, 'g1c');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g1c1', 'g1c2', 'g1c3']),
      overallRisk: 'low',
    }));
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.status).toBe('non-compliant');
  });

  it('G1-5: non-compliant when risk is critical even with 0 contradicted claims', () => {
    // overallRisk === 'critical' triggers an art9Finding AND the non-compliant branch
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'critical' }));
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.status).toBe('non-compliant');
  });

  it('G1-6: partial when risk is high but only 1 contradicted (high triggers finding but not non-compliant)', () => {
    const claims = makeClaims(3, 'g1d');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g1d1']),
      overallRisk: 'high',
    }));
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    // overallRisk 'high' ≠ 'critical', contradictedClaims.length = 1 ≤ 2 → 'partial'
    expect(art9?.status).toBe('partial');
  });
});

// ── Group 2: art10Status boundaries ───────────────────────────────────────────

describe('N-210 G2 — art10Status boundary conditions', () => {
  it('G2-1: compliant when no bias, PII, or contradicted claims', () => {
    const report = buildEuComplianceReport(makeScan());
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('compliant');
  });

  it('G2-2: non-compliant when a bias finding exists', () => {
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'bias-detector', severity: 'high', message: 'Bias.', match: 'x', offset: 0 },
      ],
    }));
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('non-compliant');
  });

  it('G2-3: partial when 1 contradicted claim and no bias (1 ≤ 2)', () => {
    const claims = makeClaims(3, 'g2c');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g2c1']),
      overallRisk: 'high',
    }));
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('partial');
  });

  it('G2-4: partial when exactly 2 contradicted claims and no bias (boundary: 2 is NOT > 2)', () => {
    const claims = makeClaims(5, 'g2d');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g2d1', 'g2d2']),
      overallRisk: 'high',
    }));
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('partial');
  });

  it('G2-5: non-compliant when 3 contradicted claims and no bias (3 > 2)', () => {
    const claims = makeClaims(5, 'g2e');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g2e1', 'g2e2', 'g2e3']),
      overallRisk: 'critical',
    }));
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('non-compliant');
  });
});

// ── Group 3: art13Status ternary boundaries ────────────────────────────────────

describe('N-210 G3 — art13Status ternary conditions', () => {
  it('G3-1: compliant when all claims are supported (no transparency gap)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('compliant');
  });

  it('G3-2: partial when mix of supported and unverified claims', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'No source.', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    // unverifiedClaims.length > 0 && supportedClaims.length > 0 → 'partial'
    expect(art13?.status).toBe('partial');
  });

  it('G3-3: partial when mix of supported and mixed-verdict claims', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'mixed', explanation: 'Conflicting.', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('partial');
  });

  it('G3-4: gap when all claims are unverified (no supported claims at all)', () => {
    const claims = makeClaims(2, 'g3d');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, [], ['g3d1', 'g3d2']),
      overallRisk: 'medium',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('gap');
  });

  it('G3-5: gap when there are zero claims', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [],
      verifications: {},
      overallRisk: 'low',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('gap');
  });

  it('G3-6: gap when only contradicted claims exist (no supported, has transparency gap)', () => {
    const claims = makeClaims(2, 'g3f');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g3f1', 'g3f2']),
      overallRisk: 'high',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    // contradicted claims are NOT in supportedClaims → supportedClaims.length = 0 → 'gap'
    expect(art13?.status).toBe('gap');
  });
});

// ── Group 4: art15Status three-way chain ──────────────────────────────────────

describe('N-210 G4 — art15Status three-way chain and contradictionRate 0.3 boundary', () => {
  it('G4-1: compliant when claims exist and none contradicted or unverified', () => {
    const report = buildEuComplianceReport(makeScan());
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('compliant');
  });

  it('G4-2: gap when claims array is empty', () => {
    const report = buildEuComplianceReport(makeScan({ claims: [], verifications: {}, overallRisk: 'low' }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('gap');
  });

  it('G4-3: partial when 1 contradicted claim, rate below 0.3 boundary', () => {
    // 4 claims, 1 contradicted: rate = 0.25 (NOT > 0.3)
    const claims = makeClaims(4, 'g4c');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g4c1']),
      overallRisk: 'high',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('partial');
  });

  it('G4-4: partial when rate is exactly 0.3 (NOT > 0.3 — boundary test)', () => {
    // 10 claims, 3 contradicted: rate = 3/10 = 0.3 (NOT > 0.3) → partial
    const claims = makeClaims(10, 'g4d');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g4d1', 'g4d2', 'g4d3']),
      overallRisk: 'high',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    // rate = 0.3 → condition `> 0.3` is false → second branch → 'partial'
    expect(art15?.status).toBe('partial');
  });

  it('G4-5: non-compliant when rate exceeds 0.3 (4/10 = 0.4)', () => {
    // 10 claims, 4 contradicted: rate = 0.4 > 0.3 → non-compliant
    const claims = makeClaims(10, 'g4e');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g4e1', 'g4e2', 'g4e3', 'g4e4']),
      overallRisk: 'critical',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('non-compliant');
  });

  it('G4-6: non-compliant when injection finding present regardless of rate', () => {
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'prompt-injection', severity: 'high', message: 'Injection.', match: 'drop', offset: 0 },
      ],
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('non-compliant');
  });

  it('G4-7: partial when high-importance claim is unverified', () => {
    const claims: Claim[] = [{ id: 'g4g1', text: 'Critical claim.', type: 'fact', importance: 5 }];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: {
        g4g1: { claimId: 'g4g1', status: 'unverified', explanation: '', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('partial');
  });

  it('G4-8: art15 finding mentions rate percentage when rate exceeds 0.3', () => {
    const claims = makeClaims(10, 'g4h');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifs(claims, ['g4h1', 'g4h2', 'g4h3', 'g4h4']),
      overallRisk: 'critical',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.findings.some(f => f.includes('%'))).toBe(true);
    expect(art15?.findings.some(f => f.includes('4/10'))).toBe(true);
  });
});

// ── Group 5: art12Status score boundaries ─────────────────────────────────────

describe('N-210 G5 — art12Status score 0/1/2/3 boundaries', () => {
  it('G5-1: compliant with score 3 (provider + claims + ruleFindings all present)', () => {
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'pii-detection', severity: 'medium', message: 'PII.', match: 'test@x.com', offset: 0 },
      ],
    }));
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    expect(art12?.status).toBe('compliant');
    expect(art12?.findings.some(f => f.includes('Provider recorded'))).toBe(true);
    expect(art12?.findings.some(f => f.includes('claim(s) extracted'))).toBe(true);
    expect(art12?.findings.some(f => f.includes('rule finding'))).toBe(true);
  });

  it('G5-2: compliant with score 2 exactly (provider + claims, no ruleFindings)', () => {
    // score = hasProvider(1) + hasStructuredClaims(1) + hasMonitoring(0) = 2 → compliant (>= 2)
    const report = buildEuComplianceReport(makeScan({ ruleFindings: [] }));
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    expect(art12?.status).toBe('compliant');
  });

  it('G5-3: partial with score 1 (provider only, no claims, no ruleFindings)', () => {
    // score = hasProvider(1) + hasStructuredClaims(0) + hasMonitoring(0) = 1 → partial (=== 1)
    const report = buildEuComplianceReport(makeScan({
      claims: [],
      verifications: {},
      ruleFindings: [],
      overallRisk: 'low',
    }));
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    expect(art12?.status).toBe('partial');
  });

  it('G5-4: gap with score 0 (no provider, no claims, no ruleFindings)', () => {
    // score = 0 → gap
    const report = buildEuComplianceReport(makeScan({
      provider: '',
      claims: [],
      verifications: {},
      ruleFindings: [],
      overallRisk: 'low',
    }));
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    expect(art12?.status).toBe('gap');
  });
});

// ── Group 6: art11Status docCoverage thresholds ────────────────────────────────

describe('N-210 G6 — art11Status docCoverage boundary values', () => {
  it('G6-1: not-applicable when claims array is empty', () => {
    const report = buildEuComplianceReport(makeScan({ claims: [], verifications: {}, overallRisk: 'low' }));
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('not-applicable');
  });

  it('G6-2: compliant when docCoverage is 1.0 (all claims have explanation + sources)', () => {
    // 2 claims, both with explanation AND sources: (2+2)/(2*2) = 1.0
    const claims: Claim[] = [
      { id: 'g6a', text: 'Claim A.', type: 'fact', importance: 3 },
      { id: 'g6b', text: 'Claim B.', type: 'fact', importance: 3 },
    ];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifsWithDocs(claims, ['g6a', 'g6b'], ['g6a', 'g6b']),
    }));
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('compliant');
  });

  it('G6-3: compliant when docCoverage is exactly 0.7 (boundary: >= 0.7)', () => {
    // 10 claims, 7 with explanation, 7 with sources (same 7): (7+7)/(10*2) = 14/20 = 0.70
    const claims = makeClaims(10, 'g6c');
    const withBoth = ['g6c1', 'g6c2', 'g6c3', 'g6c4', 'g6c5', 'g6c6', 'g6c7'];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifsWithDocs(claims, withBoth, withBoth),
    }));
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('compliant');
  });

  it('G6-4: partial when docCoverage is 0.6 (below 0.7, above 0.3)', () => {
    // 10 claims, 6 with explanation, 6 with sources: (6+6)/20 = 0.60
    const claims = makeClaims(10, 'g6d');
    const withBoth = ['g6d1', 'g6d2', 'g6d3', 'g6d4', 'g6d5', 'g6d6'];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifsWithDocs(claims, withBoth, withBoth),
    }));
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('partial');
  });

  it('G6-5: partial when docCoverage is exactly 0.3 (boundary: >= 0.3)', () => {
    // 10 claims, 3 with explanation, 3 with sources (same 3): (3+3)/(10*2) = 6/20 = 0.30
    const claims = makeClaims(10, 'g6e');
    const withBoth = ['g6e1', 'g6e2', 'g6e3'];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifsWithDocs(claims, withBoth, withBoth),
    }));
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('partial');
  });

  it('G6-6: gap when docCoverage is below 0.3 (no documentation)', () => {
    // 10 claims, 2 with explanation only: (2+0)/(10*2) = 2/20 = 0.10
    const claims = makeClaims(10, 'g6f');
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: makeVerifsWithDocs(claims, ['g6f1', 'g6f2'], []),
    }));
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('gap');
  });
});

// ── Group 7: getRemediations Art. 9 branch guards ─────────────────────────────

describe('N-210 G7 — getRemediations Art. 9 .some() keyword guards', () => {
  it('G7-1: returns empty array for compliant status', () => {
    expect(getRemediations('Article 9', 'compliant', [])).toEqual([]);
    expect(getRemediations('Article 9', 'not-applicable', [])).toEqual([]);
  });

  it('G7-2: contradicted keyword triggers "Review and correct" remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['2 contradicted claim(s) found.']);
    expect(rems.some(r => r.includes('Review and correct'))).toBe(true);
  });

  it('G7-3: injection keyword triggers prompt guardrail remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['Prompt injection pattern detected.']);
    expect(rems.some(r => r.includes('prompt guardrails'))).toBe(true);
  });

  it('G7-4: PII keyword triggers PII filtering remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['3 PII finding(s) — GDPR alignment required.']);
    expect(rems.some(r => r.includes('PII filtering'))).toBe(true);
  });

  it('G7-5: bias keyword triggers bias audit remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['1 bias finding(s) — training data governance required.']);
    expect(rems.some(r => r.includes('bias audit'))).toBe(true);
  });

  it('G7-6: Annex III keyword triggers conformity assessment remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['Overall risk assessed as HIGH — Annex III conformity assessment required.']);
    expect(rems.some(r => r.includes('Annex III conformity assessment'))).toBe(true);
  });

  it('G7-7: high keyword in findings triggers conformity assessment remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['Overall risk assessed as high.']);
    expect(rems.some(r => r.includes('conformity'))).toBe(true);
  });

  it('G7-8: interpretation keyword triggers human oversight remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['1 interpretation claim(s) require human oversight assessment.']);
    expect(rems.some(r => r.includes('interpretation'))).toBe(true);
  });

  it('G7-9: fallback remediation returned when no specific keyword matches', () => {
    const rems = getRemediations('Article 9', 'partial', ['Some generic risk finding.']);
    expect(rems.some(r => r.includes('Review risk management'))).toBe(true);
  });

  it('G7-10: multiple keywords in one finding can trigger multiple remediations', () => {
    const rems = getRemediations('Article 9', 'non-compliant', [
      '2 contradicted claim(s). 1 PII finding(s). injection detected.',
    ]);
    expect(rems.some(r => r.includes('Review and correct'))).toBe(true);
    expect(rems.some(r => r.includes('PII filtering'))).toBe(true);
    expect(rems.some(r => r.includes('prompt guardrails'))).toBe(true);
  });
});

// ── Group 8: annexApplicable / art50 / art53 boolean gates ────────────────────

describe('N-210 G8 — annexApplicable, Art. 50, and Art. 53 boolean gates', () => {
  it('G8-1: annexApplicable is true when overallRisk is high', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    expect(report.annexIIIChecklist.applicable).toBe(true);
    expect(report.annexIIIChecklist.items.length).toBeGreaterThan(0);
  });

  it('G8-2: annexApplicable is true when overallRisk is critical', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'critical' }));
    expect(report.annexIIIChecklist.applicable).toBe(true);
  });

  it('G8-3: annexApplicable is false when risk is low and no high-risk claimMappings', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'low' }));
    expect(report.annexIIIChecklist.applicable).toBe(false);
    expect(report.annexIIIChecklist.items).toHaveLength(0);
  });

  it('G8-4: annexApplicable is false when risk is medium and no high-risk claimMappings', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'medium' }));
    expect(report.annexIIIChecklist.applicable).toBe(false);
  });

  it('G8-5: annexApplicable is true when Art. 6 is partial (high-risk claimMapping, risk low)', () => {
    const report = buildEuComplianceReport(makeScan({
      overallRisk: 'low',
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1',
          claimText: 'Biometric system.',
          riskLevel: 'high',
          matchedPatterns: ['biometric identification'],
          verificationStatus: 'supported',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          confidence: 'high',
          confidenceScore: 0.9,
        }],
        euRiskSummary: {
          unacceptable: 0, high: 1, limited: 0, minimal: 1, totalClaims: 2, highestTier: 'high',
        },
      }),
    }));
    // art6Status = 'partial' (highRiskMappings.length > 0) → annexApplicable = true
    expect(report.annexIIIChecklist.applicable).toBe(true);
  });

  it('G8-6: Art. 50 is not-applicable when no opinion claims', () => {
    const report = buildEuComplianceReport(makeScan());
    const art50 = report.articleEvidence.find(e => e.article.includes('Article 50'));
    expect(art50?.status).toBe('not-applicable');
  });

  it('G8-7: Art. 50 is partial when opinion claims present', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'op1', text: 'AI is superior to humans.', type: 'opinion', importance: 2 }],
      verifications: {
        op1: { claimId: 'op1', status: 'supported', explanation: '', sources: [] },
      },
    }));
    const art50 = report.articleEvidence.find(e => e.article.includes('Article 50'));
    expect(art50?.status).toBe('partial');
  });

  it('G8-8: Art. 53 is not-applicable when Mock Provider is used', () => {
    const report = buildEuComplianceReport(makeScan({ provider: 'Mock Provider' }));
    const art53 = report.articleEvidence.find(e => e.article.includes('Article 53'));
    expect(art53?.status).toBe('not-applicable');
  });

  it('G8-9: Art. 53 is partial when a real (non-mock) provider is used', () => {
    const report = buildEuComplianceReport(makeScan({ provider: 'Gemini Pro' }));
    const art53 = report.articleEvidence.find(e => e.article.includes('Article 53'));
    expect(art53?.status).toBe('partial');
    expect(art53?.findings.some(f => f.includes('Gemini Pro'))).toBe(true);
  });

  it('G8-10: Art. 53 is not-applicable when provider is empty string', () => {
    const report = buildEuComplianceReport(makeScan({ provider: '' }));
    const art53 = report.articleEvidence.find(e => e.article.includes('Article 53'));
    expect(art53?.status).toBe('not-applicable');
  });
});

// ── Group 9: getRemediations — Art. 52 branch guards ─────────────────────────

describe('N-210 G9 — getRemediations Art. 52 branch guards', () => {
  it('G9-1: opinion keyword triggers AI disclosure remediation', () => {
    const rems = getRemediations('Article 52', 'partial',
      ['1 AI-generated opinion claim(s) detected.']);
    expect(rems.some(r => r.includes('disclosure'))).toBe(true);
  });

  it('G9-2: emotion keyword triggers emotion recognition notification', () => {
    const rems = getRemediations('Article 52', 'partial',
      ['1 emotion/sentiment finding(s).']);
    expect(rems.some(r => r.includes('emotion recognition'))).toBe(true);
  });

  it('G9-3: biometric keyword triggers biometric notification', () => {
    const rems = getRemediations('Article 52', 'partial',
      ['1 biometric categorisation mapping(s).']);
    expect(rems.some(r => r.includes('biometric'))).toBe(true);
  });

  it('G9-4: synthetic keyword triggers deep-fake labelling remediation', () => {
    const rems = getRemediations('Article 52', 'partial',
      ['1 synthetic/deep-fake content finding(s).']);
    expect(rems.some(r => r.includes('machine-generated'))).toBe(true);
  });

  it('G9-5: deepfake keyword triggers labelling remediation', () => {
    const rems = getRemediations('Article 52', 'partial',
      ['deepfake media found.']);
    expect(rems.some(r => r.includes('machine-generated'))).toBe(true);
  });

  it('G9-6: fallback remediation returned when no specific signal', () => {
    const rems = getRemediations('Article 52', 'partial', ['Some unrecognised Art 52 signal.']);
    expect(rems.some(r => r.includes('Art. 52 transparency obligations'))).toBe(true);
  });
});

// ── Group 10: getRemediations — Art. 15 branch guards ────────────────────────

describe('N-210 G10 — getRemediations Art. 15 branch guards', () => {
  it('G10-1: contradicted keyword triggers accuracy investigation remediation', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['40% of claims contradicted — accuracy requirements not met.']);
    expect(rems.some(r => r.includes('contradicted claims'))).toBe(true);
  });

  it('G10-2: injection keyword triggers cybersecurity remediation', () => {
    const rems = getRemediations('Article 15', 'non-compliant',
      ['1 injection/attack pattern(s) detected — cybersecurity measures required.']);
    expect(rems.some(r => r.includes('prompt injection'))).toBe(true);
  });

  it('G10-3: robustness/unverified keyword triggers robustness testing remediation', () => {
    const rems = getRemediations('Article 15', 'partial',
      ['1 high-importance claim(s) unverified — robustness assessment incomplete.']);
    expect(rems.some(r => r.includes('robustness testing'))).toBe(true);
  });

  it('G10-4: fallback remediation returned when no specific signal', () => {
    const rems = getRemediations('Article 15', 'partial', ['Some other Art. 15 finding.']);
    expect(rems.some(r => r.includes('accuracy metrics'))).toBe(true);
  });
});
