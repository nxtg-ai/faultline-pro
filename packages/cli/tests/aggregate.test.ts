import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregate, renderAggregatedReport, type AggregatedReport } from '../cli/aggregate';
import type { ScanResult } from '../cli/scan';

// --- Helpers ---

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    input: 'test input',
    provider: 'Mock Provider',
    claims: [
      { id: 'c1', text: 'Test claim', type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      generatedAt: '2026-02-23T00:00:00.000Z',
      overallRiskLevel: 'low',
      euRiskSummary: {
        unacceptable: 0,
        high: 0,
        limited: 0,
        minimal: 1,
        totalClaims: 1,
        highestTier: 'minimal',
      },
      claimMappings: [{
        claimId: 'c1',
        claimText: 'Test claim',
        verificationStatus: 'supported',
        riskLevel: 'minimal',
        category: { level: 'minimal', title: 'Minimal Risk', description: '', articles: [], requiredActions: [] },
        matchedPatterns: [],
        confidence: 'low',
        confidenceScore: 0.3,
      }],
      triggeredArticles: [],
      mitigations: ['All claims fall under minimal risk. Consider voluntary codes of conduct.'],
      confidenceDistribution: { high: 0, medium: 0, low: 1 },
    },
    ruleFindings: [],
    ...overrides,
  };
}

function makeHighRiskResult(file: string): { file: string; result: ScanResult } {
  return {
    file,
    result: makeScanResult({
      overallRisk: 'high',
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Contradicted.', sources: [] },
      },
      complianceReport: {
        generatedAt: '2026-02-23T00:00:00.000Z',
        overallRiskLevel: 'high',
        euRiskSummary: { unacceptable: 0, high: 1, limited: 0, minimal: 0, totalClaims: 1, highestTier: 'high' },
        claimMappings: [{
          claimId: 'c1',
          claimText: 'Biometric scoring',
          verificationStatus: 'contradicted',
          riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: '', articles: ['Annex III'], requiredActions: [] },
          matchedPatterns: ['Annex III §1'],
          confidence: 'high',
          confidenceScore: 0.9,
        }],
        triggeredArticles: [{ article: 'Annex III §1', reason: 'Biometric scoring', claimIds: ['c1'] }],
        mitigations: ['High-risk domain detected. Ensure a risk management system is in place (Article 9).'],
        confidenceDistribution: { high: 1, medium: 0, low: 0 },
      },
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'Email detected', match: 'a@b.com', offset: 0 },
      ],
    }),
  };
}

// --- aggregate() tests ---

