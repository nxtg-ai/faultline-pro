import { describe, it, expect } from 'vitest';
import type { HistoryEntry } from '../history/store.js';
import type { ScanResult } from '../cli/scan.js';
import {
  applyFilter,
  renderCsv,
  renderJson,
  renderNdjson,
  render,
  mimeType,
  fileExtension,
} from '../cli/export.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    input: 'The Eiffel Tower was built in 1889.',
    provider: 'mock',
    claims: [
      { id: 'c1', text: 'The Eiffel Tower was built in 1889.', type: 'fact', importance: 4 },
    ],
    verifications: {
      c1: {
        claimId: 'c1',
        status: 'supported',
        explanation: 'Confirmed by historical records.',
        sources: [{ title: 'Wikipedia', uri: 'https://en.wikipedia.org/wiki/Eiffel_Tower' }],
      },
    },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    timestamp: '2026-03-10T12:00:00.000Z',
    file: 'doc.txt',
    provider: 'mock',
    overallRisk: 'low',
    findingCount: 0,
    claimCount: 1,
    verificationCount: 1,
    ruleFindings: [],
    scanResult: makeScanResult(),
    ...overrides,
  };
}

const ENTRIES: HistoryEntry[] = [
  makeEntry({
    timestamp: '2026-03-05T09:00:00.000Z',
    file: 'a.txt',
    provider: 'gemini',
    overallRisk: 'high',
    claimCount: 2,
    findingCount: 1,
    scanResult: makeScanResult({ provider: 'gemini', overallRisk: 'high' }),
  }),
  makeEntry({
    timestamp: '2026-03-10T12:00:00.000Z',
    file: 'b.txt',
    provider: 'mock',
    overallRisk: 'low',
  }),
  makeEntry({
    timestamp: '2026-03-15T18:00:00.000Z',
    file: 'c.txt',
    provider: 'openai',
    overallRisk: 'medium',
    scanResult: makeScanResult({ provider: 'openai', overallRisk: 'medium' }),
  }),
  makeEntry({
    timestamp: '2026-03-20T08:00:00.000Z',
    file: 'd.txt',
    provider: 'mock',
    overallRisk: 'critical',
  }),
];

// ── applyFilter ───────────────────────────────────────────────────────────────

describe('applyFilter', () => {
  it('returns all entries when no filters set', () => {
    expect(applyFilter(ENTRIES, {})).toHaveLength(ENTRIES.length);
  });

  it('filters by --from date (inclusive)', () => {
    const result = applyFilter(ENTRIES, { from: '2026-03-10' });
    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => expect(e.timestamp >= '2026-03-10').toBe(true));
  });

  it('filters by --to date (inclusive, appends end-of-day)', () => {
    const result = applyFilter(ENTRIES, { to: '2026-03-10' });
    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => expect(e.timestamp <= '2026-03-10T23:59:59.999Z').toBe(true));
  });

  it('filters by date range --from + --to', () => {
    const result = applyFilter(ENTRIES, { from: '2026-03-05', to: '2026-03-15' });
    expect(result).toHaveLength(3); // Mar 5, 10, 15
  });

  it('filters by --provider', () => {
    const result = applyFilter(ENTRIES, { provider: 'mock' });
    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => expect(e.provider).toBe('mock'));
  });

  it('filters by --risk', () => {
    const result = applyFilter(ENTRIES, { risk: 'high' });
    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => expect(e.overallRisk).toBe('high'));
  });

  it('combines provider + risk filters', () => {
    const result = applyFilter(ENTRIES, { provider: 'mock', risk: 'low' });
    result.forEach(e => {
      expect(e.provider).toBe('mock');
      expect(e.overallRisk).toBe('low');
    });
  });

  it('returns empty array when no entries match', () => {
    expect(applyFilter(ENTRIES, { provider: 'perplexity' })).toHaveLength(0);
  });

  it('handles ISO datetime in --to (does not append end-of-day)', () => {
    const result = applyFilter(ENTRIES, { to: '2026-03-10T12:00:00.000Z' });
    expect(result.length).toBeGreaterThan(0);
    result.forEach(e => expect(e.timestamp <= '2026-03-10T12:00:00.000Z').toBe(true));
  });
});

// ── renderCsv ─────────────────────────────────────────────────────────────────

