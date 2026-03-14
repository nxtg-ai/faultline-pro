import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

import {
  Debouncer,
  processFileChange,
  isWatchedFile,
  WATCHED_EXTENSIONS,
  FindingsTracker,
  formatWatchOutput,
} from '../cli/watch';
import type { ScanResult } from '../cli/scan';

// ---------- Debouncer ----------

describe('Debouncer', () => {
  it('should allow first scan of a file', () => {
    const d = new Debouncer(500);
    expect(d.shouldScan('/tmp/file.txt')).toBe(true);
  });

  it('should block scan within debounce window', () => {
    const d = new Debouncer(500);
    const now = 10000;
    d.record('/tmp/file.txt', now);
    expect(d.shouldScan('/tmp/file.txt', now + 100)).toBe(false);
    expect(d.shouldScan('/tmp/file.txt', now + 499)).toBe(false);
  });

  it('should allow scan after debounce window expires', () => {
    const d = new Debouncer(500);
    const now = 10000;
    d.record('/tmp/file.txt', now);
    expect(d.shouldScan('/tmp/file.txt', now + 500)).toBe(true);
    expect(d.shouldScan('/tmp/file.txt', now + 600)).toBe(true);
  });

  it('should track files independently', () => {
    const d = new Debouncer(500);
    const now = 10000;
    d.record('/tmp/a.txt', now);
    expect(d.shouldScan('/tmp/a.txt', now + 100)).toBe(false);
    expect(d.shouldScan('/tmp/b.txt', now + 100)).toBe(true);
  });

  it('should use custom debounce interval', () => {
    const d = new Debouncer(1000);
    const now = 10000;
    d.record('/tmp/file.txt', now);
    expect(d.shouldScan('/tmp/file.txt', now + 999)).toBe(false);
    expect(d.shouldScan('/tmp/file.txt', now + 1000)).toBe(true);
  });

  it('should report size', () => {
    const d = new Debouncer();
    expect(d.size).toBe(0);
    d.record('/tmp/a.txt');
    expect(d.size).toBe(1);
    d.record('/tmp/b.txt');
    expect(d.size).toBe(2);
  });

  it('should clear all tracked files', () => {
    const d = new Debouncer();
    d.record('/tmp/a.txt');
    d.record('/tmp/b.txt');
    d.clear();
    expect(d.size).toBe(0);
    expect(d.shouldScan('/tmp/a.txt')).toBe(true);
  });

  it('should return last scan time', () => {
    const d = new Debouncer();
    expect(d.getLastScan('/tmp/a.txt')).toBeUndefined();
    d.record('/tmp/a.txt', 12345);
    expect(d.getLastScan('/tmp/a.txt')).toBe(12345);
  });

  it('should update last scan on re-record', () => {
    const d = new Debouncer(500);
    d.record('/tmp/file.txt', 10000);
    d.record('/tmp/file.txt', 20000);
    expect(d.getLastScan('/tmp/file.txt')).toBe(20000);
    expect(d.shouldScan('/tmp/file.txt', 20400)).toBe(false);
    expect(d.shouldScan('/tmp/file.txt', 20500)).toBe(true);
  });

  it('should default debounce to 500ms', () => {
    const d = new Debouncer();
    const now = 10000;
    d.record('/tmp/file.txt', now);
    expect(d.shouldScan('/tmp/file.txt', now + 499)).toBe(false);
    expect(d.shouldScan('/tmp/file.txt', now + 500)).toBe(true);
  });
});

// ---------- isWatchedFile ----------

describe('isWatchedFile', () => {
  it('should accept .ts files', () => {
    expect(isWatchedFile('app.ts')).toBe(true);
  });

  it('should accept .tsx files', () => {
    expect(isWatchedFile('component.tsx')).toBe(true);
  });

  it('should accept .js files', () => {
    expect(isWatchedFile('index.js')).toBe(true);
  });

  it('should accept .jsx files', () => {
    expect(isWatchedFile('component.jsx')).toBe(true);
  });

  it('should accept .py files', () => {
    expect(isWatchedFile('script.py')).toBe(true);
  });

  it('should accept .md files', () => {
    expect(isWatchedFile('README.md')).toBe(true);
  });

  it('should reject .json files', () => {
    expect(isWatchedFile('config.json')).toBe(false);
  });

  it('should reject .txt files', () => {
    expect(isWatchedFile('notes.txt')).toBe(false);
  });

  it('should reject .css files', () => {
    expect(isWatchedFile('style.css')).toBe(false);
  });

  it('should reject .html files', () => {
    expect(isWatchedFile('index.html')).toBe(false);
  });

  it('should reject files with no extension', () => {
    expect(isWatchedFile('Makefile')).toBe(false);
  });

  it('should handle full paths', () => {
    expect(isWatchedFile('/home/user/project/src/index.ts')).toBe(true);
    expect(isWatchedFile('/home/user/project/config.yaml')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isWatchedFile('README.MD')).toBe(true);
    expect(isWatchedFile('script.PY')).toBe(true);
    expect(isWatchedFile('app.TS')).toBe(true);
  });
});

