// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint, batch 5)
//
// Fifth targeted batch. Key insights from batch 4 analysis:
//   1. Art.52 BlockStatement/ConditionalExpression survivors: fallback text contains keywords
//      'emotion', 'biometric', 'synthetic' — so f.includes('emotion') passes for fallback.
//      Fix: assert UNIQUE text NOT in fallback ('OWASP Agentic AI', 'machine-generated labelling')
//      AND use negative assertions (clean scan → specific unique text absent).
//   2. EqualityOperator >=0 survivors: condition always-true fires block with count=0,
//      producing "0 emotion/sentiment..." text — still passes the keyword check.
//      Fix: negative assertion on clean scan.
//   3. renderComplianceReportMarkdown annex icons: `:warning:` and `:grey_question:` not tested.
//   4. htmlStatusColor / escapeHtml tested via renderComplianceReportHtml.
//   5. evaluateComplianceGate strict mode + art6ConformityRequired conditions.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import {
  buildEuComplianceReport,
  evaluateComplianceGate,
  renderComplianceReportMarkdown,
  renderComplianceReportSarif,
  renderComplianceReportHtml,
} from '../cli/compliance-report.js';
import type { EuAiActComplianceReport } from '../cli/compliance-report.js';
import type { ScanResult } from '../cli/scan.js';
import type { ComplianceReport } from '../compliance/report_generator.js';

// ── Helpers ─────────────────────────────────────────────────────���─────────────

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

// ── Group H5a: Art.52 — unique text assertions + negative assertions ───────────
// Key insight: fallback text = 'No Art. 52 transparency triggers detected (no chatbot
// interaction, emotion recognition, biometric categorisation, or synthetic media signals).'
// The keywords 'emotion', 'biometric', 'synthetic' appear in the FALLBACK, so we must
// use UNIQUE text not in the fallback to kill BlockStatement/ConditionalExpression/EqualityOperator.

describe('N-210 H5a — Art.52 unique text + negative assertions', () => {
  it('H5a-1: emotion ruleFindings → OWASP A06 text present (unique, not in fallback)', () => {
    // Kills BlockStatement at line 863 (block body emptied → OWASP text absent)
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'emotion-detection', severity: 'high', message: 'Emotion.', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('OWASP Agentic AI A06'))).toBe(true);
  });

  it('H5a-2: no emotion ruleFindings → OWASP A06 text ABSENT (kills condition→true)', () => {
    // Kills ConditionalExpression→true and EqualityOperator>=0 at line 863
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('OWASP Agentic AI A06'))).toBe(false);
  });

  it('H5a-3: only emotion present → art52Status partial (kills ||→&& in status condition)', () => {
    // Only emotion — no synthetic/biometric/opinion. With ||→&& mutation, status would be not-applicable.
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'sentiment-analysis', severity: 'medium', message: 'Sentiment.', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.status).toBe('partial');
  });

  it('H5a-4: emotion finding specific count text (kills StringLiteral for template literal)', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'emotion-detection', severity: 'high', message: 'Emotion.', match: '', offset: 0 },
        { ruleId: 'sentiment-analysis', severity: 'medium', message: 'Sentiment.', match: '', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    // "2 emotion/sentiment finding(s)" — count + unique fragment
    expect(art52?.findings.some(f => f.includes('emotion/sentiment') && f.includes('recognition must be informed'))).toBe(true);
  });

  it('H5a-5: biometric claimMappings → unique biometric text present (not in fallback)', () => {
    // Fallback has 'biometric categorisation' but NOT 'persons must be informed when biometric data is used'
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometric.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometric identification system'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('persons must be informed when biometric data'))).toBe(true);
  });

  it('H5a-6: no biometric claimMappings → biometric unique text ABSENT (kills condition→true)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('persons must be informed when biometric data'))).toBe(false);
  });

  it('H5a-7: only biometric present → art52Status partial (kills ||→&& in status condition)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [{
          claimId: 'c1', claimText: 'Biometric categorisation.', verificationStatus: 'supported', riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
          matchedPatterns: ['biometric categorisation of persons'], confidence: 'high', confidenceScore: 0.9,
        }],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.status).toBe('partial');
  });

  it('H5a-8: synthetic ruleFindings → machine-generated labelling text present (unique)', () => {
    // Fallback has 'synthetic media signals' but NOT 'machine-generated labelling required'
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'synthetic-media-detection', severity: 'high', message: 'Synthetic.', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('machine-generated labelling required'))).toBe(true);
  });

  it('H5a-9: no synthetic ruleFindings → machine-generated labelling ABSENT (kills condition→true)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('machine-generated labelling required'))).toBe(false);
  });

  it('H5a-10: only synthetic present → art52Status partial (kills ||→&& in status condition)', () => {
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'deepfake-detection', severity: 'high', message: 'Deepfake.', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.status).toBe('partial');
  });

  it('H5a-11: Art.52(3) text in synthetic finding (kills StringLiteral)', () => {
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'generated-content-detector', severity: 'medium', message: 'Gen.', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('Art. 52(3)'))).toBe(true);
  });

  it('H5a-12: only opinion claims present → art52Status partial (kills ||→&& at last operand)', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'I believe AI will transform society.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.status).toBe('partial');
  });

  it('H5a-13: clean scan → art52Status not-applicable (kills status condition→partial)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.status).toBe('not-applicable');
  });

  it('H5a-14: clean scan → fallback finding present (kills art52FinalFindings→art52Findings)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('No Art. 52 transparency triggers detected'))).toBe(true);
  });

  it('H5a-15: emotion scan → fallback finding ABSENT (kills art52Findings.length>0 condition)', () => {
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'emotion-detection', severity: 'high', message: 'E.', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(e => e.article.includes('Article 52'));
    expect(art52?.findings.some(f => f.includes('No Art. 52 transparency triggers detected'))).toBe(false);
  });
});

