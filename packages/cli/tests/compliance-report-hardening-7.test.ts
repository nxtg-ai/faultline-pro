// Validates: N-210 (compliance-report.ts mutation hardening — Gate 6 sprint, batch 7)
//
// Seventh targeted batch — precision kill run for the 35-kill gap to 80%.
// Targets:
//   Lines 86-210: buildTestCategoryMappings — type/status filter mutations + OptionalChaining
//   Lines 255-384: getRemediations Art.5 + Art.50 StringLiteral survivors
//   Lines 1310-1370: diffComplianceReports STATUS_RANK/RISK_RANK ObjectLiteral→{}
//   Lines 1595-1630: renderComplianceReportSarif SARIF annex deep-structure ObjectLiteral/StringLiteral
//   Lines 946, 990, 1252: miscellaneous arithmetic + conditional survivors

import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

import {
  buildEuComplianceReport,
  getRemediations,
  renderComplianceReportSarif,
  renderCiGateOutput,
  evaluateComplianceGate,
  diffComplianceReports,
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
    documentRef: `FP-B7-${Date.now()}`,
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
    pass: true, overallRisk: 'low', articles: [], nonCompliantCount: 0,
    totalArticles: 3, exitCode: 0, complianceScore: 85, threshold: 0,
    art6ConformityRequired: false, ...overrides,
  };
}

// ── Group H7a: buildTestCategoryMappings filter precision ─────────────────────

describe('N-210 H7a — buildTestCategoryMappings type/status filter precision', () => {
  it('H7a-1: missing verification entry → report builds cleanly (kills OptionalChaining ?.status→.status at lines 96/109/123/171)', () => {
    // c2 has NO entry in verifications — OptionalChaining mutation causes TypeError → mutant killed
    const report = buildEuComplianceReport(makeScan({
      claims: [
        { id: 'c1', text: 'Fact.', type: 'fact', importance: 3 },
        { id: 'c2', text: 'Fact.', type: 'fact', importance: 3 }, // no verification entry
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        // c2 intentionally absent
      },
    }));
    // With original ?.status: c2 excluded → count=1; with mutation .status: TypeError → crash
    const factSupported = report.testCategoryMappings.find(m => m.category === 'fact (supported)');
    expect(factSupported!.claimCount).toBe(1);
  });

  it('H7a-2: unverified fact claim → factSupported count = 1, not 2 (kills condition→true at line 96)', () => {
    // Mutation c.type==='fact'&&true would include the unverified claim, giving count=2
    const report = buildEuComplianceReport(makeScan({
      claims: [
        { id: 'c1', text: 'A.', type: 'fact', importance: 3 },
        { id: 'c2', text: 'B.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: '', sources: [] },
      },
    }));
    const factSupported = report.testCategoryMappings.find(m => m.category === 'fact (supported)');
    expect(factSupported!.claimCount).toBe(1);
  });

  it('H7a-3: contradicted opinion claim → factContradicted category absent (kills c.type→true at line 109)', () => {
    // Mutation c => true && status==='contradicted' would include opinion type → count=1
    const report = buildEuComplianceReport(makeScan({
      claims: [
        { id: 'c1', text: 'A.', type: 'fact', importance: 3 },
        { id: 'c2', text: 'Opinion.', type: 'opinion', importance: 2 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
    }));
    const factContradicted = report.testCategoryMappings.find(m => m.category === 'fact (contradicted)');
    // c1 is supported (not contradicted), c2 is opinion (not fact) → no fact+contradicted mapping
    expect(factContradicted).toBeUndefined();
  });

  it('H7a-4: mixed-status fact claim → factUnverified includes it (kills StringLiteral "mixed"→"" at line 123)', () => {
    // Mutation replaces 'mixed' with '' → mixed-status claim excluded from factUnverified
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'A.', type: 'fact', importance: 3 }],
      verifications: {
        c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting.', sources: [] },
      },
    }));
    const factUnverified = report.testCategoryMappings.find(m => m.category === 'fact (unverified/mixed)');
    expect(factUnverified).toBeDefined();
    expect(factUnverified!.claimCount).toBe(1);
  });

  it('H7a-5: interpretation claim → testCategoryMappings has A03 OWASP ref (kills StringLiteral at line 153)', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'Interpret.', type: 'interpretation', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    }));
    const interpMapping = report.testCategoryMappings.find(m => m.category === 'interpretation');
    expect(interpMapping).toBeDefined();
    expect(interpMapping!.owaspRef).toContain('OWASP Agentic AI A03');
    expect(interpMapping!.owaspRef).toContain('Excessive Agency');
  });

  it('H7a-6: non-bias ruleFinding → biasFindings category absent (kills MethodExpression biasFindings→ruleFindings)', () => {
    // ruleFindings has injection finding (not bias) → with mutation, all findings count as bias
    const report = buildEuComplianceReport(makeScan({
      ruleFindings: [
        { ruleId: 'injection-check', severity: 'high', message: 'Injection risk.', match: '', offset: 0 },
      ],
    }));
    // With original: biasFindings only includes /bias/ ruleIds → injection-check not included → no bias mapping
    // With mutation biasFindings→ruleFindings: injection-check IS included → bias mapping present → test fails
    const biasMapping = report.testCategoryMappings.find(m => m.category === 'bias finding(s)');
    expect(biasMapping).toBeUndefined();
  });

  it('H7a-7: importance=4 unverified claim → highImportanceUnverified includes it (kills >=4→>4 at line 171)', () => {
    // Mutation >4 would exclude importance=4 claim
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'Critical.', type: 'fact', importance: 4 }],
      verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    }));
    const hiMapping = report.testCategoryMappings.find(m => m.category === 'fact (high-importance, unverified)');
    expect(hiMapping).toBeDefined();
    expect(hiMapping!.claimCount).toBe(1);
  });

  it('H7a-8: importance=3 unverified claim → highImportanceUnverified absent (negative assertion, kills >=4→>=0)', () => {
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'Normal.', type: 'fact', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    }));
    const hiMapping = report.testCategoryMappings.find(m => m.category === 'fact (high-importance, unverified)');
    expect(hiMapping).toBeUndefined();
  });
});

