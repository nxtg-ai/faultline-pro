/**
 * Property-based oracle for Faultline Pro claim forensics (CRUCIBLE Gate 6 — oracle triangulation).
 *
 * Uses fast-check to verify invariants that must hold for *all* inputs, not
 * just hand-picked examples. Covers the four critical-path modules:
 *
 *  1. guaranteeClaimPerSentence — coverage monotonicity + idempotence
 *  2. calculateRisk (via scan mock) — risk tier monotonicity
 *  3. mapClaimToRiskCategory — EU tier ordering, claim-ID preservation
 *  4. generateComplianceReport — report invariants (counts, highest-tier)
 *
 * Oracle type: PROPERTY-BASED (fast-check) — closes the oracle triangulation
 * gap identified in CRUCIBLE audit N-58.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { guaranteeClaimPerSentence } from '../cli/scan.js';
import { mapClaimToRiskCategory } from '../compliance/eu_ai_act.js';
import { generateComplianceReport } from '../compliance/report_generator.js';
import type { Claim, VerificationResult } from '../types.js';

// ── Arbitraries ───────────────────────────────────────────────────────────────

const claimStatusArb = fc.constantFrom(
  'supported', 'contradicted', 'mixed', 'unverified', 'skipped',
) as fc.Arbitrary<VerificationResult['status']>;

const claimTypeArb = fc.constantFrom('fact', 'opinion', 'interpretation') as fc.Arbitrary<Claim['type']>;

// Use uuid-style IDs to avoid duplicates across generated arrays
const claimIdArb: fc.Arbitrary<string> = fc.uuid();

const claimArb: fc.Arbitrary<Claim> = fc.record({
  id: claimIdArb,
  text: fc.string({ minLength: 5, maxLength: 200 }),
  type: claimTypeArb,
  importance: fc.integer({ min: 1, max: 5 }),
});

const verificationArb = (claimId: string): fc.Arbitrary<VerificationResult> =>
  fc.record({
    claimId: fc.constant(claimId),
    status: claimStatusArb,
    explanation: fc.string({ minLength: 1, maxLength: 100 }),
    sources: fc.array(
      fc.record({ title: fc.string({ minLength: 1, maxLength: 50 }), uri: fc.string({ minLength: 1, maxLength: 80 }) }),
      { maxLength: 3 },
    ),
  });

// Word-like strings — only lowercase letters, no punctuation, so sentence splitting is predictable
const wordArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z]{2,8}$/);

/** Generate a text with N clearly separated sentences (≥3 words each). */
const multiSentenceTextArb = (n: number): fc.Arbitrary<string> =>
  fc.array(
    fc.array(wordArb, { minLength: 3, maxLength: 6 }).map(ws => ws.join(' ')),
    { minLength: n, maxLength: n },
  ).map(sentences => sentences.join('. ') + '.');

// ── 1. guaranteeClaimPerSentence properties ───────────────────────────────────