describe('aggregate()', () => {
  describe('empty input', () => {
    it('should handle zero files', () => {
      const result = aggregate([]);
      expect(result.filesAnalyzed).toBe(0);
      expect(result.totalFindings).toBe(0);
      expect(result.totalClaims).toBe(0);
      expect(result.highestOverallRisk).toBe('low');
      expect(result.highestEUTier).toBe('minimal');
      expect(result.riskHeatmap).toEqual([]);
    });
  });

  describe('single file', () => {
    it('should aggregate a single low-risk file', () => {
      const result = aggregate([{ file: 'a.txt', result: makeScanResult() }]);
      expect(result.filesAnalyzed).toBe(1);
      expect(result.totalClaims).toBe(1);
      expect(result.highestOverallRisk).toBe('low');
      expect(result.highestEUTier).toBe('minimal');
      expect(result.euRiskSummary.minimal).toBe(1);
      expect(result.riskHeatmap).toHaveLength(1);
      expect(result.riskHeatmap[0].file).toBe('a.txt');
    });

    it('should aggregate a single high-risk file', () => {
      const result = aggregate([makeHighRiskResult('risky.txt')]);
      expect(result.highestOverallRisk).toBe('high');
      expect(result.highestEUTier).toBe('high');
      expect(result.euRiskSummary.high).toBe(1);
      expect(result.triggeredArticles.length).toBeGreaterThan(0);
    });
  });

  describe('many files', () => {
    it('should aggregate totals across multiple files', () => {
      const result = aggregate([
        { file: 'a.txt', result: makeScanResult() },
        { file: 'b.txt', result: makeScanResult() },
        makeHighRiskResult('c.txt'),
      ]);
      expect(result.filesAnalyzed).toBe(3);
      expect(result.totalClaims).toBe(3);
      expect(result.totalVerifications).toBe(3);
    });

    it('should pick highest risk across files', () => {
      const result = aggregate([
        { file: 'low.txt', result: makeScanResult() },
        makeHighRiskResult('high.txt'),
      ]);
      expect(result.highestOverallRisk).toBe('high');
      expect(result.highestEUTier).toBe('high');
    });

    it('should sum EU risk tiers', () => {
      const result = aggregate([
        { file: 'a.txt', result: makeScanResult() },
        makeHighRiskResult('b.txt'),
      ]);
      expect(result.euRiskSummary.minimal).toBe(1);
      expect(result.euRiskSummary.high).toBe(1);
      expect(result.euRiskSummary.totalClaims).toBe(2);
    });

    it('should sum confidence distributions', () => {
      const result = aggregate([
        { file: 'a.txt', result: makeScanResult() },
        makeHighRiskResult('b.txt'),
      ]);
      expect(result.confidenceDistribution.low).toBe(1);
      expect(result.confidenceDistribution.high).toBe(1);
    });

    it('should deduplicate triggered articles', () => {
      const result = aggregate([
        makeHighRiskResult('a.txt'),
        makeHighRiskResult('b.txt'),
      ]);
      // Both files trigger Annex III §1 — should be a single article entry
      const annexArticles = result.triggeredArticles.filter(a => a.article === 'Annex III §1');
      expect(annexArticles).toHaveLength(1);
    });

    it('should deduplicate mitigations', () => {
      const result = aggregate([
        makeHighRiskResult('a.txt'),
        makeHighRiskResult('b.txt'),
      ]);
      const unique = new Set(result.mitigations);
      expect(result.mitigations.length).toBe(unique.size);
    });
  });

  describe('risk heatmap', () => {
    it('should sort by findings descending', () => {
      const result = aggregate([
        { file: 'low.txt', result: makeScanResult() },
        makeHighRiskResult('high.txt'),
      ]);
      // high.txt has more findings (1 rule + 1 contradicted)
      expect(result.riskHeatmap[0].file).toBe('high.txt');
      expect(result.riskHeatmap[0].findings).toBeGreaterThan(0);
    });

    it('should include file-level risk and EU tier', () => {
      const result = aggregate([makeHighRiskResult('x.txt')]);
      expect(result.riskHeatmap[0].highestRisk).toBe('high');
      expect(result.riskHeatmap[0].highestEUTier).toBe('high');
    });
  });

  describe('rule finding summary', () => {
    it('should count rule findings by severity', () => {
      const result = aggregate([makeHighRiskResult('a.txt')]);
      expect(result.ruleFindingSummary.total).toBe(1);
      expect(result.ruleFindingSummary.bySeverity.high).toBe(1);
    });

    it('should sum across files', () => {
      const result = aggregate([
        makeHighRiskResult('a.txt'),
        makeHighRiskResult('b.txt'),
      ]);
      expect(result.ruleFindingSummary.total).toBe(2);
    });

    it('should be zero for clean files', () => {
      const result = aggregate([{ file: 'clean.txt', result: makeScanResult() }]);
      expect(result.ruleFindingSummary.total).toBe(0);
    });
  });

  describe('metadata', () => {
    it('should include generatedAt timestamp', () => {
      const result = aggregate([]);
      expect(result.generatedAt).toBeDefined();
      expect(() => new Date(result.generatedAt)).not.toThrow();
    });
  });
});

// --- renderAggregatedReport() tests ---