describe('WATCHED_EXTENSIONS', () => {
  it('should contain exactly 6 extensions', () => {
    expect(WATCHED_EXTENSIONS.size).toBe(6);
  });

  it('should contain all required extensions', () => {
    expect(WATCHED_EXTENSIONS.has('.ts')).toBe(true);
    expect(WATCHED_EXTENSIONS.has('.tsx')).toBe(true);
    expect(WATCHED_EXTENSIONS.has('.js')).toBe(true);
    expect(WATCHED_EXTENSIONS.has('.jsx')).toBe(true);
    expect(WATCHED_EXTENSIONS.has('.py')).toBe(true);
    expect(WATCHED_EXTENSIONS.has('.md')).toBe(true);
  });
});

// ---------- FindingsTracker ----------

describe('FindingsTracker', () => {
  function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
      input: 'test',
      provider: 'mock',
      claims: [],
      verifications: {},
      overallRisk: 'low',
      complianceReport: {
        generatedAt: '',
        overallRiskLevel: 'low',
        euRiskSummary: { totalClaims: 0, highestTier: 'minimal', unacceptable: 0, high: 0, limited: 0, minimal: 0 },
        claimMappings: [],
        triggeredArticles: [],
        mitigations: [],
        confidenceDistribution: { high: 0, medium: 0, low: 0 },
      },
      ruleFindings: [],
      ...overrides,
    };
  }

  it('should track first scan as all-new findings', () => {
    const tracker = new FindingsTracker();
    const result = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Bad', sources: [] },
      },
      ruleFindings: [{ ruleId: 'pii', severity: 'high', message: 'PII found', match: 'PII found', offset: 5 }],
    });

    const diff = tracker.update('file.ts', result);
    expect(diff.newFindings).toBe(2);
    expect(diff.resolvedFindings).toBe(0);
  });

  it('should detect resolved findings on second scan', () => {
    const tracker = new FindingsTracker();
    const result1 = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Bad', sources: [] },
      },
    });
    tracker.update('file.ts', result1);

    const result2 = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Fixed', sources: [] },
      },
    });
    const diff = tracker.update('file.ts', result2);
    expect(diff.newFindings).toBe(0);
    expect(diff.resolvedFindings).toBe(1);
  });

  it('should detect new findings on second scan', () => {
    const tracker = new FindingsTracker();
    const result1 = makeScanResult();
    tracker.update('file.ts', result1);

    const result2 = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Bad', sources: [] },
      },
    });
    const diff = tracker.update('file.ts', result2);
    expect(diff.newFindings).toBe(1);
    expect(diff.resolvedFindings).toBe(0);
  });

  it('should report zero diff when nothing changes', () => {
    const tracker = new FindingsTracker();
    const result = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'mixed', explanation: 'Partial', sources: [] },
      },
    });
    tracker.update('file.ts', result);
    const diff = tracker.update('file.ts', result);
    expect(diff.newFindings).toBe(0);
    expect(diff.resolvedFindings).toBe(0);
  });

  it('should track files independently', () => {
    const tracker = new FindingsTracker();
    const resultA = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Bad', sources: [] },
      },
    });
    const resultB = makeScanResult();

    tracker.update('a.ts', resultA);
    tracker.update('b.ts', resultB);
    expect(tracker.size).toBe(2);
    expect(tracker.get('a.ts')?.verifications['c1']?.status).toBe('contradicted');
  });

  it('should return undefined for untracked files', () => {
    const tracker = new FindingsTracker();
    expect(tracker.get('unknown.ts')).toBeUndefined();
  });

  it('should clear all state', () => {
    const tracker = new FindingsTracker();
    tracker.update('a.ts', makeScanResult());
    tracker.update('b.ts', makeScanResult());
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  it('should count supported status as not a finding', () => {
    const tracker = new FindingsTracker();
    const result = makeScanResult({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Good', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Unknown', sources: [] },
      },
    });
    const diff = tracker.update('file.ts', result);
    expect(diff.newFindings).toBe(0); // supported & unverified are not findings
  });
});

// ---------- formatWatchOutput ----------

