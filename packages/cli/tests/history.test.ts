import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock @google/genai so provider imports don't blow up
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

vi.stubGlobal('fetch', vi.fn());

import {
  saveHistoryEntry,
  listHistory,
  analyzeTrend,
  formatHistoryList,
  formatTrendAnalysis,
  type HistoryEntry,
  type TrendAnalysis,
} from '../history/store';
import { main } from '../cli/index';
import type { ScanResult } from '../cli/scan';

function makeScanResult(overrides?: Partial<ScanResult>): ScanResult {
  return {
    input: 'Test input',
    provider: 'Mock Provider',
    claims: [{ id: 'c1', text: 'Test claim.', type: 'fact', importance: 5 }],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'OK', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      generatedAt: '2026-02-23T00:00:00.000Z',
      overallRiskLevel: 'low',
      euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 1, totalClaims: 1, highestTier: 'minimal' },
      claimMappings: [],
      triggeredArticles: [],
      mitigations: ['Consider voluntary codes of conduct.'],
      confidenceDistribution: { high: 0, medium: 0, low: 1 },
    },
    ruleFindings: [],
    ...overrides,
  };
}

describe('History: saveHistoryEntry()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-history-'));
  });

  it('should create history directory if it does not exist', () => {
    const historyDir = join(tmpDir, 'new-history');
    const result = makeScanResult();
    saveHistoryEntry(result, 'test.txt', historyDir);
    expect(existsSync(historyDir)).toBe(true);
  });

  it('should save a JSON file to the history directory', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    const files = readdirSync(historyDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it('should return a valid HistoryEntry', () => {
    const historyDir = join(tmpDir, 'hist');
    const entry = saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    expect(entry.timestamp).toBeDefined();
    expect(entry.file).toBe('test.txt');
    expect(entry.provider).toBe('Mock Provider');
    expect(entry.overallRisk).toBe('low');
    expect(entry.findingCount).toBe(0);
    expect(entry.claimCount).toBe(1);
    expect(entry.verificationCount).toBe(1);
  });

  it('should include scanResult in the entry', () => {
    const historyDir = join(tmpDir, 'hist');
    const entry = saveHistoryEntry(makeScanResult(), 'file.txt', historyDir);
    expect(entry.scanResult).toBeDefined();
    expect(entry.scanResult.provider).toBe('Mock Provider');
  });

  it('should include ruleFindings summary', () => {
    const historyDir = join(tmpDir, 'hist');
    const result = makeScanResult({
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'Email found', match: 'a@b.com', offset: 0 },
        { ruleId: 'bias-gender', severity: 'medium', message: 'Gender bias', match: 'mankind', offset: 10 },
      ],
    });
    const entry = saveHistoryEntry(result, 'test.txt', historyDir);
    expect(entry.findingCount).toBe(2);
    expect(entry.ruleFindings).toHaveLength(2);
    expect(entry.ruleFindings[0].ruleId).toBe('pii-email');
    expect(entry.ruleFindings[1].severity).toBe('medium');
  });

  it('should generate unique filenames for different scans', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'file1.txt', historyDir);
    saveHistoryEntry(makeScanResult(), 'file2.txt', historyDir);
    const files = readdirSync(historyDir);
    expect(files.length).toBe(2);
    expect(files[0]).not.toBe(files[1]);
  });

  it('should write valid JSON to disk', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'check.txt', historyDir);
    const files = readdirSync(historyDir);
    const content = readFileSync(join(historyDir, files[0]), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.file).toBe('check.txt');
    expect(parsed.timestamp).toBeDefined();
  });

  it('filename should contain timestamp and hash', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    const files = readdirSync(historyDir);
    // Format: {timestamp}-{8-char-hash}.json
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.json$/);
  });

  it('should handle multiple saves to the same directory', () => {
    const historyDir = join(tmpDir, 'hist');
    for (let i = 0; i < 5; i++) {
      saveHistoryEntry(makeScanResult(), `file${i}.txt`, historyDir);
    }
    const files = readdirSync(historyDir);
    expect(files.length).toBe(5);
  });
});

