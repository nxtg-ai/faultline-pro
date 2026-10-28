/**
 * A full-scan claim is served (worth a unit) under the same rule as every other
 * billed claim: a supported, contradicted or mixed verdict with at least one
 * source and no API error. Anything else is refunded.
 */
import { describe, it, expect } from 'vitest';
import type { VerificationResult } from '@nxtg/faultline/types.js';
import { describeJob, ledgerRowFor, UNSERVED_REASONS, type FullScanJob } from '../src/store/full-scan-jobs.js';

const SOURCE = { title: 'S', uri: 'https://example.org/s' };

function jobWith(verdicts: Array<VerificationResult | undefined>, charged: number): FullScanJob {
  return {
    jobId: 'fsj_test', keyId: 'k', userRef: null, estimateId: 'e', idempotencyKey: 'idem-key-1',
    createdAt: 0, provider: 'gemini', tier: 'pro', factClaims: verdicts.length, charged,
    claims: [], text: '', factIds: verdicts.map((_, i) => `f${i + 1}`), verdicts,
    status: 'done', controller: new AbortController(), finishedAt: '2026-10-28T00:00:00.000Z',
  } as FullScanJob;
}

const v = (status: VerificationResult['status'], sources: typeof SOURCE[], extra: Partial<VerificationResult> = {}): VerificationResult =>
  ({ claimId: 'x', status, explanation: '', sources, ...extra });

describe('full-scan served units follow the billing rule', () => {
  it('only a sourced definite verdict is served; zero-source and unverified are refunded as no_sourced_verdict', () => {
    // 9 claims priced at 2 units: 8 sourced verdicts would keep both units.
    const verdicts = [
      ...Array.from({ length: 8 }, () => v('supported', [SOURCE])),
      v('supported', []),
    ];
    const view = describeJob(jobWith(verdicts, 2));
    expect(view.checked).toBe(8);
    expect(view.units).toEqual({ charged: 2, served: 1, refund: 1 });
    expect(view.unserved).toEqual([{ claimId: 'f9', reason: 'no_sourced_verdict' }]);
    expect(view.failed).toBe(0);
  });

  it('unverified with a source, and contradicted with none, are not served', () => {
    const view = describeJob(jobWith([v('unverified', [SOURCE]), v('contradicted', []), v('mixed', [SOURCE])], 1));
    expect(view.progress.map((p) => p.status)).toEqual(['unserved', 'unserved', 'served']);
    expect(view.checked).toBe(1);
    expect(view.units).toEqual({ charged: 1, served: 1, refund: 0 });
  });

  it('every claim unverified: the whole job is refunded', () => {
    const view = describeJob(jobWith([v('unverified', []), v('unverified', [])], 1));
    expect(view.checked).toBe(0);
    expect(view.units).toEqual({ charged: 1, served: 0, refund: 1 });
  });

  it('an API error keeps its own reason and still counts as failed', () => {
    const view = describeJob(jobWith([v('unverified', [], { apiError: true, apiErrorReason: 'timeout' }), v('supported', [SOURCE])], 1));
    expect(view.unserved).toEqual([{ claimId: 'f1', reason: 'timeout' }]);
    expect(view.failed).toBe(1);
  });

  it('the ledger row agrees with the view', () => {
    const row = ledgerRowFor(jobWith([v('supported', [SOURCE]), v('supported', [])], 1) as never);
    expect(row.servedClaims).toBe(1);
    expect(row.verdicts).toEqual({ supported: 1 });
    expect(row.reasons).toEqual({ no_sourced_verdict: 1 });
    expect(UNSERVED_REASONS).toContain('no_sourced_verdict');
  });
});
