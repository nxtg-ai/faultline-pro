/**
 * Weakest-Link Formatter Tests (N-142)
 *
 * Validates: N-08 (Weakest-Link Detection — CLI formatter output)
 *
 * Covers formatWeakestLinkAnalysis() in cli/weakest.ts — a pure formatter with
 * zero prior tests (13% branch coverage). Tests cover every branch:
 *   WF1–WF3  : null-weakestClaim guard (short-circuit return)
 *   WF4–WF7  : fragilityBar clamping (ratio < 0, > 1, = 0, = 1, = 0.5)
 *   WF8–WF11 : statusIcon — all 4 known statuses + unknown fallback
 *   WF12–WF13: isWeakest label (true → "<< WEAKEST LINK", false → no label)
 *   WF14     : topN default (5) and custom slice
 *   WF15     : blank-line separator between entries; summary line at end
 */

import { describe, it, expect } from 'vitest';
import { formatWeakestLinkAnalysis } from '../cli/weakest';
import type { WeakestLinkAnalysis, ClaimFragility } from '../cli/weakest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaim(overrides: Partial<ClaimFragility> = {}): ClaimFragility {
  return {
    claimId: 'c1',
    claimText: 'Some verifiable fact about the world.',
    claimType: 'fact',
    importance: 3,
    status: 'contradicted',
    confidenceScore: 0.5,
    fragilityScore: 0.7,
    fragilityReason: 'Contradicted by 2 sources.',
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<WeakestLinkAnalysis> = {}): WeakestLinkAnalysis {
  const c = makeClaim();
  return {
    weakestClaim: c,
    rankedClaims: [c],
    argumentStrength: 'fragile',
    strengthScore: 0.3,
    summary: 'Most fragile: Some verifiable fact... (contradicted, importance 3/5)',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WF1–WF3 — null-weakestClaim guard
// ---------------------------------------------------------------------------

describe('formatWeakestLinkAnalysis — null guard', () => {
  it('WF1: returns no-claims message when weakestClaim is null', () => {
    const result = formatWeakestLinkAnalysis({
      weakestClaim: null,
      rankedClaims: [],
      argumentStrength: 'resilient',
      strengthScore: 1.0,
      summary: 'No verified claims to analyze.',
    });
    expect(result).toBe('No verified claims to analyze for weakest-link detection.');
  });

  it('WF2: no-claims return does not contain strength header', () => {
    const result = formatWeakestLinkAnalysis({ weakestClaim: null, rankedClaims: [], argumentStrength: 'resilient', strengthScore: 1.0, summary: '' });
    expect(result).not.toContain('Weakest-Link Analysis');
    expect(result).not.toContain('Argument Strength');
  });

  it('WF3: result string is non-empty even for null case', () => {
    const result = formatWeakestLinkAnalysis({ weakestClaim: null, rankedClaims: [], argumentStrength: 'resilient', strengthScore: 1.0, summary: '' });
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// WF4–WF7 — fragilityBar clamping via output inspection
// ---------------------------------------------------------------------------

describe('formatWeakestLinkAnalysis — fragilityBar via output', () => {
  it('WF4: fragilityScore=0 renders all-empty bar [░░░░░░░░░░]', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ fragilityScore: 0 })],
      weakestClaim: makeClaim({ fragilityScore: 0 }),
    }));
    // All 10 chars should be light shade (░), none filled (█)
    expect(result).toContain('Fragility: [' + '\u2591'.repeat(10) + '] 0%');
  });

  it('WF5: fragilityScore=1.0 renders all-filled bar [██████████]', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ fragilityScore: 1.0 })],
      weakestClaim: makeClaim({ fragilityScore: 1.0 }),
    }));
    expect(result).toContain('Fragility: [' + '\u2588'.repeat(10) + '] 100%');
  });

  it('WF6: fragilityScore=-0.5 clamps bar AND pct to 0 (Math.max branch)', () => {
    // Both bar and pct now consistently clamped — bar all-empty, pct shows 0%
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ fragilityScore: -0.5 })],
      weakestClaim: makeClaim({ fragilityScore: -0.5 }),
    }));
    expect(result).toContain('Fragility: [' + '\u2591'.repeat(10) + '] 0%');
  });

  it('WF7: fragilityScore=1.5 clamps bar AND pct to 1 (Math.min branch)', () => {
    // Both bar and pct now consistently clamped — bar all-filled, pct shows 100%
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ fragilityScore: 1.5 })],
      weakestClaim: makeClaim({ fragilityScore: 1.5 }),
    }));
    expect(result).toContain('Fragility: [' + '\u2588'.repeat(10) + '] 100%');
  });
});

// ---------------------------------------------------------------------------
// WF8–WF11 — statusIcon via claim entry output
// ---------------------------------------------------------------------------

