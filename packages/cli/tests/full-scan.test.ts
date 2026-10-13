/**
 * Full scan, engine half (GoPMO 1.18.11.3.12).
 *
 * A full scan verifies EVERY fact claim (any importance, extraction order),
 * ignores the quick-scan cap, never sends opinions or interpretations to the
 * verifier, and accounts for units: charged = ceil(facts / 8) at the estimate,
 * served = ceil(served claims / 8), refund = charged - served.
 *
 * Validates: 1.18.11.3.12 (full scan engine, docs/design/2026-10-13-full-scan-api.md §2, §4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Claim, VerificationResult } from '../types.js';

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name: 'full-scan-test-provider',
    modelId: 'full-scan-v1',
    extractClaims: mockExtractClaims,
    verifyClaim: mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import {
  scan,
  extractForFullScan,
  verifyFullScan,
  unitsForFullScan,
  unitAccounting,
  CLAIMS_PER_UNIT,
  type FullVerificationSummary,
} from '../cli/scan.js';

/** One sentence, so the per-sentence guarantee adds no synthetic claim. */
const ONE_SENTENCE = 'Full scan fixture input text.';

const ids = (claims: Claim[]): string[] => claims.map((c) => c.id);

function fact(id: string, importance: number): Claim {
  return { id, text: `Fact ${id}.`, type: 'fact', importance };
}

function facts(n: number, importance = 3): Claim[] {
  return Array.from({ length: n }, (_, i) => fact(`f${i + 1}`, importance));
}

/**
 * 12 facts with importance cycling 1..5 (three of them importance 1, which
 * quick mode never checks) interleaved with 2 opinions and 1 interpretation.
 */
function mixedFixture(): Claim[] {
  const twelve = Array.from({ length: 12 }, (_, i) => fact(`f${i + 1}`, (i % 5) + 1));
  const opinion1: Claim = { id: 'o1', text: 'An opinion.', type: 'opinion', importance: 5 };
  const opinion2: Claim = { id: 'o2', text: 'Another opinion.', type: 'opinion', importance: 4 };
  const interp: Claim = { id: 'i1', text: 'An interpretation.', type: 'interpretation', importance: 5 };
  return [twelve[0], opinion1, ...twelve.slice(1, 6), interp, ...twelve.slice(6, 11), opinion2, twelve[11]];
}
const MIXED_FACT_IDS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
const IMPORTANCE_ONE_IDS = ['f1', 'f6', 'f11'];

function supported(claim: Claim): VerificationResult {
  return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [] };
}

function apiErrorFor(claim: Claim): VerificationResult {
  return { claimId: claim.id, status: 'unverified', explanation: '429', sources: [], apiError: true };
}

/** Verifier that returns apiError for the given ids and a verdict for the rest. */
function failIds(failing: Set<string>) {
  return async (claim: Claim): Promise<VerificationResult> =>
    failing.has(claim.id) ? apiErrorFor(claim) : supported(claim);
}

const verifiedIds = (): string[] => mockVerifyClaim.mock.calls.map(([c]) => (c as Claim).id);

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyClaim.mockImplementation(async (c: Claim) => supported(c));
});

describe('unitsForFullScan / unitAccounting (doc §4 worked examples)', () => {
  it('charges per 8 fact claims', () => {
    expect(CLAIMS_PER_UNIT).toBe(8);
    expect(unitsForFullScan(31)).toBe(4);
    expect(unitsForFullScan(8)).toBe(1);
    expect(unitsForFullScan(9)).toBe(2);
    expect(unitsForFullScan(1)).toBe(1);
    expect(unitsForFullScan(0)).toBe(0);
  });

  it('31 facts, 29 served: served 4, refund 0', () => {
    expect(unitAccounting(4, 29)).toEqual({ charged: 4, served: 4, refund: 0 });
  });

  it('31 facts, 20 served: served 3, refund 1', () => {
    expect(unitAccounting(4, 20)).toEqual({ charged: 4, served: 3, refund: 1 });
  });

  it('0 served refunds every charged unit', () => {
    expect(unitAccounting(4, 0)).toEqual({ charged: 4, served: 0, refund: 4 });
  });

  it('never refunds a negative amount', () => {
    expect(unitAccounting(1, 30)).toEqual({ charged: 1, served: 4, refund: 0 });
  });

  it('treats invalid counts as 0 rather than producing NaN', () => {
    expect(unitsForFullScan(Number.NaN)).toBe(0);
    expect(unitsForFullScan(-5)).toBe(0);
    expect(unitAccounting(Number.NaN, 8)).toEqual({ charged: 0, served: 1, refund: 0 });
    expect(unitAccounting(2, -3)).toEqual({ charged: 2, served: 0, refund: 2 });
  });
});

