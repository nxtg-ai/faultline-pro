// Validates: N-157 (EU AI Act Compliance Report Generator — Art. 9/13/50 evidence, PDF + JSON)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock @google/genai so provider imports don't blow up
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

vi.stubGlobal('fetch', vi.fn());

import { main } from '../cli/index.js';
import {
  buildEuComplianceReport,
  renderComplianceReportJson,
  renderComplianceReportPdf,
  evaluateComplianceGate,
  renderCiGateOutput,
  diffComplianceReports,
  renderComplianceDiffOutput,
  getRemediations,
  renderComplianceBadgeSvg,
  type EuAiActComplianceReport,
  type CiGateResult,
  type ComplianceDiffResult,
  type GateOptions,
} from '../cli/compliance-report.js';
import type { ScanResult } from '../cli/scan.js';
import type { ComplianceReport } from '../compliance/report_generator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    input: 'Water boils at 100 degrees Celsius.',
    provider: 'Mock Provider',
    claims: [
      { id: 'c1', text: 'Water boils at 100 degrees Celsius.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'The sky is blue.', type: 'fact', importance: 3 },
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

// ── Unit tests: buildEuComplianceReport ───────────────────────────────────────

describe('buildEuComplianceReport()', () => {
  it('returns a report with articleEvidence array', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.articleEvidence).toBeDefined();
    expect(Array.isArray(report.articleEvidence)).toBe(true);
    expect(report.articleEvidence.length).toBeGreaterThan(0);
  });

  it('always includes Article 9, 13, 14, and 50', () => {
    const report = buildEuComplianceReport(makeScan());
    const articles = report.articleEvidence.map(e => e.article);
    expect(articles.some(a => a.includes('Article 9'))).toBe(true);
    expect(articles.some(a => a.includes('Article 13'))).toBe(true);
    expect(articles.some(a => a.includes('Article 14'))).toBe(true);
    expect(articles.some(a => a.includes('Article 50'))).toBe(true);
  });

  it('Article 50 disclosure section is always present with placeholder status', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.article50Disclosure).toBeDefined();
    expect(report.article50Disclosure.status).toBe('placeholder');
    expect(report.article50Disclosure.voiceAudioDisclosure).toContain('PLACEHOLDER');
  });

  it('Article 9 is non-compliant when many contradicted claims exist', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Claim one.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Claim two.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Claim three.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.status).toBe('non-compliant');
  });

  it('Article 9 findings include contradicted claim count', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'False claim.', type: 'fact', importance: 4 }],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Disproved.', sources: [] },
      },
      overallRisk: 'high',
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('contradicted'))).toBe(true);
  });

  it('Article 13 is compliant when all fact claims are supported', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('compliant');
  });

  it('Article 13 is gap when all claims are unverified', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Some claim.', type: 'fact', importance: 3 }],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'No sources.', sources: [] },
      },
      overallRisk: 'medium',
    });
    const report = buildEuComplianceReport(scan);
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('gap');
  });

  it('opinion claims map to Article 50 with partial status', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'AI should run the economy.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'Opinion.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art50 = report.articleEvidence.find(e => e.article.includes('Article 50'));
    expect(art50?.status).toBe('partial');
    expect(art50?.findings.some(f => f.includes('opinion'))).toBe(true);
  });

  it('interpretation claims map to Article 14 (partial status)', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'This suggests bias.', type: 'interpretation', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art14 = report.articleEvidence.find(e => e.article.includes('Article 14'));
    expect(art14?.status).toBe('partial');
  });

  it('Article 5 is included only when unacceptable tier is triggered', () => {
    const scanClean = makeScan();
    const reportClean = buildEuComplianceReport(scanClean);
    expect(reportClean.articleEvidence.some(e => e.article.includes('Article 5 –'))).toBe(false);

    const scanDirty = makeScan({
      complianceReport: makeComplianceReport({
        euRiskSummary: {
          unacceptable: 1, high: 0, limited: 0, minimal: 0, totalClaims: 1, highestTier: 'unacceptable',
        },
      }),
    });
    const reportDirty = buildEuComplianceReport(scanDirty);
    expect(reportDirty.articleEvidence.some(e => e.article.includes('Article 5 –'))).toBe(true);
    const art5 = reportDirty.articleEvidence.find(e => e.article.includes('Article 5 –'));
    expect(art5?.status).toBe('non-compliant');
  });

  it('PII findings appear in Article 9 with OWASP A06 reference', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'PII found', match: 'user@example.com', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('PII') && f.includes('A06'))).toBe(true);
  });

  it('testCategoryMappings reflects claim types correctly', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'A fact.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'An opinion.', type: 'opinion', importance: 3 },
        { id: 'c3', text: 'An interpretation.', type: 'interpretation', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Opinion.', sources: [] },
        c3: { claimId: 'c3', status: 'mixed', explanation: 'Partial.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const categories = report.testCategoryMappings.map(m => m.category);
    expect(categories).toContain('fact (supported)');
    expect(categories).toContain('opinion');
    expect(categories).toContain('interpretation');
  });

  it('summary counts are correct', () => {
    const report = buildEuComplianceReport(makeScan());
    const total =
      report.summary.compliantArticles +
      report.summary.nonCompliantArticles +
      report.summary.partialArticles +
      report.summary.gapArticles;
    // not-applicable articles are not in any count — total should be <= articleEvidence.length
    expect(total).toBeLessThanOrEqual(report.articleEvidence.length);
    expect(report.summary.totalClaimsAnalyzed).toBe(2);
  });

  it('documentRef has FP-EUACT- prefix', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.documentRef).toMatch(/^FP-EUACT-\d+$/);
  });

  it('uses provided projectName', () => {
    const report = buildEuComplianceReport(makeScan(), { projectName: 'MySystem v2' });
    expect(report.projectName).toBe('MySystem v2');
  });

  it('complianceScore is 0-100 number', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(typeof report.complianceScore).toBe('number');
    expect(report.complianceScore).toBeGreaterThanOrEqual(0);
    expect(report.complianceScore).toBeLessThanOrEqual(100);
  });

  it('complianceScore is high for compliant low-risk scan', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.complianceScore).toBeGreaterThanOrEqual(50);
  });

  it('complianceScore is low for non-compliant critical scan', () => {
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
    expect(report.complianceScore).toBeLessThan(80);
  });

  it('complianceScore appears in JSON output', () => {
    const report = buildEuComplianceReport(makeScan());
    const json = renderComplianceReportJson(report);
    const parsed = JSON.parse(json);
    expect(typeof parsed.complianceScore).toBe('number');
  });

  it('complianceScore appears in CI gate output', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('/100');
  });

  it('defaults projectName when not provided', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.projectName).toBeTruthy();
  });
});