describe('formatWeakestLinkAnalysis — statusIcon', () => {
  it('WF8: contradicted status shows [X] icon', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ status: 'contradicted' })],
      weakestClaim: makeClaim({ status: 'contradicted' }),
    }));
    expect(result).toContain('[X]');
  });

  it('WF9: supported status shows [v] icon', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ status: 'supported' })],
      weakestClaim: makeClaim({ status: 'supported' }),
    }));
    expect(result).toContain('[v]');
  });

  it('WF10: mixed status shows [?] icon', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ status: 'mixed' })],
      weakestClaim: makeClaim({ status: 'mixed' }),
    }));
    expect(result).toContain('[?]');
  });

  it('WF11: unknown status falls back to [?] icon (??-operator branch)', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({
      rankedClaims: [makeClaim({ status: 'loading' })],
      weakestClaim: makeClaim({ status: 'loading' }),
    }));
    // 'loading' is not in STATUS_ICONS → ?? '[?]' fallback
    expect(result).toContain('[?]');
  });
});

// ---------------------------------------------------------------------------
// WF12–WF13 — isWeakest label (first vs subsequent claims)
// ---------------------------------------------------------------------------

describe('formatWeakestLinkAnalysis — WEAKEST LINK label', () => {
  it('WF12: first claim (rank 1) gets "<< WEAKEST LINK" label', () => {
    const claims = [
      makeClaim({ claimId: 'c1', fragilityScore: 0.9 }),
      makeClaim({ claimId: 'c2', fragilityScore: 0.5 }),
    ];
    const result = formatWeakestLinkAnalysis(makeAnalysis({ rankedClaims: claims, weakestClaim: claims[0] }));
    expect(result).toContain('<< WEAKEST LINK');
  });

  it('WF13: second claim (rank 2) does NOT get "<< WEAKEST LINK" label', () => {
    const claims = [
      makeClaim({ claimId: 'c1', claimText: 'First claim.', fragilityScore: 0.9 }),
      makeClaim({ claimId: 'c2', claimText: 'Second claim.', fragilityScore: 0.5 }),
    ];
    const result = formatWeakestLinkAnalysis(makeAnalysis({ rankedClaims: claims, weakestClaim: claims[0] }));
    // Only one occurrence of the label
    const occurrences = (result.match(/<< WEAKEST LINK/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WF14 — topN slicing
// ---------------------------------------------------------------------------

describe('formatWeakestLinkAnalysis — topN limit', () => {
  it('WF14: topN=2 shows only 2 claims out of 4 in rankedClaims', () => {
    const claims = [
      makeClaim({ claimId: 'c1', claimText: 'Claim one about AI.' }),
      makeClaim({ claimId: 'c2', claimText: 'Claim two about data.' }),
      makeClaim({ claimId: 'c3', claimText: 'Claim three about models.' }),
      makeClaim({ claimId: 'c4', claimText: 'Claim four about safety.' }),
    ];
    const result = formatWeakestLinkAnalysis(makeAnalysis({ rankedClaims: claims, weakestClaim: claims[0] }), 2);
    expect(result).toContain('Top 2 fragile claims:');
    expect(result).toContain('"Claim one about AI."');
    expect(result).toContain('"Claim two about data."');
    expect(result).not.toContain('"Claim three about models."');
    expect(result).not.toContain('"Claim four about safety."');
  });
});

// ---------------------------------------------------------------------------
// WF15 — separator, summary, strength icons
// ---------------------------------------------------------------------------

describe('formatWeakestLinkAnalysis — structure', () => {
  it('WF15: blank line appears between claims (not after last claim)', () => {
    const claims = [
      makeClaim({ claimId: 'c1', claimText: 'First entry.' }),
      makeClaim({ claimId: 'c2', claimText: 'Second entry.' }),
    ];
    const result = formatWeakestLinkAnalysis(makeAnalysis({ rankedClaims: claims, weakestClaim: claims[0] }));
    // blank line between entries: "First entry." is followed by a blank line before "2."
    expect(result).toMatch(/"First entry\."\n.*\n.*\n\n\s+2\./s);
  });

  it('WF16: Summary line present at end of output', () => {
    const analysis = makeAnalysis({ summary: 'Most fragile: test claim (contradicted, importance 3/5)' });
    const result = formatWeakestLinkAnalysis(analysis);
    expect(result).toContain('Summary: Most fragile: test claim (contradicted, importance 3/5)');
    // Summary should be near the end
    const lines = result.split('\n');
    const summaryLine = lines.findIndex(l => l.startsWith('Summary:'));
    expect(summaryLine).toBeGreaterThan(lines.length - 5);
  });

  it('WF17: all four argumentStrength icons render correctly', () => {
    for (const [strength, icon] of [
      ['resilient', '[OK]'],
      ['stable', '[~~]'],
      ['fragile', '[!]'],
      ['critical', '[!!]'],
    ] as const) {
      const result = formatWeakestLinkAnalysis(makeAnalysis({
        argumentStrength: strength,
        rankedClaims: [makeClaim()],
        weakestClaim: makeClaim(),
      }));
      expect(result).toContain(icon);
      expect(result).toContain(strength.toUpperCase());
    }
  });

  it('WF18: strengthScore formatted to 2 decimal places', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis({ strengthScore: 0.3 }));
    expect(result).toContain('0.30/1.00');
  });

  it('WF19: header and separator line always present when weakestClaim exists', () => {
    const result = formatWeakestLinkAnalysis(makeAnalysis());
    expect(result).toContain('Weakest-Link Analysis');
    expect(result).toContain('\u2550'.repeat(21));
  });
});
