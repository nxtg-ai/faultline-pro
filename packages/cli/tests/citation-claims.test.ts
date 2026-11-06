/**
 * Citation claims (N-237): one claim per cited work, ranked ahead of plain
 * facts under the verify cap, settled by the DOI registry when it can be,
 * billed once either way.
 *
 * Extraction is driven through parseExtractedClaims (the parse every model
 * provider shares) and through scan() with a registered fixture provider; no
 * model, search or network call is made.
 *
 * Validates: N-237 (citation claims, direct DOI check)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { parseExtractedClaims } from '../providers/extraction-error.js';
import { scan, guaranteeClaimPerSentence } from '../cli/scan.js';
import { rankEligibleClaims, isEligibleForVerification } from '../cli/verify-cap.js';
import { runVerification, type Verifier } from '../cli/verify-runner.js';
import { registerProvider, getProvider } from '../providers/registry.js';
import { doiHandleUrl, crossrefWorkUrl, DOI_RETRIEVER, type DoiCheckOptions } from '../evidence/doi.js';
import { CITATION_EXTRACTION_RULE, citationClaimText, sanitizeCitation, citationSpans } from '../lib/citation.js';
import { billableVerdictCount, isBillableVerdict } from '../lib/verdict-guard.js';
import type { Claim, Source, VerificationResult } from '../types.js';
import type { Retriever } from '../providers/base_provider.js';

const BIBLIOGRAPHY_TEXT = [
  'Neural networks now dominate image recognition benchmarks.',
  '',
  'References',
  'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436-444. https://doi.org/10.1038/nature14539',
  'Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30, 5998-6008.',
  'Roe, J., & Doe, A. (2021). Synthetic benchmarks for imaginary tasks. Journal of Invented Results, 12(3), 45-67. https://doi.org/10.4471/jca.2021.0388',
].join('\n');

const REFS = BIBLIOGRAPHY_TEXT.split('\n').slice(3);

/** What a model following CITATION_EXTRACTION_RULE returns for BIBLIOGRAPHY_TEXT. */
const MODEL_REPLY = JSON.stringify([
  { id: 'c1', text: 'Neural networks now dominate image recognition benchmarks.', type: 'fact', importance: 4 },
  { id: 'c2', text: 'LeCun et al. 2015 is cited.', type: 'fact', importance: 3,
    citation: { title: 'Deep learning', authors: 'LeCun, Y., Bengio, Y., & Hinton, G.', year: 2015, venue: 'Nature', doi: 'https://doi.org/10.1038/nature14539', raw: REFS[0] } },
  { id: 'c3', text: 'Vaswani et al. 2017 is cited.', type: 'fact', importance: 3,
    citation: { title: 'Attention is all you need', authors: ['Vaswani, A.', 'Shazeer, N.', 'Parmar, N.'], year: '2017', venue: 'Advances in Neural Information Processing Systems', raw: REFS[1] } },
  { id: 'c4', text: 'Roe and Doe 2021 is cited.', type: 'fact', importance: 1,
    citation: { title: 'Synthetic benchmarks for imaginary tasks', authors: 'Roe, J., & Doe, A.', year: '2021', venue: 'Journal of Invented Results', raw: REFS[2] } },
]);