describe('formatWatchOutput', () => {
  it('should include clear screen escape code', () => {
    const output = formatWatchOutput('test.ts', '{}', { newFindings: 0, resolvedFindings: 0 });
    expect(output).toContain('\x1Bc');
  });

  it('should include file name header', () => {
    const output = formatWatchOutput('src/app.ts', '{}', { newFindings: 0, resolvedFindings: 0 });
    expect(output).toContain('--- src/app.ts ---');
  });

  it('should show new findings count', () => {
    const output = formatWatchOutput('test.ts', '{}', { newFindings: 3, resolvedFindings: 0 });
    expect(output).toContain('+3 new');
  });

  it('should show resolved findings count', () => {
    const output = formatWatchOutput('test.ts', '{}', { newFindings: 0, resolvedFindings: 2 });
    expect(output).toContain('-2 resolved');
  });

  it('should show both new and resolved', () => {
    const output = formatWatchOutput('test.ts', '{}', { newFindings: 1, resolvedFindings: 1 });
    expect(output).toContain('+1 new');
    expect(output).toContain('-1 resolved');
  });

  it('should not show tags when no changes', () => {
    const output = formatWatchOutput('test.ts', '{}', { newFindings: 0, resolvedFindings: 0 });
    expect(output).not.toContain('+0');
    expect(output).not.toContain('-0');
    expect(output).not.toContain('[');
  });

  it('should include report output', () => {
    const report = '{"provider":"mock","claims":[]}';
    const output = formatWatchOutput('test.ts', report, { newFindings: 0, resolvedFindings: 0 });
    expect(output).toContain(report);
  });
});

// ---------- processFileChange ----------

describe('processFileChange', () => {
  let tmpDir: string;
  let debouncer: Debouncer;
  let results: Array<{ file: string; output: string }>;
  let errors: Array<{ file: string; error: string }>;

  const opts = () => ({
    provider: 'mock' as const,
    onResult: (file: string, output: string) => results.push({ file, output }),
    onError: (file: string, error: string) => errors.push({ file, error }),
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-watch-'));
    debouncer = new Debouncer(500);
    results = [];
    errors = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should scan a valid file and emit result', async () => {
    const file = join(tmpDir, 'test.txt');
    writeFileSync(file, 'The Earth is round. Water is wet.');
    const scanned = await processFileChange(file, debouncer, opts());
    expect(scanned).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].file).toBe(file);
    expect(results[0].output.length).toBeGreaterThan(0);
  });

  it('should return false for debounced file', async () => {
    const file = join(tmpDir, 'debounced.txt');
    writeFileSync(file, 'Some content.');
    await processFileChange(file, debouncer, opts());
    expect(results.length).toBe(1);

    // Second call within debounce window
    const scanned = await processFileChange(file, debouncer, opts());
    expect(scanned).toBe(false);
    expect(results.length).toBe(1); // no new result
  });

  it('should return false for nonexistent file', async () => {
    const scanned = await processFileChange('/nonexistent/file.txt', debouncer, opts());
    expect(scanned).toBe(false);
    expect(results.length).toBe(0);
  });

  it('should return false for empty file', async () => {
    const file = join(tmpDir, 'empty.txt');
    writeFileSync(file, '');
    const scanned = await processFileChange(file, debouncer, opts());
    expect(scanned).toBe(false);
  });

  it('should return false for directory', async () => {
    const dir = join(tmpDir, 'subdir');
    mkdirSync(dir);
    const scanned = await processFileChange(dir, debouncer, opts());
    expect(scanned).toBe(false);
  });

  it('should record scan time after successful scan', async () => {
    const file = join(tmpDir, 'record.txt');
    writeFileSync(file, 'Content here.');
    expect(debouncer.getLastScan(file)).toBeUndefined();
    await processFileChange(file, debouncer, opts());
    expect(debouncer.getLastScan(file)).toBeDefined();
  });

  it('should parse scan result as JSON', async () => {
    const file = join(tmpDir, 'json-check.txt');
    writeFileSync(file, 'The sky is blue. Gravity pulls down.');
    await processFileChange(file, debouncer, opts());
    const parsed = JSON.parse(results[0].output);
    expect(parsed.provider).toBe('Mock Provider');
    expect(parsed.claims).toBeDefined();
    expect(parsed.ruleFindings).toBeDefined();
  });

  it('should use findings tracker when provided', async () => {
    const tracker = new FindingsTracker();
    const file = join(tmpDir, 'tracked.txt');
    writeFileSync(file, 'The sky is blue.');
    await processFileChange(file, debouncer, { ...opts(), findingsTracker: tracker });
    expect(tracker.size).toBe(1);
    expect(results[0].output).toContain('---'); // formatted output has header
  });

  it('should return false for whitespace-only file', async () => {
    const file = join(tmpDir, 'whitespace.txt');
    writeFileSync(file, '   \n\n  ');
    const scanned = await processFileChange(file, debouncer, opts());
    expect(scanned).toBe(false);
  });
});
