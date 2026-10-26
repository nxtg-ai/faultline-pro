// Validates: typed secondary retrieval status (a failed independent search is told apart from one that found nothing, and a report says so once)
/**
 * A scan whose independent searches all fail returns evidenceCoverage
 * 'partial' with the failure counted by status, and the text and markdown
 * reports print one PARTIAL EVIDENCE line. Real scan engine, real OpenAI
 * retriever; only the OpenAI HTTP endpoint is stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { scan, buildEvidenceCoverage, type ScanResult } from '../cli/scan.js';
import { renderReport, renderReportAs, partialEvidenceLine } from '../cli/report.js';
import { registerProvider } from '../providers/registry.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import type { Claim, VerificationResult } from '../types.js';

const SENTENCES = [
  'The Eiffel Tower was completed in 1889.',
  'The Golden Gate Bridge opened in 1937.',
  'The Sydney Opera House opened in 1973.',
];
const TEXT = SENTENCES.join(' ');
const CLAIMS: Claim[] = SENTENCES.map((text, i) => ({ id: `c${i + 1}`, text, type: 'fact', importance: 5 }));

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fixture-unused';
  registerProvider('coverage-fixture', () => ({
    name: 'Coverage fixture',
    modelId: 'fixture-v1',
    extractClaims: async (): Promise<Claim[]> => CLAIMS,
    verifyClaim: async (c: Claim) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [] }),
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }) as never);
});
afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

const openaiFetch = vi.fn();
beforeEach(() => { openaiFetch.mockReset(); vi.stubGlobal('fetch', openaiFetch); });
afterEach(() => { vi.unstubAllGlobals(); });

async function scanWithFailingSearch(): Promise<ScanResult> {
  openaiFetch.mockImplementation(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' }));
  const pageFetch = vi.fn();
  const r = await scan(TEXT, 'coverage-fixture', undefined, undefined, undefined, undefined, undefined, {
    independentEvidence: { retriever: new OpenAIWebSearchRetriever('test-openai'), fetch: pageFetch as never },
  });
  expect(pageFetch).not.toHaveBeenCalled();
  return r;
}

describe('scan-level evidence coverage', () => {
  it('every independent search fails with provider_error: coverage is partial and the text report says so once', async () => {
    const r = await scanWithFailingSearch();
    const verdicts = Object.values(r.verifications);
    expect(verdicts.length).toBe(3);
    expect(openaiFetch).toHaveBeenCalledTimes(3);
    for (const v of verdicts) expect(v.independentEvidence!.status).toBe('provider_error');
    expect(r.evidenceCoverage).toEqual({ state: 'partial', checked: 3, corroborated: 0, byStatus: { provider_error: 3 } });

    const text = renderReport(r);
    expect(text.length).toBeGreaterThan(0);
    expect(count(text, 'PARTIAL EVIDENCE')).toBe(1);
    const line = text.split('\n').find((l) => l.startsWith('PARTIAL EVIDENCE'));
    expect(line).toBe('PARTIAL EVIDENCE: independent corroboration for 0 of 3 checked claims; 3 provider_error');
    // Each claim names its status instead of an empty source list.
    expect(count(text, '[independent search: provider_error]')).toBe(3);
  });

  it('the markdown report carries the same single line', async () => {
    const r = await scanWithFailingSearch();
    const md = renderReportAs(r, 'markdown');
    expect(md.length).toBeGreaterThan(0);
    expect(count(md, 'PARTIAL EVIDENCE')).toBe(1);
    expect(md).toContain('> PARTIAL EVIDENCE: independent corroboration for 0 of 3 checked claims; 3 provider_error');
    expect(count(md, '(independent search: provider_error)')).toBe(3);
  });

  it('the leg did not run: no evidenceCoverage and nothing new in the report', async () => {
    const r = await scan(TEXT, 'coverage-fixture');
    expect(Object.keys(r.verifications).length).toBe(3);
    expect(r).not.toHaveProperty('evidenceCoverage');
    const text = renderReport(r);
    expect(text).not.toContain('PARTIAL EVIDENCE');
    expect(text).not.toContain('independent search');
    expect(renderReportAs(r, 'markdown')).not.toContain('independent search');
    expect(openaiFetch).not.toHaveBeenCalled();
  });
});

describe('buildEvidenceCoverage', () => {
  const v = (id: string, ie?: VerificationResult['independentEvidence']): VerificationResult =>
    ({ claimId: id, status: 'supported', explanation: 'ok', sources: [], ...(ie ? { independentEvidence: ie } : {}) });
  const ie = (status: 'hits' | 'zero' | 'timeout', n = 0) => ({
    retriever: 'r', retrievedAt: '2026-10-26T00:00:00.000Z', status,
    sources: Array.from({ length: n }, (_, i) => ({ title: `${i}`, uri: `https://p${i}.example/` })),
  });

  it('complete when every checked claim was corroborated', () => {
    const cov = buildEvidenceCoverage({ a: v('a', ie('hits', 1)), b: v('b', ie('hits', 2)), c: v('c') })!;
    expect(cov).toBeDefined();
    expect(cov).toEqual({ state: 'complete', checked: 2, corroborated: 2, byStatus: { hits: 2 } });
  });

  it('partial with a mix, counting each status', () => {
    const cov = buildEvidenceCoverage({ a: v('a', ie('hits', 1)), b: v('b', ie('zero')), c: v('c', ie('timeout')) })!;
    expect(cov).toBeDefined();
    expect(cov).toEqual({ state: 'partial', checked: 3, corroborated: 1, byStatus: { hits: 1, zero: 1, timeout: 1 } });
    const line = partialEvidenceLine({ evidenceCoverage: cov } as ScanResult);
    expect(line).toBe('PARTIAL EVIDENCE: independent corroboration for 1 of 3 checked claims; 1 zero, 1 timeout');
  });

  it('undefined when no verdict carries independentEvidence', () => {
    expect(buildEvidenceCoverage({ a: v('a') })).toBeUndefined();
    expect(buildEvidenceCoverage({})).toBeUndefined();
  });

  it('a complete scan prints no PARTIAL EVIDENCE line', () => {
    expect(partialEvidenceLine({ evidenceCoverage: { state: 'complete', checked: 2, corroborated: 2, byStatus: { hits: 2 } } } as ScanResult)).toBeNull();
  });
});
