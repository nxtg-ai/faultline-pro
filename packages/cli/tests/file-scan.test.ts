import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../cli/index.js';

// Mock the scan module to avoid real API calls
vi.mock('../cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Extracted file content',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'Test claim from file', type: 'fact', importance: 4 }],
    verifications: {
      c1: { claimId: 'c1', status: 'unverified', explanation: 'No source found.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: {
      riskTier: 'minimal',
      findings: [],
      euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 0 },
    },
    ruleFindings: [],
  }),
  batchScan: vi.fn(),
}));

// Mock the extract module (tesseract.js and pdf-parse are mocked through this)
vi.mock('../cli/extract.js', () => ({
  extractTextFromFile: vi.fn().mockResolvedValue('Extracted content from file'),
  extractTextFromBuffer: vi.fn().mockResolvedValue('Extracted content from buffer'),
  mimeFromExtension: vi.fn((ext: string) => {
    const map: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    return map[ext] ?? '';
  }),
  SUPPORTED_EXTENSIONS: ['.pdf', '.png', '.jpg', '.jpeg', '.webp'],
}));

const tmpPdf = join(tmpdir(), 'faultline-test-extract.pdf');
const tmpPng = join(tmpdir(), 'faultline-test-extract.png');
const tmpCsv = join(tmpdir(), 'faultline-test-extract.csv');

beforeAll(() => {
  writeFileSync(tmpPdf, Buffer.from('%PDF-1.4 fake content'));
  writeFileSync(tmpPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(tmpCsv, Buffer.from('col1,col2\n1,2\n3,4'));
});

afterAll(() => {
  for (const f of [tmpPdf, tmpPng, tmpCsv]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  process.env.FAULTLINE_PROVIDER = undefined as unknown as string;
  delete process.env.FAULTLINE_PROVIDER;
});

describe('CLI --file flag', () => {
  it('returns error when file not found', async () => {
    const { exitCode, output } = await main([
      'scan', '--file', '/nonexistent/path/missing.pdf', '--provider', 'mock',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('File not found');
  });

  it('returns error for unsupported extension (.csv)', async () => {
    const { extractTextFromFile } = await import('../cli/extract.js');
    vi.mocked(extractTextFromFile).mockRejectedValueOnce(
      new Error('Unsupported file type: .csv. Supported: .pdf, .png, .jpg, .jpeg, .webp'),
    );
    const { exitCode, output } = await main([
      'scan', '--file', tmpCsv, '--provider', 'mock',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('Unsupported file type');
  });

  it('successful scan via --file doc.pdf with mock provider', async () => {
    const { exitCode, output } = await main([
      'scan', '--file', tmpPdf, '--provider', 'mock',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    // Gate 2: non-empty claims
    expect(Array.isArray(parsed.claims)).toBe(true);
    expect(parsed.claims.length).toBeGreaterThan(0);
  });

  it('successful scan via --file screenshot.png with mock provider', async () => {
    const { exitCode, output } = await main([
      'scan', '--file', tmpPng, '--provider', 'mock',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(typeof parsed.overallRisk).toBe('string');
  });

  it('returns error when extraction returns empty text', async () => {
    const { extractTextFromFile } = await import('../cli/extract.js');
    vi.mocked(extractTextFromFile).mockResolvedValueOnce('');
    const { exitCode, output } = await main([
      'scan', '--file', tmpPdf, '--provider', 'mock',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('No text could be extracted');
  });

  it('--file + --provider mock → JSON output with correct structure', async () => {
    const { exitCode, output } = await main([
      'scan', '--file', tmpPdf, '--provider', 'mock', '--output-format', 'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.claims).toBeDefined();
    expect(parsed.verifications).toBeDefined();
    expect(parsed.overallRisk).toBeDefined();
    expect(parsed.complianceReport).toHaveProperty('euRiskSummary');
  });

  it('returns error when --file and --input are both provided', async () => {
    const { exitCode, output } = await main([
      'scan', '--file', tmpPdf, '--input', 'somefile.txt', '--provider', 'mock',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('mutually exclusive');
  });

  it('extract error propagates to CLI exit code 1', async () => {
    const { extractTextFromFile } = await import('../cli/extract.js');
    vi.mocked(extractTextFromFile).mockRejectedValueOnce(
      new Error('Corrupt PDF: unable to parse structure'),
    );
    const { exitCode, output } = await main([
      'scan', '--file', tmpPdf, '--provider', 'mock',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('Corrupt PDF');
  });
});