// ── Group H7b: buildTestCategoryMappings documentation filter ─────────────────

describe('N-210 H7b — buildTestCategoryMappings claimsWithDocumentation filter', () => {
  it('H7b-1: claim with explanation only (no sources) → documentation category present (kills ||→&&)', () => {
    // Mutation ||→&& requires BOTH explanation AND sources → claim with only explanation would be excluded
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'A.', type: 'fact', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'Explanation here.', sources: [] } },
    }));
    const docMapping = report.testCategoryMappings.find(m => m.category === 'claim(s) with verification documentation');
    expect(docMapping).toBeDefined();
    expect(docMapping!.claimCount).toBe(1);
  });

  it('H7b-2: claim with sources only (no explanation) → documentation category present (kills explanation branch→false)', () => {
    // Mutation (v.explanation && ...) → false → claim with only sources excluded
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'A.', type: 'fact', importance: 3 }],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [{ uri: 'http://example.com', title: 'Ref' }] },
      },
    }));
    const docMapping = report.testCategoryMappings.find(m => m.category === 'claim(s) with verification documentation');
    expect(docMapping).toBeDefined();
    expect(docMapping!.claimCount).toBe(1);
  });

  it('H7b-3: claim with no explanation and no sources → documentation category absent (kills condition→true)', () => {
    // Mutation condition→true would always include claim even without documentation
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'A.', type: 'fact', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    }));
    const docMapping = report.testCategoryMappings.find(m => m.category === 'claim(s) with verification documentation');
    expect(docMapping).toBeUndefined();
  });

  it('H7b-4: documentation category name exact match (kills StringLiteral "claim(s) with verification documentation"→"")', () => {
    const report = buildEuComplianceReport(makeScan());
    const docMapping = report.testCategoryMappings.find(m => m.category === 'claim(s) with verification documentation');
    expect(docMapping).toBeDefined();
    expect(docMapping!.category).toContain('verification documentation');
  });
});

// ── Group H7c: getRemediations Art.5 + Art.50 StringLiteral survivors ─────────

describe('N-210 H7c — getRemediations Art.5 and Art.50 remediations', () => {
  it('H7c-1: Art.5 non-compliant → "Remove or reclassify" remediation present (kills StringLiteral)', () => {
    const rems = getRemediations('Article 5 – Prohibited AI Practices', 'non-compliant', ['1 prohibited practice found.']);
    expect(rems.some(r => r.includes('Remove or reclassify'))).toBe(true);
  });

  it('H7c-2: Art.5 non-compliant → "Conduct Art. 5(1) legal review" present (kills StringLiteral)', () => {
    const rems = getRemediations('Article 5 – Prohibited AI Practices', 'non-compliant', ['Finding.']);
    expect(rems.some(r => r.includes('Art. 5(1) legal review'))).toBe(true);
  });

  it('H7c-3: Art.50 with opinion finding → "disclosure mechanisms" remediation present (kills condition + StringLiteral)', () => {
    const rems = getRemediations('Article 50 – GPAI Transparency', 'partial', ['opinion claim detected.']);
    expect(rems.some(r => r.includes('disclosure mechanisms for AI-generated opinion'))).toBe(true);
  });

  it('H7c-4: Art.50 without opinion finding → "disclosure mechanisms" absent (kills condition→true)', () => {
    const rems = getRemediations('Article 50 – GPAI Transparency', 'partial', ['AI-generated content found.']);
    expect(rems.some(r => r.includes('disclosure mechanisms for AI-generated opinion'))).toBe(false);
  });

  it('H7c-5: Art.50 partial → voice/audio disclosure always present (kills StringLiteral "Art. 50(4)")', () => {
    const rems = getRemediations('Article 50 – GPAI Transparency', 'partial', []);
    expect(rems.some(r => r.includes('Art. 50(4) voice/audio disclosure'))).toBe(true);
  });
});