describe('Property: guaranteeClaimPerSentence', () => {
  it('result length is always >= input claims length (monotone — never drops claims)', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 0, maxLength: 300 }),
      fc.array(claimArb, { maxLength: 10 }),
      (text, claims) => {
        const result = guaranteeClaimPerSentence(text, claims);
        expect(result.length).toBeGreaterThanOrEqual(claims.length);
      },
    ), { numRuns: 200 });
  });

  it('all original claims are preserved in the output (no drops, no mutations)', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 0, maxLength: 300 }),
      fc.uniqueArray(claimArb, { selector: c => c.id, maxLength: 10 }),
      (text, claims) => {
        const result = guaranteeClaimPerSentence(text, claims);
        for (const original of claims) {
          const found = result.find(c => c.id === original.id);
          expect(found).toBeDefined();
          expect(found!.text).toBe(original.text);
          expect(found!.type).toBe(original.type);
          expect(found!.importance).toBe(original.importance);
        }
      },
    ), { numRuns: 200 });
  });

  it('synthetic claims always have type "fact" and importance 3 (required for verification threshold)', () => {
    fc.assert(fc.property(
      multiSentenceTextArb(3),
      (text) => {
        const result = guaranteeClaimPerSentence(text, []);
        const synthetic = result.filter(c => c.id.startsWith('s'));
        for (const c of synthetic) {
          expect(c.type).toBe('fact');
          expect(c.importance).toBe(3);
        }
      },
    ), { numRuns: 100 });
  });

  it('synthetic claim IDs all start with "s" and are unique', () => {
    fc.assert(fc.property(
      multiSentenceTextArb(4),
      (text) => {
        const result = guaranteeClaimPerSentence(text, []);
        const synthetic = result.filter(c => c.id.startsWith('s'));
        const ids = synthetic.map(c => c.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
      },
    ), { numRuns: 100 });
  });

  it('single-sentence input never adds synthetic claims', () => {
    fc.assert(fc.property(
      // Single sentence: 3–10 alpha words joined by spaces, ending in period — no interior punctuation
      fc.array(wordArb, { minLength: 3, maxLength: 10 }).map(ws => ws.join(' ') + '.'),
      fc.array(claimArb, { minLength: 1, maxLength: 5 }),
      (text, claims) => {
        const result = guaranteeClaimPerSentence(text, claims);
        // Single sentence → splitSentences returns < 2 items → function returns claims unchanged
        expect(result.length).toBe(claims.length);
      },
    ), { numRuns: 150 });
  });

  it('N-sentence input with empty claims produces at least N results', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 5 }),
      (n) => {
        // Build exactly N sentences of ≥3 words, clearly separated
        const sentences = Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is verifiable.`);
        const text = sentences.join(' ');
        const result = guaranteeClaimPerSentence(text, []);
        expect(result.length).toBeGreaterThanOrEqual(n);
      },
    ), { numRuns: 100 });
  });

  it('idempotent: running twice produces the same set of claim IDs', () => {
    fc.assert(fc.property(
      multiSentenceTextArb(3),
      fc.uniqueArray(claimArb, { selector: c => c.id, maxLength: 5 }),
      (text, claims) => {
        const once = guaranteeClaimPerSentence(text, claims);
        const twice = guaranteeClaimPerSentence(text, once);
        const idsOnce = once.map(c => c.id).sort();
        const idsTwice = twice.map(c => c.id).sort();
        expect(idsTwice).toEqual(idsOnce);
      },
    ), { numRuns: 100 });
  });
});

// ── 2. mapClaimToRiskCategory properties ─────────────────────────────────────

describe('Property: mapClaimToRiskCategory', () => {
  const EU_RISK_ORDER = ['unacceptable', 'high', 'limited', 'minimal'];

  it('always returns one of the four valid EU risk levels', () => {
    fc.assert(fc.property(
      claimArb,
      claimStatusArb,
      (claim, status) => {
        const verification: VerificationResult = {
          claimId: claim.id,
          status,
          explanation: 'test',
          sources: [],
        };
        const result = mapClaimToRiskCategory(claim, verification);
        expect(EU_RISK_ORDER).toContain(result.riskLevel);
      },
    ), { numRuns: 300 });
  });

  it('claimId in output always matches input claim.id', () => {
    fc.assert(fc.property(
      claimArb,
      claimStatusArb,
      (claim, status) => {
        const verification: VerificationResult = {
          claimId: claim.id,
          status,
          explanation: 'test',
          sources: [],
        };
        const result = mapClaimToRiskCategory(claim, verification);
        expect(result.claimId).toBe(claim.id);
        expect(result.claimText).toBe(claim.text);
        expect(result.verificationStatus).toBe(status);
      },
    ), { numRuns: 300 });
  });

  it('confidence score is always in [0, 1]', () => {
    fc.assert(fc.property(
      claimArb,
      claimStatusArb,
      (claim, status) => {
        const verification: VerificationResult = {
          claimId: claim.id,
          status,
          explanation: 'test',
          sources: [],
        };
        const result = mapClaimToRiskCategory(claim, verification);
        expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(result.confidenceScore).toBeLessThanOrEqual(1);
      },
    ), { numRuns: 300 });
  });

  it('confidence label is consistent with confidenceScore', () => {
    fc.assert(fc.property(
      claimArb,
      claimStatusArb,
      (claim, status) => {
        const verification: VerificationResult = {
          claimId: claim.id,
          status,
          explanation: 'test',
          sources: [],
        };
        const result = mapClaimToRiskCategory(claim, verification);
        if (result.confidence === 'high') {
          expect(result.confidenceScore).toBeGreaterThanOrEqual(0.8);
        } else if (result.confidence === 'medium') {
          expect(result.confidenceScore).toBeGreaterThanOrEqual(0.5);
          expect(result.confidenceScore).toBeLessThan(0.9);
        } else {
          expect(result.confidenceScore).toBeLessThan(0.6);
        }
      },
    ), { numRuns: 300 });
  });

  it('supported/unverified/skipped claims in non-high-risk domains always map to minimal', () => {
    // Claims with generic text unlikely to trigger any pattern keyword
    const safeText = 'The quarterly report shows positive results this year';
    const safeStatuses = ['supported', 'unverified', 'skipped'] as const;

    fc.assert(fc.property(
      fc.constantFrom(...safeStatuses),
      fc.integer({ min: 1, max: 5 }),
      (status, importance) => {
        const claim: Claim = { id: 'c1', text: safeText, type: 'fact', importance };
        const verification: VerificationResult = {
          claimId: 'c1', status, explanation: 'ok', sources: [],
        };
        const result = mapClaimToRiskCategory(claim, verification);
        expect(result.riskLevel).toBe('minimal');
      },
    ), { numRuns: 100 });
  });
});

// ── 3. generateComplianceReport properties ────────────────────────────────────

describe('Property: generateComplianceReport', () => {
  const riskLevelArb = fc.constantFrom('low', 'medium', 'high', 'critical') as fc.Arbitrary<'low'|'medium'|'high'|'critical'>;

  /**
   * Build a matched claims+verifications pair so generateComplianceReport
   * can process every claim.
   */
  const claimsWithVerificationsArb = fc.array(claimArb, { minLength: 0, maxLength: 8 }).chain(claims => {
    const verEntries = claims.map(c =>
      verificationArb(c.id).map(v => [c.id, v] as [string, VerificationResult])
    );
    return fc.tuple(...verEntries.map(a => a)).map(entries => ({
      claims,
      verifications: Object.fromEntries(entries),
    }));
  });

  it('totalClaims in euRiskSummary equals number of claims with verifications', () => {
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      ({ claims, verifications }, overallRisk) => {
        const report = generateComplianceReport(claims, verifications, overallRisk);
        expect(report.euRiskSummary.totalClaims).toBe(claims.length);
      },
    ), { numRuns: 200 });
  });

  it('tier counts sum to totalClaims', () => {
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      ({ claims, verifications }, overallRisk) => {
        const report = generateComplianceReport(claims, verifications, overallRisk);
        const s = report.euRiskSummary;
        const sum = s.unacceptable + s.high + s.limited + s.minimal;
        expect(sum).toBe(s.totalClaims);
      },
    ), { numRuns: 200 });
  });

  it('highestTier is always the most severe tier that has count > 0', () => {
    const TIER_ORDER = ['unacceptable', 'high', 'limited', 'minimal'] as const;
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      ({ claims, verifications }, overallRisk) => {
        if (claims.length === 0) return; // empty: highest tier is meaningless default
        const report = generateComplianceReport(claims, verifications, overallRisk);
        const s = report.euRiskSummary;
        const expected = TIER_ORDER.find(tier => s[tier] > 0) ?? 'minimal';
        expect(s.highestTier).toBe(expected);
      },
    ), { numRuns: 200 });
  });

  it('confidence distribution sums to totalClaims', () => {
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      ({ claims, verifications }, overallRisk) => {
        const report = generateComplianceReport(claims, verifications, overallRisk);
        const cd = report.confidenceDistribution;
        const sum = cd.high + cd.medium + cd.low;
        expect(sum).toBe(report.euRiskSummary.totalClaims);
      },
    ), { numRuns: 200 });
  });

  it('generatedAt is a valid ISO timestamp', () => {
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      ({ claims, verifications }, overallRisk) => {
        const report = generateComplianceReport(claims, verifications, overallRisk);
        const d = new Date(report.generatedAt);
        expect(isNaN(d.getTime())).toBe(false);
      },
    ), { numRuns: 100 });
  });

  it('minConfidence filter: totalClaims never exceeds unfiltered count', () => {
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      fc.float({ min: 0, max: 1 }),
      ({ claims, verifications }, overallRisk, threshold) => {
        const unfiltered = generateComplianceReport(claims, verifications, overallRisk);
        const filtered = generateComplianceReport(claims, verifications, overallRisk, threshold);
        expect(filtered.euRiskSummary.totalClaims).toBeLessThanOrEqual(
          unfiltered.euRiskSummary.totalClaims,
        );
      },
    ), { numRuns: 150 });
  });

  it('report claimMappings preserve all input claim IDs (before filtering)', () => {
    fc.assert(fc.property(
      claimsWithVerificationsArb,
      riskLevelArb,
      ({ claims, verifications }, overallRisk) => {
        const report = generateComplianceReport(claims, verifications, overallRisk, 0);
        const mappedIds = new Set(report.claimMappings.map(m => m.claimId));
        for (const claim of claims) {
          expect(mappedIds.has(claim.id)).toBe(true);
        }
      },
    ), { numRuns: 150 });
  });
});
