/**
 * A verdict the engine rewrote carries none of Google's grounded fields.
 *
 * Google's Gemini API terms (Grounding with Google Search) forbid modifying a
 * Grounded Result and require its Search Suggestions to be shown with it. When
 * abstainWithoutSource replaces a grounded verdict's status and explanation,
 * the result is Faultline's, not Google's, so it must not ship beside Google's
 * Search Suggestions chip or search queries. A verdict that passes the guard is
 * Google's grounded result and keeps them unaltered.
 */
// NEXUS: GoPMO 1.18.11.7.22 grounding terms, no modify
import { describe, it, expect } from 'vitest';
import {
  GROUNDED_RESPONSE_FIELDS,
  NO_SOURCE_EXPLANATION,
  abstainScanWithoutSource,
  abstainWithoutSource,
} from '../lib/verdict-guard.js';
import type { ProviderVote, VerificationResult } from '../types.js';

const ENTRY = { renderedContent: '<div class="chip">eiffel tower</div>' };
const QUERIES = ['eiffel tower location'];
const PROVENANCE = { provider: 'gemini', model: 'gemini-test', verifiedAt: 'T', retriever: 'gemini-grounding', retrievedAt: 'T' };
const DEFINITE = ['supported', 'contradicted', 'mixed'] as const;

/** A Gemini grounded verdict as verifyClaim builds it, with every field it attaches. */
function grounded(status: VerificationResult['status'], sources: VerificationResult['sources']): VerificationResult {
  return {
    claimId: 'c1',
    status,
    explanation: 'Google grounded explanation.',
    sources,
    searchEntryPoint: ENTRY,
    webSearchQueries: QUERIES,
    provenance: PROVENANCE,
  };
}

function expectNoGroundedFields(v: object): void {
  for (const k of GROUNDED_RESPONSE_FIELDS) expect(k in v, `${k} present`).toBe(false);
}

describe('abstainWithoutSource strips Google grounded fields only when it abstains', () => {
  it('names the two fields the Gemini grounded verify attaches', () => {
    expect(GROUNDED_RESPONSE_FIELDS.length).toBeGreaterThan(0);
    expect(GROUNDED_RESPONSE_FIELDS).toContain('searchEntryPoint');
    expect(GROUNDED_RESPONSE_FIELDS).toContain('webSearchQueries');
  });

  for (const status of DEFINITE) {
    it(`(a) ${status} with no openable source: unverified, NO_SOURCE_EXPLANATION, no grounded field`, () => {
      const given = {
        ...grounded(status, [{ title: 'Relative', uri: '/not-openable' }]),
        groundingMetadata: { groundingChunks: [{ web: { uri: '/not-openable' } }] },
      } as VerificationResult;
      const out = abstainWithoutSource(given);
      expect(Object.keys(out).length).toBeGreaterThan(0);
      expect(out.claimId).toBe('c1');
      expect(out.status).toBe('unverified');
      expect(out.explanation).toBe(NO_SOURCE_EXPLANATION);
      expect(out.noSourceAbstain).toBe(true);
      expect(out.sources).toEqual([]);
      expectNoGroundedFields(out);
      expect(JSON.stringify(out)).not.toContain('chip');
      expect(JSON.stringify(out)).not.toContain('eiffel tower location');
      expect(JSON.stringify(out)).not.toContain('Google grounded explanation');
      // Faultline's own record of who was asked and when is kept.
      expect(out.provenance).toEqual(PROVENANCE);
      // The input object is not modified.
      expect(given.searchEntryPoint).toEqual(ENTRY);
    });

    it(`(b) ${status} with an openable source keeps searchEntryPoint and webSearchQueries unchanged`, () => {
      const given = grounded(status, [{ title: 'Court', uri: 'https://court.example/op' }]);
      const out = abstainWithoutSource(given);
      expect(out.sources).toHaveLength(1);
      expect(out).toBe(given);
      expect(out.status).toBe(status);
      expect(out.searchEntryPoint).toEqual(ENTRY);
      expect(out.webSearchQueries).toEqual(QUERIES);
    });

    it(`(b) ${status} with openable and unopenable sources drops the bad link but keeps the Search Suggestions`, () => {
      const given = grounded(status, [{ title: 'Court', uri: 'https://court.example/op' }, { title: 'Bad', uri: 'javascript:x' }]);
      const out = abstainWithoutSource(given);
      expect(out.sources).toEqual([{ title: 'Court', uri: 'https://court.example/op' }]);
      expect(out.status).toBe(status);
      expect(out.searchEntryPoint).toEqual(ENTRY);
      expect(out.webSearchQueries).toEqual(QUERIES);
    });
  }

  it('a grounded unverified verdict from Google itself is not rewritten and keeps its Search Suggestions', () => {
    const given = grounded('unverified', []);
    const out = abstainWithoutSource(given);
    expect(out).toBe(given);
    expect(out.searchEntryPoint).toEqual(ENTRY);
    expect(out.webSearchQueries).toEqual(QUERIES);
  });

  it('a verdict already abstained (stored before this rule) loses its grounded fields on read', () => {
    const stored: VerificationResult = {
      ...grounded('unverified', []),
      explanation: NO_SOURCE_EXPLANATION,
      noSourceAbstain: true,
    };
    const out = abstainWithoutSource(stored);
    expect(Object.keys(out).length).toBeGreaterThan(0);
    expect(out.status).toBe('unverified');
    expect(out.explanation).toBe(NO_SOURCE_EXPLANATION);
    expectNoGroundedFields(out);
    // Nothing to strip the second time: the same object comes back.
    expect(abstainWithoutSource(out)).toBe(out);
  });

  it('abstainScanWithoutSource strips an abstained verdict and leaves a passing one with its chip', () => {
    const scan = {
      verifications: {
        c1: grounded('supported', []),
        c2: { ...grounded('supported', [{ title: 'S', uri: 'https://s.example/a' }]), claimId: 'c2' },
      },
    };
    const out = abstainScanWithoutSource(scan);
    const v = out.verifications as Record<string, VerificationResult>;
    expect(Object.keys(v)).toHaveLength(2);
    expect(v.c1.status).toBe('unverified');
    expectNoGroundedFields(v.c1);
    expect(v.c2.status).toBe('supported');
    expect(v.c2.searchEntryPoint).toEqual(ENTRY);
    expect(v.c2.webSearchQueries).toEqual(QUERIES);
  });
});