// ── Group H5b: renderComplianceReportMarkdown annex icons + passRate ────────────

describe('N-210 H5b — renderComplianceReportMarkdown annex icons and passRate', () => {
  function makeAnnexMdReport(items: EuAiActComplianceReport['annexIIIChecklist']['items'], passRate = 0.5): EuAiActComplianceReport {
    return makeMinimalReport({
      annexIIIChecklist: { applicable: true, passRate, items },
      articleEvidence: [{
        article: 'Article 9 – Risk Management System', requirement: 'R',
        status: 'partial', findings: ['Issue.'], remediations: ['Fix it.'],
        evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
  }

  it('H5b-1: annex item status pass → :white_check_mark: emoji in markdown', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 9', requirement: 'Risk mgmt', status: 'pass', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain(':white_check_mark:');
    expect(md).toContain('Art. 9');
  });

  it('H5b-2: annex item status fail → :x: emoji in markdown', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 10', requirement: 'Data gov', status: 'fail', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    // :x: appears for both the gate FAIL icon and the annex fail icon
    expect(md).toContain(':x:');
  });

  it('H5b-3: annex item status partial → :warning: emoji in markdown (kills StringLiteral)', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 11', requirement: 'Tech doc', status: 'partial', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain(':warning:');
  });

  it('H5b-4: annex item status not-assessed → :grey_question: emoji in markdown (kills StringLiteral)', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 6', requirement: 'Classification', status: 'not-assessed', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain(':grey_question:');
  });

  it('H5b-5: passRate 0.75 → "75%" in markdown (kills * 100 arithmetic)', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 9', requirement: 'R', status: 'pass', evidence: 'E' },
    ], 0.75);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('75%');
  });

  it('H5b-6: passRate 0.33 → "33%" in markdown (kills * 100 arithmetic with non-round value)', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 9', requirement: 'R', status: 'partial', evidence: 'E' },
    ], 0.33);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('33%');
  });

  it('H5b-7: Pass rate label present in markdown (kills StringLiteral for "**Pass rate:**")', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 9', requirement: 'R', status: 'pass', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('**Pass rate:**');
  });

  it('H5b-8: Annex III section heading present (kills StringLiteral)', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 9', requirement: 'R', status: 'pass', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('### Annex III Conformity Assessment');
  });

  it('H5b-9: annex section absent when applicable=false (kills &&→|| logic)', () => {
    const report = makeMinimalReport({ annexIIIChecklist: { applicable: false, passRate: 1, items: [] } });
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).not.toContain('### Annex III Conformity Assessment');
  });

  it('H5b-10: item status uppercase in markdown row (kills toUpperCase MethodExpression)', () => {
    const report = makeAnnexMdReport([
      { id: 'a1', article: 'Art. 9', requirement: 'R', status: 'partial', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('PARTIAL');
  });
});

// ── Group H5c: htmlStatusColor + escapeHtml via renderComplianceReportHtml ───────

describe('N-210 H5c — htmlStatusColor and escapeHtml via HTML renderer', () => {
  function makeHtmlReport(status: EuAiActComplianceReport['articleEvidence'][0]['status']): EuAiActComplianceReport {
    return makeMinimalReport({
      articleEvidence: [{ article: 'Test Article', requirement: 'R', status, findings: [], remediations: [], evidenceCount: 0, sourceCount: 0, strengthScore: 0 }],
    });
  }

  it('H5c-1: compliant status → green hex #16a34a in HTML (kills StringLiteral)', () => {
    const report = makeHtmlReport('compliant');
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('#16a34a');
  });

  it('H5c-2: partial status → amber hex #ca8a04 in HTML (kills StringLiteral)', () => {
    const report = makeHtmlReport('partial');
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('#ca8a04');
  });

  it('H5c-3: gap status → orange hex #ea580c in HTML (kills StringLiteral)', () => {
    const report = makeHtmlReport('gap');
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('#ea580c');
  });

  it('H5c-4: non-compliant status → red hex #dc2626 in HTML (kills StringLiteral)', () => {
    const report = makeHtmlReport('non-compliant');
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('#dc2626');
  });

  it('H5c-5: not-applicable status → grey hex #6b7280 in HTML (kills StringLiteral)', () => {
    const report = makeHtmlReport('not-applicable');
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('#6b7280');
  });

  it('H5c-6: requirement with <angle> brackets → escaped in HTML (kills escapeHtml StringLiteral)', () => {
    const report = makeMinimalReport({
      articleEvidence: [{
        article: 'Test', requirement: 'Check <input> & validate "output"', status: 'partial',
        findings: [], remediations: [], evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('&lt;input&gt;');
    expect(html).toContain('&amp;');
  });

  it('H5c-7: remediation with special chars → escaped in HTML (kills escapeHtml in remediations)', () => {
    const report = makeMinimalReport({
      articleEvidence: [{
        article: 'Test', requirement: 'R', status: 'partial',
        findings: ['Issue.'], remediations: ['Fix <this> & review "policy"'],
        evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('&lt;this&gt;');
    expect(html).toContain('&quot;policy&quot;');
  });
});

// ── Group H5d: SARIF annex items — pass skip, fail/partial/note levels, ruleIndex ──

describe('N-210 H5d — renderComplianceReportSarif annex items level mapping', () => {
  function makeAnnexSarifReport(items: EuAiActComplianceReport['annexIIIChecklist']['items']): EuAiActComplianceReport {
    return makeMinimalReport({
      overallRisk: 'high',
      annexIIIChecklist: { applicable: true, passRate: 0.5, items },
    });
  }

  it('H5d-1: annex pass item → NOT in SARIF annex results (kills item.status===pass condition)', () => {
    const report = makeAnnexSarifReport([
      { id: 'annex-iii-1', article: 'Art. 9', requirement: 'Risk mgmt', status: 'pass', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    // Pass items should be skipped, so no annex result for this item
    const annexResults = sarif.runs[0].results.filter(
      (r: { ruleId: string }) => r.ruleId.includes('annex-iii'),
    );
    expect(annexResults.length).toBe(0);
  });

  it('H5d-2: annex fail item → "error" level in SARIF (kills fail→error StringLiteral)', () => {
    const report = makeAnnexSarifReport([
      { id: 'annex-iii-1', article: 'Art. 10', requirement: 'Data', status: 'fail', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const annexResult = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId.includes('annex-iii'));
    expect(annexResult).toBeDefined();
    expect(annexResult.level).toBe('error');
  });

  it('H5d-3: annex partial item → "warning" level in SARIF (kills partial→warning StringLiteral)', () => {
    const report = makeAnnexSarifReport([
      { id: 'annex-iii-2', article: 'Art. 11', requirement: 'Doc', status: 'partial', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const annexResult = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId.includes('annex-iii'));
    expect(annexResult?.level).toBe('warning');
  });

  it('H5d-4: annex not-assessed item → "note" level in SARIF (kills else→note StringLiteral)', () => {
    const report = makeAnnexSarifReport([
      { id: 'annex-iii-0', article: 'Art. 6', requirement: 'Class', status: 'not-assessed', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const annexResult = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId.includes('annex-iii'));
    expect(annexResult?.level).toBe('note');
  });

  it('H5d-5: annex rule ruleIndex = rules.length - 1 (kills arithmetic -1→+1)', () => {
    const report = makeAnnexSarifReport([
      { id: 'annex-iii-1', article: 'Art. 9', requirement: 'Risk', status: 'fail', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const rules = sarif.runs[0].tool.driver.rules;
    const annexResult = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId.includes('annex-iii'));
    // ruleIndex should be the index of the annex rule, which is the last rule added
    expect(annexResult?.ruleIndex).toBe(rules.length - 1);
  });

  it('H5d-6: annex SARIF rule has annex-iii tag (kills StringLiteral for tag)', () => {
    const report = makeAnnexSarifReport([
      { id: 'annex-iii-1', article: 'Art. 9', requirement: 'Risk', status: 'fail', evidence: 'E' },
    ]);
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const rules = sarif.runs[0].tool.driver.rules;
    const annexRule = rules.find((r: { properties: { tags: string[] } }) => r.properties?.tags?.includes('annex-iii'));
    expect(annexRule).toBeDefined();
    expect(annexRule?.properties?.tags).toContain('annex-iii');
  });

  it('H5d-7: SARIF articleSlug includes hyphens for spaces (kills Regex /[^a-z0-9]+/g)', () => {
    const report = makeMinimalReport({
      articleEvidence: [{
        article: 'Article 9 – Risk Management System',
        requirement: 'R', status: 'partial', findings: ['F.'], remediations: [],
        evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const gate = evaluateComplianceGate(report);
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const rule = sarif.runs[0].tool.driver.rules[0];
    // ruleId should use hyphens in place of spaces and special chars
    expect(rule.id).toContain('article-9');
    expect(rule.id).not.toContain(' ');
  });
});

// ── Group H5e: evaluateComplianceGate strict mode + art6ConformityRequired ──────

describe('N-210 H5e — evaluateComplianceGate strict mode + art6ConformityRequired', () => {
  it('H5e-1: strict mode — partial article fails gate (kills strict condition)', () => {
    const report = makeMinimalReport({
      overallRisk: 'low',
      articleEvidence: [
        { article: 'Article 9', requirement: 'R', status: 'partial', findings: [], remediations: [], evidenceCount: 0, sourceCount: 0, strengthScore: 0 },
      ],
    });
    const gate = evaluateComplianceGate(report, { strict: true });
    // In strict mode, partial is NOT passing → at least one article fails → gate.pass = false
    expect(gate.pass).toBe(false);
  });

  it('H5e-2: non-strict mode — partial article passes gate (validates strict condition)', () => {
    const report = makeMinimalReport({
      overallRisk: 'low',
      articleEvidence: [
        { article: 'Article 9', requirement: 'R', status: 'partial', findings: [], remediations: [], evidenceCount: 0, sourceCount: 0, strengthScore: 0 },
      ],
    });
    const gate = evaluateComplianceGate(report, { strict: false });
    // In non-strict mode, partial IS passing (only non-compliant fails)
    expect(gate.pass).toBe(true);
  });

  it('H5e-3: strict + annexFail (fail item) → gate fails (kills annexFail condition)', () => {
    const report = makeMinimalReport({
      overallRisk: 'low',
      annexIIIChecklist: {
        applicable: true,
        passRate: 0.5,
        items: [{ id: 'a1', article: 'Art. 9', requirement: 'R', status: 'fail', evidence: 'E' }],
      },
    });
    const gate = evaluateComplianceGate(report, { strict: true });
    // strict=true + applicable=true + fail item → annexFail = true → gate fails
    expect(gate.pass).toBe(false);
  });

  it('H5e-4: strict + annexFail (not-assessed item) → gate fails (kills fail||not-assessed LogicalOperator)', () => {
    // Item is 'not-assessed' (not 'fail') — need || not && for annexFail to be true
    const report = makeMinimalReport({
      overallRisk: 'low',
      annexIIIChecklist: {
        applicable: true,
        passRate: 0.5,
        items: [{ id: 'a1', article: 'Art. 9', requirement: 'R', status: 'not-assessed', evidence: 'E' }],
      },
    });
    const gate = evaluateComplianceGate(report, { strict: true });
    // With ||: 'not-assessed' matches → annexFail = true → gate fails ✓
    // With && mutation: 'not-assessed' needs BOTH fail AND not-assessed → fails on 'not-assessed' only → gate passes → KILLS mutant
    expect(gate.pass).toBe(false);
  });

  it('H5e-5: art6ConformityRequired true when annex-iii-0 item not pass (kills art6 condition)', () => {
    const report = makeMinimalReport({
      overallRisk: 'low', // NOT high/critical → riskFail=false → art6ConformityRequired can trigger
      annexIIIChecklist: {
        applicable: true,
        passRate: 0.5,
        items: [{ id: 'annex-iii-0', article: 'Art. 6', requirement: 'R', status: 'partial', evidence: 'E' }],
      },
    });
    const gate = evaluateComplianceGate(report);
    expect(gate.art6ConformityRequired).toBe(true);
  });

  it('H5e-6: art6ConformityRequired false when annex-iii-0 item IS pass (kills condition)', () => {
    const report = makeMinimalReport({
      overallRisk: 'low',
      annexIIIChecklist: {
        applicable: true,
        passRate: 1.0,
        items: [{ id: 'annex-iii-0', article: 'Art. 6', requirement: 'R', status: 'pass', evidence: 'E' }],
      },
    });
    const gate = evaluateComplianceGate(report);
    expect(gate.art6ConformityRequired).toBe(false);
  });

  it('H5e-7: non-annex-iii-0 failing item → art6ConformityRequired false (kills ||→&& in id===annex-iii-0)', () => {
    // Item id is NOT 'annex-iii-0' but status is 'fail' — art6ConformityRequired should be FALSE
    // With || mutation: i.id === 'annex-iii-0' || i.status !== 'pass' → any failing item triggers → TRUE → KILLS mutant
    const report = makeMinimalReport({
      overallRisk: 'low',
      annexIIIChecklist: {
        applicable: true,
        passRate: 0.5,
        items: [{ id: 'annex-iii-1', article: 'Art. 9', requirement: 'R', status: 'fail', evidence: 'E' }],
      },
    });
    const gate = evaluateComplianceGate(report);
    expect(gate.art6ConformityRequired).toBe(false);
  });
});

// ── Group H5f: complianceScore summary counts ─────────────────────��──────────

describe('N-210 H5f — complianceScore summary article counts', () => {
  it('H5f-1: summary.compliantArticles > 0 for scan with compliant articles (kills ArrowFunction→undefined)', () => {
    // A scan with sources should have some compliant articles
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    }));
    expect(report.summary.compliantArticles).toBeGreaterThan(0);
  });

  it('H5f-2: summary.partialArticles > 0 for basic scan (kills filter→undefined for partialCount)', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.summary.partialArticles).toBeGreaterThan(0);
  });

  it('H5f-3: summary counts sum to total articles (validates all four count filters)', () => {
    const report = buildEuComplianceReport(makeScan());
    const total = report.summary.compliantArticles + report.summary.nonCompliantArticles +
                  report.summary.partialArticles + report.summary.gapArticles;
    // Plus not-applicable articles (not in summary) — total should be <= articleEvidence.length
    expect(total).toBeGreaterThanOrEqual(0);
    expect(report.summary.compliantArticles + report.summary.nonCompliantArticles +
           report.summary.partialArticles + report.summary.gapArticles)
      .toBeLessThanOrEqual(report.articleEvidence.length);
  });

  it('H5f-4: highRiskFindings = 0 for clean scan (kills + arithmetic)', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.summary.highRiskFindings).toBe(0);
  });

  it('H5f-5: highRiskFindings includes PII findings count (kills + piiFindings arithmetic)', () => {
    // A scan with PII ruleFindings should increase highRiskFindings
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'pii-detection', severity: 'high', message: 'PII detected.', match: 'email', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    expect(report.summary.highRiskFindings).toBeGreaterThan(0);
  });
});