describe('renderAggregatedReport()', () => {
  const sampleReport = aggregate([
    { file: 'a.txt', result: makeScanResult() },
    makeHighRiskResult('b.txt'),
  ]);

  describe('JSON format', () => {
    it('should produce valid JSON', () => {
      const output = renderAggregatedReport(sampleReport, 'json');
      const parsed = JSON.parse(output);
      expect(parsed.filesAnalyzed).toBe(2);
      expect(parsed.riskHeatmap).toBeDefined();
    });
  });

  describe('Markdown format', () => {
    it('should include h1 title', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('# Faultline Aggregated Compliance Report');
    });

    it('should include EU risk summary table', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('## EU AI Act Risk Summary');
      expect(output).toContain('| Risk Level | Count |');
    });

    it('should include risk heatmap', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('## Risk Heatmap');
      expect(output).toContain('b.txt');
      expect(output).toContain('a.txt');
    });

    it('should include triggered articles', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('## Triggered EU AI Act Articles');
    });

    it('should include mitigations', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('## Recommended Mitigations');
    });

    it('should include confidence distribution', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('## Confidence Distribution');
    });

    it('should include footer', () => {
      const output = renderAggregatedReport(sampleReport, 'markdown');
      expect(output).toContain('Generated by');
    });
  });

  describe('HTML format', () => {
    it('should produce complete HTML document', () => {
      const output = renderAggregatedReport(sampleReport, 'html');
      expect(output).toContain('<!DOCTYPE html>');
      expect(output).toContain('</html>');
    });

    it('should include embedded CSS', () => {
      const output = renderAggregatedReport(sampleReport, 'html');
      expect(output).toContain('<style>');
    });

    it('should include title', () => {
      const output = renderAggregatedReport(sampleReport, 'html');
      expect(output).toContain('Faultline Aggregated Compliance Report');
    });

    it('should include summary cards', () => {
      const output = renderAggregatedReport(sampleReport, 'html');
      expect(output).toContain('Files Analyzed');
      expect(output).toContain('Total Findings');
    });

    it('should include heatmap table', () => {
      const output = renderAggregatedReport(sampleReport, 'html');
      expect(output).toContain('Risk Heatmap');
      expect(output).toContain('b.txt');
    });

    it('should include footer', () => {
      const output = renderAggregatedReport(sampleReport, 'html');
      expect(output).toContain('<footer>');
    });
  });

  describe('SARIF format', () => {
    it('should produce valid SARIF JSON', () => {
      const output = renderAggregatedReport(sampleReport, 'sarif');
      const parsed = JSON.parse(output);
      expect(parsed.version).toBe('2.1.0');
      expect(parsed.$schema).toContain('sarif');
    });

    it('should have multiple runs (one per file + summary)', () => {
      const output = renderAggregatedReport(sampleReport, 'sarif');
      const parsed = JSON.parse(output);
      // 2 files + 1 summary run
      expect(parsed.runs.length).toBe(3);
    });

    it('should include aggregated summary run', () => {
      const output = renderAggregatedReport(sampleReport, 'sarif');
      const parsed = JSON.parse(output);
      const summaryRun = parsed.runs[parsed.runs.length - 1];
      expect(summaryRun.invocations[0].properties.aggregated).toBe(true);
      expect(summaryRun.invocations[0].properties.filesAnalyzed).toBe(2);
    });
  });
});

// --- CLI integration tests ---

// Mock @google/genai so provider imports don't fail
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn() }; },
}));
vi.stubGlobal('fetch', vi.fn());

describe('faultline aggregate CLI', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-agg-'));
  });

  it('should require --dir flag', async () => {
    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate']);
    expect(exitCode).toBe(1);
    expect(output).toContain('--dir');
  });

  it('should reject missing directory', async () => {
    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', '/nonexistent/path']);
    expect(exitCode).toBe(1);
    expect(output).toContain('not found');
  });

  it('should reject empty directory (no JSON files)', async () => {
    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir]);
    expect(exitCode).toBe(1);
    expect(output).toContain('No JSON files');
  });

  it('should reject directory with invalid JSON files only', async () => {
    writeFileSync(join(tmpDir, 'bad.json'), 'not json');
    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir]);
    expect(exitCode).toBe(1);
    expect(output).toContain('No valid scan result');
  });

  it('should aggregate valid scan results from directory', async () => {
    const scanResult = makeScanResult();
    writeFileSync(join(tmpDir, 'result1.json'), JSON.stringify(scanResult));
    writeFileSync(join(tmpDir, 'result2.json'), JSON.stringify(scanResult));

    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir]);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output);
    expect(parsed.filesAnalyzed).toBe(2);
    expect(parsed.totalClaims).toBe(2);
  });

  it('should skip non-scan JSON files', async () => {
    writeFileSync(join(tmpDir, 'valid.json'), JSON.stringify(makeScanResult()));
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));

    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir]);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output);
    expect(parsed.filesAnalyzed).toBe(1);
  });

  it('should support --output-format markdown', async () => {
    writeFileSync(join(tmpDir, 'result.json'), JSON.stringify(makeScanResult()));

    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir, '--output-format', 'markdown']);
    expect(exitCode).toBe(0);
    expect(output).toContain('# Faultline Aggregated Compliance Report');
  });

  it('should support --output-format html', async () => {
    writeFileSync(join(tmpDir, 'result.json'), JSON.stringify(makeScanResult()));

    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir, '--output-format', 'html']);
    expect(exitCode).toBe(0);
    expect(output).toContain('<!DOCTYPE html>');
  });

  it('should support --output-format sarif', async () => {
    writeFileSync(join(tmpDir, 'result.json'), JSON.stringify(makeScanResult()));

    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir, '--output-format', 'sarif']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe('2.1.0');
  });

  it('should reject invalid output format', async () => {
    writeFileSync(join(tmpDir, 'result.json'), JSON.stringify(makeScanResult()));

    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['aggregate', '--dir', tmpDir, '--output-format', 'xml']);
    expect(exitCode).toBe(1);
    expect(output).toContain('--output-format');
  });
});
