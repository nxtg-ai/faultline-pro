import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  evaluateGuard,
  formatGuardReport,
  formatGuardJson,
  readStdin,
  isFailOn,
  FAIL_ON_VALUES,
  type FailOn,
} from '../cli/guard';
import type { ScanResult } from '../cli/scan';
import type { VerificationResult } from '../types';

function verification(over: Partial<VerificationResult> & { claimId: string }): VerificationResult {
  return { status: 'supported', explanation: 'ok', sources: [], ...over };
}

/** A scan result with one claim per supplied verification. */
function scanResult(
  verifications: Record<string, VerificationResult>,
  over: Partial<ScanResult> = {},
): ScanResult {
  const ids = Object.keys(verifications);
  return {
    input: 'text',
    provider: 'Mock Provider',
    claims: ids.map((id, i) => ({
      id,
      text: `Claim ${id}`,
      type: 'fact' as const,
      importance: 5 - i,
    })),
    verifications,
    overallRisk: 'medium',
    complianceReport: {} as ScanResult['complianceReport'],
    ruleFindings: [],
    verificationErrors: 0,
    degraded: false,
    ...over,
  };
}

describe('isFailOn', () => {
  it('accepts the documented values', () => {
    for (const v of FAIL_ON_VALUES) expect(isFailOn(v)).toBe(true);
  });

  it('rejects severity words borrowed from `scan --fail-on`', () => {
    // `scan --fail-on` takes critical|high|medium|low. Silently accepting those
    // here would build a gate that never trips.
    for (const v of ['critical', 'high', 'medium', 'low', '', 'REFUTED']) {
      expect(isFailOn(v)).toBe(false);
    }
  });
});

describe('evaluateGuard — advisory by default', () => {
  it('exits 0 with no --fail-on even when a claim is refuted', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'contradicted' }) }),
    );
    expect(report.exitCode).toBe(0);
    expect(report.tripped).toHaveLength(0);
  });

  it('exits 0 with no --fail-on even when the scan is degraded', () => {
    const report = evaluateGuard(
      scanResult(
        { c1: verification({ claimId: 'c1', status: 'unverified', apiError: true }) },
        { degraded: true, verificationErrors: 1 },
      ),
    );
    expect(report.exitCode).toBe(0);
    expect(report.degraded).toBe(true);
  });
});

describe('evaluateGuard — --fail-on refuted', () => {
  it('exits non-zero on a refuted claim', () => {
    const report = evaluateGuard(
      scanResult({
        c1: verification({ claimId: 'c1', status: 'supported' }),
        c2: verification({ claimId: 'c2', status: 'contradicted' }),
      }),
      'refuted',
    );
    expect(report.exitCode).toBe(1);
    expect(report.failureReason).toBe('verdict');
    expect(report.tripped.map((t) => t.verdict)).toEqual(['REFUTED']);
  });

  it('exits 0 on clean text', () => {
    const report = evaluateGuard(
      scanResult({
        c1: verification({ claimId: 'c1', status: 'supported' }),
        c2: verification({ claimId: 'c2', status: 'supported' }),
      }),
      'refuted',
    );
    expect(report.exitCode).toBe(0);
  });

  it('does not trip on merely unsupported claims', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'unverified' }) }),
      'refuted',
    );
    expect(report.exitCode).toBe(0);
  });
});

describe('evaluateGuard — --fail-on unsupported is the stricter superset', () => {
  it('trips on unsupported', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'unverified' }) }),
      'unsupported',
    );
    expect(report.exitCode).toBe(1);
  });

  it('also trips on refuted', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'contradicted' }) }),
      'unsupported',
    );
    expect(report.exitCode).toBe(1);
  });

  it('also trips on mixed, where part of the evidence contradicts', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'mixed' }) }),
      'unsupported',
    );
    expect(report.exitCode).toBe(1);
  });

  it('does not trip on a skipped opinion', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'skipped' }) }),
      'unsupported',
    );
    expect(report.exitCode).toBe(0);
  });
});

