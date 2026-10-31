/**
 * A definite verdict needs a source the reader can open: a uri that parses as
 * an absolute http or https URL. abstainWithoutSource drops every other source
 * and downgrades the verdict to unverified (noSourceAbstain) when none remain.
 * It runs before billing: isBillableVerdict counts sources by length, so it
 * must see the cleaned list. Checked on the helper, on the verify runner's
 * returned result and its onClaimVerified callback (the stream path), on the
 * grounded Gemini provider (the only one with an engine retriever, so the one
 * whose verdicts bill), and on the scan-level read guard.
 */
// Validates: no definite verdict without an openable source
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ uris: [] as Array<string | undefined> }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({
        text: JSON.stringify({ status: 'supported', explanation: 'Checked.' }),
        modelVersion: 'gemini-test',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        candidates: [{ groundingMetadata: { groundingChunks: sdk.uris.map((uri, i) => ({ web: { title: `S${i}`, uri } })) } }],
      }),
    };
  },
}));

import { runVerification } from '../cli/verify-runner.js';
import { getProvider } from '../providers/registry.js';
import {
  NO_SOURCE_EXPLANATION,
  abstainScanWithoutSource,
  abstainWithoutSource,
  billableVerdictCount,
  isBillableVerdict,
  isOpenableSource,
} from '../lib/verdict-guard.js';
import type { LLMProvider } from '../providers/base_provider.js';
import type { Claim, VerificationResult } from '../types.js';

const DEFINITE = ['supported', 'contradicted', 'mixed'] as const;
const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 };
const VALID = { title: 'Valid', uri: 'https://valid.example/a' };

/** Each source that cannot be opened, by name. */
const UNOPENABLE: Record<string, Record<string, unknown>> = {
  'an empty uri': { title: 'x', uri: '' },
  'a blank uri': { title: 'x', uri: '   ' },
  'a javascript: uri': { title: 'x', uri: 'javascript:alert(1)' },
  'an ftp: uri': { title: 'x', uri: 'ftp://x' },
  'a relative uri': { title: 'x', uri: '/relative' },
  'a missing uri': { title: 'x' },
};

function expectAbstained(v: VerificationResult | undefined): void {
  expect(v).toBeDefined();
  expect(v!.status).toBe('unverified');
  expect(v!.noSourceAbstain).toBe(true);
  expect(v!.explanation).toBe(NO_SOURCE_EXPLANATION);
  expect(v!.sources).toEqual([]);
  expect(isBillableVerdict(v)).toBe(false);
}

const verdict = (status: string, sources: unknown[]): VerificationResult =>
  ({ claimId: 'c1', status, explanation: 'model text', sources } as unknown as VerificationResult);

describe('isOpenableSource', () => {
  for (const [name, source] of Object.entries(UNOPENABLE)) {
    it(`${name} cannot be opened`, () => expect(isOpenableSource(source)).toBe(false));
  }
  it('an absolute http or https URL can be opened', () => {
    expect(isOpenableSource({ uri: 'https://a.example/x' })).toBe(true);
    expect(isOpenableSource({ uri: 'http://a.example' })).toBe(true);
  });
  it('a non-object source cannot be opened', () => {
    expect(isOpenableSource(null)).toBe(false);
    expect(isOpenableSource('https://a.example')).toBe(false);
    expect(isOpenableSource({ uri: 42 })).toBe(false);
  });
});

describe('abstainWithoutSource drops sources that cannot be opened', () => {
  for (const status of DEFINITE) {
    for (const [name, source] of Object.entries(UNOPENABLE)) {
      it(`${status} with only ${name} becomes unverified`, () => {
        expectAbstained(abstainWithoutSource(verdict(status, [source])));
      });

      it(`${status} with ${name} and one valid https source stays ${status} with only the valid source`, () => {
        const out = abstainWithoutSource(verdict(status, [source, VALID]));
        expect(out.status).toBe(status);
        expect(out.explanation).toBe('model text');
        expect(out.sources).toEqual([VALID]);
        expect(out.noSourceAbstain).toBeUndefined();
      });
    }

    it(`${status} with every kind of unopenable source at once becomes unverified`, () => {
      expectAbstained(abstainWithoutSource(verdict(status, Object.values(UNOPENABLE))));
    });
  }

  it('the input is never modified', () => {
    const given = verdict('supported', [UNOPENABLE['a javascript: uri'], VALID]);
    const copy = structuredClone(given);
    abstainWithoutSource(given);
    expect(given).toEqual(copy);
  });

  it('unverified keeps its sources as given', () => {
    const given = verdict('unverified', [UNOPENABLE['an empty uri']]);
    expect(abstainWithoutSource(given)).toBe(given);
  });
});

