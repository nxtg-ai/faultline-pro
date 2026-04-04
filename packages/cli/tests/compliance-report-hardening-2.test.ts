// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint, batch 2)
//
// Second targeted batch. Kills survivors in:
//   diffComplianceReports: trend type comparison strings, STATUS_RANK/RISK_RANK ordering, new/removed
//   renderComplianceDiffOutput: all icon literals, null-label fallback
//   evaluateComplianceGate: nonCompliantCount-only failure (riskFail not involved)
//   renderCiGateOutput: all conditional sections (threshold label, annex, failing articles, risk msg)
//   buildTestCategoryMappings: exact category/euArticle/status strings, presence/absence
//   Art.11/12/13/14 finding content assertions

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import {
  buildEuComplianceReport,
  evaluateComplianceGate,
  renderCiGateOutput,
  diffComplianceReports,
  renderComplianceDiffOutput,
  type EuAiActComplianceReport,
} from '../cli/compliance-report.js';
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

/** Minimal EuAiActComplianceReport for diff testing. */
function makeMinimalReport(overrides: {
  overallRisk?: string;
  articleEvidence?: EuAiActComplianceReport['articleEvidence'];
} = {}): EuAiActComplianceReport {
  return {
    generatedAt: new Date().toISOString(),
    documentRef: `FP-TEST-${Date.now()}`,
    projectName: 'Test',
    provider: 'mock',
    overallRisk: overrides.overallRisk ?? 'low',
    articleEvidence: overrides.articleEvidence ?? [],
    article50Disclosure: {
      status: 'not-applicable',
      note: '',
      voiceAudioDisclosure: '',
    },
    testCategoryMappings: [],
    complianceScore: 80,
    annexIIIChecklist: { applicable: false, passRate: 1, items: [] },
    summary: {
      compliantArticles: 0,
      nonCompliantArticles: 0,
      partialArticles: 0,
      gapArticles: 0,
      totalClaimsAnalyzed: 0,
      highRiskFindings: 0,
    },
  };
}

function makeArticle(
  article: string,
  status: EuAiActComplianceReport['articleEvidence'][number]['status'],
): EuAiActComplianceReport['articleEvidence'][number] {
  return {
    article,
    requirement: 'Test requirement.',
    status,
    findings: [],
    remediations: [],
    evidenceCount: 0,
    sourceCount: 0,
    strengthScore: 0.5,
  };
}

// ── Group D1: diffComplianceReports trend type ordering ───────────────────────

