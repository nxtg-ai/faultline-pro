/**
 * Tests for filterClaimsForVerification (N-79)
 *
 * Verifies the importance threshold is >= 2 (lowered from >= 3 in N-79),
 * that non-fact types are excluded, that sorting and the 8-claim cap work
 * correctly, and that the change does not break existing scan behaviour.
 */
import { describe, it, expect } from 'vitest';
import { filterClaimsForVerification } from '../cli/scan.js';
import type { Claim } from '../types.js';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    text: 'Some verifiable fact.',
    type: 'fact',
    importance: 3,
    ...overrides,
  };
}

// ── Threshold: importance >= 2 ────────────────────────────────────────────────

describe('filterClaimsForVerification — importance threshold', () => {
  it('includes claims with importance === 2 (new lower bound)', () => {
    const claims = [makeClaim({ id: 'c1', importance: 2 })];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('includes claims with importance === 3 (previous lower bound, still passes)', () => {
    const claims = [makeClaim({ id: 'c1', importance: 3 })];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(1);
  });

  it('includes claims with importance 4 and 5', () => {
    const claims = [
      makeClaim({ id: 'c4', importance: 4 }),
      makeClaim({ id: 'c5', importance: 5 }),
    ];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(2);
  });

  it('excludes claims with importance === 1', () => {
    const claims = [makeClaim({ id: 'c1', importance: 1 })];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(0);
  });

  it('excludes claims with importance === 0', () => {
    const claims = [makeClaim({ id: 'c1', importance: 0 })];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(0);
  });
});

// ── Type filter ────────────────────────────────────────────────────────────────

describe('filterClaimsForVerification — type filter', () => {
  it('excludes opinion-type claims regardless of importance', () => {
    const claims = [makeClaim({ id: 'c1', type: 'opinion', importance: 5 })];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(0);
  });

  it('excludes interpretation-type claims regardless of importance', () => {
    const claims = [makeClaim({ id: 'c1', type: 'interpretation', importance: 5 })];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(0);
  });

  it('passes only fact-type claims through', () => {
    const claims = [
      makeClaim({ id: 'c1', type: 'fact',           importance: 4 }),
      makeClaim({ id: 'c2', type: 'opinion',        importance: 5 }),
      makeClaim({ id: 'c3', type: 'interpretation', importance: 5 }),
    ];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });
});

// ── Sorting ───────────────────────────────────────────────────────────────────

describe('filterClaimsForVerification — importance sort', () => {
  it('returns claims sorted by importance descending', () => {
    const claims = [
      makeClaim({ id: 'c2', importance: 2 }),
      makeClaim({ id: 'c5', importance: 5 }),
      makeClaim({ id: 'c3', importance: 3 }),
    ];
    const result = filterClaimsForVerification(claims);
    expect(result.map(c => c.importance)).toEqual([5, 3, 2]);
  });
});

// ── 8-claim cap ───────────────────────────────────────────────────────────────

describe('filterClaimsForVerification — 8-claim cap', () => {
  it('returns at most 8 claims', () => {
    const claims = Array.from({ length: 12 }, (_, i) =>
      makeClaim({ id: `c${i}`, importance: 5 - (i % 4) }),
    );
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(8);
  });

  it('cap selects highest-importance claims', () => {
    const claims = [
      ...Array.from({ length: 5 }, (_, i) => makeClaim({ id: `hi${i}`, importance: 5 })),
      ...Array.from({ length: 5 }, (_, i) => makeClaim({ id: `lo${i}`, importance: 2 })),
    ];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(8);
    // All 5 importance-5 claims should be included
    const highIds = result.filter(c => c.id.startsWith('hi')).length;
    expect(highIds).toBe(5);
  });

  it('returns all claims when fewer than 8 pass filters', () => {
    const claims = [
      makeClaim({ id: 'c1', importance: 2 }),
      makeClaim({ id: 'c2', importance: 4 }),
    ];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(2);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('filterClaimsForVerification — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(filterClaimsForVerification([])).toEqual([]);
  });

  it('returns empty array when all claims are below threshold', () => {
    const claims = [
      makeClaim({ id: 'c1', importance: 0 }),
      makeClaim({ id: 'c2', importance: 1 }),
    ];
    expect(filterClaimsForVerification(claims)).toEqual([]);
  });

  it('importance=2 claim is included after guaranteeClaimPerSentence synthetic claims (importance=3)', () => {
    // Synthetic claims use importance:3. Real LLM claims can be importance:2.
    // Both should pass the new >= 2 threshold.
    const claims = [
      makeClaim({ id: 's1', importance: 3, text: 'Synthetic sentence one.' }),
      makeClaim({ id: 'c1', importance: 2, text: 'Low-importance but verifiable claim.' }),
    ];
    const result = filterClaimsForVerification(claims);
    expect(result).toHaveLength(2);
    expect(result.some(c => c.id === 'c1')).toBe(true);
  });
});