describe('renderCsv', () => {
  it('outputs a non-empty string', () => {
    const out = renderCsv(ENTRIES);
    expect(out.length).toBeGreaterThan(0);
  });

  it('first line is the header row', () => {
    const lines = renderCsv(ENTRIES).split('\n').filter(Boolean);
    expect(lines[0]).toContain('scan_timestamp');
    expect(lines[0]).toContain('claim_id');
    expect(lines[0]).toContain('verdict');
    expect(lines[0]).toContain('overall_risk');
  });

  it('produces at least one data row per entry (claim explosion)', () => {
    const lines = renderCsv(ENTRIES).split('\n').filter(Boolean);
    // 1 header + at least 1 row per entry (entries each have 1 claim)
    expect(lines.length).toBeGreaterThan(ENTRIES.length);
  });

  it('includes claim text and verdict in data rows', () => {
    const out = renderCsv(ENTRIES);
    expect(out).toContain('supported');
    expect(out).toContain('Eiffel Tower');
  });

  it('CSV-escapes fields containing commas', () => {
    const entryWithComma = makeEntry({
      file: 'my,file.txt',
      scanResult: makeScanResult(),
    });
    const out = renderCsv([entryWithComma]);
    expect(out).toContain('"my,file.txt"');
  });

  it('emits a summary row for entries with no claims', () => {
    const noClaimsEntry = makeEntry({
      scanResult: makeScanResult({ claims: [], verifications: {} }),
      claimCount: 0,
    });
    const lines = renderCsv([noClaimsEntry]).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2); // header + 1 summary row
  });

  it('ends with a trailing newline', () => {
    expect(renderCsv(ENTRIES).endsWith('\n')).toBe(true);
  });
});

// ── renderJson ────────────────────────────────────────────────────────────────

describe('renderJson', () => {
  it('parses as valid JSON array', () => {
    const out = renderJson(ENTRIES);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(ENTRIES.length);
  });

  it('each row includes trust_score', () => {
    const parsed = JSON.parse(renderJson(ENTRIES));
    parsed.forEach((row: Record<string, unknown>) => {
      expect(typeof row['trust_score']).toBe('number');
      expect(row['trust_score']).toBeGreaterThanOrEqual(0);
      expect(row['trust_score']).toBeLessThanOrEqual(100);
    });
  });

  it('each row includes required summary fields', () => {
    const parsed = JSON.parse(renderJson(ENTRIES));
    parsed.forEach((row: Record<string, unknown>) => {
      expect(row).toHaveProperty('scan_timestamp');
      expect(row).toHaveProperty('file');
      expect(row).toHaveProperty('provider');
      expect(row).toHaveProperty('overall_risk');
      expect(row).toHaveProperty('claim_count');
    });
  });
});

// ── renderNdjson ──────────────────────────────────────────────────────────────

describe('renderNdjson', () => {
  it('each non-empty line is valid JSON', () => {
    const lines = renderNdjson(ENTRIES).split('\n').filter(Boolean);
    expect(lines.length).toBe(ENTRIES.length);
    lines.forEach(line => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  it('each line includes trust_score', () => {
    const lines = renderNdjson(ENTRIES).split('\n').filter(Boolean);
    lines.forEach(line => {
      const obj = JSON.parse(line);
      expect(typeof obj.trust_score).toBe('number');
    });
  });
});

// ── render dispatch ───────────────────────────────────────────────────────────

describe('render', () => {
  it('csv format calls renderCsv path', () => {
    const out = render(ENTRIES, 'csv');
    expect(out.startsWith('scan_timestamp')).toBe(true);
  });

  it('json format calls renderJson path', () => {
    const out = render(ENTRIES, 'json');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('ndjson format calls renderNdjson path', () => {
    const lines = render(ENTRIES, 'ndjson').split('\n').filter(Boolean);
    expect(lines.length).toBe(ENTRIES.length);
  });
});

// ── mimeType + fileExtension ──────────────────────────────────────────────────

describe('mimeType', () => {
  it('csv → text/csv', () => expect(mimeType('csv')).toBe('text/csv'));
  it('json → application/json', () => expect(mimeType('json')).toBe('application/json'));
  it('ndjson → application/x-ndjson', () => expect(mimeType('ndjson')).toBe('application/x-ndjson'));
});

describe('fileExtension', () => {
  it('csv → csv', () => expect(fileExtension('csv')).toBe('csv'));
  it('json → json', () => expect(fileExtension('json')).toBe('json'));
  it('ndjson → ndjson', () => expect(fileExtension('ndjson')).toBe('ndjson'));
});