describe('scan(mode full)', () => {
  it('verifies all 12 facts, including importance 1, in extraction order', async () => {
    mockExtractClaims.mockResolvedValue(mixedFixture());
    const r = await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });

    expect(mockVerifyClaim).toHaveBeenCalledTimes(12);
    expect(verifiedIds()).toEqual(MIXED_FACT_IDS);
    for (const id of IMPORTANCE_ONE_IDS) expect(verifiedIds()).toContain(id);
    expect(Object.keys(r.verifications)).toHaveLength(12);
    expect(r.claims).toHaveLength(15);
  });

  it('ignores verifyCap: cap 3 still verifies all 12 facts', async () => {
    mockExtractClaims.mockResolvedValue(mixedFixture());
    await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full', verifyCap: 3 });
    expect(mockVerifyClaim).toHaveBeenCalledTimes(12);
  });

  it('never sends opinions or interpretations to verify and lists them as not checkable', async () => {
    mockExtractClaims.mockResolvedValue(mixedFixture());
    const r = await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });

    expect(verifiedIds()).not.toContain('o1');
    expect(verifiedIds()).not.toContain('o2');
    expect(verifiedIds()).not.toContain('i1');
    expect(r.verifications.o1).toBeUndefined();
    expect(r.verifications.i1).toBeUndefined();
    expect(r.verification).toEqual({
      mode: 'full',
      cap: 12,
      eligibleClaims: 12,
      verifiedClaims: 12,
      uncheckedClaims: 0,
      uncheckedClaimIds: [],
      factClaims: 12,
      notCheckableClaimIds: ['o1', 'i1', 'o2'],
      servedClaims: 12,
      unservedClaimIds: [],
    });
  });

  it('fires onClaimVerified once per fact', async () => {
    mockExtractClaims.mockResolvedValue(mixedFixture());
    const onClaim = vi.fn();
    await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, onClaim, undefined, { mode: 'full' });
    expect(onClaim).toHaveBeenCalledTimes(12);
    expect(onClaim.mock.calls.every(([, , , total]) => total === 12)).toBe(true);
  });

  it('apiError claims are unserved; 31 facts with 11 lost refunds 1 unit', async () => {
    const thirtyOne = facts(31);
    const failing = new Set(thirtyOne.slice(20).map((c) => c.id)); // f21..f31
    mockExtractClaims.mockResolvedValue(thirtyOne);
    mockVerifyClaim.mockImplementation(failIds(failing));
    const r = await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });
    const v = r.verification as FullVerificationSummary;

    expect(mockVerifyClaim).toHaveBeenCalledTimes(31);
    expect(v.factClaims).toBe(31);
    expect(v.servedClaims).toBe(20);
    expect(v.unservedClaimIds).toHaveLength(11);
    expect(v.unservedClaimIds).toEqual([...failing]);
    expect(r.verificationErrors).toBe(11);
    expect(r.degraded).toBe(true);
    expect(unitAccounting(unitsForFullScan(v.factClaims), v.servedClaims)).toEqual({ charged: 4, served: 3, refund: 1 });
  });

  it('31 facts with 2 lost to 429 refunds nothing', async () => {
    mockExtractClaims.mockResolvedValue(facts(31));
    mockVerifyClaim.mockImplementation(failIds(new Set(['f4', 'f17'])));
    const r = await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });
    const v = r.verification as FullVerificationSummary;

    expect(v.servedClaims).toBe(29);
    expect(v.unservedClaimIds).toEqual(['f4', 'f17']);
    expect(unitAccounting(unitsForFullScan(v.factClaims), v.servedClaims)).toEqual({ charged: 4, served: 4, refund: 0 });
  });

  it('counts unserved by position, so a duplicated id cannot hide a failure', async () => {
    const dupA = fact('dup', 3);
    const dupB = { ...fact('dup', 3), text: 'Second claim with the same id.' };
    mockExtractClaims.mockResolvedValue([dupA, dupB]);
    mockVerifyClaim
      .mockResolvedValueOnce(apiErrorFor(dupA))
      .mockResolvedValueOnce(supported(dupB));
    const r = await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });
    const v = r.verification as FullVerificationSummary;
    expect(v.servedClaims).toBe(1);
    expect(v.unservedClaimIds).toEqual(['dup']);
    expect(r.verificationErrors).toBe(1);
    expect(r.degraded).toBe(true);
  });

  describe('a provider that throws on every retry', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function scanWithThrowingClaim(mode: 'quick' | 'full') {
      mockExtractClaims.mockResolvedValue(facts(3));
      mockVerifyClaim.mockImplementation(async (c: Claim) => {
        if (c.id === 'f2') throw new Error('HTTP 503 model overloaded');
        return supported(c);
      });
      const pending = scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, { mode });
      await vi.advanceTimersByTimeAsync(10_000);
      return pending;
    }

    it('full mode marks the claim apiError and unserved after 3 attempts', async () => {
      const r = await scanWithThrowingClaim('full');
      const v = r.verification as FullVerificationSummary;
      expect(mockVerifyClaim.mock.calls.filter(([c]) => (c as Claim).id === 'f2')).toHaveLength(3);
      expect(r.verifications.f2.apiError).toBe(true);
      expect(r.verifications.f2.status).toBe('unverified');
      expect(v.servedClaims).toBe(2);
      expect(v.unservedClaimIds).toEqual(['f2']);
    });

    it('quick mode keeps its historical result: no apiError on the exhausted claim', async () => {
      const r = await scanWithThrowingClaim('quick');
      expect(r.verifications.f2).toEqual({
        claimId: 'f2', status: 'unverified', explanation: 'Verify failed after retries.', sources: [],
      });
      expect(r.verificationErrors).toBe(0);
    });
  });
});