describe('(c) the per-vote rule strips grounded fields from an abstained consensus vote', () => {
  /** A vote that arrives carrying Google's fields (they are not on the type, but a stored or plugin vote can hold them). */
  const vote = (status: ProviderVote['status'], sources: ProviderVote['sources']): ProviderVote =>
    ({ provider: 'gemini', status, explanation: 'Google grounded vote.', sources, searchEntryPoint: ENTRY, webSearchQueries: QUERIES }) as ProviderVote;

  it('an abstained vote has no grounded field; a passing vote keeps them', () => {
    const fused: VerificationResult = {
      claimId: 'c1',
      status: 'supported',
      explanation: 'fused',
      sources: [{ title: 'S', uri: 'https://s.example/a' }],
      consensus: { agreement: 'majority', providerCount: 2, dissenting: 0 },
      providerVotes: [vote('supported', [{ title: 'Bad', uri: 'ftp://x.example' }]), vote('supported', [{ title: 'S', uri: 'https://s.example/a' }])],
    };
    const out = abstainWithoutSource(fused);
    const votes = out.providerVotes ?? [];
    expect(votes).toHaveLength(2);
    expect(votes[0].status).toBe('unverified');
    expect(votes[0].explanation).toBe(NO_SOURCE_EXPLANATION);
    expect(votes[0].noSourceAbstain).toBe(true);
    expect(votes[0].sources).toEqual([]);
    expectNoGroundedFields(votes[0]);
    expect(votes[1].status).toBe('supported');
    expect((votes[1] as unknown as { searchEntryPoint: unknown }).searchEntryPoint).toEqual(ENTRY);
    expect((votes[1] as unknown as { webSearchQueries: unknown }).webSearchQueries).toEqual(QUERIES);
    // The fused verdict passed, so it is otherwise left as it was.
    expect(out.status).toBe('supported');
  });

  it('an already-abstained vote loses its grounded fields on read', () => {
    const stored = { ...vote('unverified', []), explanation: NO_SOURCE_EXPLANATION, noSourceAbstain: true } as ProviderVote;
    const fused: VerificationResult = { claimId: 'c1', status: 'unverified', explanation: 'x', sources: [], providerVotes: [stored] };
    const votes = abstainWithoutSource(fused).providerVotes ?? [];
    expect(votes).toHaveLength(1);
    expect(votes[0].status).toBe('unverified');
    expectNoGroundedFields(votes[0]);
  });
});