describe('N-210 D1 — diffComplianceReports STATUS_RANK ordering and trend types', () => {
  it('D1-1: article trend is improved when status moves non-compliant → compliant (rank 4→0)', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk Management System', 'non-compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk Management System', 'compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const art9 = diff.articles.find(a => a.article.includes('Article 9'));
    expect(art9?.trend).toBe('improved');
    expect(diff.improved).toBe(1);
    expect(diff.regressed).toBe(0);
  });

  it('D1-2: article trend is regressed when status moves compliant → non-compliant (rank 0→4)', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk Management System', 'compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk Management System', 'non-compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const art9 = diff.articles.find(a => a.article.includes('Article 9'));
    expect(art9?.trend).toBe('regressed');
    expect(diff.regressed).toBe(1);
    expect(diff.improved).toBe(0);
  });

  it('D1-3: article trend is unchanged when status is same (compliant → compliant)', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk Management System', 'compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk Management System', 'compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const art9 = diff.articles.find(a => a.article.includes('Article 9'));
    expect(art9?.trend).toBe('unchanged');
    expect(diff.unchanged).toBe(1);
  });

  it('D1-4: article trend is new when article appears in after but not in before', () => {
    const before = makeMinimalReport({ articleEvidence: [] });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 5 – Prohibited AI Practices', 'non-compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const art5 = diff.articles.find(a => a.article.includes('Article 5'));
    expect(art5?.trend).toBe('new');
    expect(art5?.before).toBeNull();
    expect(art5?.after).toBe('non-compliant');
  });

  it('D1-5: article trend is removed when article in before disappears in after', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 5 – Prohibited AI Practices', 'non-compliant')],
    });
    const after = makeMinimalReport({ articleEvidence: [] });
    const diff = diffComplianceReports(before, after);
    const art5 = diff.articles.find(a => a.article.includes('Article 5'));
    expect(art5?.trend).toBe('removed');
    expect(art5?.before).toBe('non-compliant');
    expect(art5?.after).toBeNull();
  });

  it('D1-6: partial → compliant is improved (rank 2→0)', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 10 – Data', 'partial')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 10 – Data', 'compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const art10 = diff.articles.find(a => a.article.includes('Article 10'));
    expect(art10?.trend).toBe('improved');
  });

  it('D1-7: compliant → partial is regressed (rank 0→2)', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 10 – Data', 'compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 10 – Data', 'partial')],
    });
    const diff = diffComplianceReports(before, after);
    const art10 = diff.articles.find(a => a.article.includes('Article 10'));
    expect(art10?.trend).toBe('regressed');
  });

  it('D1-8: gap → partial is improved (rank 3→2)', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 11 – Technical', 'gap')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 11 – Technical', 'partial')],
    });
    const diff = diffComplianceReports(before, after);
    const art11 = diff.articles.find(a => a.article.includes('Article 11'));
    expect(art11?.trend).toBe('improved');
  });

  it('D1-9: RISK_RANK — risk improved when going critical→low', () => {
    const before = makeMinimalReport({ overallRisk: 'critical' });
    const after = makeMinimalReport({ overallRisk: 'low' });
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('improved');
    expect(diff.before.overallRisk).toBe('critical');
    expect(diff.after.overallRisk).toBe('low');
  });

  it('D1-10: RISK_RANK — risk regressed when going low→critical', () => {
    const before = makeMinimalReport({ overallRisk: 'low' });
    const after = makeMinimalReport({ overallRisk: 'critical' });
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('regressed');
  });

  it('D1-11: RISK_RANK — risk unchanged when both medium', () => {
    const before = makeMinimalReport({ overallRisk: 'medium' });
    const after = makeMinimalReport({ overallRisk: 'medium' });
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('unchanged');
  });

  it('D1-12: multiple article improvements/regressions counted correctly', () => {
    const before = makeMinimalReport({
      articleEvidence: [
        makeArticle('Art A', 'non-compliant'),
        makeArticle('Art B', 'compliant'),
        makeArticle('Art C', 'partial'),
      ],
    });
    const after = makeMinimalReport({
      articleEvidence: [
        makeArticle('Art A', 'compliant'),    // improved
        makeArticle('Art B', 'partial'),      // regressed
        makeArticle('Art C', 'partial'),      // unchanged
      ],
    });
    const diff = diffComplianceReports(before, after);
    expect(diff.improved).toBe(1);
    expect(diff.regressed).toBe(1);
    expect(diff.unchanged).toBe(1);
  });
});

// ── Group D2: renderComplianceDiffOutput icons ────────────────────────────────

describe('N-210 D2 — renderComplianceDiffOutput trend icons', () => {
  it('D2-1: [+] icon rendered for improved articles', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk', 'non-compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk', 'compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('[+]');
  });

  it('D2-2: [-] icon rendered for regressed articles', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk', 'compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk', 'non-compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('[-]');
  });

  it('D2-3: [N] icon rendered for new articles', () => {
    const before = makeMinimalReport({ articleEvidence: [] });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 5 – Prohibited', 'non-compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('[N]');
  });

  it('D2-4: [R] icon rendered for removed articles', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 5 – Prohibited', 'non-compliant')],
    });
    const after = makeMinimalReport({ articleEvidence: [] });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('[R]');
  });

  it('D2-5: [ ] icon rendered for unchanged articles', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk', 'compliant')],
    });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 9 – Risk', 'compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('[ ]');
  });

  it('D2-6: null before shows N/A label', () => {
    const before = makeMinimalReport({ articleEvidence: [] });
    const after = makeMinimalReport({
      articleEvidence: [makeArticle('Article 5 – Prohibited', 'non-compliant')],
    });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('N/A');
  });

  it('D2-7: null after shows N/A label', () => {
    const before = makeMinimalReport({
      articleEvidence: [makeArticle('Article 5 – Prohibited', 'non-compliant')],
    });
    const after = makeMinimalReport({ articleEvidence: [] });
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('N/A');
  });

  it('D2-8: summary shows improved/regressed/unchanged counts', () => {
    const diff = diffComplianceReports(
      makeMinimalReport({ articleEvidence: [makeArticle('Art A', 'non-compliant')] }),
      makeMinimalReport({ articleEvidence: [makeArticle('Art A', 'compliant')] }),
    );
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('1 improved');
    expect(output).toContain('0 regressed');
    expect(output).toContain('0 unchanged');
  });
});

// ── Group E1: evaluateComplianceGate — nonCompliantCount-only failure ─────────