describe('History: listHistory()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-list-'));
  });

  it('should return empty array for nonexistent directory', () => {
    const entries = listHistory(join(tmpDir, 'nonexistent'));
    expect(entries).toEqual([]);
  });

  it('should return empty array for empty directory', () => {
    const historyDir = join(tmpDir, 'empty');
    mkdirSync(historyDir);
    const entries = listHistory(historyDir);
    expect(entries).toEqual([]);
  });

  it('should return saved entries', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe('test.txt');
  });

  it('should return entries sorted by timestamp descending', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    // Manually create entries with distinct timestamps
    const e1: HistoryEntry = { timestamp: '2026-02-23T08:00:00.000Z', file: 'first.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    const e2: HistoryEntry = { timestamp: '2026-02-23T09:00:00.000Z', file: 'second.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    const e3: HistoryEntry = { timestamp: '2026-02-23T10:00:00.000Z', file: 'third.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    writeFileSync(join(historyDir, '2026-02-23T08-00-00-aaaaaaaa.json'), JSON.stringify(e1));
    writeFileSync(join(historyDir, '2026-02-23T09-00-00-bbbbbbbb.json'), JSON.stringify(e2));
    writeFileSync(join(historyDir, '2026-02-23T10-00-00-cccccccc.json'), JSON.stringify(e3));

    const entries = listHistory(historyDir, { all: true });
    // Most recent first
    expect(entries[0].file).toBe('third.txt');
    expect(entries[entries.length - 1].file).toBe('first.txt');
  });

  it('should limit to 20 entries by default', () => {
    const historyDir = join(tmpDir, 'hist');
    for (let i = 0; i < 25; i++) {
      saveHistoryEntry(makeScanResult(), `file${String(i).padStart(2, '0')}.txt`, historyDir);
    }
    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(20);
  });

  it('should return all entries with --all option', () => {
    const historyDir = join(tmpDir, 'hist');
    for (let i = 0; i < 25; i++) {
      saveHistoryEntry(makeScanResult(), `file${i}.txt`, historyDir);
    }
    const entries = listHistory(historyDir, { all: true });
    expect(entries).toHaveLength(25);
  });

  it('should skip non-JSON files', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, 'readme.txt'), 'Not JSON');
    saveHistoryEntry(makeScanResult(), 'valid.txt', historyDir);
    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe('valid.txt');
  });

  it('should skip corrupt JSON files', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, 'corrupt.json'), '{invalid json');
    saveHistoryEntry(makeScanResult(), 'valid.txt', historyDir);
    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(1);
  });

  it('should skip JSON files without required fields', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, 'incomplete.json'), JSON.stringify({ foo: 'bar' }));
    saveHistoryEntry(makeScanResult(), 'valid.txt', historyDir);
    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(1);
  });
});