// ── JSON renderer ─────────────────────────────────────────────────────────────

describe('renderComplianceReportJson()', () => {
  it('returns valid JSON string', () => {
    const report = buildEuComplianceReport(makeScan());
    const json = renderComplianceReportJson(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('serialized JSON contains articleEvidence', () => {
    const report = buildEuComplianceReport(makeScan());
    const parsed = JSON.parse(renderComplianceReportJson(report)) as EuAiActComplianceReport;
    expect(Array.isArray(parsed.articleEvidence)).toBe(true);
    expect(parsed.articleEvidence.length).toBeGreaterThan(0);
  });

  it('serialized JSON contains article50Disclosure with placeholder status', () => {
    const report = buildEuComplianceReport(makeScan());
    const parsed = JSON.parse(renderComplianceReportJson(report)) as EuAiActComplianceReport;
    expect(parsed.article50Disclosure.status).toBe('placeholder');
  });

  it('serialized JSON contains testCategoryMappings', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'A fact.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'An opinion.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Opinion.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const parsed = JSON.parse(renderComplianceReportJson(report)) as EuAiActComplianceReport;
    expect(Array.isArray(parsed.testCategoryMappings)).toBe(true);
    expect(parsed.testCategoryMappings.length).toBeGreaterThan(0);
  });
});

// ── PDF renderer ──────────────────────────────────────────────────────────────

describe('renderComplianceReportPdf()', () => {
  it('returns a non-empty Buffer', async () => {
    const report = buildEuComplianceReport(makeScan());
    const buf = await renderComplianceReportPdf(report);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('PDF starts with %PDF- magic bytes', async () => {
    const report = buildEuComplianceReport(makeScan());
    const buf = await renderComplianceReportPdf(report);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('generates PDF for high-risk scan without throwing', async () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'AI systems replace judges.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'AI should monitor citizens.', type: 'opinion', importance: 4 },
        { id: 'c3', text: 'This suggests bias.', type: 'interpretation', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Disproved.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Opinion.', sources: [] },
        c3: { claimId: 'c3', status: 'mixed', explanation: 'Partial.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    await expect(renderComplianceReportPdf(report)).resolves.toBeInstanceOf(Buffer);
  });
});

// ── CLI integration ───────────────────────────────────────────────────────────

describe('CLI: compliance-report command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-cr-test-'));
  });

  it('requires --input or --text flag', async () => {
    const { exitCode, output } = await main(['compliance-report']);
    expect(exitCode).toBe(1);
    expect(output).toContain('--input');
  });

  it('returns error for missing input file', async () => {
    const { exitCode, output } = await main(['compliance-report', '--input', '/nonexistent/path.json']);
    expect(exitCode).toBe(1);
    expect(output).toContain('not found');
  });

  it('reads existing scan JSON and outputs compliance report JSON', async () => {
    const scanData = makeScan();
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(scanData));

    const { exitCode, output } = await main(['compliance-report', '--input', scanFile]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    expect(Array.isArray(parsed.articleEvidence)).toBe(true);
    expect(parsed.article50Disclosure.status).toBe('placeholder');
  });

  it('--output flag writes JSON to file', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    const outFile = join(tmpDir, 'report.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--output', outFile,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(output).toContain(outFile);
  });

  it('--format pdf writes a PDF file', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    const outFile = join(tmpDir, 'report.pdf');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--format', 'pdf', '--output', outFile,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(output).toContain(outFile);
  });

  it('--text + --provider mock runs scan then produces JSON report', async () => {
    const { exitCode, output } = await main([
      'compliance-report',
      '--text', 'Water boils at 100 degrees Celsius.',
      '--provider', 'mock',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    expect(parsed.articleEvidence.length).toBeGreaterThan(0);
    expect(parsed.summary.totalClaimsAnalyzed).toBeGreaterThanOrEqual(0);
  });

  it('--project-name is reflected in report', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--project-name', 'Acme AI Judge v3',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    expect(parsed.projectName).toBe('Acme AI Judge v3');
  });

  it('output JSON contains OWASP references in article findings', async () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'False claim.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'PII found', match: 'x@y.com', offset: 0 },
      ],
      overallRisk: 'high',
    });
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(scan));

    const { exitCode, output } = await main(['compliance-report', '--input', scanFile]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    const art9 = parsed.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('A06') || f.includes('OWASP'))).toBe(true);
  });

  it('compliance-report appears in help output', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('compliance-report');
  });

  it('--ci flag: exits 0 for compliant low-risk scan', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--ci',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('PASS');
    expect(output).toContain('Exit code: 0');
  });

  it('--ci flag: exits 1 for non-compliant scan', async () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Wrong claim.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Very wrong.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(scan));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--ci',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('Exit code: 1');
  });

  it('--ci + --output writes JSON report alongside gate output', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    const outFile = join(tmpDir, 'ci-report.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode } = await main([
      'compliance-report', '--input', scanFile, '--ci', '--output', outFile,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    const parsed = JSON.parse(require('fs').readFileSync(outFile, 'utf-8'));
    expect(parsed.articleEvidence).toBeDefined();
  });

  it('--ci shows article-by-article results', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { output } = await main([
      'compliance-report', '--input', scanFile, '--ci',
    ]);
    expect(output).toContain('Article 9');
    expect(output).toContain('Article 13');
    expect(output).toContain('[PASS]');
  });

  it('--ci help text visible in usage', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('--ci');
  });
});

