import { describe, it, expect } from 'vitest';
import {
  parseActionInputs,
  checkThreshold,
  buildCliArgs,
  countFromSarif,
  countFromScanResult,
  type SeverityLevel,
  type ScanCounts,
} from '../cli/action';

describe('GitHub Action: parseActionInputs()', () => {
  it('should return defaults when minimal inputs provided', () => {
    const result = parseActionInputs({ templates: 'injection' });
    expect(result.provider).toBe('mock');
    expect(result.threshold).toBe('critical');
    expect(result.minConfidence).toBe(0);
    expect(result.outputFormat).toBe('sarif');
    expect(result.rules).toBe('');
    expect(result.templates).toBe('injection');
  });

  it('should parse all inputs', () => {
    const result = parseActionInputs({
      provider: 'claude',
      templates: 'injection,bias',
      input: '',
      dir: '',
      threshold: 'high',
      'min-confidence': '0.7',
      rules: 'pii,toxicity',
      'output-format': 'json',
    });
    expect(result.provider).toBe('claude');
    expect(result.templates).toBe('injection,bias');
    expect(result.threshold).toBe('high');
    expect(result.minConfidence).toBe(0.7);
    expect(result.rules).toBe('pii,toxicity');
    expect(result.outputFormat).toBe('json');
  });

  it('should accept "input" as scan target', () => {
    const result = parseActionInputs({ input: 'file.txt' });
    expect(result.input).toBe('file.txt');
  });

  it('should accept "dir" as scan target', () => {
    const result = parseActionInputs({ dir: './src/' });
    expect(result.dir).toBe('./src/');
  });

  it('should throw on missing scan target', () => {
    expect(() => parseActionInputs({})).toThrow('One of "input", "dir", or "templates" must be specified');
  });

  it('should throw on invalid threshold', () => {
    expect(() => parseActionInputs({ templates: 'x', threshold: 'bogus' })).toThrow('Invalid threshold');
  });

  it('should throw on invalid min-confidence (NaN)', () => {
    expect(() => parseActionInputs({ templates: 'x', 'min-confidence': 'abc' })).toThrow('Invalid min-confidence');
  });

  it('should throw on invalid min-confidence (out of range)', () => {
    expect(() => parseActionInputs({ templates: 'x', 'min-confidence': '1.5' })).toThrow('Invalid min-confidence');
  });

  it('should throw on invalid output-format', () => {
    expect(() => parseActionInputs({ templates: 'x', 'output-format': 'xml' })).toThrow('Invalid output-format');
  });
});

describe('GitHub Action: checkThreshold()', () => {
  const zeroCounts: ScanCounts = { findings: 0, critical: 0, high: 0, medium: 0, low: 0 };

  it('should pass when no findings at any threshold', () => {
    for (const t of ['critical', 'high', 'medium', 'low'] as SeverityLevel[]) {
      expect(checkThreshold(t, zeroCounts)).toBe(true);
    }
  });

  it('threshold=critical: should fail only on critical findings', () => {
    expect(checkThreshold('critical', { ...zeroCounts, critical: 1 })).toBe(false);
    expect(checkThreshold('critical', { ...zeroCounts, high: 5, findings: 5 })).toBe(true);
    expect(checkThreshold('critical', { ...zeroCounts, medium: 3, findings: 3 })).toBe(true);
    expect(checkThreshold('critical', { ...zeroCounts, low: 10, findings: 10 })).toBe(true);
  });

  it('threshold=high: should fail on critical or high findings', () => {
    expect(checkThreshold('high', { ...zeroCounts, critical: 1 })).toBe(false);
    expect(checkThreshold('high', { ...zeroCounts, high: 1 })).toBe(false);
    expect(checkThreshold('high', { ...zeroCounts, medium: 5, findings: 5 })).toBe(true);
    expect(checkThreshold('high', { ...zeroCounts, low: 10, findings: 10 })).toBe(true);
  });

  it('threshold=medium: should fail on critical, high, or medium findings', () => {
    expect(checkThreshold('medium', { ...zeroCounts, critical: 1 })).toBe(false);
    expect(checkThreshold('medium', { ...zeroCounts, high: 1 })).toBe(false);
    expect(checkThreshold('medium', { ...zeroCounts, medium: 1 })).toBe(false);
    expect(checkThreshold('medium', { ...zeroCounts, low: 5, findings: 5 })).toBe(true);
  });

  it('threshold=low: should fail on any findings', () => {
    expect(checkThreshold('low', { ...zeroCounts, critical: 1 })).toBe(false);
    expect(checkThreshold('low', { ...zeroCounts, high: 1 })).toBe(false);
    expect(checkThreshold('low', { ...zeroCounts, medium: 1 })).toBe(false);
    expect(checkThreshold('low', { ...zeroCounts, low: 1 })).toBe(false);
  });

  it('should pass at low threshold when truly zero findings', () => {
    expect(checkThreshold('low', zeroCounts)).toBe(true);
  });
});