describe('extractForFullScan', () => {
  it('extracts and prices without any verify call', async () => {
    mockExtractClaims.mockResolvedValue(mixedFixture());
    const est = await extractForFullScan(ONE_SENTENCE, 'mock');

    expect(mockExtractClaims).toHaveBeenCalledTimes(1);
    expect(mockVerifyClaim).toHaveBeenCalledTimes(0);
    expect(est.claims).toHaveLength(15);
    expect(est.factClaims).toBe(12);
    expect(est.notCheckable).toBe(3);
    expect(est.units).toBe(2);
  });

  it('counts a synthetic per-sentence claim as a fact', async () => {
    const text = 'The first sentence is here today. The second sentence was dropped by the model.';
    mockExtractClaims.mockResolvedValue([{ id: 'c1', text: 'The first sentence is here today.', type: 'fact', importance: 4 }]);
    const est = await extractForFullScan(text, 'mock');

    expect(ids(est.claims)).toEqual(['c1', 's2']);
    expect(est.factClaims).toBe(2);
    expect(est.units).toBe(1);
    expect(mockVerifyClaim).toHaveBeenCalledTimes(0);
  });

  it('is 0 units when nothing is a fact', async () => {
    mockExtractClaims.mockResolvedValue([{ id: 'o1', text: 'An opinion.', type: 'opinion', importance: 5 }]);
    const est = await extractForFullScan(ONE_SENTENCE, 'mock');
    expect(est.claims).toHaveLength(1);
    expect(est).toMatchObject({ factClaims: 0, notCheckable: 1, units: 0 });
  });
});