describe('the verify runner: returned result and onClaimVerified callback', () => {
  /** A plugin provider returning `sources` with `status`. */
  const providerWith = (status: string, sources: unknown[]): LLMProvider => ({
    name: 'Plugin', modelId: 'p1',
    extractClaims: async () => [CLAIM],
    verifyClaim: async (c: Claim) => ({ claimId: c.id, status, explanation: 'model text', sources: structuredClone(sources) }),
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }) as unknown as LLMProvider;

  async function run(provider: LLMProvider, providerName = 'plugin') {
    const streamed: VerificationResult[] = [];
    const out = await runVerification([CLAIM], { provider, providerName, consensusRig: null }, {
      onClaimVerified: (_c, r) => { streamed.push(r); },
    });
    expect(streamed).toHaveLength(1);
    return { result: out.results[0], map: out.verifications.c1, streamed: streamed[0] };
  }

  for (const [name, source] of Object.entries(UNOPENABLE)) {
    it(`supported with only ${name}: unverified in the result and in the callback`, async () => {
      const { result, map, streamed } = await run(providerWith('supported', [source]));
      expectAbstained(result);
      expectAbstained(map);
      expectAbstained(streamed);
    });

    it(`contradicted with ${name} and a valid https source: definite with only the valid source, in both`, async () => {
      const { result, streamed } = await run(providerWith('contradicted', [source, VALID]));
      for (const r of [result, streamed]) {
        expect(r!.status).toBe('contradicted');
        expect(r!.sources).toEqual([VALID]);
        expect(r!.noSourceAbstain).toBeUndefined();
      }
    });
  }
});

describe('billing sees the cleaned list (the grounded Gemini provider, which has an engine retriever)', () => {
  beforeEach(() => { sdk.uris = []; });

  async function runGemini() {
    const provider = getProvider('k', 'gemini');
    const streamed: VerificationResult[] = [];
    const out = await runVerification([CLAIM], { provider, providerName: 'gemini', consensusRig: null }, {
      onClaimVerified: (_c, r) => { streamed.push(r); },
    });
    expect(streamed).toHaveLength(1);
    return { result: out.results[0]!, streamed: streamed[0] };
  }

  it('a raw verdict whose only source is javascript: would bill by length; the helper leaves nothing to bill', async () => {
    const raw = { ...verdict('supported', [UNOPENABLE['a javascript: uri']]), provenance: { provider: 'gemini', model: 'm', verifiedAt: 'T', retriever: 'gemini-grounding', retrievedAt: 'T' } };
    expect(isBillableVerdict(raw)).toBe(true);
    expect(isBillableVerdict(abstainWithoutSource(raw))).toBe(false);

    sdk.uris = ['javascript:alert(1)', 'ftp://x', '/relative', '   '];
    const { result, streamed } = await runGemini();
    expect(result.provenance?.retriever).toBe('gemini-grounding');
    expectAbstained(result);
    expectAbstained(streamed);
    expect(billableVerdictCount({ c1: result })).toBe(0);
  });

  it('with one valid https source alongside, the verdict bills on that source alone', async () => {
    sdk.uris = ['javascript:alert(1)', 'https://valid.example/a'];
    const { result, streamed } = await runGemini();
    for (const r of [result, streamed]) {
      expect(r.status).toBe('supported');
      expect(r.sources.map((s) => s.uri)).toEqual(['https://valid.example/a']);
      expect(isBillableVerdict(r)).toBe(true);
    }
  });
});

describe('abstainScanWithoutSource (the store read guard)', () => {
  const legacy = () => ({
    provider: 'openai',
    claims: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }],
    verifications: {
      c1: verdict('supported', []),
      c2: verdict('contradicted', [UNOPENABLE['a relative uri']]),
      c3: verdict('mixed', [UNOPENABLE['a missing uri']]),
      c4: verdict('supported', [VALID]),
    },
  });

  it('downgrades every sourceless definite verdict and keeps the sourced one', () => {
    const given = legacy();
    const out = abstainScanWithoutSource(given);
    expect(Object.keys(out.verifications)).toHaveLength(4);
    for (const id of ['c1', 'c2', 'c3'] as const) expectAbstained(out.verifications[id]);
    expect(out.verifications.c4).toBe(given.verifications.c4);
    // Not rewritten: the stored object keeps what was written.
    expect(given.verifications.c1.status).toBe('supported');
    expect(out.claims).toBe(given.claims);
  });

  it('an array of verifications is guarded the same way', () => {
    const out = abstainScanWithoutSource({ verifications: [verdict('mixed', []), verdict('supported', [VALID])] });
    expect(out.verifications).toHaveLength(2);
    expectAbstained(out.verifications[0]);
    expect(out.verifications[1].status).toBe('supported');
  });

  it('a result with nothing to change is returned as given; non-results pass through', () => {
    const clean = { verifications: { c1: verdict('supported', [VALID]) } };
    expect(abstainScanWithoutSource(clean)).toBe(clean);
    expect(abstainScanWithoutSource(undefined)).toBeUndefined();
    const noVerifications = { error: 'x' };
    expect(abstainScanWithoutSource(noVerifications)).toBe(noVerifications);
  });
});
