import { describe, it, expect } from 'vitest';
import {
  toVerdict,
  toClaimVerdict,
  toRiskScore,
  isRealVerdict,
  type Verdict,
} from '../src/verdict.js';
import type { VerificationResult } from '@nxtg/faultline/types.js';

describe('toVerdict — engine ClaimStatus mapping', () => {
  it('maps supported to VERIFIED', () => {
    expect(toVerdict('supported')).toBe('VERIFIED');
  });

  it('maps contradicted to REFUTED', () => {
    expect(toVerdict('contradicted')).toBe('REFUTED');
  });

  it('keeps mixed distinct rather than rounding it to UNSUPPORTED', () => {
    expect(toVerdict('mixed')).toBe('MIXED');
  });

  it('maps a genuinely-checked unverified to UNSUPPORTED', () => {
    expect(toVerdict('unverified', false)).toBe('UNSUPPORTED');
  });

  it('maps skipped to UNCHECKED', () => {
    expect(toVerdict('skipped')).toBe('UNCHECKED');
  });

  it('maps loading to UNCHECKED rather than guessing', () => {
    expect(toVerdict('loading')).toBe('UNCHECKED');
  });
});

describe('toVerdict — apiError dominance (the false-verdict guard)', () => {
  // This is the core safety property: a provider failure must never render as
  // a verdict about the claim. packages/cli/types.ts is explicit that treating
  // an API failure as an unsupported claim is the failure mode to prevent.
  it('returns UNCHECKED for an apiError unverified, NOT UNSUPPORTED', () => {
    expect(toVerdict('unverified', true)).toBe('UNCHECKED');
    expect(toVerdict('unverified', true)).not.toBe('UNSUPPORTED');
  });

  it('returns UNCHECKED even when a stale status accompanies the error', () => {
    const statuses = ['supported', 'contradicted', 'mixed', 'skipped', 'loading'] as const;
    for (const s of statuses) {
      expect(toVerdict(s, true)).toBe('UNCHECKED');
    }
  });
});

describe('isRealVerdict', () => {
  it('treats the four checked outcomes as real', () => {
    for (const v of ['VERIFIED', 'REFUTED', 'UNSUPPORTED', 'MIXED'] as Verdict[]) {
      expect(isRealVerdict(v)).toBe(true);
    }
  });

  it('does not treat UNCHECKED as a verdict', () => {
    expect(isRealVerdict('UNCHECKED')).toBe(false);
  });
});

describe('toClaimVerdict', () => {
  const verification = (over: Partial<VerificationResult> = {}): VerificationResult => ({
    claimId: 'c1',
    status: 'supported',
    explanation: 'Confirmed by census data.',
    sources: [{ title: 'Census', uri: 'https://census.gov/x' }],
    ...over,
  });

  it('surfaces the first source as evidence_url and all of them as evidence_urls', () => {
    const result = toClaimVerdict('Population is 331m.', verification({
      sources: [
        { title: 'A', uri: 'https://a.example/1' },
        { title: 'B', uri: 'https://b.example/2' },
      ],
    }));
    expect(result.evidence_url).toBe('https://a.example/1');
    expect(result.evidence_urls).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('omits evidence_url when the verifier returned no sources', () => {
    const result = toClaimVerdict('X', verification({ sources: [] }));
    expect(result.evidence_url).toBeUndefined();
    expect(result.evidence_urls).toEqual([]);
  });

  it('labels a provider failure as provider_error, not a missing-evidence verdict', () => {
    const result = toClaimVerdict(
      'X',
      verification({ status: 'unverified', apiError: true, sources: [] }),
    );
    expect(result.verdict).toBe('UNCHECKED');
    expect(result.unchecked_reason).toBe('provider_error');
  });

  it('labels a skipped claim as not_verifiable', () => {
    const result = toClaimVerdict('I think blue is nice.', verification({ status: 'skipped' }));
    expect(result.verdict).toBe('UNCHECKED');
    expect(result.unchecked_reason).toBe('not_verifiable');
  });

  it('returns UNCHECKED when no verification record exists at all', () => {
    const result = toClaimVerdict('Orphan claim', undefined);
    expect(result.verdict).toBe('UNCHECKED');
    expect(result.unchecked_reason).toBe('not_verifiable');
    expect(result.note).toMatch(/no verification/i);
  });

  it('tolerates a malformed sources field without throwing', () => {
    const result = toClaimVerdict(
      'X',
      verification({ sources: undefined as unknown as VerificationResult['sources'] }),
    );
    expect(result.evidence_urls).toEqual([]);
  });
});

describe('toRiskScore', () => {
  it('increases monotonically with the engine risk band', () => {
    expect(toRiskScore('low')).toBeLessThan(toRiskScore('medium'));
    expect(toRiskScore('medium')).toBeLessThan(toRiskScore('high'));
    expect(toRiskScore('high')).toBeLessThan(toRiskScore('critical'));
  });

  it('falls back to a mid score on an unknown band rather than claiming safety', () => {
    expect(toRiskScore('nonsense')).toBe(50);
  });
});