// ── CI Gate unit tests ───────────────────────────────────────────────────────

describe('evaluateComplianceGate()', () => {
  it('returns pass=true for all-compliant low-risk report', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.exitCode).toBe(0);
    expect(gate.nonCompliantCount).toBe(0);
  });

  it('returns pass=false when articles are non-compliant', () => {
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
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.nonCompliantCount).toBeGreaterThan(0);
  });

  it('fails on high overall risk even if no non-compliant articles', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.overallRisk).toBe('high');
  });

  it('totalArticles matches articleEvidence length', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.totalArticles).toBe(report.articleEvidence.length);
  });

  it('each article result has pass boolean and status', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    for (const a of gate.articles) {
      expect(typeof a.pass).toBe('boolean');
      expect(typeof a.status).toBe('string');
      expect(typeof a.article).toBe('string');
    }
  });
});

describe('renderCiGateOutput()', () => {
  it('includes PASS for passing gate', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('PASS');
    expect(output).toContain('Exit code: 0');
  });

  it('includes FAIL for failing gate', () => {
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
    expect(output).toContain('FAIL');
    expect(output).toContain('Exit code: 1');
    expect(output).toContain('non-compliant');
  });

  it('lists all articles with [PASS] or [FAIL] prefix', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    for (const a of gate.articles) {
      expect(output).toContain(a.article);
    }
    expect(output).toContain('[PASS]');
  });

  it('shows article pass ratio', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain(`/${gate.totalArticles} passing`);
  });
});

