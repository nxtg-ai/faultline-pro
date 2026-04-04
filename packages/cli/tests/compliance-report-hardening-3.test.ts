// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint, batch 3)
//
// Third targeted batch. Kills survivors in:
//   renderComplianceReportMarkdown: annex icons, threshold row, remediations, PASS/FAIL
//   renderCiGateOutput: negative assertions (sections NOT shown when conditions false)
//   renderComplianceReportSarif: SARIF level mapping, non-passing article filtering
//   getRemediations: Art.10/13/14/15 keyword branches
//   Art.15: finding text presence/absence, injection content assertion
//   Art.9/12: finding content assertions

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import {
  buildEuComplianceReport,
  evaluateComplianceGate,
  renderCiGateOutput,
  renderComplianceReportMarkdown,
  renderComplianceReportSarif,
  getRemediations,
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

// Scan with sources for Art.11 compliant (full docCoverage)
function makeScanWithSources(): ScanResult {
  return makeScan({
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
      c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
    },
  });
}

// ── Group R1: renderComplianceReportMarkdown ───────────────────────────────────

describe('N-210 R1 — renderComplianceReportMarkdown conditional sections', () => {
  it('R1-1: PASS header and check-mark emoji for passing gate', () => {
    const report = buildEuComplianceReport(makeScanWithSources());
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('PASS');
    expect(md).toContain(':white_check_mark:');
  });

  it('R1-2: FAIL header and x emoji for failing gate', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('FAIL');
    expect(md).toContain(':x:');
  });

  it('R1-3: threshold row shown when threshold > 0', () => {
    const report = buildEuComplianceReport(makeScanWithSources());
    const gate = evaluateComplianceGate(report, { threshold: 70 });
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('Threshold');
    expect(md).toContain('70');
  });

  it('R1-4: threshold row NOT shown when threshold = 0', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 0 });
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).not.toContain('Threshold');
  });

  it('R1-5: remediations section shown when failing articles have remediations', () => {
    const scan = makeScan({
      overallRisk: 'low',
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias.', match: 'x', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('Recommended Remediations');
    expect(md).toContain('<details>');
  });

  it('R1-6: remediations section NOT shown when all articles pass', () => {
    const report = buildEuComplianceReport(makeScanWithSources());
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).not.toContain('<details>');
  });

  it('R1-7: Annex III section shown when applicable and items present', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('Annex III Conformity Assessment');
    expect(md).toContain('Pass rate:');
  });

  it('R1-8: Annex III section NOT shown when not applicable', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).not.toContain('Annex III Conformity Assessment');
  });

  it('R1-9: Annex item icons — :white_check_mark: for pass items', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    // Some annex items will pass (e.g., Art.10 is compliant for a high-risk scan with no bias)
    expect(md).toContain(':white_check_mark:');
  });

  it('R1-10: Annex item icons — :warning: for partial items', () => {
    // High risk scan with all-supported claims → Art.9 is 'partial' → annex item is 'partial' → :warning:
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain(':warning:');
  });

  it('R1-11: Annex item icons — :x: for fail items', () => {
    // Critical risk + 3 contradicted → Art.9 non-compliant → toAnnexStatus = 'fail' → :x:
    const claims: Claim[] = [
      { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
    ];
    const scan = makeScan({
      claims,
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    // Art.9 is non-compliant → annex item 'fail' → :x:
    expect(md).toContain(':x:');
  });

  it('R1-12: article status table includes all articles', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('Article Status');
    expect(md).toContain('Article 9');
    expect(md).toContain('Article 13');
  });
});

// ── Group R2: renderCiGateOutput negative assertions ─────────────────────────