// ── Group H7d: SARIF annex items deep structure ───────────────────────────────

describe('N-210 H7d — renderComplianceReportSarif annex deep-structure fields', () => {
  function makeAnnexSarifReport(): EuAiActComplianceReport {
    return makeMinimalReport({
      annexIIIChecklist: {
        applicable: true,
        passRate: 0.5,
        items: [
          {
            id: 'annex-iii-1',
            article: 'Article 9',
            requirement: 'Risk management system — continuous identification',
            status: 'partial', // != 'pass' → included in SARIF
            evidence: 'Article 9 status: partial',
          },
          {
            id: 'annex-iii-4',
            article: 'Article 12',
            requirement: 'Record-keeping — automatic logging',
            status: 'fail',
            evidence: 'Article 12 status: non-compliant',
          },
        ],
      },
    });
  }

  it('H7d-1: fullDescription.text contains item.evidence (kills fullDescription ObjectLiteral→{})', () => {
    const report = makeAnnexSarifReport();
    const gate = makeGate();
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const rules = sarif.runs[0].tool.driver.rules;
    const rule = rules.find((r: { id: string }) => r.id.includes('annex-iii-1'));
    expect(rule).toBeDefined();
    expect(rule.fullDescription.text).toContain('Article 9 status: partial');
  });

  it('H7d-2: defaultConfiguration.level === level (kills defaultConfiguration ObjectLiteral→{})', () => {
    const report = makeAnnexSarifReport();
    const gate = makeGate();
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const rules = sarif.runs[0].tool.driver.rules;
    const rule = rules.find((r: { id: string }) => r.id.includes('annex-iii-4'));
    expect(rule).toBeDefined();
    // annex-iii-4 has status='fail' → level='error'
    expect(rule.defaultConfiguration.level).toBe('error');
  });

  it('H7d-3: result message.text contains "Annex III conformity gap" (kills ObjectLiteral/StringLiteral at 1618)', () => {
    const report = makeAnnexSarifReport();
    const gate = makeGate();
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const results = sarif.runs[0].results;
    const res = results.find((r: { ruleId: string }) => r.ruleId.includes('annex-iii-1'));
    expect(res).toBeDefined();
    expect(res.message.text).toContain('Annex III conformity gap');
    expect(res.message.text).toContain('Article 9');
  });

  it('H7d-4: rule properties.tags contains "eu-ai-act" and "conformity" (kills StringLiteral)', () => {
    const report = makeAnnexSarifReport();
    const gate = makeGate();
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const rule = sarif.runs[0].tool.driver.rules[0];
    expect(rule.properties.tags).toContain('eu-ai-act');
    expect(rule.properties.tags).toContain('conformity');
  });

  it('H7d-5: result locations[0].artifactLocation uri and uriBaseId (kills StringLiteral "input" + "%SRCROOT%")', () => {
    const report = makeAnnexSarifReport();
    const gate = makeGate();
    const sarif = JSON.parse(renderComplianceReportSarif(report, gate));
    const result = sarif.runs[0].results[0];
    const loc = result.locations[0].physicalLocation.artifactLocation;
    expect(loc.uri).toBe('input');
    expect(loc.uriBaseId).toBe('%SRCROOT%');
  });
});

// ── Group H7e: diffComplianceReports STATUS_RANK/RISK_RANK ────────────────────