describe('N-210 E1 — evaluateComplianceGate nonCompliantCount without riskFail', () => {
  it('E1-1: gate fails when article is non-compliant even with low risk (bias → Art.10 non-compliant)', () => {
    // Art.10 becomes non-compliant due to bias; overallRisk='low' so riskFail=false
    const scan = makeScan({
      overallRisk: 'low',
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias detected.', match: 'bias', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.nonCompliantCount).toBeGreaterThan(0);
    // Confirm riskFail is not involved — overallRisk is 'low'
    expect(gate.overallRisk).toBe('low');
  });

  it('E1-2: gate passes when same scan has no bias findings (Art.10 becomes compliant)', () => {
    const scan = makeScan({ overallRisk: 'low', ruleFindings: [] });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.nonCompliantCount).toBe(0);
  });

  it('E1-3: strict mode — partial article fails gate (Art.14 partial via mixed claims)', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
      },
      overallRisk: 'low',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { strict: true });
    expect(gate.pass).toBe(false);
    // In strict mode, partial articles fail — find a failing article
    const failing = gate.articles.filter(a => !a.pass);
    expect(failing.length).toBeGreaterThan(0);
  });

  it('E1-4: strict mode — not-applicable article still passes (Art.14 not-applicable)', () => {
    // All-supported scan: Art.14 is 'not-applicable' (no interpretation or mixed claims)
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { strict: true });
    const art14 = gate.articles.find(a => a.article.includes('Article 14'));
    // 'not-applicable' counts as pass in strict mode
    expect(art14?.pass).toBe(true);
  });

  it('E1-5: threshold failure at exact score-1 (score < threshold)', () => {
    const report = buildEuComplianceReport(makeScan());
    const score = report.complianceScore;
    // threshold = score + 1 → scoreFail = true → gate fails
    const gate = evaluateComplianceGate(report, { threshold: score + 1 });
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
  });

  it('E1-6: threshold passes at exact score (score < threshold must be false when equal)', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    }));
    const score = report.complianceScore;
    // threshold = score → complianceScore < threshold = false → no scoreFail
    const gate = evaluateComplianceGate(report, { threshold: score });
    // Gate should pass (no other failures)
    expect(gate.exitCode).toBe(0);
  });

  it('E1-7: threshold=0 never triggers scoreFail', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 0 });
    // Even though score might be < 100, threshold=0 means no scoreFail
    // Gate should pass for a clean scan
    expect(gate.threshold).toBe(0);
    expect(gate.pass).toBe(true);
  });
});

// ── Group E2: renderCiGateOutput conditional sections ─────────────────────────

describe('N-210 E2 — renderCiGateOutput conditional sections', () => {
  it('E2-1: threshold label shown when threshold > 0', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    }));
    const gate = evaluateComplianceGate(report, { threshold: 75 });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('threshold: 75');
  });

  it('E2-2: threshold label NOT shown when threshold = 0 (default)', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('threshold:');
  });

  it('E2-3: annex III section rendered when applicable and items present', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    // annexApplicable=true for high risk → section appears
    expect(output).toContain('Annex III Conformity Assessment:');
    expect(output).toContain('Pass rate:');
  });

  it('E2-4: annex section NOT rendered for low risk (not applicable)', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('Annex III Conformity Assessment:');
  });

  it('E2-5: non-compliant count message rendered when nonCompliantCount > 0', () => {
    const scan = makeScan({
      overallRisk: 'low',
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias.', match: 'bias', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('non-compliant article(s) found');
    expect(output).toContain(`${gate.nonCompliantCount}`);
  });

  it('E2-6: high risk message rendered when overallRisk is high', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Overall risk is HIGH');
  });

  it('E2-7: critical risk message rendered when overallRisk is critical', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('CRITICAL');
  });

  it('E2-8: score below threshold message rendered when threshold fails', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 100 });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Compliance score');
    expect(output).toContain('below threshold 100');
  });

  it('E2-9: Exit code: 0 shown in passing output', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Exit code: 0');
    expect(output).toContain('All articles compliant');
  });

  it('E2-10: Exit code: 1 shown in failing output', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Exit code: 1');
  });

  it('E2-11: remediations section rendered when failing articles have remediations', () => {
    const scan = makeScan({
      overallRisk: 'low',
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias.', match: 'bias', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Recommended Remediations:');
  });

  it('E2-12: PASS/FAIL label reflects gate result', () => {
    const passScan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const passReport = buildEuComplianceReport(passScan);
    const passGate = evaluateComplianceGate(passReport);
    expect(renderCiGateOutput(passGate, passReport)).toContain('PASS');

    const failReport = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const failGate = evaluateComplianceGate(failReport);
    expect(renderCiGateOutput(failGate, failReport)).toContain('FAIL');
  });
});