describe('N-210 R2 — renderCiGateOutput sections NOT shown when conditions false', () => {
  it('R2-1: non-compliant count message NOT shown in passing output', () => {
    const report = buildEuComplianceReport(makeScanWithSources());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(gate.pass).toBe(true);
    expect(output).not.toContain('non-compliant article(s) found');
  });

  it('R2-2: high/critical risk message NOT shown when risk is low', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('Overall risk is');
  });

  it('R2-3: threshold message NOT shown when threshold is 0', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('below threshold');
  });

  it('R2-4: art6ConformityRequired message NOT shown when art6 not triggered', () => {
    // Default scan: no high-risk claimMappings → art6ConformityRequired = false
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('conformity assessment required');
  });

  it('R2-5: annex failing items message NOT shown when no failing items', () => {
    // High risk + all supported → some annex items may be partial but not 'fail' or 'not-assessed'
    const scan = makeScan({
      overallRisk: 'high',
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    // Art.9 is partial for high risk → toAnnexStatus = 'partial', NOT 'fail' → no "Annex III: N conformity item(s)" message
    expect(output).not.toContain('conformity item(s) require attention');
  });

  it('R2-6: annex failing items message shown when annex items fail', () => {
    // Critical + 3 contradicted → Art.9 non-compliant → toAnnexStatus = 'fail' → message shown
    const claims: Claim[] = [
      { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
    ];
    const scan = makeScan({
      claims,
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
    expect(output).toContain('conformity item(s) require attention');
  });

  it('R2-7: remediations section NOT shown when all articles have no remediations', () => {
    // For a fully passing scan, no remediations
    const report = buildEuComplianceReport(makeScanWithSources());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('Recommended Remediations:');
  });
});

// ── Group S1: renderComplianceReportSarif ────────────────────────────────────

describe('N-210 S1 — renderComplianceReportSarif structure and level mapping', () => {
  it('S1-1: produces valid SARIF 2.1.0 JSON', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    expect(sarif.version).toBe('2.1.0');
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs[0].tool.driver.name).toBe('Faultline Pro');
  });

  it('S1-2: compliant and not-applicable articles are excluded from SARIF results', () => {
    const report = buildEuComplianceReport(makeScanWithSources());
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    // For a clean scan, only partial articles produce results (not compliant/not-applicable)
    const results = sarif.runs[0].results as Array<{ properties: { status: string } }>;
    for (const r of results) {
      expect(r.properties.status).not.toBe('compliant');
      expect(r.properties.status).not.toBe('not-applicable');
    }
  });

  it('S1-3: non-compliant articles produce "error" SARIF level', () => {
    const scan = makeScan({
      overallRisk: 'low',
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias.', match: 'x', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const results = sarif.runs[0].results as Array<{ level: string; properties: { status: string } }>;
    const nonCompliantResult = results.find(r => r.properties.status === 'non-compliant');
    expect(nonCompliantResult).toBeDefined();
    expect(nonCompliantResult?.level).toBe('error');
  });

  it('S1-4: partial articles produce "warning" SARIF level', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const results = sarif.runs[0].results as Array<{ level: string; properties: { status: string } }>;
    const partialResults = results.filter(r => r.properties.status === 'partial');
    expect(partialResults.length).toBeGreaterThan(0);
    for (const r of partialResults) {
      expect(r.level).toBe('warning');
    }
  });

  it('S1-5: SARIF result message includes article findings when present', () => {
    const scan = makeScan({
      overallRisk: 'low',
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias.', match: 'x', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const results = sarif.runs[0].results as Array<{ message: { text: string }; properties: { status: string } }>;
    const nonCompliantResult = results.find(r => r.properties.status === 'non-compliant');
    // Message should include the article name and findings text
    expect(nonCompliantResult?.message.text).toContain('non-compliant');
    expect(nonCompliantResult?.message.text.length).toBeGreaterThan(10);
  });

  it('S1-6: gap articles produce "error" SARIF level', () => {
    const scan = makeScan({
      claims: [],
      verifications: {},
      overallRisk: 'low',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const results = sarif.runs[0].results as Array<{ level: string; properties: { status: string } }>;
    const gapResults = results.filter(r => r.properties.status === 'gap');
    // Art.15 is 'gap' when no claims
    for (const r of gapResults) {
      expect(r.level).toBe('error');
    }
  });
});

// ── Group G3: getRemediations Art.10/13/14/15 keyword branches ───────────────

describe('N-210 G3 — getRemediations keyword branch coverage', () => {
  it('G3-1: Art.10 bias → audit + document remediations', () => {
    const rems = getRemediations('Article 10', 'non-compliant', ['1 bias finding(s) detected.']);
    expect(rems.some(r => r.includes('bias audit'))).toBe(true);
    expect(rems.some(r => r.includes('Document bias'))).toBe(true);
  });

  it('G3-2: Art.10 PII → special category data remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['1 PII finding(s) — data processing must comply.']);
    expect(rems.some(r => r.includes('special category'))).toBe(true);
  });

  it('G3-3: Art.10 contradicted → training data quality remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['1 contradicted claim(s) — data quality issue.']);
    expect(rems.some(r => r.includes('training data quality'))).toBe(true);
  });

  it('G3-4: Art.10 unverified → data completeness remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['1 high-importance claim(s) remain unverified.']);
    expect(rems.some(r => r.includes('unverified high-importance'))).toBe(true);
  });

  it('G3-5: Art.10 fallback when no keyword matches', () => {
    const rems = getRemediations('Article 10', 'partial', ['Some generic data finding.']);
    expect(rems.some(r => r.includes('data governance'))).toBe(true);
  });

  it('G3-6: Art.13 unverified → source attribution remediations', () => {
    const rems = getRemediations('Article 13', 'partial', ['1 unverified/mixed claim(s) represent transparency gaps.']);
    expect(rems.some(r => r.includes('source attribution'))).toBe(true);
    expect(rems.some(r => r.includes('confidence scoring'))).toBe(true);
  });

  it('G3-7: Art.13 mixed → source attribution remediations', () => {
    const rems = getRemediations('Article 13', 'partial', ['1 mixed claim(s) represent transparency gaps.']);
    expect(rems.some(r => r.includes('source attribution'))).toBe(true);
  });

  it('G3-8: Art.13 no-claims → ensure factual statements remediation', () => {
    const rems = getRemediations('Article 13', 'gap', ['No claims extracted.']);
    expect(rems.some(r => r.includes('verifiable factual'))).toBe(true);
  });

  it('G3-9: Art.13 always includes capabilities/limitations remediation', () => {
    const rems = getRemediations('Article 13', 'partial', ['Some transparency gap.']);
    expect(rems.some(r => r.includes('capabilities'))).toBe(true);
  });

  it('G3-10: Art.14 always returns oversight remediations', () => {
    const rems = getRemediations('Article 14', 'partial', ['1 interpretation claim(s).']);
    expect(rems.some(r => r.includes('human-in-the-loop'))).toBe(true);
    expect(rems.some(r => r.includes('oversight procedures'))).toBe(true);
  });

  it('G3-11: Art.11 insufficient → add explanations remediation', () => {
    const rems = getRemediations('Article 11', 'gap', ['No verification explanations or sources present — technical documentation of system decision-making is insufficient.']);
    expect(rems.some(r => r.includes('verification explanations'))).toBe(true);
  });

  it('G3-12: Art.11 sources → provenance remediation', () => {
    const rems = getRemediations('Article 11', 'partial', ['1/2 claim(s) cite verification sources — evidence provenance documented.']);
    expect(rems.some(r => r.includes('source citations'))).toBe(true);
  });

  it('G3-13: Art.11 always includes technical documentation remediation', () => {
    const rems = getRemediations('Article 11', 'partial', ['Some documentation finding.']);
    expect(rems.some(r => r.includes('technical documentation'))).toBe(true);
  });

  it('G3-14: Art.12 no-provider → record provider remediation', () => {
    const rems = getRemediations('Article 12', 'partial', ['Rule finding(s) recorded.']);
    // No 'Provider recorded' in findings → push "Record AI system provider" remediation
    expect(rems.some(r => r.includes('Record AI system provider'))).toBe(true);
  });

  it('G3-15: Art.12 no-monitoring → implement monitoring remediation', () => {
    const rems = getRemediations('Article 12', 'partial', ['Provider recorded: "mock"']);
    // No 'rule finding' in findings → push monitoring remediation
    expect(rems.some(r => r.includes('monitoring rules'))).toBe(true);
  });

  it('G3-16: Art.12 always includes automatic event logging remediation', () => {
    const rems = getRemediations('Article 12', 'partial', ['']);
    expect(rems.some(r => r.includes('automatic event logging'))).toBe(true);
  });
});

// ── Group A1: Art.15 finding content assertions ───────────────────────────────

describe('N-210 A1 — Art.15 finding content and injection path', () => {
  it('A1-1: Art.15 injection finding includes cybersecurity text', () => {
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'prompt-injection', severity: 'critical', message: 'Injection.', match: 'drop table', offset: 0 },
      ],
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.findings.some(f => f.includes('injection/attack'))).toBe(true);
    expect(art15?.findings.some(f => f.includes('cybersecurity'))).toBe(true);
  });

  it('A1-2: Art.15 is non-compliant when injection finding present', () => {
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'injection-detection', severity: 'high', message: 'Injection.', match: 'x', offset: 0 },
      ],
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.status).toBe('non-compliant');
  });

  it('A1-3: Art.15 high-importance unverified finding includes "robustness assessment" text', () => {
    const claims: Claim[] = [{ id: 'hi1', text: 'Critical claim.', type: 'fact', importance: 5 }];
    const report = buildEuComplianceReport(makeScan({
      claims,
      verifications: {
        hi1: { claimId: 'hi1', status: 'unverified', explanation: '', sources: [] },
      },
      overallRisk: 'medium',
    }));
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.findings.some(f => f.includes('robustness assessment'))).toBe(true);
    expect(art15?.status).toBe('partial');
  });

  it('A1-4: Art.15 no-issues fallback finding when all claims clean', () => {
    const report = buildEuComplianceReport(makeScan());
    const art15 = report.articleEvidence.find(e => e.article.includes('Article 15'));
    expect(art15?.findings.some(f => f.includes('No accuracy, robustness'))).toBe(true);
  });

  it('A1-5: Art.9 no-issues fallback finding when all clean', () => {
    const report = buildEuComplianceReport(makeScan());
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('No risk management findings'))).toBe(true);
  });

  it('A1-6: Art.9 PII finding text includes GDPR mention', () => {
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'pii-detector', severity: 'high', message: 'PII found.', match: 'email@test.com', offset: 0 },
      ],
    }));
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('PII'))).toBe(true);
    expect(art9?.findings.some(f => f.includes('GDPR'))).toBe(true);
  });

  it('A1-7: Art.9 interpretation finding text mentions human oversight', () => {
    const scan = makeScan({
      claims: [{ id: 'i1', text: 'Interpretation.', type: 'interpretation', importance: 3 }],
      verifications: {
        i1: { claimId: 'i1', status: 'supported', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('human oversight'))).toBe(true);
  });

  it('A1-8: Art.12 no-findings fallback text when no ruleFindings', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [],
      verifications: {},
      provider: '',
      ruleFindings: [],
      overallRisk: 'low',
    }));
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    // score=0 → gap, uses fallback findings
    expect(art12?.findings.some(f => f.includes('no logging evidence'))).toBe(true);
  });
});