describe('extraction: one claim per citation', () => {
  it('a bibliography of 3 references parses to 3 citation claims with canonical text and structured fields', () => {
    const claims = parseExtractedClaims(MODEL_REPLY);
    const citations = claims.filter((c) => c.citation);
    expect(citations).toHaveLength(3);
    expect(citations[0]).toMatchObject({
      type: 'fact',
      text: 'The work "Deep learning" by LeCun, Y., Bengio, Y., & Hinton, G. (2015), Nature, DOI 10.1038/nature14539 exists as cited.',
      citation: { title: 'Deep learning', year: '2015', doi: '10.1038/nature14539' },
    });
    expect(citations[1]!.citation!.authors).toBe('Vaswani, A., Shazeer, N., Parmar, N.');
    expect(citations[1]!.citation!.doi).toBeUndefined();
    // No `doi` field, but the DOI is written in the raw reference: it is picked up.
    expect(citations[2]!.citation!.doi).toBe('10.4471/jca.2021.0388');
  });

  it('the per-sentence guarantee adds no field claims for the reference fragments', () => {
    const claims = guaranteeClaimPerSentence(BIBLIOGRAPHY_TEXT, parseExtractedClaims(MODEL_REPLY));
    // 1 body fact + 3 citations, not ~18 field claims (title, year, pages, venue...).
    expect(claims).toHaveLength(4);
    expect(claims.filter((c) => c.citation)).toHaveLength(3);
  });

  it('without the citation spans, the same text grows synthetic field claims (the guarantee is what was fixed)', () => {
    const plain = parseExtractedClaims(MODEL_REPLY).map(({ citation: _c, ...rest }) => rest);
    expect(guaranteeClaimPerSentence(BIBLIOGRAPHY_TEXT, plain).length).toBeGreaterThan(4);
  });

  it('a body sentence quoting a cited title keeps its own claim when the citation has raw text', () => {
    const text = 'The study Attention is all you need changed machine translation forever. It was widely adopted.\n' + REFS[1];
    const claims = guaranteeClaimPerSentence(text, [
      { id: 'c1', text: 'It was widely adopted.', type: 'fact', importance: 3 },
      { id: 'c2', text: 'x', type: 'fact', importance: 3, citation: sanitizeCitation({ title: 'Attention is all you need', raw: REFS[1] }) },
    ]);
    expect(claims.some((c) => c.id.startsWith('s') && c.text.startsWith('The study Attention'))).toBe(true);
  });

  it('with no raw text, the reference line is found by DOI or title', () => {
    const spans = citationSpans(BIBLIOGRAPHY_TEXT, [
      { id: 'a', text: 'x', type: 'fact', importance: 3, citation: { title: 'Deep learning', doi: '10.1038/nature14539' } },
      { id: 'b', text: 'x', type: 'fact', importance: 3, citation: { title: 'Attention is all you need' } },
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toContain('lecun');
    expect(spans[1]).toContain('vaswani');
  });

  it('an inline "(Smith et al., 2021)" citation is one claim with authors and year, beside the sentence it supports', () => {
    const claims = parseExtractedClaims(JSON.stringify({ claims: [
      { id: 'c1', text: 'Retrieval augmentation cut hallucinations by 40 percent.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Smith et al., 2021', type: 'fact', importance: 2, citation: { authors: 'Smith et al.', year: '2021' } },
    ] }), true);
    expect(claims).toHaveLength(2);
    expect(claims[1]!.text).toBe('A work by Smith et al. (2021) exists as cited.');
    expect(claims[1]!.citation).toEqual({ authors: 'Smith et al.', year: '2021' });
    expect(claims[0]!.citation).toBeUndefined();
  });

  it('a citation naming neither a title nor authors and year is dropped, the claim kept as given', () => {
    const [claim] = parseExtractedClaims(JSON.stringify([
      { id: 'c1', text: 'Something was cited.', type: 'fact', importance: 3, citation: { year: '2020', evil: 'x'.repeat(10) } },
    ]));
    expect(claim).toEqual({ id: 'c1', text: 'Something was cited.', type: 'fact', importance: 3 });
  });

  it('citation fields are strings of bounded length with unknown keys and control characters removed', () => {
    const c = sanitizeCitation({ title: `A\u0000 title\n with  breaks ${'x'.repeat(900)}`, authors: 'A', year: 2020, extra: { nested: 1 } });
    expect(c).toBeDefined();
    expect(Object.keys(c!).sort()).toEqual(['authors', 'title', 'year']);
    expect(c!.title!.startsWith('A title with breaks')).toBe(true);
    expect(c!.title!.length).toBe(500);
    expect(citationClaimText({ title: 'T' })).toBe('The work "T" exists as cited.');
  });

  it('every model provider prompt carries the citation rule; Gemini declares the citation property in its schema', () => {
    const root = join(__dirname, '..');
    for (const file of ['providers/openai_provider.ts', 'providers/claude_provider.ts', 'providers/perplexity_provider.ts', 'services/geminiService.ts']) {
      expect(readFileSync(join(root, file), 'utf8')).toContain('${CITATION_EXTRACTION_RULE}');
    }
    expect(readFileSync(join(root, 'services/geminiService.ts'), 'utf8')).toContain('citation: GEMINI_CITATION_SCHEMA');
    expect(CITATION_EXTRACTION_RULE).toContain('never one claim per field');
  });
});

describe('selection: citations rank ahead of plain facts and count toward the cap', () => {
  const citation = (i: number): Claim => ({
    id: `ref${i}`, text: 'x', type: 'fact', importance: 1, citation: { title: `Cited work number ${i}`, year: '2020' },
  });
  const fact = (i: number): Claim => ({ id: `f${i}`, text: `Fact ${i}.`, type: 'fact', importance: 5 });

  it('a citation of importance 1 is still eligible', () => {
    expect(isEligibleForVerification(citation(1))).toBe(true);
    expect(isEligibleForVerification({ ...fact(1), importance: 1 })).toBe(false);
  });

  it('ranking puts every citation first, in extraction order', () => {
    const claims = [fact(1), citation(1), fact(2), citation(2)];
    expect(rankEligibleClaims(claims).map((c) => c.id)).toEqual(['ref1', 'ref2', 'f1', 'f2']);
  });

  describe('through scan(): 5 references and 10 plain facts', () => {
    const facts = Array.from({ length: 10 }, (_, i) => `Plain fact number ${i + 1} holds firmly`);
    const refs = Array.from({ length: 5 }, (_, i) => `Author${i}, A. (202${i}). Cited work number ${i}. Journal ${i}, 1-2.`);
    const text = `${facts.join('. ')}.\n\nReferences\n${refs.join('\n')}`;
    const extracted: Claim[] = [
      ...facts.map((f, i): Claim => ({ id: `f${i + 1}`, text: `${f}.`, type: 'fact', importance: 5 })),
      ...refs.map((raw, i): Claim => ({
        id: `ref${i + 1}`, text: 'x', type: 'fact', importance: 2,
        citation: sanitizeCitation({ title: `Cited work number ${i}`, authors: `Author${i}, A.`, year: `202${i}`, raw }),
      })),
    ];
    const verified: string[] = [];
    let savedKey: string | undefined;
    beforeAll(() => {
      savedKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'fixture-unused';
      registerProvider('citation-fixture', () => ({
        name: 'Citation fixture',
        modelId: 'fixture-v1',
        extractClaims: async (): Promise<Claim[]> => extracted,
        verifyClaim: async (c: Claim) => { verified.push(c.id); return { claimId: c.id, status: 'supported', explanation: 'ok', sources: [] }; },
        generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
      }) as never);
    });
    afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

    it('all 5 citation claims are among the 8 verified, and no field claims were added', async () => {
      const result = await scan(text, 'citation-fixture', undefined, undefined, undefined, undefined, undefined, { doi: false });
      expect(result.claims).toHaveLength(15);
      const ids = Object.keys(result.verifications);
      expect(ids).toHaveLength(8);
      for (let i = 1; i <= 5; i++) expect(ids).toContain(`ref${i}`);
      expect(verified).toHaveLength(8);
      expect(result.verification).toMatchObject({ cap: 8, eligibleClaims: 15, verifiedClaims: 8, uncheckedClaims: 7 });
    });
  });
});

describe('verify runner: the DOI check settles first, a fallback is verified (and billed) once', () => {
  const settledClaim: Claim = {
    id: 'cite-fake', text: 'x', type: 'fact', importance: 3,
    citation: { title: 'Synthetic benchmarks for imaginary tasks', doi: '10.4471/jca.2021.0388' },
  };
  const fallbackClaim: Claim = {
    id: 'cite-datacite', text: 'The work "A dataset" (2020), DOI 10.5061/dryad.abc123 exists as cited.', type: 'fact', importance: 3,
    citation: { title: 'A dataset', year: '2020', doi: '10.5061/dryad.abc123' },
  };
  const searchedSource: Source = { title: 'A dataset', uri: 'https://example.org/dataset' };

  function harness() {
    const doiCalls: string[] = [];
    const doi: DoiCheckOptions = {
      fetch: async (url) => {
        doiCalls.push(url);
        if (url === doiHandleUrl('10.4471/jca.2021.0388')) return new Response(JSON.stringify({ responseCode: 100 }), { status: 404 });
        if (url === doiHandleUrl('10.5061/dryad.abc123')) return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 });
        if (url === crossrefWorkUrl('10.5061/dryad.abc123')) return new Response('Resource not found.', { status: 404 });
        throw new Error(`unexpected ${url}`);
      },
    };
    const retrieve = vi.fn(async (_text: string): Promise<Source[]> => [searchedSource]);
    const retriever: Retriever = { name: 'fake-search', retrieve } as unknown as Retriever;
    const provider = getProvider('', 'mock');
    const verifyClaimGrounded = vi.spyOn(provider, 'verifyClaimGrounded' as never);
    const verifier: Verifier = { provider, providerName: 'mock', consensusRig: null, groundedRig: { retriever } };
    const evidenceFetch = vi.fn(async () => new Response('', { status: 404 }));
    return { doi, doiCalls, retrieve, verifyClaimGrounded, verifier, evidenceFetch };
  }

  it('settled claim: no search, no judge, no page fetch; fallback: one search, one judge; both billable once', async () => {
    const h = harness();
    const run = await runVerification([settledClaim, fallbackClaim], h.verifier, {
      doi: h.doi, evidence: { fetch: h.evidenceFetch as never },
    });

    const settled = run.verifications['cite-fake'] as VerificationResult;
    expect(settled.status).toBe('contradicted');
    expect(settled.provenance?.retriever).toBe(DOI_RETRIEVER);
    expect(isBillableVerdict(settled)).toBe(true);

    const fallback = run.verifications['cite-datacite'] as VerificationResult;
    expect(fallback.provenance?.retriever).toBe('fake-search');
    expect(isBillableVerdict(fallback)).toBe(true);

    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(h.retrieve).toHaveBeenCalledWith(fallbackClaim.text);
    expect(h.verifyClaimGrounded).toHaveBeenCalledTimes(1);
    expect(billableVerdictCount(run.verifications)).toBe(2);
    expect(Object.keys(run.verifications)).toHaveLength(2);

    // The DOI verdict's registry links are never fetched as evidence pages.
    const fetched = h.evidenceFetch.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) {
      expect(url).not.toContain('doi.org');
      expect(url).not.toContain('crossref.org');
    }
    // Claims run concurrently, so the order across claims is not fixed.
    expect([...h.doiCalls].sort()).toEqual([
      doiHandleUrl('10.4471/jca.2021.0388'),
      doiHandleUrl('10.5061/dryad.abc123'),
      crossrefWorkUrl('10.5061/dryad.abc123'),
    ].sort());
  });

  it('doi: false sends citation claims straight to the normal verify', async () => {
    const h = harness();
    const run = await runVerification([settledClaim], h.verifier, { doi: false });
    expect(h.doiCalls).toHaveLength(0);
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(run.verifications['cite-fake']!.provenance?.retriever).toBe('fake-search');
  });

  it('a plain fact never triggers a DOI lookup', async () => {
    const h = harness();
    await runVerification([{ id: 'f', text: 'Water boils at 100 C at sea level.', type: 'fact', importance: 3 }], h.verifier, { doi: h.doi });
    expect(h.doiCalls).toHaveLength(0);
  });
});