describe('GitHub Action: buildCliArgs()', () => {
  it('should build args for template scan', () => {
    const args = buildCliArgs({
      provider: 'mock',
      templates: 'injection,bias',
      input: '',
      dir: '',
      threshold: 'critical',
      minConfidence: 0,
      rules: '',
      outputFormat: 'sarif',
    });
    expect(args).toEqual(['scan', '--templates', 'injection,bias', '--provider', 'mock', '--output-format', 'sarif']);
  });

  it('should build args for directory scan', () => {
    const args = buildCliArgs({
      provider: 'gemini',
      templates: '',
      input: '',
      dir: './src/',
      threshold: 'high',
      minConfidence: 0.5,
      rules: 'pii',
      outputFormat: 'json',
    });
    expect(args).toEqual(['scan', '--dir', './src/', '--provider', 'gemini', '--output-format', 'json', '--min-confidence', '0.5', '--rules', 'pii']);
  });

  it('should build args for file scan', () => {
    const args = buildCliArgs({
      provider: 'claude',
      templates: '',
      input: 'test.txt',
      dir: '',
      threshold: 'medium',
      minConfidence: 0,
      rules: 'pii,bias',
      outputFormat: 'html',
    });
    expect(args).toEqual(['scan', '--input', 'test.txt', '--provider', 'claude', '--output-format', 'html', '--rules', 'pii,bias']);
  });

  it('should omit --min-confidence when zero', () => {
    const args = buildCliArgs({
      provider: 'mock',
      templates: 'bias',
      input: '',
      dir: '',
      threshold: 'critical',
      minConfidence: 0,
      rules: '',
      outputFormat: 'sarif',
    });
    expect(args).not.toContain('--min-confidence');
  });

  it('should omit --rules when empty', () => {
    const args = buildCliArgs({
      provider: 'mock',
      templates: 'bias',
      input: '',
      dir: '',
      threshold: 'critical',
      minConfidence: 0,
      rules: '',
      outputFormat: 'sarif',
    });
    expect(args).not.toContain('--rules');
  });
});

describe('GitHub Action: countFromSarif()', () => {
  it('should count zero for empty SARIF', () => {
    const counts = countFromSarif({ runs: [{ results: [] }] });
    expect(counts).toEqual({ findings: 0, critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('should count findings by SARIF level', () => {
    const counts = countFromSarif({
      runs: [{
        results: [
          { level: 'error' },
          { level: 'error' },
          { level: 'warning' },
          { level: 'note' },
          { level: 'none' },
        ],
      }],
    });
    expect(counts.findings).toBe(5);
    expect(counts.critical).toBe(2);
    expect(counts.medium).toBe(1);
    expect(counts.low).toBe(1);
  });

  it('should handle missing runs gracefully', () => {
    const counts = countFromSarif({});
    expect(counts.findings).toBe(0);
  });

  it('should handle missing results gracefully', () => {
    const counts = countFromSarif({ runs: [{}] });
    expect(counts.findings).toBe(0);
  });
});

describe('GitHub Action: countFromScanResult()', () => {
  it('should count zero for clean result', () => {
    const counts = countFromScanResult({
      ruleFindings: [],
      verifications: { c1: { status: 'supported' } },
    });
    expect(counts).toEqual({ findings: 0, critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('should count rule findings by severity', () => {
    const counts = countFromScanResult({
      ruleFindings: [
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'high' },
        { severity: 'medium' },
        { severity: 'low' },
      ],
      verifications: {},
    });
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(2);
    expect(counts.medium).toBe(1);
    expect(counts.low).toBe(1);
    expect(counts.findings).toBe(5);
  });

  it('should count non-supported verifications', () => {
    const counts = countFromScanResult({
      ruleFindings: [],
      verifications: {
        c1: { status: 'contradicted' },
        c2: { status: 'mixed' },
        c3: { status: 'unverified' },
        c4: { status: 'supported' },
      },
    });
    expect(counts.high).toBe(1);   // contradicted
    expect(counts.medium).toBe(1); // mixed
    expect(counts.low).toBe(1);    // unverified
    expect(counts.findings).toBe(3);
  });

  it('should combine rule findings and verification counts', () => {
    const counts = countFromScanResult({
      ruleFindings: [{ severity: 'critical' }],
      verifications: { c1: { status: 'contradicted' } },
    });
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(1);
    expect(counts.findings).toBe(2);
  });

  it('should handle missing ruleFindings gracefully', () => {
    const counts = countFromScanResult({ verifications: {} });
    expect(counts.findings).toBe(0);
  });

  it('should handle missing verifications gracefully', () => {
    const counts = countFromScanResult({ ruleFindings: [] });
    expect(counts.findings).toBe(0);
  });
});
