/**
 * Claims about the document itself never reach verification (lib/claim-scope.ts).
 *
 * Runs the real scan pipeline on the mock provider. The mock's verifier is wrapped
 * so that it would answer 'contradicted' for the two document-relative claims:
 * if either one were ever sent to verification, the scan's risk would go to high.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scan, extractForFullScan } from '../cli/scan.js';
import { createMockProvider } from '../providers/mock_provider.js';
import { renderReport, renderReportAs, DOCUMENT_SCOPE_HEADING } from '../cli/report.js';
import type { Claim, VerificationResult } from '../types.js';

const DOC_FOCUS = 'The focus of the analysis is on roughly 7B-class models.';
const DOC_EXCLUDES = 'The analysis does not focus on 70B+ models with small active parameter counts.';
const WORLD_1 = 'Mistral 7B was released in September 2023.';
const WORLD_2 = 'Llama 2 was released by Meta in July 2023.';

const DOCUMENT = [DOC_FOCUS, DOC_EXCLUDES, WORLD_1, WORLD_2].join(' ');

/** The mock extractor drops the trailing period; compare on the bare sentence. */
const bare = (s: string): string => s.replace(/\.$/, '');
const DOC_TEXTS = new Set([bare(DOC_FOCUS), bare(DOC_EXCLUDES)]);

// The mock provider's verifyClaim lives on its class prototype; every instance
// the registry creates shares it.
const mockPrototype = Object.getPrototypeOf(createMockProvider('')) as {
  verifyClaim: (claim: Claim) => Promise<VerificationResult>;
};

beforeEach(() => {
  vi.spyOn(mockPrototype, 'verifyClaim').mockImplementation(async (claim: Claim) => ({
    claimId: claim.id,
    status: DOC_TEXTS.has(claim.text) ? 'contradicted' : 'supported',
    explanation: 'Mock verification.',
    sources: [],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scan: claims about the document itself', () => {
  it('extracts all four claims, verifies only the world facts, and keeps risk low', async () => {
    const result = await scan(DOCUMENT, 'mock');

    expect(result.claims.length).toBe(4);
    const docClaims = result.claims.filter((c) => DOC_TEXTS.has(c.text));
    const worldClaims = result.claims.filter((c) => !DOC_TEXTS.has(c.text));
    expect(docClaims).toHaveLength(2);
    expect(worldClaims).toHaveLength(2);

    for (const c of docClaims) {
      expect(result.verifications[c.id], `document claim ${c.id} must not be verified`).toBeUndefined();
      expect(c.scope, `document claim ${c.id} must carry scope 'document'`).toBe('document');
    }
    for (const c of worldClaims) {
      expect(result.verifications[c.id]?.status, `world claim ${c.id} is verified`).toBe('supported');
      expect(c.scope).toBeUndefined();
    }

    const contradicted = Object.values(result.verifications).filter((v) => v.status === 'contradicted');
    expect(contradicted).toHaveLength(0);
    expect(result.overallRisk).toBe('low');
    expect(result.verification.eligibleClaims).toBe(2);
    expect(mockPrototype.verifyClaim).toHaveBeenCalledTimes(2);
  });

  it('lists the document claims under one heading in text and markdown reports', async () => {
    const result = await scan(DOCUMENT, 'mock');
    const text = renderReport(result);
    const markdown = renderReportAs(result, 'markdown');
    for (const out of [text, markdown]) {
      expect(out.split(DOCUMENT_SCOPE_HEADING)).toHaveLength(2);
      expect(out).toContain(bare(DOC_FOCUS));
      expect(out).toContain(bare(DOC_EXCLUDES));
    }
    expect(text).toContain('Overall Risk: LOW');
  });

  it('a full scan does not verify them either', async () => {
    const result = await scan(DOCUMENT, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' });
    const docIds = result.claims.filter((c) => DOC_TEXTS.has(c.text)).map((c) => c.id);
    expect(docIds).toHaveLength(2);
    for (const id of docIds) expect(result.verifications[id]).toBeUndefined();
    expect(result.overallRisk).toBe('low');
  });
});

describe('deep-scan estimate: claims about the document itself', () => {
  it('counts 2 fact claims, not 4, and prices only those', async () => {
    const estimate = await extractForFullScan(DOCUMENT, 'mock');
    expect(estimate.claims.length).toBe(4);
    expect(estimate.factClaims).toBe(2);
    expect(estimate.notCheckable).toBe(2);
    expect(estimate.units).toBe(1);
  });
});
