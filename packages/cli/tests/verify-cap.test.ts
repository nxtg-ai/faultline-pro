/**
 * Per-tier verify cap, engine half (GoPMO 1.18.11.3.5).
 *
 * The fixed 8-claim verification cap became a parameter. The default must give
 * exactly the output the fixed cap gave; an invalid cap must fall back to 8,
 * never 0 (no verification) and never unbounded (no cost bound). Every scan
 * reports what the cap did in `verification`.
 *
 * Validates: 1.18.11.3.5 (per-tier verify cap)
 */
import { describe, it, expect } from 'vitest';
import { filterClaimsForVerification, scan, DEFAULT_VERIFY_CAP, resolveVerifyCap } from '../cli/scan.js';
import { buildVerificationSummary, rankEligibleClaims } from '../cli/verify-cap.js';
import type { Claim } from '../types.js';

/**
 * 12 eligible facts with importance 2..5, plus 3 claims that are never eligible.
 * Ranking (importance desc, stable, so ties keep input order): e1,e2,e3 (5) · e4,e5,e6 (4) ·
 * e7,e8,e9 (3) · e12,e10,e11 (2) — e12 is placed first in the input.
 */
function twelveEligible(): Claim[] {
  const importances = [5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2];
  const eligible = importances.map((importance, i) => ({
    id: `e${i + 1}`,
    text: `Eligible fact ${i + 1}.`,
    type: 'fact' as const,
    importance,
  }));
  const ineligible: Claim[] = [
    { id: 'x1', text: 'Low importance fact.', type: 'fact', importance: 1 },
    { id: 'x2', text: 'An opinion.', type: 'opinion', importance: 5 },
    { id: 'x3', text: 'An interpretation.', type: 'interpretation', importance: 4 },
  ];
  // Interleave so ranking, not input order, decides the result.
  return [eligible[11], ineligible[0], ...eligible.slice(0, 6), ineligible[1], ...eligible.slice(6, 11), ineligible[2]];
}

const ids = (claims: Claim[]): string[] => claims.map((c) => c.id);
const TOP_EIGHT = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'];

/** The fixed-cap implementation this change replaced, kept as the reference oracle. */
function legacyFilter(claims: Claim[]): Claim[] {
  return claims
    .filter((c) => c.type === 'fact' && c.importance >= 2)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
}