// ── Compliance Diff unit tests ───────────────────────────────────────────────

describe('diffComplianceReports()', () => {
  const lowRiskScan = makeScan();
  const highRiskScan = makeScan({
    claims: [
      { id: 'c1', text: 'Wrong.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'Very wrong.', type: 'fact', importance: 4 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
      c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
      c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
    },
    overallRisk: 'critical',
  });

  it('detects improvement when risk decreases', () => {
    const before = buildEuComplianceReport(highRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('improved');
  });

  it('detects regression when risk increases', () => {
    const before = buildEuComplianceReport(lowRiskScan);
    const after = buildEuComplianceReport(highRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('regressed');
  });

  it('shows unchanged when same risk', () => {
    const before = buildEuComplianceReport(lowRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('unchanged');
  });

  it('returns article-level diffs', () => {
    const before = buildEuComplianceReport(highRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.articles.length).toBeGreaterThan(0);
    for (const a of diff.articles) {
      expect(typeof a.article).toBe('string');
      expect(['improved', 'regressed', 'unchanged', 'new', 'removed']).toContain(a.trend);
    }
  });

  it('counts improved/regressed/unchanged correctly', () => {
    const before = buildEuComplianceReport(highRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.improved + diff.regressed + diff.unchanged).toBeGreaterThan(0);
    expect(diff.improved).toBeGreaterThanOrEqual(0);
  });

  it('includes before/after metadata', () => {
    const before = buildEuComplianceReport(lowRiskScan);
    const after = buildEuComplianceReport(highRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.before.documentRef).toBeTruthy();
    expect(diff.after.documentRef).toBeTruthy();
    expect(diff.before.overallRisk).toBe('low');
    expect(diff.after.overallRisk).toBe('critical');
  });
});

describe('renderComplianceDiffOutput()', () => {
  it('includes risk trend', () => {
    const before = buildEuComplianceReport(makeScan());
    const after = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('REGRESSED');
  });

  it('shows article transitions', () => {
    const before = buildEuComplianceReport(makeScan());
    const after = buildEuComplianceReport(makeScan());
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('Article');
    expect(output).toContain('->');
  });

  it('shows summary counts', () => {
    const before = buildEuComplianceReport(makeScan());
    const after = buildEuComplianceReport(makeScan());
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('improved');
    expect(output).toContain('regressed');
    expect(output).toContain('unchanged');
  });
});

describe('CLI: compliance-report --diff', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-diff-test-'));
  });

  it('compares two scan files and shows diff', async () => {
    const beforeFile = join(tmpDir, 'before.json');
    const afterFile = join(tmpDir, 'after.json');
    writeFileSync(beforeFile, JSON.stringify(makeScan()));
    writeFileSync(afterFile, JSON.stringify(makeScan({ overallRisk: 'high' })));

    const { exitCode, output } = await main([
      'compliance-report', '--diff', `${beforeFile},${afterFile}`,
    ]);
    expect(output).toContain('Compliance Diff');
    expect(output).toContain('->');
    // Regressed = exit 1
    expect(exitCode).toBe(1);
  });

  it('exits 0 when no regressions', async () => {
    const beforeFile = join(tmpDir, 'before.json');
    const afterFile = join(tmpDir, 'after.json');
    writeFileSync(beforeFile, JSON.stringify(makeScan()));
    writeFileSync(afterFile, JSON.stringify(makeScan()));

    const { exitCode } = await main([
      'compliance-report', '--diff', `${beforeFile},${afterFile}`,
    ]);
    expect(exitCode).toBe(0);
  });

  it('--diff with --format json outputs JSON', async () => {
    const beforeFile = join(tmpDir, 'before.json');
    const afterFile = join(tmpDir, 'after.json');
    writeFileSync(beforeFile, JSON.stringify(makeScan()));
    writeFileSync(afterFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--diff', `${beforeFile},${afterFile}`, '--format', 'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as ComplianceDiffResult;
    expect(parsed.riskTrend).toBe('unchanged');
    expect(Array.isArray(parsed.articles)).toBe(true);
  });

  it('returns error for invalid --diff format', async () => {
    const { exitCode, output } = await main([
      'compliance-report', '--diff', 'only-one-file.json',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('two');
  });

  it('--diff appears in help output', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('--diff');
  });
});

// ── N-166: Remediation Recommendations ──────────────────────────────────────

describe('getRemediations()', () => {
  it('RR1: returns empty array for compliant status', () => {
    const rems = getRemediations('Article 9', 'compliant', ['All good.']);
    expect(rems).toEqual([]);
  });

  it('RR2: returns empty array for not-applicable status', () => {
    const rems = getRemediations('Article 14', 'not-applicable', []);
    expect(rems).toEqual([]);
  });

  it('RR3: Article 5 non-compliant returns legal review remediation', () => {
    const rems = getRemediations('Article 5', 'non-compliant', ['1 claim(s) flagged for prohibited']);
    expect(rems.length).toBeGreaterThan(0);
    expect(rems.some(r => r.includes('legal review'))).toBe(true);
  });

  it('RR4: Article 9 with contradicted claims returns correction remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['2 contradicted claim(s) detected']);
    expect(rems.some(r => r.includes('contradicted'))).toBe(true);
  });

  it('RR5: Article 9 with PII returns filtering remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['1 PII finding(s)']);
    expect(rems.some(r => r.includes('PII'))).toBe(true);
  });

  it('RR6: Article 9 with bias returns audit remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['1 bias finding(s)']);
    expect(rems.some(r => r.includes('bias'))).toBe(true);
  });

  it('RR7: Article 9 with injection returns guardrails remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['Prompt injection pattern detected']);
    expect(rems.some(r => r.includes('guardrails') || r.includes('injection'))).toBe(true);
  });

  it('RR8: Article 9 with high risk returns Annex III remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['Overall risk assessed as CRITICAL — Annex III']);
    expect(rems.some(r => r.includes('Annex III'))).toBe(true);
  });

  it('RR9: Article 13 gap returns transparency remediation', () => {
    const rems = getRemediations('Article 13', 'gap', ['No claims extracted']);
    expect(rems.some(r => r.includes('verifiable'))).toBe(true);
    expect(rems.some(r => r.includes('capabilities'))).toBe(true);
  });

  it('RR10: Article 13 partial with unverified returns source attribution', () => {
    const rems = getRemediations('Article 13', 'partial', ['2 unverified/mixed claim(s)']);
    expect(rems.some(r => r.includes('source attribution'))).toBe(true);
  });

  it('RR11: Article 14 partial returns human oversight remediation', () => {
    const rems = getRemediations('Article 14', 'partial', ['3 interpretation claims']);
    expect(rems.some(r => r.includes('human-in-the-loop'))).toBe(true);
    expect(rems.some(r => r.includes('oversight'))).toBe(true);
  });

  it('RR12: Article 50 partial with opinions returns labelling remediation', () => {
    const rems = getRemediations('Article 50', 'partial', ['2 opinion claim(s) detected']);
    expect(rems.some(r => r.includes('labelling'))).toBe(true);
    expect(rems.some(r => r.includes('opinion'))).toBe(true);
  });

  it('RR13: Article 9 with interpretation returns Art 14 reference', () => {
    const rems = getRemediations('Article 9', 'partial', ['2 interpretation claim(s) require human oversight']);
    expect(rems.some(r => r.includes('Art. 14'))).toBe(true);
  });

  it('RR14: Article 9 with generic findings returns fallback remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['Some other finding']);
    expect(rems.length).toBeGreaterThan(0);
  });
});

