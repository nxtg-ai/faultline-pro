/**
 * billingSummary: which claims of a scan were billed, which were not, and why.
 * A claim is billed exactly when isBillableVerdict is true, so billedClaims
 * always equals billableVerdictCount for the same input. The reason for an
 * unbilled claim is the first match of: provider error (its apiErrorReason, else
 * provider_error), noSourceAbstain (no_source), a status other than supported,
 * contradicted or mixed (the status), no source (no_source), no engine
 * retriever (no_retriever).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { billableVerdictCount, billingSummary, isBillableVerdict } from '../lib/verdict-guard.js';

const SOURCE = { title: 'S', uri: 'https://example.org/s' };
const RETRIEVED = { provider: 'gemini', model: 'm', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'gemini-grounding' };

/** A verdict that bills. */
const billable = (status = 'supported') => ({ status, explanation: 'ok', sources: [SOURCE], provenance: RETRIEVED });

describe('billingSummary', () => {
  it('a billable verdict is billed and not listed', () => {
    expect(billingSummary({ c1: billable(), c2: billable('contradicted'), c3: billable('mixed') }))
      .toEqual({ billedClaims: 3, unbilledClaims: 0, unbilled: [] });
  });

  it('gives each unbilled claim its reason, in input order', () => {
    const verifications = {
      a: { ...billable(), apiError: true, apiErrorReason: 'rate_limited' },
      b: { ...billable(), apiError: true },
      c: { status: 'unverified', explanation: 'x', sources: [], provenance: RETRIEVED, noSourceAbstain: true },
      d: { status: 'unverified', explanation: 'x', sources: [SOURCE], provenance: RETRIEVED },
      e: { status: 'skipped', explanation: 'x', sources: [SOURCE], provenance: RETRIEVED },
      f: { status: 'supported', explanation: 'x', sources: [], provenance: RETRIEVED },
      g: { status: 'supported', explanation: 'x', sources: [SOURCE] },
      h: { status: 'mixed', explanation: 'x', sources: [SOURCE], provenance: { ...RETRIEVED, retriever: '' } },
      i: billable(),
    };
    expect(billingSummary(verifications)).toEqual({
      billedClaims: 1,
      unbilledClaims: 8,
      unbilled: [
        { claimId: 'a', reason: 'rate_limited' },
        { claimId: 'b', reason: 'provider_error' },
        { claimId: 'c', reason: 'no_source' },
        { claimId: 'd', reason: 'unverified' },
        { claimId: 'e', reason: 'skipped' },
        { claimId: 'f', reason: 'no_source' },
        { claimId: 'g', reason: 'no_retriever' },
        { claimId: 'h', reason: 'no_retriever' },
      ],
    });
  });

  it('a provider error wins over every other reason, and noSourceAbstain over the status', () => {
    const both = { status: 'unverified', sources: [], apiError: true, apiErrorReason: 'output_truncated', noSourceAbstain: true };
    expect(billingSummary({ x: both }).unbilled).toEqual([{ claimId: 'x', reason: 'output_truncated' }]);
    const abstained = { status: 'unverified', sources: [], noSourceAbstain: true };
    expect(billingSummary({ x: abstained }).unbilled).toEqual([{ claimId: 'x', reason: 'no_source' }]);
  });

  it('takes an array of results named by claimId, keeping their order', () => {
    const list = [
      { ...billable(), claimId: 'z' },
      { status: 'unverified', sources: [], claimId: 'y' },
      { ...billable(), apiError: true, claimId: 'x' },
    ];
    expect(billingSummary(list)).toEqual({
      billedClaims: 1,
      unbilledClaims: 2,
      unbilled: [{ claimId: 'y', reason: 'unverified' }, { claimId: 'x', reason: 'provider_error' }],
    });
  });

  it('a malformed entry is not billed and reads unverified; an array entry without claimId is named by its index', () => {
    expect(billingSummary([null, { status: 42 }, billable()])).toEqual({
      billedClaims: 1,
      unbilledClaims: 2,
      unbilled: [{ claimId: '0', reason: 'unverified' }, { claimId: '1', reason: 'unverified' }],
    });
  });

  it('nothing to read is zero and zero', () => {
    for (const empty of [undefined, null, 'x', 3, {}, []]) {
      expect(billingSummary(empty)).toEqual({ billedClaims: 0, unbilledClaims: 0, unbilled: [] });
    }
  });

  it('billedClaims equals billableVerdictCount, and billed plus unbilled is every claim (property)', () => {
    const verdict = fc.record({
      status: fc.constantFrom('supported', 'contradicted', 'mixed', 'unverified', 'skipped', 'loading'),
      sources: fc.constantFrom([], [SOURCE]),
      provenance: fc.constantFrom(undefined, RETRIEVED, { ...RETRIEVED, retriever: '' }),
      apiError: fc.constantFrom(undefined, true, false),
      apiErrorReason: fc.constantFrom(undefined, 'rate_limited'),
      noSourceAbstain: fc.constantFrom(undefined, true),
    }, { requiredKeys: ['status'] });
    fc.assert(fc.property(fc.dictionary(fc.constantFrom('c1', 'c2', 'c3', 'c4', 'c5', 'c6'), verdict), (verifications) => {
      const summary = billingSummary(verifications);
      expect(summary.billedClaims).toBe(billableVerdictCount(verifications));
      expect(summary.billedClaims + summary.unbilledClaims).toBe(Object.keys(verifications).length);
      expect(summary.unbilled.length).toBe(summary.unbilledClaims);
      for (const { claimId, reason } of summary.unbilled) {
        expect(isBillableVerdict(verifications[claimId])).toBe(false);
        expect(reason.length).toBeGreaterThan(0);
      }
    }));
  });
});