describe('evaluateGuard — degraded fails the gate CLOSED', () => {
  // Mirrors degradedGateFailure() in cli/index.ts. A gate that returns 0 when
  // claims went unchecked passes possibly-fabricated text off as clean.
  it('fails on a provider error even though no claim was refuted', () => {
    const report = evaluateGuard(
      scanResult(
        {
          c1: verification({ claimId: 'c1', status: 'supported' }),
          c2: verification({ claimId: 'c2', status: 'unverified', apiError: true }),
        },
        { degraded: true, verificationErrors: 1 },
      ),
      'refuted',
    );
    expect(report.exitCode).toBe(1);
    expect(report.failureReason).toBe('degraded');
  });

  it('reports degradation ahead of verdicts when both are present', () => {
    const report = evaluateGuard(
      scanResult(
        {
          c1: verification({ claimId: 'c1', status: 'contradicted' }),
          c2: verification({ claimId: 'c2', status: 'unverified', apiError: true }),
        },
        { degraded: true, verificationErrors: 1 },
      ),
      'refuted',
    );
    expect(report.failureReason).toBe('degraded');
  });

  it('detects degradation from apiError even if the engine flag is unset', () => {
    const report = evaluateGuard(
      scanResult(
        { c1: verification({ claimId: 'c1', status: 'unverified', apiError: true }) },
        { degraded: false },
      ),
      'refuted',
    );
    expect(report.degraded).toBe(true);
    expect(report.exitCode).toBe(1);
  });

  it('does not treat a skipped opinion as degradation', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'skipped' }) }),
      'refuted',
    );
    expect(report.degraded).toBe(false);
    expect(report.exitCode).toBe(0);
  });
});

describe('formatGuardReport', () => {
  const refuted = scanResult({ c1: verification({ claimId: 'c1', status: 'contradicted' }) });

  it('says it is advisory when no gate is set', () => {
    const out = formatGuardReport(evaluateGuard(refuted), undefined);
    expect(out).toMatch(/Advisory mode/);
    expect(out).toMatch(/REFUTED/);
  });

  it('explains a verdict failure', () => {
    const out = formatGuardReport(evaluateGuard(refuted, 'refuted'), 'refuted');
    expect(out).toMatch(/Gate FAILED/);
    expect(out).toMatch(/1 REFUTED/);
  });

  it('explains a degraded failure as untrustworthy rather than as a bad claim', () => {
    const report = evaluateGuard(
      scanResult(
        { c1: verification({ claimId: 'c1', status: 'unverified', apiError: true }) },
        { degraded: true },
      ),
      'refuted',
    );
    const out = formatGuardReport(report, 'refuted');
    expect(out).toMatch(/degraded/i);
    expect(out).toMatch(/fails closed/i);
    expect(out).toMatch(/NOT CHECKED/);
  });

  it('reports honestly when no claims were found', () => {
    const out = formatGuardReport(evaluateGuard(scanResult({})), undefined);
    expect(out).toMatch(/No verifiable factual claims/);
  });
});

describe('formatGuardJson', () => {
  it('emits parseable JSON carrying the gate outcome', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'contradicted' }) }),
      'refuted',
    );
    const parsed = JSON.parse(formatGuardJson(report, 'refuted'));
    expect(parsed.gate_passed).toBe(false);
    expect(parsed.fail_on).toBe('refuted');
    expect(parsed.claims[0].verdict).toBe('REFUTED');
    expect(parsed.claims[0].real_verdict).toBe(true);
  });

  it('marks UNCHECKED as not a real verdict', () => {
    const report = evaluateGuard(
      scanResult({ c1: verification({ claimId: 'c1', status: 'unverified', apiError: true }) }),
    );
    const parsed = JSON.parse(formatGuardJson(report, undefined));
    expect(parsed.claims[0].verdict).toBe('UNCHECKED');
    expect(parsed.claims[0].real_verdict).toBe(false);
    expect(parsed.claims[0].unchecked_reason).toBe('provider_error');
    expect(parsed.fail_on).toBeNull();
  });
});

describe('readStdin', () => {
  it('reads piped input', async () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream;
    const promise = readStdin(stream);
    stream.write('piped text');
    stream.end();
    expect(await promise).toBe('piped text');
  });

  it('returns empty immediately on a TTY rather than hanging for input', async () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream;
    (stream as { isTTY?: boolean }).isTTY = true;
    expect(await readStdin(stream)).toBe('');
  });
});
