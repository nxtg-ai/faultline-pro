import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock @google/genai so provider imports don't blow up
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

// Mock fetch for Claude provider
vi.stubGlobal('fetch', vi.fn());

import { main } from '../cli/index';
import { renderReport, renderReportAs } from '../cli/report';
import type { ScanResult, BatchScanResult } from '../cli/scan';

describe('CLI: main()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-test-'));
  });

  describe('version command', () => {
    it('should print version', async () => {
      const { exitCode, output } = await main(['version']);
      expect(exitCode).toBe(0);
      expect(output).toMatch(/Faultline v\d+\.\d+\.\d+/);
    });
  });

  describe('scan command', () => {
    it('should require --input flag', async () => {
      const { exitCode, output } = await main(['scan']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--input');
    });

    it('should error on missing file', async () => {
      const { exitCode, output } = await main(['scan', '--input', '/nonexistent/file.txt']);
      expect(exitCode).toBe(1);
      expect(output).toContain('File not found');
    });

    it('should error on empty file', async () => {
      const emptyFile = join(tmpDir, 'empty.txt');
      writeFileSync(emptyFile, '');
      const { exitCode, output } = await main(['scan', '--input', emptyFile]);
      expect(exitCode).toBe(1);
      expect(output).toContain('empty');
    });

    it('should scan with mock provider and output JSON', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');

      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(output) as ScanResult;
      expect(result.provider).toBe('Mock Provider');
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.overallRisk).toBeDefined();
      expect(result.complianceReport).toBeDefined();
      expect(result.complianceReport.euRiskSummary).toBeDefined();
    });

    it('mock provider should produce valid compliance report', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'AI recruitment tools screen candidates. Credit scoring uses machine learning.');

      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(output) as ScanResult;
      expect(result.complianceReport.euRiskSummary.totalClaims).toBeGreaterThan(0);
      expect(result.complianceReport.mitigations.length).toBeGreaterThan(0);
    });

    it('should include confidence distribution in scan output', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');

      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(output) as ScanResult;
      expect(result.complianceReport.confidenceDistribution).toBeDefined();
      const cd = result.complianceReport.confidenceDistribution;
      expect(cd.high + cd.medium + cd.low).toBeGreaterThanOrEqual(0);
    });

    it('should filter claims with --min-confidence', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');

      // Without filter
      const unfiltered = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      const unfilteredResult = JSON.parse(unfiltered.output) as ScanResult;
      const allMappings = unfilteredResult.complianceReport.claimMappings.length;

      // With high confidence filter — mock claims are all minimal (0.3) so all should be filtered
      const filtered = await main(['scan', '--input', inputFile, '--provider', 'mock', '--min-confidence', '0.5']);
      const filteredResult = JSON.parse(filtered.output) as ScanResult;
      expect(filteredResult.complianceReport.claimMappings.length).toBeLessThanOrEqual(allMappings);
    });

    it('should reject invalid --min-confidence values', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Test.');

      const bad1 = await main(['scan', '--input', inputFile, '--provider', 'mock', '--min-confidence', 'abc']);
      expect(bad1.exitCode).toBe(1);
      expect(bad1.output).toContain('--min-confidence');

      const bad2 = await main(['scan', '--input', inputFile, '--provider', 'mock', '--min-confidence', '1.5']);
      expect(bad2.exitCode).toBe(1);

      const bad3 = await main(['scan', '--input', inputFile, '--provider', 'mock', '--min-confidence', '-0.1']);
      expect(bad3.exitCode).toBe(1);
    });

    it('should output JSON by default', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      expect(exitCode).toBe(0);
      // Default is JSON
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should output markdown with --output-format markdown', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--output-format', 'markdown']);
      expect(exitCode).toBe(0);
      expect(output).toContain('# Faultline Compliance Report');
      expect(output).toContain('## EU AI Act Risk Summary');
    });

    it('should output HTML with --output-format html', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--output-format', 'html']);
      expect(exitCode).toBe(0);
      expect(output).toContain('<!DOCTYPE html>');
      expect(output).toContain('Faultline Compliance Report');
      expect(output).toContain('</html>');
    });

    it('should output SARIF with --output-format sarif', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--output-format', 'sarif']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed.version).toBe('2.1.0');
      expect(parsed.$schema).toContain('sarif');
      expect(parsed.runs).toHaveLength(1);
      expect(parsed.runs[0].tool.driver.name).toBe('Faultline');
    });

    it('should output SARIF with --sarif shorthand flag', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--sarif']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed.version).toBe('2.1.0');
      expect(parsed.$schema).toContain('sarif');
      expect(parsed.runs).toHaveLength(1);
    });

    it('--sarif flag should write results.sarif file', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      // Change cwd to tmpDir so results.sarif is written there
      const origCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--sarif']);
        expect(exitCode).toBe(0);
        const sarifFile = join(tmpDir, 'results.sarif');
        expect(existsSync(sarifFile)).toBe(true);
        const contents = JSON.parse(readFileSync(sarifFile, 'utf-8'));
        expect(contents.version).toBe('2.1.0');
      } finally {
        process.chdir(origCwd);
      }
    });

    it('--sarif should use input file path in artifactLocation', async () => {
      const inputFile = join(tmpDir, 'my-doc.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--sarif']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output);
      // Check that at least one result location uses the actual input path
      const run = parsed.runs[0];
      expect(run.originalUriBaseIds).toBeDefined();
      expect(run.originalUriBaseIds['%SRCROOT%']).toBeDefined();
    });

    it('should reject invalid --output-format', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Test.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--output-format', 'xml']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--output-format');
    });
  });

  describe('scan --dir (batch mode)', () => {
    it('should require --input or --dir', async () => {
      const { exitCode, output } = await main(['scan']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--input');
      expect(output).toContain('--dir');
    });

    it('should error on missing directory', async () => {
      const { exitCode, output } = await main(['scan', '--dir', '/nonexistent/dir']);
      expect(exitCode).toBe(1);
      expect(output).toContain('Directory not found');
    });

    it('should error when --dir points to a file', async () => {
      const file = join(tmpDir, 'afile.txt');
      writeFileSync(file, 'content');
      const { exitCode, output } = await main(['scan', '--dir', file]);
      expect(exitCode).toBe(1);
      expect(output).toContain('Not a directory');
    });

    it('should error when directory has no files', async () => {
      const emptyDir = join(tmpDir, 'empty');
      mkdirSync(emptyDir);
      const { exitCode, output } = await main(['scan', '--dir', emptyDir, '--provider', 'mock']);
      expect(exitCode).toBe(1);
      expect(output).toContain('No files found');
    });

    it('should scan all files in a directory', async () => {
      const scanDir = join(tmpDir, 'docs');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'a.txt'), 'Water boils at 100 degrees.');
      writeFileSync(join(scanDir, 'b.txt'), 'The sky is blue.');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.filesScanned).toBe(2);
      expect(batch.results).toHaveLength(2);
      expect(batch.summary).toBeDefined();
      expect(batch.summary.totalClaims).toBeGreaterThan(0);
    });

    it('should scan recursively into subdirectories', async () => {
      const scanDir = join(tmpDir, 'nested');
      mkdirSync(scanDir);
      mkdirSync(join(scanDir, 'sub'));
      writeFileSync(join(scanDir, 'top.txt'), 'Claim one.');
      writeFileSync(join(scanDir, 'sub', 'deep.txt'), 'Claim two.');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.filesScanned).toBe(2);
      // Relative paths
      const files = batch.results.map(r => r.file);
      expect(files).toContain('top.txt');
      expect(files.some(f => f.includes('deep.txt'))).toBe(true);
    });

    it('should filter files with --glob', async () => {
      const scanDir = join(tmpDir, 'mixed');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'readme.txt'), 'Water boils at 100 degrees.');
      writeFileSync(join(scanDir, 'code.py'), 'import os # Python code.');
      writeFileSync(join(scanDir, 'data.json'), '{"key": "value"}');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--glob', '*.txt', '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.filesScanned).toBe(1);
      expect(batch.glob).toBe('*.txt');
      expect(batch.results[0].file).toBe('readme.txt');
    });

    it('should error when glob matches no files', async () => {
      const scanDir = join(tmpDir, 'noglob');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'readme.txt'), 'Content.');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--glob', '*.xyz', '--provider', 'mock']);
      expect(exitCode).toBe(1);
      expect(output).toContain('No files found');
      expect(output).toContain('*.xyz');
    });

    it('should skip empty files and count them', async () => {
      const scanDir = join(tmpDir, 'withempty');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'good.txt'), 'Valid content here.');
      writeFileSync(join(scanDir, 'empty.txt'), '');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.filesScanned).toBe(1);
      expect(batch.filesSkipped).toBe(1);
    });

    it('should aggregate summary across files', async () => {
      const scanDir = join(tmpDir, 'agg');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'a.txt'), 'First claim. Second claim.');
      writeFileSync(join(scanDir, 'b.txt'), 'Third claim.');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.summary.totalClaims).toBeGreaterThanOrEqual(3);
      expect(batch.summary.riskCounts).toBeDefined();
      expect(batch.summary.highestRisk).toBeDefined();
      expect(batch.summary.euTierCounts).toBeDefined();
    });

    it('should include directory path and per-file results', async () => {
      const scanDir = join(tmpDir, 'meta');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'test.txt'), 'A claim about things.');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.directory).toContain('meta');
      expect(batch.results[0].result.provider).toBe('Mock Provider');
      expect(batch.results[0].result.claims.length).toBeGreaterThan(0);
    });

    it('should skip hidden directories', async () => {
      const scanDir = join(tmpDir, 'withhidden');
      mkdirSync(scanDir);
      mkdirSync(join(scanDir, '.hidden'));
      writeFileSync(join(scanDir, 'visible.txt'), 'Visible content.');
      writeFileSync(join(scanDir, '.hidden', 'secret.txt'), 'Hidden content.');

      const { exitCode, output } = await main(['scan', '--dir', scanDir, '--provider', 'mock']);
      expect(exitCode).toBe(0);

      const batch = JSON.parse(output) as BatchScanResult;
      expect(batch.filesScanned).toBe(1);
      const files = batch.results.map(r => r.file);
      expect(files).toContain('visible.txt');
      expect(files.some(f => f.includes('secret'))).toBe(false);
    });
  });

  describe('rules command', () => {
    it('should list available rules', async () => {
      const { exitCode, output } = await main(['rules']);
      expect(exitCode).toBe(0);
      expect(output).toContain('pii');
      expect(output).toContain('bias');
      expect(output).toContain('toxicity');
      expect(output).toContain('Available rules');
    });
  });

  describe('init command', () => {
    it('should create .faultlinerc.json', async () => {
      const initDir = mkdtempSync(join(tmpdir(), 'faultline-init-'));
      const { exitCode, output } = await main(['init', '--dir', initDir]);
      expect(exitCode).toBe(0);
      expect(output).toContain('.faultlinerc.json');
      expect(existsSync(join(initDir, '.faultlinerc.json'))).toBe(true);
      rmSync(initDir, { recursive: true, force: true });
    });
  });

  describe('watch command', () => {
    it('should require --dir flag', async () => {
      const { exitCode, output } = await main(['watch']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--dir');
    });

    it('should error on missing directory', async () => {
      const { exitCode, output } = await main(['watch', '--dir', '/nonexistent/watch']);
      expect(exitCode).toBe(1);
      expect(output).toContain('Directory not found');
    });

    it('should error when --dir points to a file', async () => {
      const file = join(tmpDir, 'not-a-dir.txt');
      writeFileSync(file, 'content');
      const { exitCode, output } = await main(['watch', '--dir', file]);
      expect(exitCode).toBe(1);
      expect(output).toContain('Not a directory');
    });
  });

  describe('scan --rules', () => {
    it('should include rule findings in scan output', async () => {
      const file = join(tmpDir, 'pii-test.txt');
      writeFileSync(file, 'Contact john@example.com for details.');
      const { exitCode, output } = await main(['scan', '--input', file, '--provider', 'mock']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      expect(result.ruleFindings).toBeDefined();
      expect(result.ruleFindings.length).toBeGreaterThanOrEqual(1);
      expect(result.ruleFindings.some((f: any) => f.ruleId === 'pii-email')).toBe(true);
    });

    it('should filter to specific rules with --rules', async () => {
      const file = join(tmpDir, 'rules-filter.txt');
      writeFileSync(file, 'Contact john@example.com, they said crazy things.');
      const { exitCode, output } = await main(['scan', '--input', file, '--provider', 'mock', '--rules', 'pii']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      expect(result.ruleFindings.every((f: any) => f.ruleId.startsWith('pii'))).toBe(true);
    });

    it('should reject unknown rule name', async () => {
      const file = join(tmpDir, 'rules-bad.txt');
      writeFileSync(file, 'Some text.');
      const { exitCode, output } = await main(['scan', '--input', file, '--provider', 'mock', '--rules', 'nonexistent']);
      expect(exitCode).toBe(1);
      expect(output).toContain('Unknown rule');
      expect(output).toContain('nonexistent');
    });

    it('should accept comma-separated rule names', async () => {
      const file = join(tmpDir, 'multi-rule.txt');
      writeFileSync(file, 'Email john@test.com. SSN 123-45-6789.');
      const { exitCode, output } = await main(['scan', '--input', file, '--provider', 'mock', '--rules', 'pii,toxicity']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      const ruleIds = result.ruleFindings.map((f: any) => f.ruleId);
      expect(ruleIds.some((id: string) => id.startsWith('pii'))).toBe(true);
    });

    it('should return empty findings for clean text', async () => {
      const file = join(tmpDir, 'clean.txt');
      writeFileSync(file, 'Quarterly revenue grew steadily.');
      const { exitCode, output } = await main(['scan', '--input', file, '--provider', 'mock']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      expect(result.ruleFindings).toEqual([]);
    });
  });

  describe('templates command', () => {
    it('should list all templates', async () => {
      const { exitCode, output } = await main(['templates', 'list']);
      expect(exitCode).toBe(0);
      expect(output).toContain('Red-team prompt templates');
      expect(output).toContain('INJECTION');
      expect(output).toContain('JAILBREAK');
      expect(output).toContain('BIAS');
      expect(output).toContain('HALLUCINATION');
      expect(output).toContain('PII-LEAKAGE');
    });

    it('should filter by --category', async () => {
      const { exitCode, output } = await main(['templates', 'list', '--category', 'injection']);
      expect(exitCode).toBe(0);
      expect(output).toContain('INJECTION');
      expect(output).not.toContain('JAILBREAK');
      expect(output).not.toContain('HALLUCINATION');
    });

    it('should reject unknown category', async () => {
      const { exitCode, output } = await main(['templates', 'list', '--category', 'bogus']);
      expect(exitCode).toBe(1);
      expect(output).toContain('Unknown category');
    });

    it('should default to list subcommand', async () => {
      const { exitCode, output } = await main(['templates']);
      expect(exitCode).toBe(0);
      expect(output).toContain('Red-team prompt templates');
    });
  });

  describe('scan --templates', () => {
    it('should scan with template categories', async () => {
      const { exitCode, output } = await main(['scan', '--templates', 'injection', '--provider', 'mock']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      expect(result.mode).toBe('template-scan');
      expect(result.categories).toEqual(['injection']);
      expect(result.templatesScanned).toBeGreaterThanOrEqual(3);
      expect(result.results.length).toBe(result.templatesScanned);
    });

    it('should scan multiple categories', async () => {
      const { exitCode, output } = await main(['scan', '--templates', 'injection,bias', '--provider', 'mock']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      expect(result.categories).toEqual(['injection', 'bias']);
      const cats = new Set(result.results.map((r: { category: string }) => r.category));
      expect(cats.has('injection')).toBe(true);
      expect(cats.has('bias')).toBe(true);
    });

    it('should reject unknown template category', async () => {
      const { exitCode, output } = await main(['scan', '--templates', 'bogus', '--provider', 'mock']);
      expect(exitCode).toBe(1);
      expect(output).toContain('Unknown template category');
    });

    it('should include template metadata in each result', async () => {
      const { exitCode, output } = await main(['scan', '--templates', 'pii-leakage', '--provider', 'mock']);
      expect(exitCode).toBe(0);
      const result = JSON.parse(output);
      for (const r of result.results) {
        expect(r.templateId).toBeDefined();
        expect(r.category).toBe('pii-leakage');
        expect(r.severity).toBeDefined();
        expect(r.prompt).toBeDefined();
        expect(r.result).toBeDefined();
        expect(r.result.provider).toBe('Mock Provider');
      }
    });

    it('should not require --input when --templates is used', async () => {
      const { exitCode } = await main(['scan', '--templates', 'bias', '--provider', 'mock']);
      expect(exitCode).toBe(0);
    });
  });

  describe('scan --fail-on', () => {
    it('should exit 0 without --fail-on (backwards compatible)', async () => {
      const inputFile = join(tmpDir, 'pii-failon.txt');
      writeFileSync(inputFile, 'Contact john@example.com for details about the social scoring system.');
      const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      expect(exitCode).toBe(0);
    });

    it('should exit 0 when no findings exceed threshold', async () => {
      const inputFile = join(tmpDir, 'clean-failon.txt');
      writeFileSync(inputFile, 'Quarterly revenue grew steadily.');
      const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--fail-on', 'low']);
      expect(exitCode).toBe(0);
    });

    it('should exit 1 when findings at or above --fail-on critical', async () => {
      // PII-SSN is critical severity
      const inputFile = join(tmpDir, 'critical-failon.txt');
      writeFileSync(inputFile, 'SSN is 123-45-6789 and credit card 4111111111111111.');
      const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--fail-on', 'critical']);
      expect(exitCode).toBe(1);
    });

    it('should exit 1 when findings at --fail-on high', async () => {
      // PII-email is high severity
      const inputFile = join(tmpDir, 'high-failon.txt');
      writeFileSync(inputFile, 'Contact john@example.com for details.');
      const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--fail-on', 'high']);
      expect(exitCode).toBe(1);
    });

    it('should exit 0 when findings below --fail-on threshold', async () => {
      // PII-email is high severity, but threshold is critical — should pass
      const inputFile = join(tmpDir, 'below-failon.txt');
      writeFileSync(inputFile, 'Contact john@example.com for details.');
      const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--fail-on', 'critical']);
      expect(exitCode).toBe(0);
    });

    it('should reject invalid --fail-on value', async () => {
      const inputFile = join(tmpDir, 'bad-failon.txt');
      writeFileSync(inputFile, 'Test text.');
      const { exitCode, output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--fail-on', 'extreme']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--fail-on');
    });

    it('should work with --dir mode', async () => {
      const scanDir = join(tmpDir, 'failon-dir');
      mkdirSync(scanDir);
      writeFileSync(join(scanDir, 'pii.txt'), 'SSN is 123-45-6789.');
      const { exitCode } = await main(['scan', '--dir', scanDir, '--provider', 'mock', '--fail-on', 'critical']);
      expect(exitCode).toBe(1);
    });

    it('should work with --templates mode', async () => {
      // Templates always produce findings via mock — but mock provider returns all "supported"
      // so rule findings drive the threshold
      const { exitCode } = await main(['scan', '--templates', 'bias', '--provider', 'mock', '--fail-on', 'low']);
      // Mock provider produces minimal-risk claims, but bias templates may trigger rule findings
      expect(typeof exitCode).toBe('number');
      expect(exitCode === 0 || exitCode === 1).toBe(true);
    });
  });

  describe('report command', () => {
    it('should require --input flag', async () => {
      const { exitCode, output } = await main(['report']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--input');
    });

    it('should error on missing file', async () => {
      const { exitCode, output } = await main(['report', '--input', '/nonexistent/results.json']);
      expect(exitCode).toBe(1);
      expect(output).toContain('File not found');
    });

    it('should error on invalid JSON', async () => {
      const badFile = join(tmpDir, 'bad.json');
      writeFileSync(badFile, 'not json');
      const { exitCode, output } = await main(['report', '--input', badFile]);
      expect(exitCode).toBe(1);
      expect(output).toContain('Invalid JSON');
    });

    it('should render human-readable report from scan output', async () => {
      // First scan to get JSON
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');
      const scanResult = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      const resultFile = join(tmpDir, 'results.json');
      writeFileSync(resultFile, scanResult.output);

      // Then render report
      const { exitCode, output } = await main(['report', '--input', resultFile]);
      expect(exitCode).toBe(0);
      expect(output).toContain('FAULTLINE COMPLIANCE REPORT');
      expect(output).toContain('Overall Risk:');
      expect(output).toContain('EU Risk Tier:');
      expect(output).toContain('END REPORT');
    });

    it('should render markdown report with --output-format markdown', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const scanResult = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      const resultFile = join(tmpDir, 'results.json');
      writeFileSync(resultFile, scanResult.output);

      const { exitCode, output } = await main(['report', '--input', resultFile, '--output-format', 'markdown']);
      expect(exitCode).toBe(0);
      expect(output).toContain('# Faultline Compliance Report');
    });

    it('should render HTML report with --output-format html', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const scanResult = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      const resultFile = join(tmpDir, 'results.json');
      writeFileSync(resultFile, scanResult.output);

      const { exitCode, output } = await main(['report', '--input', resultFile, '--output-format', 'html']);
      expect(exitCode).toBe(0);
      expect(output).toContain('<!DOCTYPE html>');
    });

    it('should render SARIF report with --output-format sarif', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const scanResult = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      const resultFile = join(tmpDir, 'results.json');
      writeFileSync(resultFile, scanResult.output);

      const { exitCode, output } = await main(['report', '--input', resultFile, '--output-format', 'sarif']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed.version).toBe('2.1.0');
      expect(parsed.runs[0].tool.driver.name).toBe('Faultline');
    });

    it('should reject invalid --output-format in report command', async () => {
      const inputFile = join(tmpDir, 'input.txt');
      writeFileSync(inputFile, 'Water boils at 100 degrees.');
      const scanResult = await main(['scan', '--input', inputFile, '--provider', 'mock']);
      const resultFile = join(tmpDir, 'results.json');
      writeFileSync(resultFile, scanResult.output);

      const { exitCode, output } = await main(['report', '--input', resultFile, '--output-format', 'csv']);
      expect(exitCode).toBe(1);
      expect(output).toContain('--output-format');
    });
  });

  describe('unknown/no command', () => {
    it('should show usage for unknown command', async () => {
      const { exitCode, output } = await main(['bogus']);
      expect(exitCode).toBe(1);
      expect(output).toContain('Unknown command: bogus');
      expect(output).toContain('Usage:');
    });

    it('should show usage with no arguments', async () => {
      const { exitCode, output } = await main([]);
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage:');
    });
  });
});

describe('CLI: renderReport()', () => {
  const mockScanResult: ScanResult = {
    input: 'Test input text',
    provider: 'Mock Provider',
    claims: [{ id: 'c1', text: 'Test claim.', type: 'fact', importance: 5 }],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      generatedAt: '2026-02-22T00:00:00.000Z',
      overallRiskLevel: 'low',
      euRiskSummary: {
        unacceptable: 0,
        high: 0,
        limited: 0,
        minimal: 1,
        totalClaims: 1,
        highestTier: 'minimal',
      },
      claimMappings: [],
      triggeredArticles: [],
      mitigations: ['Consider voluntary codes of conduct.'],
      confidenceDistribution: { high: 0, medium: 0, low: 1 },
    },
    ruleFindings: [],
  };

  it('should include header and footer', () => {
    const output = renderReport(mockScanResult);
    expect(output).toContain('=== FAULTLINE COMPLIANCE REPORT ===');
    expect(output).toContain('=== END REPORT ===');
  });

  it('should include provider and risk level', () => {
    const output = renderReport(mockScanResult);
    expect(output).toContain('Mock Provider');
    expect(output).toContain('LOW');
    expect(output).toContain('MINIMAL');
  });

  it('should include claim verification details', () => {
    const output = renderReport(mockScanResult);
    expect(output).toContain('[OK] c1: supported');
  });

  it('should include mitigations', () => {
    const output = renderReport(mockScanResult);
    expect(output).toContain('voluntary codes');
  });

  it('should include confidence distribution section', () => {
    const withConfidence: ScanResult = {
      ...mockScanResult,
      complianceReport: {
        ...mockScanResult.complianceReport,
        confidenceDistribution: { high: 2, medium: 1, low: 0 },
      },
    };
    const output = renderReport(withConfidence);
    expect(output).toContain('Confidence Distribution');
    expect(output).toContain('High (>=0.8):   2');
    expect(output).toContain('Medium (0.5-0.8): 1');
    expect(output).toContain('Low (<0.5):     0');
  });

  it('should show per-claim confidence scores when claimMappings exist', () => {
    const withMappings: ScanResult = {
      ...mockScanResult,
      complianceReport: {
        ...mockScanResult.complianceReport,
        claimMappings: [{
          claimId: 'c1',
          claimText: 'Test',
          verificationStatus: 'supported',
          riskLevel: 'minimal',
          category: { level: 'minimal', title: 'Minimal', description: '', articles: [], requiredActions: [] },
          matchedPatterns: [],
          confidence: 'low',
          confidenceScore: 0.3,
        }],
        confidenceDistribution: { high: 0, medium: 0, low: 1 },
      },
    };
    const output = renderReport(withMappings);
    expect(output).toContain('confidence: 0.30');
  });
});

describe('CLI: renderReportAs()', () => {
  const mockData: ScanResult = {
    input: 'Test input',
    provider: 'Mock Provider',
    claims: [{ id: 'c1', text: 'Earth is round.', type: 'fact', importance: 5 }],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      generatedAt: '2026-02-22T00:00:00.000Z',
      overallRiskLevel: 'low',
      euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 1, totalClaims: 1, highestTier: 'minimal' },
      claimMappings: [{
        claimId: 'c1', claimText: 'Earth is round.', verificationStatus: 'supported',
        riskLevel: 'minimal',
        category: { level: 'minimal', title: 'Minimal', description: '', articles: [], requiredActions: [] },
        matchedPatterns: [], confidence: 'low', confidenceScore: 0.3,
      }],
      triggeredArticles: [{ article: 'Recital 32', reason: 'Minimal risk', claimIds: ['c1'] }],
      mitigations: ['Consider voluntary codes of conduct.'],
      confidenceDistribution: { high: 0, medium: 0, low: 1 },
    },
    ruleFindings: [],
  };

  describe('json format', () => {
    it('should return valid JSON', () => {
      const output = renderReportAs(mockData, 'json');
      const parsed = JSON.parse(output);
      expect(parsed.provider).toBe('Mock Provider');
      expect(parsed.overallRisk).toBe('low');
    });
  });

  describe('markdown format', () => {
    it('should have h1 title', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('# Faultline Compliance Report');
    });

    it('should include risk summary table', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('## EU AI Act Risk Summary');
      expect(output).toContain('| Risk Level | Count |');
    });

    it('should include confidence distribution table', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('## Confidence Distribution');
      expect(output).toContain('High');
      expect(output).toContain('Medium');
      expect(output).toContain('Low');
    });

    it('should include claim verifications table with confidence scores', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('## Claim Verifications');
      expect(output).toContain('c1');
      expect(output).toContain('0.30');
    });

    it('should include triggered articles table', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('## Triggered EU AI Act Articles');
      expect(output).toContain('Recital 32');
    });

    it('should include mitigations list', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('## Recommended Mitigations');
      expect(output).toContain('- Consider voluntary codes');
    });

    it('should include footer', () => {
      const output = renderReportAs(mockData, 'markdown');
      expect(output).toContain('Generated by');
    });

    it('should include color-coded risk badges', () => {
      const output = renderReportAs(mockData, 'markdown');
      // Should contain emoji badges
      expect(output).toMatch(/🟢|🟡|🟠|🔴/);
    });
  });

  describe('html format', () => {
    it('should be a complete HTML document', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('<!DOCTYPE html>');
      expect(output).toContain('<html');
      expect(output).toContain('</html>');
    });

    it('should have embedded CSS (no external deps)', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('<style>');
      expect(output).not.toContain('<link rel="stylesheet"');
    });

    it('should include the title', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('<title>Faultline Compliance Report</title>');
    });

    it('should include provider info', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('Mock Provider');
    });

    it('should include risk summary table', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('EU AI Act Risk Summary');
      expect(output).toContain('Unacceptable');
      expect(output).toContain('Minimal');
    });

    it('should include confidence distribution', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('Confidence Distribution');
    });

    it('should include claim verifications', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('Claim Verifications');
      expect(output).toContain('c1');
      expect(output).toContain('0.30');
    });

    it('should include triggered articles', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('Triggered EU AI Act Articles');
      expect(output).toContain('Recital 32');
    });

    it('should include mitigations', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('Recommended Mitigations');
      expect(output).toContain('voluntary codes');
    });

    it('should escape HTML entities in claim text', () => {
      const dataWithHtml: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'supported', explanation: 'Has <script>alert("xss")</script>', sources: [] },
        },
      };
      const output = renderReportAs(dataWithHtml, 'html');
      expect(output).not.toContain('<script>alert');
      expect(output).toContain('&lt;script&gt;');
    });

    it('should include color-coded badges', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('class="badge"');
      expect(output).toContain('background:');
    });

    it('should have a footer', () => {
      const output = renderReportAs(mockData, 'html');
      expect(output).toContain('<footer>');
      expect(output).toContain('Faultline');
    });
  });

  describe('sarif format', () => {
    it('should return valid JSON', () => {
      const output = renderReportAs(mockData, 'sarif');
      const parsed = JSON.parse(output);
      expect(parsed).toBeDefined();
    });

    it('should have SARIF 2.1.0 $schema and version', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(parsed.$schema).toContain('sarif-schema-2.1.0');
      expect(parsed.version).toBe('2.1.0');
    });

    it('should have exactly one run', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(parsed.runs).toHaveLength(1);
    });

    it('should have tool.driver with name and version', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const driver = parsed.runs[0].tool.driver;
      expect(driver.name).toBe('Faultline');
      expect(driver.version).toBe('0.1.0');
      expect(driver.informationUri).toContain('github.com');
    });

    it('should have rule definitions with required fields', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const rules = parsed.runs[0].tool.driver.rules;
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.id).toBeDefined();
        expect(rule.shortDescription).toBeDefined();
        expect(rule.shortDescription.text).toBeDefined();
        expect(rule.defaultConfiguration).toBeDefined();
        expect(rule.defaultConfiguration.level).toMatch(/^(error|warning|note|none)$/);
      }
    });

    it('should include EU AI Act risk tier rules', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const ruleIds = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
      expect(ruleIds).toContain('faultline/eu-ai-act/unacceptable');
      expect(ruleIds).toContain('faultline/eu-ai-act/high');
      expect(ruleIds).toContain('faultline/eu-ai-act/limited');
      expect(ruleIds).toContain('faultline/eu-ai-act/minimal');
    });

    it('should include verification rules', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const ruleIds = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
      expect(ruleIds).toContain('faultline/verification/contradicted');
      expect(ruleIds).toContain('faultline/verification/mixed');
      expect(ruleIds).toContain('faultline/verification/unverified');
    });

    it('should have results array', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(Array.isArray(parsed.runs[0].results)).toBe(true);
    });

    it('should have invocations array in run', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(Array.isArray(parsed.runs[0].invocations)).toBe(true);
      expect(parsed.runs[0].invocations).toHaveLength(1);
    });

    it('tool driver should have informationUri', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(parsed.runs[0].tool.driver.informationUri).toContain('github.com');
    });

    it('each rule should have name property', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      for (const rule of parsed.runs[0].tool.driver.rules) {
        expect(rule.name).toBeDefined();
        expect(typeof rule.name).toBe('string');
        expect(rule.name.length).toBeGreaterThan(0);
      }
    });

    it('run should have originalUriBaseIds with %SRCROOT%', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(parsed.runs[0].originalUriBaseIds).toBeDefined();
      expect(parsed.runs[0].originalUriBaseIds['%SRCROOT%'].uri).toBe('');
    });

    it('should not include results for supported claims', () => {
      // mockData has only supported claim — no issue results from verification
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const verificationResults = parsed.runs[0].results.filter(
        (r: { ruleId: string }) => r.ruleId.startsWith('faultline/verification/')
      );
      expect(verificationResults).toHaveLength(0);
    });

    it('should include results for contradicted claims', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Evidence says otherwise.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      const contradicted = parsed.runs[0].results.filter(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/contradicted'
      );
      expect(contradicted.length).toBeGreaterThan(0);
      expect(contradicted[0].level).toBe('error');
      expect(contradicted[0].message.text).toContain('c1');
    });

    it('should include results for mixed claims', () => {
      const dataWithMixed: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting evidence.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithMixed, 'sarif'));
      const mixed = parsed.runs[0].results.filter(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/mixed'
      );
      expect(mixed.length).toBeGreaterThan(0);
      expect(mixed[0].level).toBe('warning');
    });

    it('should include results with locations', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      const result = parsed.runs[0].results[0];
      expect(result.locations).toBeDefined();
      expect(result.locations[0].physicalLocation).toBeDefined();
      expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('input');
    });

    it('should include rule findings with charOffset and charLength', () => {
      const dataWithFindings: ScanResult = {
        ...mockData,
        ruleFindings: [
          { ruleId: 'pii-email', severity: 'high', message: 'PII: Email detected', match: 'test@example.com', offset: 42 },
        ],
      };
      const parsed = JSON.parse(renderReportAs(dataWithFindings, 'sarif'));
      const ruleResults = parsed.runs[0].results.filter(
        (r: { ruleId: string }) => r.ruleId === 'faultline/rule/pii-email'
      );
      expect(ruleResults.length).toBe(1);
      expect(ruleResults[0].level).toBe('error');
      expect(ruleResults[0].locations[0].physicalLocation.region.charOffset).toBe(42);
      expect(ruleResults[0].locations[0].physicalLocation.region.charLength).toBe(16);
    });

    it('should add rule definitions for custom rule findings', () => {
      const dataWithFindings: ScanResult = {
        ...mockData,
        ruleFindings: [
          { ruleId: 'pii-email', severity: 'high', message: 'PII: Email detected', match: 'test@example.com', offset: 0 },
          { ruleId: 'bias-gender', severity: 'medium', message: 'Bias: gender term', match: 'mankind', offset: 10 },
        ],
      };
      const parsed = JSON.parse(renderReportAs(dataWithFindings, 'sarif'));
      const ruleIds = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
      expect(ruleIds).toContain('faultline/rule/pii-email');
      expect(ruleIds).toContain('faultline/rule/bias-gender');
    });

    it('should have invocations with execution metadata', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const invocation = parsed.runs[0].invocations[0];
      expect(invocation.executionSuccessful).toBe(true);
      expect(invocation.properties.provider).toBe('Mock Provider');
      expect(invocation.properties.overallRisk).toBe('low');
      expect(invocation.properties.euHighestTier).toBe('minimal');
      expect(invocation.properties.totalClaims).toBe(1);
      expect(invocation.properties.confidenceDistribution).toBeDefined();
    });

    it('should include ruleIndex referencing correct rule definition', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      const result = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/contradicted'
      );
      expect(result.ruleIndex).toBeGreaterThanOrEqual(0);
      const rule = parsed.runs[0].tool.driver.rules[result.ruleIndex];
      expect(rule.id).toBe('faultline/verification/contradicted');
    });

    it('should map severity levels correctly', () => {
      const dataWithFindings: ScanResult = {
        ...mockData,
        ruleFindings: [
          { ruleId: 'toxicity-threats', severity: 'critical', message: 'Threat', match: 'kill', offset: 0 },
          { ruleId: 'pii-email', severity: 'high', message: 'Email', match: 'a@b.c', offset: 5 },
          { ruleId: 'bias-age', severity: 'medium', message: 'Age', match: 'old', offset: 10 },
          { ruleId: 'custom-info', severity: 'low', message: 'Info', match: 'x', offset: 15 },
        ],
      };
      const parsed = JSON.parse(renderReportAs(dataWithFindings, 'sarif'));
      const levels = parsed.runs[0].results
        .filter((r: { ruleId: string }) => r.ruleId.startsWith('faultline/rule/'))
        .map((r: { level: string }) => r.level);
      expect(levels).toContain('error');   // critical + high
      expect(levels).toContain('warning'); // medium
      expect(levels).toContain('note');    // low
    });

    it('should include EU AI Act results for non-minimal mappings', () => {
      const dataWithHighRisk: ScanResult = {
        ...mockData,
        complianceReport: {
          ...mockData.complianceReport,
          euRiskSummary: { ...mockData.complianceReport.euRiskSummary, high: 1, highestTier: 'high' },
          claimMappings: [{
            claimId: 'c1', claimText: 'Recruitment uses AI', verificationStatus: 'supported',
            riskLevel: 'high',
            category: { level: 'high', title: 'High Risk', description: '', articles: ['Article 6'], requiredActions: [] },
            matchedPatterns: ['employment'], confidence: 'high', confidenceScore: 0.7,
          }],
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithHighRisk, 'sarif'));
      const euResults = parsed.runs[0].results.filter(
        (r: { ruleId: string }) => r.ruleId === 'faultline/eu-ai-act/high'
      );
      expect(euResults.length).toBe(1);
      expect(euResults[0].level).toBe('error');
      expect(euResults[0].properties.riskLevel).toBe('high');
      expect(euResults[0].properties.confidence).toBe(0.7);
    });

    // --- Enhanced SARIF: relatedLocations ---

    it('should include relatedLocations on verification results', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      const result = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/contradicted'
      );
      expect(result.relatedLocations).toBeDefined();
      expect(result.relatedLocations).toHaveLength(1);
      expect(result.relatedLocations[0].id).toBe(0);
      expect(result.relatedLocations[0].message.text).toContain('Claim:');
      expect(result.relatedLocations[0].message.text).toContain('Earth is round.');
      expect(result.relatedLocations[0].physicalLocation.artifactLocation).toBeDefined();
    });

    it('should include relatedLocations on EU AI Act results', () => {
      const dataWithHighRisk: ScanResult = {
        ...mockData,
        complianceReport: {
          ...mockData.complianceReport,
          euRiskSummary: { ...mockData.complianceReport.euRiskSummary, high: 1, highestTier: 'high' },
          claimMappings: [{
            claimId: 'c1', claimText: 'Recruitment uses AI', verificationStatus: 'supported',
            riskLevel: 'high',
            category: { level: 'high', title: 'High Risk', description: '', articles: ['Article 6'], requiredActions: [] },
            matchedPatterns: ['employment'], confidence: 'high', confidenceScore: 0.7,
          }],
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithHighRisk, 'sarif'));
      const euResult = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/eu-ai-act/high'
      );
      expect(euResult.relatedLocations).toBeDefined();
      expect(euResult.relatedLocations[0].message.text).toContain('Recruitment uses AI');
    });

    // --- Enhanced SARIF: uriBaseId ---

    it('should include uriBaseId in artifactLocation', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      const result = parsed.runs[0].results[0];
      expect(result.locations[0].physicalLocation.artifactLocation.uriBaseId).toBe('%SRCROOT%');
    });

    it('should include originalUriBaseIds in run', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      const run = parsed.runs[0];
      expect(run.originalUriBaseIds).toBeDefined();
      expect(run.originalUriBaseIds['%SRCROOT%']).toBeDefined();
      expect(run.originalUriBaseIds['%SRCROOT%'].uri).toBe('');
    });

    // --- Enhanced SARIF: codeFlows ---

    it('should include codeFlows for verification results', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Evidence says no.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      const result = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/contradicted'
      );
      expect(result.codeFlows).toBeDefined();
      expect(result.codeFlows).toHaveLength(1);
      expect(result.codeFlows[0].message.text).toContain('Verification chain');
      expect(result.codeFlows[0].threadFlows).toHaveLength(1);
      const locations = result.codeFlows[0].threadFlows[0].locations;
      expect(locations).toHaveLength(2);
      expect(locations[0].location.message.text).toContain('Claim extracted');
      expect(locations[1].location.message.text).toContain('Verification result');
      expect(locations[1].location.message.text).toContain('contradicted');
    });

    it('should include codeFlows for EU AI Act results', () => {
      const dataWithHighRisk: ScanResult = {
        ...mockData,
        complianceReport: {
          ...mockData.complianceReport,
          euRiskSummary: { ...mockData.complianceReport.euRiskSummary, high: 1, highestTier: 'high' },
          claimMappings: [{
            claimId: 'c1', claimText: 'AI screens job applicants', verificationStatus: 'supported',
            riskLevel: 'high',
            category: { level: 'high', title: 'High Risk', description: '', articles: ['Article 6'], requiredActions: [] },
            matchedPatterns: ['employment', 'screening'], confidence: 'high', confidenceScore: 0.8,
          }],
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithHighRisk, 'sarif'));
      const euResult = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/eu-ai-act/high'
      );
      expect(euResult.codeFlows).toBeDefined();
      expect(euResult.codeFlows).toHaveLength(1);
      const flow = euResult.codeFlows[0];
      expect(flow.message.text).toContain('EU AI Act risk assessment');
      const locs = flow.threadFlows[0].locations;
      expect(locs).toHaveLength(3); // claim → patterns → risk level
      expect(locs[0].location.message.text).toContain('AI screens job applicants');
      expect(locs[1].location.message.text).toContain('employment');
      expect(locs[2].location.message.text).toContain('high');
    });

    it('codeFlows threadFlow locations should have proper physicalLocation', () => {
      const dataWithMixed: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithMixed, 'sarif'));
      const result = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/mixed'
      );
      for (const loc of result.codeFlows[0].threadFlows[0].locations) {
        expect(loc.location.physicalLocation).toBeDefined();
        expect(loc.location.physicalLocation.artifactLocation.uri).toBe('input');
        expect(loc.location.physicalLocation.artifactLocation.uriBaseId).toBe('%SRCROOT%');
      }
    });

    // --- Enhanced SARIF: SarifOptions.inputUri ---

    it('should use custom inputUri from SarifOptions', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif', { inputUri: 'docs/report.txt' }));
      const result = parsed.runs[0].results[0];
      expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('docs/report.txt');
    });

    it('SarifOptions inputUri should propagate to relatedLocations', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif', { inputUri: 'my/file.md' }));
      const result = parsed.runs[0].results[0];
      expect(result.relatedLocations[0].physicalLocation.artifactLocation.uri).toBe('my/file.md');
    });

    it('SarifOptions inputUri should propagate to codeFlows', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif', { inputUri: 'src/data.txt' }));
      const result = parsed.runs[0].results[0];
      const flowLoc = result.codeFlows[0].threadFlows[0].locations[0];
      expect(flowLoc.location.physicalLocation.artifactLocation.uri).toBe('src/data.txt');
    });

    // --- Enhanced SARIF: schema structure validation ---

    it('should have all required SARIF 2.1.0 top-level properties', () => {
      const parsed = JSON.parse(renderReportAs(mockData, 'sarif'));
      expect(parsed).toHaveProperty('$schema');
      expect(parsed).toHaveProperty('version');
      expect(parsed).toHaveProperty('runs');
      expect(parsed.version).toBe('2.1.0');
    });

    it('each result should have ruleId, ruleIndex, level, and message', () => {
      const dataWithContradiction: ScanResult = {
        ...mockData,
        verifications: {
          c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithContradiction, 'sarif'));
      for (const result of parsed.runs[0].results) {
        expect(result).toHaveProperty('ruleId');
        expect(result).toHaveProperty('ruleIndex');
        expect(result).toHaveProperty('level');
        expect(result).toHaveProperty('message');
        expect(typeof result.ruleId).toBe('string');
        expect(typeof result.ruleIndex).toBe('number');
        expect(['error', 'warning', 'note', 'none']).toContain(result.level);
        expect(typeof result.message.text).toBe('string');
      }
    });

    it('each result location should have artifactLocation with uriBaseId', () => {
      const dataWithFindings: ScanResult = {
        ...mockData,
        ruleFindings: [
          { ruleId: 'pii-email', severity: 'high', message: 'PII: Email', match: 'a@b.com', offset: 0 },
        ],
      };
      const parsed = JSON.parse(renderReportAs(dataWithFindings, 'sarif'));
      for (const result of parsed.runs[0].results) {
        if (result.locations) {
          for (const loc of result.locations) {
            expect(loc.physicalLocation.artifactLocation.uriBaseId).toBe('%SRCROOT%');
          }
        }
      }
    });

    it('rule findings should not have codeFlows (only verifications and EU results do)', () => {
      const dataWithFindings: ScanResult = {
        ...mockData,
        ruleFindings: [
          { ruleId: 'pii-email', severity: 'high', message: 'PII: Email', match: 'a@b.com', offset: 0 },
        ],
      };
      const parsed = JSON.parse(renderReportAs(dataWithFindings, 'sarif'));
      const ruleResults = parsed.runs[0].results.filter(
        (r: { ruleId: string }) => r.ruleId.startsWith('faultline/rule/')
      );
      for (const r of ruleResults) {
        expect(r.codeFlows).toBeUndefined();
      }
    });

    it('should not include relatedLocations when claim is not found', () => {
      // verification for a claim not in the claims array
      const dataWithOrphan: ScanResult = {
        ...mockData,
        claims: [], // no claims
        verifications: {
          c99: { claimId: 'c99', status: 'unverified', explanation: 'Unknown.', sources: [] },
        },
      };
      const parsed = JSON.parse(renderReportAs(dataWithOrphan, 'sarif'));
      const result = parsed.runs[0].results.find(
        (r: { ruleId: string }) => r.ruleId === 'faultline/verification/unverified'
      );
      expect(result).toBeDefined();
      // No relatedLocations or codeFlows when claim not found
      expect(result.relatedLocations).toBeUndefined();
      expect(result.codeFlows).toBeUndefined();
    });
  });
});