describe('remediations in buildEuComplianceReport()', () => {
  it('RR15: every articleEvidence entry has a remediations array', () => {
    const report = buildEuComplianceReport(makeScan());
    for (const ev of report.articleEvidence) {
      expect(Array.isArray(ev.remediations)).toBe(true);
    }
  });

  it('RR16: compliant articles have empty remediations', () => {
    const report = buildEuComplianceReport(makeScan());
    const compliant = report.articleEvidence.filter(ev => ev.status === 'compliant');
    expect(compliant.length).toBeGreaterThan(0);
    for (const ev of compliant) {
      expect(ev.remediations).toEqual([]);
    }
  });

  it('RR17: non-compliant scan has non-empty remediations', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'False claim.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Another false.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Also wrong.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9!.status).toBe('non-compliant');
    expect(art9!.remediations.length).toBeGreaterThan(0);
  });

  it('RR18: CI gate output includes remediations when failing', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Wrong.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Still wrong.', type: 'fact', importance: 3 },
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
    expect(output).toContain('Recommended Remediations');
    expect(output).toContain('Article 9');
  });
});

// ── N-167: Compliance Threshold Configuration ───────────────────────────────

describe('evaluateComplianceGate() threshold/strict options', () => {
  it('TH1: default gate passes for compliant scan', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.threshold).toBe(0);
  });

  it('TH2: threshold=100 fails when score is below 100', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Claim.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    // Opinion claims → Art. 50 partial → score < 100
    expect(report.complianceScore).toBeLessThan(100);
    const gate = evaluateComplianceGate(report, { threshold: 100 });
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
  });

  it('TH3: threshold=0 (default) passes even with partial score', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Opinion.', type: 'opinion', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { threshold: 0 });
    expect(gate.pass).toBe(true);
  });

  it('TH4: strict mode fails on partial articles', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Interpretation.', type: 'interpretation', importance: 3 },
      ],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    // Art. 14 will be partial (interpretation triggers it)
    const gate = evaluateComplianceGate(report, { strict: true });
    expect(gate.pass).toBe(false);
    const art14 = gate.articles.find(a => a.article.includes('Article 14'));
    expect(art14!.pass).toBe(false);
  });

  it('TH5: strict mode passes when all articles are compliant/not-applicable', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { strict: true });
    // Default scan has all-supported facts → compliant + not-applicable
    expect(gate.pass).toBe(true);
  });

  it('TH6: gate result includes complianceScore and threshold', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 80 });
    expect(typeof gate.complianceScore).toBe('number');
    expect(gate.threshold).toBe(80);
  });

  it('TH7: threshold below score passes', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.complianceScore).toBeGreaterThanOrEqual(80);
    const gate = evaluateComplianceGate(report, { threshold: 50 });
    expect(gate.pass).toBe(true);
  });

  it('TH8: CI gate output shows threshold when set', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 80 });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('threshold: 80');
  });

  it('TH9: CI gate output shows score below threshold message', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Opinion.', type: 'opinion', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { threshold: 100 });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('below threshold');
  });

  it('TH10: strict + threshold can be combined', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Interp.', type: 'interpretation', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { strict: true, threshold: 90 });
    expect(gate.pass).toBe(false);
  });
});