describe('verifyFullScan', () => {
  it('verifies exactly the passed facts, with no re-extraction, and calls onClaim once per fact', async () => {
    const onClaim = vi.fn();
    const r = await verifyFullScan(mixedFixture(), { providerName: 'mock', onClaim });

    expect(mockExtractClaims).toHaveBeenCalledTimes(0);
    expect(verifiedIds()).toEqual(MIXED_FACT_IDS);
    expect(onClaim).toHaveBeenCalledTimes(12);
    const seen = onClaim.mock.calls.map(([claim, verdict, index, total]) => {
      expect((verdict as VerificationResult).claimId).toBe((claim as Claim).id);
      expect(total).toBe(12);
      return index as number;
    });
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(r.notAttemptedClaimIds).toEqual([]);
    expect(r.verification.servedClaims).toBe(12);
    expect(r.verification.notCheckableClaimIds).toEqual(['o1', 'i1', 'o2']);
    expect(r.claims).toHaveLength(15);
  });

  it('runs local rules only when given the text', async () => {
    const withText = await verifyFullScan(facts(1), { providerName: 'mock', text: ONE_SENTENCE });
    const without = await verifyFullScan(facts(1), { providerName: 'mock' });
    expect(withText.input).toBe(ONE_SENTENCE);
    expect(without.input).toBe('');
    expect(without.ruleFindings).toEqual([]);
  });

  it('abort stops new claims: 12 facts, abort at the first verdict, 8 in flight finish, 4 not attempted', async () => {
    const controller = new AbortController();
    const onClaim = vi.fn(() => controller.abort());
    const r = await verifyFullScan(facts(12), { providerName: 'mock', onClaim, signal: controller.signal });

    expect(mockVerifyClaim).toHaveBeenCalledTimes(8);
    expect(onClaim).toHaveBeenCalledTimes(8);
    expect(r.notAttemptedClaimIds).toEqual(['f9', 'f10', 'f11', 'f12']);
    expect(r.verification).toMatchObject({ verifiedClaims: 8, uncheckedClaims: 4, servedClaims: 8, factClaims: 12 });
    expect(r.verification.unservedClaimIds).toEqual([]);
    expect(Object.keys(r.verifications)).toHaveLength(8);
  });

  it('an already-aborted signal starts nothing and refunds every unit', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await verifyFullScan(facts(10), { providerName: 'mock', signal: controller.signal });

    expect(mockVerifyClaim).toHaveBeenCalledTimes(0);
    expect(r.notAttemptedClaimIds).toHaveLength(10);
    expect(r.verification.servedClaims).toBe(0);
    expect(unitAccounting(unitsForFullScan(r.verification.factClaims), r.verification.servedClaims))
      .toEqual({ charged: 2, served: 0, refund: 2 });
  });
});

describe('quick mode is unchanged (regression)', () => {
  for (const options of [undefined, { mode: 'quick' as const }, { mode: 'deep' as unknown as 'quick' }]) {
    it(`options ${JSON.stringify(options)}: cap 8, importance-1 facts and opinions never verified`, async () => {
      mockExtractClaims.mockResolvedValue(mixedFixture());
      const r = await scan(ONE_SENTENCE, 'mock', undefined, undefined, undefined, undefined, undefined, options);

      expect(mockVerifyClaim).toHaveBeenCalledTimes(8);
      for (const id of IMPORTANCE_ONE_IDS) expect(verifiedIds()).not.toContain(id);
      expect(r.verification).toEqual({
        cap: 8,
        eligibleClaims: 9,
        verifiedClaims: 8,
        uncheckedClaims: 1,
        uncheckedClaimIds: ['f12'],
      });
      expect(r.verification).not.toHaveProperty('mode');
    });
  }
});
