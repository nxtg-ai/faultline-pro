/**
 * CLI behaviour when claim extraction fails: a clear error, a non-zero exit, and
 * no report (a report here would be built on synthetic per-sentence claims).
 * Also: the hosted transport names a 502 extraction_failed, and telemetry
 * classifies by the ExtractionError reason, not its customer text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name: 'cli-extraction-test-provider',
    modelId: 'cli-extraction-v1',
    extractClaims: mockExtractClaims,
    verifyClaim: mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { main } from '../cli/index.js';
import { runScan, HostedScanError } from '../cli/transport.js';
import { classifyError } from '../cli/telemetry.js';
import { ExtractionError } from '../providers/extraction-error.js';

const TEXT = 'Acme reported record revenue in Q3. The merger closed last year. Profits doubled since.';

describe('faultline scan — extraction failure', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-extract-fail-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 with the safe extraction message, verifies nothing, and prints no report', async () => {
    mockExtractClaims.mockRejectedValue(
      new ExtractionError('invalid_output', new SyntaxError('Unterminated string in JSON at position 8191')),
    );
    const f = join(tmpDir, 'draft.txt');
    writeFileSync(f, TEXT);

    const { exitCode, output } = await main(['scan', '--input', f, '--provider', 'mock', '--history-dir', tmpDir]);

    expect(exitCode).toBe(1);
    expect(output).toContain('Claim extraction failed');
    expect(output).toContain('Nothing was verified');
    expect(output).toContain('invalid_output');
    expect(output).not.toContain('Unterminated string');
    expect(() => JSON.parse(output)).toThrow();
    expect(mockVerifyClaim).not.toHaveBeenCalled();
  });

  it('exits 1 under --fail-on too (a failed extraction is never a pass)', async () => {
    mockExtractClaims.mockRejectedValue(new ExtractionError('rate_limited', new Error('429')));
    const f = join(tmpDir, 'draft.txt');
    writeFileSync(f, TEXT);

    const { exitCode, output } = await main([
      'scan', '--input', f, '--provider', 'mock', '--fail-on', 'critical', '--history-dir', tmpDir,
    ]);

    expect(exitCode).toBe(1);
    expect(output).toContain('rate_limited');
    expect(mockVerifyClaim).not.toHaveBeenCalled();
  });

  it('--dir: one file failing extraction fails the run (exit 1), names the file and reason, JSON stays on stdout', async () => {
    mockExtractClaims
      .mockResolvedValueOnce([{ id: 'c1', text: 'Acme reported record revenue in Q3.', type: 'fact', importance: 4 }])
      .mockRejectedValueOnce(new ExtractionError('timeout', new Error('timed out')));
    mockVerifyClaim.mockImplementation(async (c: { id: string }) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [] }));
    writeFileSync(join(tmpDir, 'a.md'), 'Acme reported record revenue in Q3.');
    writeFileSync(join(tmpDir, 'b.md'), TEXT);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { exitCode, output } = await main(['scan', '--dir', tmpDir, '--provider', 'mock', '--glob', '*.md']);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.filesScanned).toBe(1);
    expect(parsed.extractionFailures.length).toBe(1);
    expect(parsed.extractionFailures[0].reason).toBe('timeout');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('Claim extraction failed for 1 file(s)'))).toBe(true);
  });

  it('still rethrows a non-extraction error (no blanket catch)', async () => {
    mockExtractClaims.mockRejectedValue(new TypeError('engine bug'));
    const f = join(tmpDir, 'draft.txt');
    writeFileSync(f, TEXT);

    await expect(main(['scan', '--input', f, '--provider', 'mock', '--history-dir', tmpDir]))
      .rejects.toThrow('engine bug');
  });
});

describe('hosted transport — 502 extraction_failed', () => {
  it('says the API could not extract claims and nothing was verified', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'extraction_failed', reason: 'invalid_output' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    const err = await runScan(TEXT, undefined, { mode: 'hosted', apiUrl: 'https://api.example.test', apiKey: 'k' }, { fetchImpl })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HostedScanError);
    expect((err as HostedScanError).status).toBe(502);
    expect((err as HostedScanError).message).toContain('could not extract claims');
    expect((err as HostedScanError).message).toContain('Nothing was verified');
    expect((err as HostedScanError).message).toContain('invalid_output');
  });
});

describe('telemetry classifyError — ExtractionError', () => {
  it('maps each reason to its error code', () => {
    expect(classifyError(new ExtractionError('rate_limited'))).toBe('RATE_LIMIT');
    expect(classifyError(new ExtractionError('timeout'))).toBe('TIMEOUT');
    expect(classifyError(new ExtractionError('provider_unavailable'))).toBe('PROVIDER_UNAVAILABLE');
    expect(classifyError(new ExtractionError('invalid_output'))).toBe('PARSE_ERROR');
    expect(classifyError(new ExtractionError('provider_error'))).toBe('API_ERROR');
  });
});