// ── N-168: Compliance Badge SVG ─────────────────────────────────────────────

describe('renderComplianceBadgeSvg()', () => {
  it('BG1: returns valid SVG with xmlns', () => {
    const svg = renderComplianceBadgeSvg(100, true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('BG2: passing badge shows PASS and green color', () => {
    const svg = renderComplianceBadgeSvg(95, true);
    expect(svg).toContain('PASS');
    expect(svg).toContain('#4c1'); // bright green for score >= 80
  });

  it('BG3: failing badge shows FAIL and red color', () => {
    const svg = renderComplianceBadgeSvg(25, false);
    expect(svg).toContain('FAIL');
    expect(svg).toContain('#e05d44'); // red for score < 50
  });

  it('BG4: default label is "EU AI Act"', () => {
    const svg = renderComplianceBadgeSvg(80, true);
    expect(svg).toContain('EU AI Act');
  });

  it('BG5: custom label overrides default', () => {
    const svg = renderComplianceBadgeSvg(80, true, { label: 'Compliance' });
    expect(svg).toContain('Compliance');
    expect(svg).not.toContain('EU AI Act');
  });

  it('BG6: score is displayed in badge', () => {
    const svg = renderComplianceBadgeSvg(73, true);
    expect(svg).toContain('73');
  });

  it('BG7: yellow color for failing but score >= 50', () => {
    const svg = renderComplianceBadgeSvg(65, false);
    expect(svg).toContain('#dfb317');
  });

  it('BG8: light green for passing but score < 80', () => {
    const svg = renderComplianceBadgeSvg(70, true);
    expect(svg).toContain('#a3c51c');
  });

  it('BG9: includes aria-label for accessibility', () => {
    const svg = renderComplianceBadgeSvg(90, true);
    expect(svg).toContain('aria-label');
  });

  it('BG10: includes title element', () => {
    const svg = renderComplianceBadgeSvg(90, true);
    expect(svg).toContain('<title>');
  });
});
