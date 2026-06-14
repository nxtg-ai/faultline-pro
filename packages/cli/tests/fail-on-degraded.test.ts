/**
 * --fail-on gate — degraded-scan FAIL-CLOSED integrity guard.
 *
 * A `--fail-on` gate is the citation-gate engine: exit 0 = "publish", exit 1 = "block".
 * It had a fail-OPEN hole. When verification is DEGRADED (transient 429/503/network
 * left claims unchecked — `ScanResult.degraded`, the 957439a contract), those claims
 * surface as `unverified`, which `countFromScanResult` tallies only as `low`. But
 * `--fail-on critical|high|medium` ignores `low`, so a fully-degraded scan (verifier
 * down, nothing actually checked) exited 0 = PASS = "safe to publish". A fabricated
 * claim would sail through precisely when the verifier could not run — the exact
 * failure this product exists to catch. 957439a stopped degraded results masquerading
 * in the DISPLAY layer; these tests pin the same fix in the EXIT-CODE/gate layer:
 * a degraded scan under an active gate must fail CLOSED, with the diagnostic on
 * STDERR so machine-readable JSON stdout stays parseable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VerificationResult } from '../types.js';

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim:   vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name:    'gate-test-provider',
    modelId: 'gate-v1',
    extractClaims:             mockExtractClaims,
    verifyClaim:               mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { main } from '../cli/index.js';

function vr(
  status: VerificationResult['status'],
  claimId: string,
  apiError?: boolean,
): VerificationResult {
  return { claimId, status, explanation: `test:${status}`, sources: [], ...(apiError ? { apiError: true } : {}) };
}

function makeClaims(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Verifiable claim number ${i + 1} about the subject matter here.`,
    type: 'fact' as const,
    importance: 3,
  }));
}

// A swallowed transient error (e.g. 429 quota) resolves to unverified+apiError —
// it does NOT throw, mirroring geminiService's real behavior (no retry backoff).
const degradedVerify = (c: { id: string }) => Promise.resolve(vr('unverified', c.id, true));
const healthyVerify  = (c: { id: string }) => Promise.resolve(vr('supported', c.id));

describe('--fail-on gate — fail closed on degraded verification', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-gate-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('single-file: --fail-on high fails CLOSED (exit 1) when the scan is degraded', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(3));
    mockVerifyClaim.mockImplementation(degradedVerify); // every claim hit a 429 -> never checked
    const f = join(tmpDir, 'draft.txt');
    writeFileSync(f, 'Acme reported record revenue in Q3. The merger closed last year.');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { exitCode, output } = await main([
      'scan', '--input', f, '--provider', 'mock', '--fail-on', 'high', '--history-dir', tmpDir,
    ]);

    expect(exitCode).toBe(1); // fail closed — the verifier was down, the result is not trustworthy
    const parsed = JSON.parse(output); // stdout stays machine-parseable for the citation-gate recipe
    expect(parsed.degraded).toBe(true);
    expect(output).not.toContain('gate FAILED'); // diagnostic must NOT leak into JSON stdout
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('gate FAILED'))).toBe(true);
  });

  it('single-file: a degraded scan with NO --fail-on gate is unaffected (exit 0)', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim.mockImplementation(degradedVerify);
    const f = join(tmpDir, 'draft.txt');
    writeFileSync(f, 'Some claim here. Another claim here.');

    const { exitCode, output } = await main([
      'scan', '--input', f, '--provider', 'mock', '--history-dir', tmpDir,
    ]);

    expect(exitCode).toBe(0); // user did not request a gate — no exit-code change
    expect(JSON.parse(output).degraded).toBe(true); // degradation is still surfaced in the output
  });

  it('single-file: a healthy scan below threshold still PASSES the gate (exit 0)', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim.mockImplementation(healthyVerify); // real verdicts, no apiError
    const f = join(tmpDir, 'draft.txt');
    writeFileSync(f, 'Water boils at 100 degrees. The sky is blue.');

    const { exitCode, output } = await main([
      'scan', '--input', f, '--provider', 'mock', '--fail-on', 'high', '--history-dir', tmpDir,
    ]);

    expect(exitCode).toBe(0); // regression guard: the fix must not break healthy gates
    expect(JSON.parse(output).degraded).toBe(false);
  });

  it('batch: --fail-on high fails CLOSED (exit 1) when any file in the batch is degraded', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim.mockImplementation(degradedVerify);
    writeFileSync(join(tmpDir, 'a.txt'), 'Claim one is here. Claim two is here.');

    const { exitCode, output } = await main([
      'scan', '--dir', tmpDir, '--glob', '*.txt', '--provider', 'mock', '--fail-on', 'high',
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.results.some((r: { result: { degraded?: boolean } }) => r.result.degraded === true)).toBe(true);
  });
});