// ── Group M1: buildTestCategoryMappings exact string assertions ───────────────

describe('N-210 M1 — buildTestCategoryMappings exact category/euArticle/status strings', () => {
  it('M1-1: fact+supported entry has correct category, euArticle, and status strings', () => {
    const report = buildEuComplianceReport(makeScan());
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (supported)');
    expect(mapping).toBeDefined();
    expect(mapping?.euArticle).toContain('Article 13');
    expect(mapping?.status).toBe('compliant');
    expect(mapping?.claimCount).toBeGreaterThan(0);
  });

  it('M1-2: fact+supported absent when no fact claims are supported', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Opinion.', type: 'opinion', importance: 3 }],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (supported)');
    expect(mapping).toBeUndefined();
  });

  it('M1-3: fact+contradicted entry has correct category, euArticle, and status', () => {
    const claims: Claim[] = [{ id: 'fc1', text: 'Wrong claim.', type: 'fact', importance: 4 }];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: {
        fc1: { claimId: 'fc1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'high',
    }));
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (contradicted)');
    expect(mapping).toBeDefined();
    expect(mapping?.euArticle).toContain('Article 9');
    expect(mapping?.status).toBe('non-compliant');
  });

  it('M1-4: fact+contradicted absent when fact claim is NOT contradicted', () => {
    const report = buildEuComplianceReport(makeScan());
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (contradicted)');
    expect(mapping).toBeUndefined();
  });

  it('M1-5: fact+contradicted absent when contradicted claim is not a fact type', () => {
    const claims: Claim[] = [{ id: 'oc1', text: 'Opinion.', type: 'opinion', importance: 3 }];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: {
        oc1: { claimId: 'oc1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'high',
    }));
    // opinion contradicted does NOT map to 'fact (contradicted)'
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (contradicted)');
    expect(mapping).toBeUndefined();
  });

  it('M1-6: fact+unverified/mixed entry has correct category and status', () => {
    const claims: Claim[] = [
      { id: 'u1', text: 'Unverified fact.', type: 'fact', importance: 3 },
    ];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: {
        u1: { claimId: 'u1', status: 'unverified', explanation: 'No source.', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (unverified/mixed)');
    expect(mapping).toBeDefined();
    expect(mapping?.euArticle).toContain('Article 13');
    expect(mapping?.status).toBe('gap');
  });

  it('M1-7: fact+unverified/mixed absent when no unverified/mixed facts', () => {
    const report = buildEuComplianceReport(makeScan());
    const mapping = report.testCategoryMappings.find(m => m.category === 'fact (unverified/mixed)');
    expect(mapping).toBeUndefined();
  });

  it('M1-8: opinion entry maps to Art. 50 with partial status', () => {
    const scan = makeScan({
      claims: [{ id: 'op1', text: 'AI will dominate.', type: 'opinion', importance: 2 }],
      verifications: {
        op1: { claimId: 'op1', status: 'supported', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const mapping = report.testCategoryMappings.find(m => m.category === 'opinion');
    expect(mapping).toBeDefined();
    expect(mapping?.euArticle).toContain('Article 50');
    expect(mapping?.status).toBe('partial');
  });

  it('M1-9: opinion entry absent when no opinion claims', () => {
    const report = buildEuComplianceReport(makeScan());
    const mapping = report.testCategoryMappings.find(m => m.category === 'opinion');
    expect(mapping).toBeUndefined();
  });

  it('M1-10: interpretation entry maps to Art. 9 + Art. 14 with partial status', () => {
    const scan = makeScan({
      claims: [{ id: 'int1', text: 'AI interprets the world.', type: 'interpretation', importance: 3 }],
      verifications: {
        int1: { claimId: 'int1', status: 'supported', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const mapping = report.testCategoryMappings.find(m => m.category === 'interpretation');
    expect(mapping).toBeDefined();
    expect(mapping?.euArticle).toContain('Article 9');
    expect(mapping?.euArticle).toContain('Article 14');
    expect(mapping?.status).toBe('partial');
  });

  it('M1-11: interpretation absent when no interpretation claims', () => {
    const report = buildEuComplianceReport(makeScan());
    const mapping = report.testCategoryMappings.find(m => m.category === 'interpretation');
    expect(mapping).toBeUndefined();
  });
});

// ── Group F1: Art.11/13/14 finding content assertions ────────────────────────

describe('N-210 F1 — Art.11/13/14 finding content — presence and absence', () => {
  it('F1-1: Art.11 finding mentions claimsWithExplanation count when present', () => {
    const report = buildEuComplianceReport(makeScan());
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    // Default scan has c1+c2 with explanation → finding references "2/2 claim(s)"
    expect(art11?.findings.some(f => f.includes('explanation'))).toBe(true);
  });

  it('F1-2: Art.11 "insufficient" finding appears when claims exist but have no docs', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    // claimsWithExplanation=0, claimsWithSources=0, claims.length>0 → "insufficient" finding
    expect(art11?.findings.some(f => f.includes('insufficient'))).toBe(true);
  });

  it('F1-3: Art.11 sources finding appears when claims have sources', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.findings.some(f => f.includes('sources'))).toBe(true);
  });

  it('F1-4: Art.11 explanation finding absent when no claims have explanation', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: '', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    // claimsWithExplanation=0 → the "explanation" finding is NOT pushed
    expect(art11?.findings.some(f => f.includes('explanations'))).toBe(false);
    // But sources finding IS there
    expect(art11?.findings.some(f => f.includes('sources'))).toBe(true);
  });

  it('F1-5: Art.13 supported claims finding appears when supported claims exist', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.findings.some(f => f.includes('verified fact claim'))).toBe(true);
  });

  it('F1-6: Art.13 unverified finding appears when unverified claims exist', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'No source.', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.findings.some(f => f.includes('unverified/mixed'))).toBe(true);
  });

  it('F1-7: Art.13 no-claims finding appears when zero claims', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [],
      verifications: {},
      overallRisk: 'low',
    }));
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.findings.some(f => f.includes('No claims extracted'))).toBe(true);
  });

  it('F1-8: Art.14 interpretation finding appears when interpretation claims exist', () => {
    const scan = makeScan({
      claims: [{ id: 'int1', text: 'Interpretation claim.', type: 'interpretation', importance: 3 }],
      verifications: {
        int1: { claimId: 'int1', status: 'supported', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art14 = report.articleEvidence.find(e => e.article.includes('Article 14'));
    expect(art14?.findings.some(f => f.includes('interpretation'))).toBe(true);
    expect(art14?.status).toBe('partial');
  });

  it('F1-9: Art.14 mixed claims finding appears when mixed-verdict claims exist', () => {
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting evidence.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const art14 = report.articleEvidence.find(e => e.article.includes('Article 14'));
    expect(art14?.findings.some(f => f.includes('conflicting evidence'))).toBe(true);
  });

  it('F1-10: Art.14 is not-applicable when no interpretation or mixed claims', () => {
    const report = buildEuComplianceReport(makeScan());
    const art14 = report.articleEvidence.find(e => e.article.includes('Article 14'));
    expect(art14?.status).toBe('not-applicable');
    // Verify the "no oversight requirements" fallback finding appears
    expect(art14?.findings.some(f => f.includes('No human oversight requirements'))).toBe(true);
  });

  it('F1-11: Art.15 rate percentage appears in finding when contradiction rate exceeds 0.3', () => {
    const claims: Claim[] = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i+1}`, text: `Claim ${i+1}.`, type: 'fact' as const, importance: 3,
    }));
    const verifs: Record<string, VerificationResult> = {};
    for (const c of claims) {
      verifs[c.id] = {
        claimId: c.id,
        status: ['r1','r2','r3','r4'].includes(c.id) ? 'contradicted' : 'supported',
        explanation: 'Test.',
        sources: [],
      };
    }
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: verifs,
      overallRisk: 'critical',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    // rate = 4/10 = 40% > 30% → finding includes percentage
    expect(art15?.findings.some(f => f.includes('40%'))).toBe(true);
    expect(art15?.findings.some(f => f.includes('4/10'))).toBe(true);
  });

  it('F1-12: Art.15 contradiction finding uses minor concern text when rate ≤ 0.3', () => {
    const claims: Claim[] = [
      { id: 'l1', text: 'Claim 1.', type: 'fact', importance: 3 },
      { id: 'l2', text: 'Claim 2.', type: 'fact', importance: 3 },
      { id: 'l3', text: 'Claim 3.', type: 'fact', importance: 3 },
      { id: 'l4', text: 'Claim 4.', type: 'fact', importance: 3 },
    ];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: {
        l1: { claimId: 'l1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        l2: { claimId: 'l2', status: 'supported', explanation: 'OK.', sources: [] },
        l3: { claimId: 'l3', status: 'supported', explanation: 'OK.', sources: [] },
        l4: { claimId: 'l4', status: 'supported', explanation: 'OK.', sources: [] },
      },
      overallRisk: 'medium',
    }));
    // rate = 1/4 = 0.25 (NOT > 0.3) → uses "minor accuracy concern" text
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.findings.some(f => f.includes('minor accuracy concern'))).toBe(true);
  });
});