describe('filterClaimsForVerification — cap parameter', () => {
  it('exports a default cap of 8', () => {
    expect(DEFAULT_VERIFY_CAP).toBe(8);
  });

  it('default cap gives exactly the fixed-cap output: 8 of 12 eligible', () => {
    const claims = twelveEligible();
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(8);
    expect(ids(result)).toEqual(TOP_EIGHT);
    expect(result).toEqual(legacyFilter(claims));
  });

  it('cap 3 gives the top 3', () => {
    const result = filterClaimsForVerification(twelveEligible(), 3);
    expect(result).toHaveLength(3);
    expect(ids(result)).toEqual(['e1', 'e2', 'e3']);
  });

  it('cap 20 with 12 eligible gives all 12 and no ineligible claim', () => {
    const result = filterClaimsForVerification(twelveEligible(), 20);
    expect(result).toHaveLength(12);
    expect(ids(result)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e12', 'e10', 'e11']);
  });

  for (const invalid of [0, -1, Number.NaN, 2.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`invalid cap ${String(invalid)} falls back to 8`, () => {
      const result = filterClaimsForVerification(twelveEligible(), invalid);
      expect(result).toHaveLength(8);
      expect(ids(result)).toEqual(TOP_EIGHT);
    });
  }
});

describe('resolveVerifyCap', () => {
  it('keeps a positive integer', () => {
    expect(resolveVerifyCap(1)).toBe(1);
    expect(resolveVerifyCap(3)).toBe(3);
    expect(resolveVerifyCap(20)).toBe(20);
  });

  it('falls back to 8 for anything that is not a finite integer >= 1', () => {
    for (const bad of [0, -1, -8, Number.NaN, 2.5, 0.5, Number.POSITIVE_INFINITY, undefined, null, '3', {}]) {
      expect(resolveVerifyCap(bad)).toBe(8);
    }
  });
});

describe('buildVerificationSummary', () => {
  it('counts eligible, verified and unchecked exactly, ids in ranking order', () => {
    const ranked = rankEligibleClaims(twelveEligible());
    const selected = ranked.slice(0, 8);
    expect(buildVerificationSummary(ranked, selected, 8)).toEqual({
      cap: 8,
      eligibleClaims: 12,
      verifiedClaims: 8,
      uncheckedClaims: 4,
      uncheckedClaimIds: ['e9', 'e12', 'e10', 'e11'],
    });
  });

  it('counts two claims that share an id separately', () => {
    const a: Claim = { id: 'dup', text: 'First.', type: 'fact', importance: 5 };
    const b: Claim = { id: 'dup', text: 'Second.', type: 'fact', importance: 3 };
    const summary = buildVerificationSummary([a, b], [a], 1);
    expect(summary.uncheckedClaims).toBe(1);
    expect(summary.uncheckedClaimIds).toEqual(['dup']);
  });
});

// The mock provider extracts one fact per sentence; importance is 3 for the
// first two sentences, 4 for the next two, 5 from the fifth on.
const TWELVE_SENTENCES = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} states a checkable fact`).join('. ') + '.';

async function scanCountingVerifies(verifyCap?: number): Promise<{ verified: string[]; result: Awaited<ReturnType<typeof scan>> }> {
  const verified: string[] = [];
  const result = await scan(
    TWELVE_SENTENCES, 'mock', undefined, undefined, undefined,
    (claim) => { verified.push(claim.id); },
    undefined,
    verifyCap === undefined ? undefined : { verifyCap },
  );
  return { verified, result };
}

describe('scan() — verify cap and verification summary (mock provider)', () => {
  it('default: verifies exactly 8 of 12 and reports the 4 unchecked by id', async () => {
    const { verified, result } = await scanCountingVerifies();
    expect(result.claims).toHaveLength(12);
    expect(verified).toHaveLength(8);
    expect(Object.keys(result.verifications)).toHaveLength(8);
    expect(result.verification).toEqual({
      cap: 8,
      eligibleClaims: 12,
      verifiedClaims: 8,
      uncheckedClaims: 4,
      // importance 5: c5..c12 verified; c3,c4 (4) then c1,c2 (3) unchecked.
      uncheckedClaimIds: ['c3', 'c4', 'c1', 'c2'],
    });
  });

  it('cap 3: verifies exactly 3 and reports 9 unchecked', async () => {
    const { verified, result } = await scanCountingVerifies(3);
    expect(verified).toHaveLength(3);
    expect(Object.keys(result.verifications).sort()).toEqual(['c5', 'c6', 'c7']);
    expect(result.verification?.cap).toBe(3);
    expect(result.verification?.verifiedClaims).toBe(3);
    expect(result.verification?.uncheckedClaims).toBe(9);
    expect(result.verification?.uncheckedClaimIds).toHaveLength(9);
  });

  it('cap 20 with 12 eligible: verifies all 12, nothing unchecked', async () => {
    const { verified, result } = await scanCountingVerifies(20);
    expect(verified).toHaveLength(12);
    expect(result.verification).toEqual({
      cap: 20, eligibleClaims: 12, verifiedClaims: 12, uncheckedClaims: 0, uncheckedClaimIds: [],
    });
  });

  for (const invalid of [0, -1, Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
    it(`invalid cap ${String(invalid)}: verifies 8 and reports cap 8`, async () => {
      const { verified, result } = await scanCountingVerifies(invalid);
      expect(verified).toHaveLength(8);
      expect(result.verification?.cap).toBe(8);
      expect(result.verification?.uncheckedClaims).toBe(4);
    });
  }
});