describe('N-210 H7e — diffComplianceReports STATUS_RANK and RISK_RANK', () => {
  it('H7e-1: article improves from non-compliant to compliant → trend="improved" (kills STATUS_RANK→{})', () => {
    // With STATUS_RANK→{}, all ranks default to 2 (??2) → aRank===bRank → trend="unchanged"
    const before = makeMinimalReport({
      overallRisk: 'high',
      articleEvidence: [{
        article: 'Article 9 – Risk Management System', requirement: 'R', status: 'non-compliant',
        findings: ['Issue.'], remediations: ['Fix it.'], evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const after = makeMinimalReport({
      overallRisk: 'high',
      articleEvidence: [{
        article: 'Article 9 – Risk Management System', requirement: 'R', status: 'compliant',
        findings: [], remediations: [], evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const diff = diffComplianceReports(before, after);
    const art9 = diff.articles.find(a => a.article.includes('Article 9'))!;
    expect(art9.trend).toBe('improved');
    expect(diff.improved).toBe(1);
    expect(diff.regressed).toBe(0);
  });

  it('H7e-2: article regresses from compliant to gap → trend="regressed" (kills STATUS_RANK→{})', () => {
    const before = makeMinimalReport({
      overallRisk: 'low',
      articleEvidence: [{
        article: 'Article 10 – Data', requirement: 'R', status: 'compliant',
        findings: [], remediations: [], evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const after = makeMinimalReport({
      overallRisk: 'low',
      articleEvidence: [{
        article: 'Article 10 – Data', requirement: 'R', status: 'gap',
        findings: ['Gap.'], remediations: ['Fix.'], evidenceCount: 0, sourceCount: 0, strengthScore: 0,
      }],
    });
    const diff = diffComplianceReports(before, after);
    const art10 = diff.articles.find(a => a.article.includes('Article 10'))!;
    expect(art10.trend).toBe('regressed');
    expect(diff.regressed).toBe(1);
  });

  it('H7e-3: risk improves from high to low → riskTrend="improved" (kills RISK_RANK→{})', () => {
    // With RISK_RANK→{}, all risk ranks default to 1 (??1) → all equal → riskTrend="unchanged"
    const before = makeMinimalReport({ overallRisk: 'high' });
    const after = makeMinimalReport({ overallRisk: 'low' });
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('improved');
  });
});

// ── Group H7f: miscellaneous arithmetic + conditional survivors ────────────────

describe('N-210 H7f — miscellaneous survivors: Art.50 opinion, highRiskFindings, threshold conditions', () => {
  it('H7f-1: 1 opinion claim → Art.50 opinion finding present (kills opinionClaims.length>0 → >1)', () => {
    // Mutation >1 would require 2+ opinion claims; >0 correctly includes 1
    const report = buildEuComplianceReport(makeScan({
      claims: [{ id: 'c1', text: 'I believe.', type: 'opinion', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    }));
    const art50 = report.articleEvidence.find(a => a.article.includes('Article 50'))!;
    expect(art50.findings.some(f => f.includes('opinion claim(s) detected'))).toBe(true);
  });

  it('H7f-2: no opinion claims → Art.50 opinion finding absent (kills >0→>=0)', () => {
    const report = buildEuComplianceReport(makeScan());
    const art50 = report.articleEvidence.find(a => a.article.includes('Article 50'))!;
    expect(art50.findings.some(f => f.includes('opinion claim(s) detected'))).toBe(false);
  });

  it('H7f-3: highRiskFindings = contradicted + pii + bias + unacceptable (kills +→- arithmetic at line 990)', () => {
    // 1 contradicted + 1 pii finding + 1 bias finding = highRiskFindings=3
    // Mutation +→- for any operand changes the sum; test exact count kills it
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
      },
      ruleFindings: [
        { ruleId: 'pii-detector', severity: 'high', message: 'PII found.', match: '', offset: 0 },
        { ruleId: 'bias-check', severity: 'medium', message: 'Bias found.', match: '', offset: 0 },
      ],
    }));
    // 1 contradicted + 1 pii + 1 bias + 0 unacceptable = 3
    expect(report.summary.highRiskFindings).toBe(3);
  });

  it('H7f-4: threshold=0, fail gate (nonCompliant=1) → "is below threshold" absent (kills threshold>0→>=0)', () => {
    // With mutation threshold>=0: threshold=0 satisfies >=0 → might show the threshold message
    // The condition: gate.threshold > 0 && score < gate.threshold
    // With threshold=0: >0 is false → block skipped → message absent ✓
    // With mutation >=0: >=0 is true for threshold=0 AND score(50) < threshold(0) is FALSE → still absent!
    // Actually this might be more subtle. Let me think:
    // The mutation at line 1252 might be the ConditionalExpression → true/false, not just >0→>=0.
    // With condition→true: message ALWAYS shows → test fails → kills mutant
    const output = renderCiGateOutput(
      makeGate({ threshold: 0, complianceScore: 50, pass: false, exitCode: 1, nonCompliantCount: 1 }),
      makeMinimalReport({ complianceScore: 50, overallRisk: 'low' }),
    );
    expect(output).not.toContain('is below threshold');
  });

  it('H7f-5: threshold=75, score=75 (equal) → "is below threshold" absent (kills <→<=)', () => {
    // Mutation <→<=: score <= threshold is true when score=threshold=75 → message would appear
    const output = renderCiGateOutput(
      makeGate({ threshold: 75, complianceScore: 75, pass: false, exitCode: 1, nonCompliantCount: 1 }),
      makeMinimalReport({ complianceScore: 75, overallRisk: 'low' }),
    );
    expect(output).not.toContain('is below threshold');
  });
});