describe('History: analyzeTrend()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-trend-'));
  });

  it('should return insufficient-data for empty history', () => {
    const trend = analyzeTrend('nonexistent.txt', join(tmpDir, 'empty'));
    expect(trend.direction).toBe('insufficient-data');
    expect(trend.points).toEqual([]);
    expect(trend.firstScan).toBeNull();
    expect(trend.lastScan).toBeNull();
  });

  it('should return insufficient-data for single scan', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    const trend = analyzeTrend('test.txt', historyDir);
    expect(trend.direction).toBe('insufficient-data');
    expect(trend.points).toHaveLength(1);
    expect(trend.firstScan).toBeDefined();
  });

  it('should detect stable trend when findings stay the same', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    const e1: HistoryEntry = { timestamp: '2026-02-23T10:00:00.000Z', file: 'test.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    const e2: HistoryEntry = { timestamp: '2026-02-23T11:00:00.000Z', file: 'test.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    writeFileSync(join(historyDir, '2026-02-23T10-00-00-aaaaaaaa.json'), JSON.stringify(e1));
    writeFileSync(join(historyDir, '2026-02-23T11-00-00-bbbbbbbb.json'), JSON.stringify(e2));
    const trend = analyzeTrend('test.txt', historyDir);
    expect(trend.direction).toBe('stable');
    expect(trend.findingDelta).toBe(0);
  });

  it('should detect improving trend when findings decrease', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });

    // Manually create entries with controlled timestamps and finding counts
    const entry1: HistoryEntry = {
      timestamp: '2026-02-23T10:00:00.000Z',
      file: 'test.txt',
      provider: 'Mock Provider',
      overallRisk: 'high',
      findingCount: 5,
      claimCount: 3,
      verificationCount: 2,
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'Email' },
        { ruleId: 'pii-ssn', severity: 'critical', message: 'SSN' },
        { ruleId: 'bias-gender', severity: 'medium', message: 'Gender' },
        { ruleId: 'bias-age', severity: 'medium', message: 'Age' },
        { ruleId: 'toxicity-threats', severity: 'critical', message: 'Threat' },
      ],
      scanResult: makeScanResult(),
    };
    const entry2: HistoryEntry = {
      timestamp: '2026-02-23T11:00:00.000Z',
      file: 'test.txt',
      provider: 'Mock Provider',
      overallRisk: 'low',
      findingCount: 1,
      claimCount: 3,
      verificationCount: 2,
      ruleFindings: [{ ruleId: 'pii-email', severity: 'high', message: 'Email' }],
      scanResult: makeScanResult(),
    };

    writeFileSync(join(historyDir, '2026-02-23T10-00-00-abc12345.json'), JSON.stringify(entry1));
    writeFileSync(join(historyDir, '2026-02-23T11-00-00-def67890.json'), JSON.stringify(entry2));

    const trend = analyzeTrend('test.txt', historyDir);
    expect(trend.direction).toBe('improving');
    expect(trend.findingDelta).toBe(-4);
  });

  it('should detect degrading trend when findings increase', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });

    const entry1: HistoryEntry = {
      timestamp: '2026-02-23T10:00:00.000Z',
      file: 'test.txt',
      provider: 'Mock Provider',
      overallRisk: 'low',
      findingCount: 1,
      claimCount: 2,
      verificationCount: 1,
      ruleFindings: [{ ruleId: 'pii-email', severity: 'high', message: 'Email' }],
      scanResult: makeScanResult(),
    };
    const entry2: HistoryEntry = {
      timestamp: '2026-02-23T12:00:00.000Z',
      file: 'test.txt',
      provider: 'Mock Provider',
      overallRisk: 'critical',
      findingCount: 7,
      claimCount: 5,
      verificationCount: 4,
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'Email' },
        { ruleId: 'pii-ssn', severity: 'critical', message: 'SSN' },
        { ruleId: 'bias-gender', severity: 'medium', message: 'Gender' },
        { ruleId: 'toxicity-threats', severity: 'critical', message: 'Threat' },
        { ruleId: 'toxicity-slurs', severity: 'critical', message: 'Slur' },
        { ruleId: 'bias-age', severity: 'medium', message: 'Age' },
        { ruleId: 'pii-phone', severity: 'high', message: 'Phone' },
      ],
      scanResult: makeScanResult(),
    };

    writeFileSync(join(historyDir, '2026-02-23T10-00-00-aaa11111.json'), JSON.stringify(entry1));
    writeFileSync(join(historyDir, '2026-02-23T12-00-00-bbb22222.json'), JSON.stringify(entry2));

    const trend = analyzeTrend('test.txt', historyDir);
    expect(trend.direction).toBe('degrading');
    expect(trend.findingDelta).toBe(6);
  });

  it('should only include entries for the specified file', () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    const target1: HistoryEntry = { timestamp: '2026-02-23T10:00:00.000Z', file: 'target.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 1, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    const other: HistoryEntry = { timestamp: '2026-02-23T10:30:00.000Z', file: 'other.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    const target2: HistoryEntry = { timestamp: '2026-02-23T11:00:00.000Z', file: 'target.txt', provider: 'Mock Provider', overallRisk: 'low', findingCount: 1, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    writeFileSync(join(historyDir, '2026-02-23T10-00-00-aaaaaaaa.json'), JSON.stringify(target1));
    writeFileSync(join(historyDir, '2026-02-23T10-30-00-bbbbbbbb.json'), JSON.stringify(other));
    writeFileSync(join(historyDir, '2026-02-23T11-00-00-cccccccc.json'), JSON.stringify(target2));

    const trend = analyzeTrend('target.txt', historyDir);
    expect(trend.points).toHaveLength(2);
    expect(trend.file).toBe('target.txt');
  });

  it('should set firstScan and lastScan timestamps', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);

    const trend = analyzeTrend('test.txt', historyDir);
    expect(trend.firstScan).toBeDefined();
    expect(trend.lastScan).toBeDefined();
    expect(trend.firstScan!.localeCompare(trend.lastScan!)).toBeLessThanOrEqual(0);
  });

  it('points should be in chronological order', () => {
    const historyDir = join(tmpDir, 'hist');
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);
    saveHistoryEntry(makeScanResult(), 'test.txt', historyDir);

    const trend = analyzeTrend('test.txt', historyDir);
    for (let i = 1; i < trend.points.length; i++) {
      expect(trend.points[i].timestamp.localeCompare(trend.points[i - 1].timestamp)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('History: formatHistoryList()', () => {
  it('should show empty message when no entries', () => {
    const output = formatHistoryList([]);
    expect(output).toContain('No scan history found');
    expect(output).toContain('faultline scan');
  });

  it('should show entry count in header', () => {
    const entries: HistoryEntry[] = [
      {
        timestamp: '2026-02-23T10:00:00.000Z',
        file: 'test.txt',
        provider: 'Mock Provider',
        overallRisk: 'low',
        findingCount: 0,
        claimCount: 1,
        verificationCount: 1,
        ruleFindings: [],
        scanResult: makeScanResult(),
      },
    ];
    const output = formatHistoryList(entries);
    expect(output).toContain('1 entries');
  });

  it('should include date, file, findings, and risk columns', () => {
    const entries: HistoryEntry[] = [
      {
        timestamp: '2026-02-23T10:30:00.000Z',
        file: 'report.txt',
        provider: 'Mock Provider',
        overallRisk: 'high',
        findingCount: 3,
        claimCount: 5,
        verificationCount: 4,
        ruleFindings: [],
        scanResult: makeScanResult(),
      },
    ];
    const output = formatHistoryList(entries);
    expect(output).toContain('2026-02-23');
    expect(output).toContain('report.txt');
    expect(output).toContain('3');
    expect(output).toContain('HIGH');
  });

  it('should truncate long filenames', () => {
    const entries: HistoryEntry[] = [
      {
        timestamp: '2026-02-23T10:00:00.000Z',
        file: 'very/long/deeply/nested/path/to/document.txt',
        provider: 'Mock Provider',
        overallRisk: 'low',
        findingCount: 0,
        claimCount: 1,
        verificationCount: 1,
        ruleFindings: [],
        scanResult: makeScanResult(),
      },
    ];
    const output = formatHistoryList(entries);
    expect(output).toContain('...');
  });

  it('should include table headers', () => {
    const entries: HistoryEntry[] = [
      {
        timestamp: '2026-02-23T10:00:00.000Z',
        file: 'test.txt',
        provider: 'Mock Provider',
        overallRisk: 'low',
        findingCount: 0,
        claimCount: 1,
        verificationCount: 1,
        ruleFindings: [],
        scanResult: makeScanResult(),
      },
    ];
    const output = formatHistoryList(entries);
    expect(output).toContain('Date');
    expect(output).toContain('File');
    expect(output).toContain('Findings');
    expect(output).toContain('Risk');
  });
});

describe('History: formatTrendAnalysis()', () => {
  it('should show no-history message for empty trend', () => {
    const trend: TrendAnalysis = {
      file: 'missing.txt',
      points: [],
      direction: 'insufficient-data',
      firstScan: null,
      lastScan: null,
      findingDelta: 0,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('No scan history found');
    expect(output).toContain('missing.txt');
  });

  it('should show insufficient-data message for single scan', () => {
    const trend: TrendAnalysis = {
      file: 'once.txt',
      points: [{ timestamp: '2026-02-23T10:00:00.000Z', findingCount: 2, overallRisk: 'medium', claimCount: 3 }],
      direction: 'insufficient-data',
      firstScan: '2026-02-23T10:00:00.000Z',
      lastScan: '2026-02-23T10:00:00.000Z',
      findingDelta: 0,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('Insufficient data');
    expect(output).toContain('once.txt');
  });

  it('should show IMPROVING for decreasing findings', () => {
    const trend: TrendAnalysis = {
      file: 'test.txt',
      points: [
        { timestamp: '2026-02-23T10:00:00.000Z', findingCount: 5, overallRisk: 'high', claimCount: 3 },
        { timestamp: '2026-02-23T11:00:00.000Z', findingCount: 2, overallRisk: 'low', claimCount: 3 },
      ],
      direction: 'improving',
      firstScan: '2026-02-23T10:00:00.000Z',
      lastScan: '2026-02-23T11:00:00.000Z',
      findingDelta: -3,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('IMPROVING');
    expect(output).toContain('-3');
  });

  it('should show DEGRADING for increasing findings', () => {
    const trend: TrendAnalysis = {
      file: 'test.txt',
      points: [
        { timestamp: '2026-02-23T10:00:00.000Z', findingCount: 1, overallRisk: 'low', claimCount: 2 },
        { timestamp: '2026-02-23T12:00:00.000Z', findingCount: 8, overallRisk: 'critical', claimCount: 5 },
      ],
      direction: 'degrading',
      firstScan: '2026-02-23T10:00:00.000Z',
      lastScan: '2026-02-23T12:00:00.000Z',
      findingDelta: 7,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('DEGRADING');
    expect(output).toContain('+7');
  });

  it('should show STABLE for unchanged findings', () => {
    const trend: TrendAnalysis = {
      file: 'test.txt',
      points: [
        { timestamp: '2026-02-23T10:00:00.000Z', findingCount: 2, overallRisk: 'medium', claimCount: 3 },
        { timestamp: '2026-02-23T11:00:00.000Z', findingCount: 2, overallRisk: 'medium', claimCount: 3 },
      ],
      direction: 'stable',
      firstScan: '2026-02-23T10:00:00.000Z',
      lastScan: '2026-02-23T11:00:00.000Z',
      findingDelta: 0,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('STABLE');
  });

  it('should include timeline with bar chart', () => {
    const trend: TrendAnalysis = {
      file: 'test.txt',
      points: [
        { timestamp: '2026-02-23T10:00:00.000Z', findingCount: 3, overallRisk: 'medium', claimCount: 4 },
        { timestamp: '2026-02-23T11:00:00.000Z', findingCount: 1, overallRisk: 'low', claimCount: 4 },
      ],
      direction: 'improving',
      firstScan: '2026-02-23T10:00:00.000Z',
      lastScan: '2026-02-23T11:00:00.000Z',
      findingDelta: -2,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('Timeline');
    expect(output).toContain('###'); // 3 hash marks for 3 findings
    expect(output).toContain('#');   // 1 hash mark for 1 finding
  });

  it('should include scan count', () => {
    const trend: TrendAnalysis = {
      file: 'test.txt',
      points: [
        { timestamp: '2026-02-23T10:00:00.000Z', findingCount: 2, overallRisk: 'low', claimCount: 1 },
        { timestamp: '2026-02-23T11:00:00.000Z', findingCount: 2, overallRisk: 'low', claimCount: 1 },
        { timestamp: '2026-02-23T12:00:00.000Z', findingCount: 2, overallRisk: 'low', claimCount: 1 },
      ],
      direction: 'stable',
      firstScan: '2026-02-23T10:00:00.000Z',
      lastScan: '2026-02-23T12:00:00.000Z',
      findingDelta: 0,
    };
    const output = formatTrendAnalysis(trend);
    expect(output).toContain('Scans: 3');
  });
});

describe('CLI: history command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-cli-hist-'));
  });

  it('should show empty message for no history', async () => {
    const historyDir = join(tmpDir, 'empty-hist');
    const { exitCode, output } = await main(['history', '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(output).toContain('No scan history found');
  });

  it('should list scans after scanning a file', async () => {
    const historyDir = join(tmpDir, 'hist');
    const inputFile = join(tmpDir, 'test.txt');
    writeFileSync(inputFile, 'Water boils at 100 degrees.');

    // Scan with history dir
    await main(['scan', '--input', inputFile, '--provider', 'mock', '--history-dir', historyDir]);

    // Now list history
    const { exitCode, output } = await main(['history', '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(output).toContain('1 entries');
    expect(output).toContain('LOW');
  });

  it('should show limited entries by default', async () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });

    // Manually create 25 entries
    for (let i = 0; i < 25; i++) {
      const entry: HistoryEntry = {
        timestamp: `2026-02-23T${String(i).padStart(2, '0')}:00:00.000Z`,
        file: `file${i}.txt`,
        provider: 'Mock Provider',
        overallRisk: 'low',
        findingCount: 0,
        claimCount: 1,
        verificationCount: 1,
        ruleFindings: [],
        scanResult: makeScanResult(),
      };
      writeFileSync(
        join(historyDir, `2026-02-23T${String(i).padStart(2, '0')}-00-00-${String(i).padStart(8, '0')}.json`),
        JSON.stringify(entry),
      );
    }

    const { output } = await main(['history', '--history-dir', historyDir]);
    expect(output).toContain('20 entries');
  });

  it('should show all entries with --all flag', async () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });

    for (let i = 0; i < 25; i++) {
      const entry: HistoryEntry = {
        timestamp: `2026-02-23T${String(i).padStart(2, '0')}:00:00.000Z`,
        file: `file${i}.txt`,
        provider: 'Mock Provider',
        overallRisk: 'low',
        findingCount: 0,
        claimCount: 1,
        verificationCount: 1,
        ruleFindings: [],
        scanResult: makeScanResult(),
      };
      writeFileSync(
        join(historyDir, `2026-02-23T${String(i).padStart(2, '0')}-00-00-${String(i).padStart(8, '0')}.json`),
        JSON.stringify(entry),
      );
    }

    const { output } = await main(['history', '--history-dir', historyDir, '--all']);
    expect(output).toContain('25 entries');
  });
});

describe('CLI: trend command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-cli-trend-'));
  });

  it('should require --file flag', async () => {
    const { exitCode, output } = await main(['trend']);
    expect(exitCode).toBe(1);
    expect(output).toContain('--file');
  });

  it('should show no-history for unknown file', async () => {
    const historyDir = join(tmpDir, 'empty');
    const { exitCode, output } = await main(['trend', '--file', 'unknown.txt', '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(output).toContain('No scan history found');
  });

  it('should show trend after multiple scans of same file', async () => {
    const historyDir = join(tmpDir, 'hist');
    mkdirSync(historyDir, { recursive: true });
    const inputFile = join(tmpDir, 'test.txt');
    writeFileSync(inputFile, 'Water boils at 100 degrees.');

    // Manually seed two history entries with different timestamps for the same file
    const e1: HistoryEntry = { timestamp: '2026-02-23T10:00:00.000Z', file: inputFile, provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    const e2: HistoryEntry = { timestamp: '2026-02-23T11:00:00.000Z', file: inputFile, provider: 'Mock Provider', overallRisk: 'low', findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: makeScanResult() };
    writeFileSync(join(historyDir, '2026-02-23T10-00-00-aaaaaaaa.json'), JSON.stringify(e1));
    writeFileSync(join(historyDir, '2026-02-23T11-00-00-bbbbbbbb.json'), JSON.stringify(e2));

    const { exitCode, output } = await main(['trend', '--file', inputFile, '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(output).toContain('Trend Analysis');
    expect(output).toContain('STABLE');
  });

  it('should show insufficient-data for single scan', async () => {
    const historyDir = join(tmpDir, 'hist');
    const inputFile = join(tmpDir, 'once.txt');
    writeFileSync(inputFile, 'The sky is blue.');

    await main(['scan', '--input', inputFile, '--provider', 'mock', '--history-dir', historyDir]);

    const { exitCode, output } = await main(['trend', '--file', inputFile, '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(output).toContain('Insufficient data');
  });
});

describe('History: integration with scan command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-int-'));
  });

  it('scan should save to history dir when --history-dir is provided', async () => {
    const historyDir = join(tmpDir, 'hist');
    const inputFile = join(tmpDir, 'input.txt');
    writeFileSync(inputFile, 'Water boils at 100 degrees.');

    const { exitCode } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(existsSync(historyDir)).toBe(true);

    const files = readdirSync(historyDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it('saved history entry should match scan result', async () => {
    const historyDir = join(tmpDir, 'hist');
    const inputFile = join(tmpDir, 'input.txt');
    writeFileSync(inputFile, 'Water boils at 100 degrees. The sky is blue.');

    const { output } = await main(['scan', '--input', inputFile, '--provider', 'mock', '--history-dir', historyDir]);
    const scanResult = JSON.parse(output) as ScanResult;

    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe(scanResult.provider);
    expect(entries[0].overallRisk).toBe(scanResult.overallRisk);
    expect(entries[0].file).toBe(inputFile);
  });

  it('history should accumulate across multiple scans', async () => {
    const historyDir = join(tmpDir, 'hist');
    const file1 = join(tmpDir, 'a.txt');
    const file2 = join(tmpDir, 'b.txt');
    writeFileSync(file1, 'First file content.');
    writeFileSync(file2, 'Second file content.');

    await main(['scan', '--input', file1, '--provider', 'mock', '--history-dir', historyDir]);
    await main(['scan', '--input', file2, '--provider', 'mock', '--history-dir', historyDir]);

    const entries = listHistory(historyDir, { all: true });
    expect(entries).toHaveLength(2);
  });

  it('scan with PII should record findings in history', async () => {
    const historyDir = join(tmpDir, 'hist');
    const inputFile = join(tmpDir, 'pii.txt');
    writeFileSync(inputFile, 'Contact john@example.com for details about SSN 123-45-6789.');

    await main(['scan', '--input', inputFile, '--provider', 'mock', '--history-dir', historyDir]);

    const entries = listHistory(historyDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].findingCount).toBeGreaterThan(0);
    expect(entries[0].ruleFindings.length).toBeGreaterThan(0);
  });
});
