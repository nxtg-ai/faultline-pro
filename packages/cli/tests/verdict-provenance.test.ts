// Validates: N-234 (per-verdict provenance, GoPMO 1.18.11.3 P1a; EP4 recert 02-codex-evidence.md row 2)
/**
 * Every verdict names the provider and model that produced it and when, bound
 * at the provider call, not at ingestion (Honor System point #2).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: mockGenerateContent }; },
}));

import { verifyClaim, GEMINI_MODEL } from '../services/geminiService.js';
import { scan } from '../cli/scan.js';
import { registerProvider } from '../providers/registry.js';
import { consensusVerify } from '../consensus/consensus_engine.js';
import type { Claim, VerificationResult } from '../types.js';

const CLAIM: Claim = { id: 'c1', text: 'The examiner fixture contains a factual claim.', type: 'fact', importance: 5 };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function registerFixture(name: string, verify: (c: Claim) => unknown): void {
  registerProvider(name, () => ({
    name: 'Examiner fixture',
    modelId: 'fixture-v1',
    extractClaims: async () => [CLAIM],
    verifyClaim: async (c: Claim) => verify(c) as VerificationResult,
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }) as never);
}

describe('Gemini grounded verdict', () => {
  beforeEach(() => mockGenerateContent.mockReset());

  it('names the model Google served and one time for retrieval and verdict', async () => {
    const before = Date.now();
    mockGenerateContent.mockResolvedValue({
      text: '{"status":"supported","explanation":"ok"}',
      modelVersion: 'gemini-2.5-flash-001',
      candidates: [],
    });
    const v = await verifyClaim(CLAIM, 'k');
    expect(v.provenance).toBeDefined();
    expect(v.provenance!.provider).toBe('gemini');
    expect(v.provenance!.model).toBe('gemini-2.5-flash-001');
    expect(v.provenance!.verifiedAt).toMatch(ISO);
    expect(v.provenance!.retrievedAt).toBe(v.provenance!.verifiedAt);
    expect(v.provenance!.retriever).toBe('gemini-grounding');
    expect(Date.parse(v.provenance!.verifiedAt)).toBeGreaterThanOrEqual(before);
  });

  it('falls back to the configured model when Google reports none', async () => {
    mockGenerateContent.mockResolvedValue({ text: '{"status":"mixed","explanation":"ok"}', candidates: [] });
    const v = await verifyClaim(CLAIM, 'k');
    expect(v.provenance!.model).toBe(GEMINI_MODEL);
  });
});

describe('engine binding through scan()', () => {
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'fixture-unused'; });
  afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

  it('a provider that reports nothing gets the resolved provider id, its model and the return time', async () => {
    registerFixture('prov-plain', (c) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [] }));
    const before = Date.now();
    const r = await scan(CLAIM.text, 'prov-plain');
    const p = r.verifications.c1.provenance!;
    expect(p).toEqual({ provider: 'prov-plain', model: 'fixture-v1', verifiedAt: expect.stringMatching(ISO) });
    expect(Date.parse(p.verifiedAt)).toBeGreaterThanOrEqual(before);
  });

  it('a provider cannot claim another identity, a retriever or a time: only its model is kept', async () => {
    registerFixture('prov-liar', (c) => ({
      claimId: c.id, status: 'supported', explanation: 'ok', sources: [],
      provenance: { provider: 'gemini', model: 'served-model-7', verifiedAt: '2026-01-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-01-01T00:00:00.000Z' },
    }));
    const before = Date.now();
    const r = await scan(CLAIM.text, 'prov-liar');
    const p = r.verifications.c1.provenance!;
    expect(p).toEqual({ provider: 'prov-liar', model: 'served-model-7', verifiedAt: expect.stringMatching(ISO) });
    expect(Date.parse(p.verifiedAt)).toBeGreaterThanOrEqual(before);
  });

  it('EP4 examiner probe-spoof: a provider labelling itself gemini-grounding still has its citations fetched', async () => {
    const page = '<p>The examiner fixture contains a factual claim that this page states in full.</p>';
    const fetch = vi.fn(async (url: string) => (url.endsWith('/robots.txt')
      ? new Response('', { status: 404 })
      : new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })));
    const cite = { title: 'Publisher', uri: 'https://publisher.example/claim' };
    registerFixture('prov-spoof', (c) => ({
      claimId: c.id, status: 'supported', explanation: 'ok', sources: [cite],
      provenance: { provider: 'gemini', model: 'm', verifiedAt: '2026-01-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-01-01T00:00:00.000Z' },
    }));
    const r = await scan(CLAIM.text, 'prov-spoof', undefined, undefined, undefined, undefined, undefined, { evidence: { fetch } });
    const v = r.verifications.c1;
    expect(v.provenance!.retriever).toBeUndefined();
    expect(v.sources[0].evidence!.status).toBe('ok');
    expect(fetch.mock.calls.map((c) => c[0])).toContain(cite.uri);
  });

  it('the real gemini provider id carries the gemini-grounding retriever, timed at the call site', async () => {
    mockGenerateContent.mockReset();
    // The first call extracts the claim list; the next verifies it.
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify([{ id: 'c1', text: CLAIM.text, type: 'fact', importance: 5 }]), candidates: [] });
    mockGenerateContent.mockResolvedValue({
      text: '{"status":"supported","explanation":"ok"}', modelVersion: 'gemini-2.5-flash-001', candidates: [],
    });
    const before = Date.now();
    const r = await scan(CLAIM.text, 'gemini');
    const p = r.verifications.c1.provenance!;
    expect(p.provider).toBe('gemini');
    expect(p.retriever).toBe('gemini-grounding');
    expect(p.retrievedAt).toBe(p.verifiedAt);
    expect(Date.parse(p.verifiedAt)).toBeGreaterThanOrEqual(before);
  });

  it('a verdict replaced by the allowlist guard carries no provenance', async () => {
    registerFixture('prov-bad', (c) => ({ claimId: c.id, status: 'ROYALLY_CERTIFIED', explanation: 'x', sources: [] }));
    const r = await scan(CLAIM.text, 'prov-bad');
    expect(r.verifications.c1.apiError).toBe(true);
    expect(r.verifications.c1.provenance).toBeUndefined();
  });
});

describe('consensus', () => {
  const voter = (name: string, model: string, status: string) => ({
    name,
    provider: { name, modelId: model, verifyClaimGrounded: async () => ({ claimId: 'c1', status, explanation: name, sources: [] }) } as never,
  });

  it('names every voter with its model and the time the shared retrieval returned', async () => {
    const before = Date.now();
    const v = await consensusVerify(CLAIM, { name: 'kestrel-retriever', retrieve: async () => [{ title: 's', uri: 'https://example.org' }] } as never, [
      voter('openai', 'gpt-x', 'supported'),
      voter('claude', 'claude-y', 'supported'),
    ]);
    expect(v.provenance!.provider).toBe('consensus');
    expect(v.provenance!.model).toBe('openai:gpt-x+claude:claude-y');
    expect(v.provenance!.retriever).toBe('kestrel-retriever');
    expect(v.provenance!.retrievedAt).toMatch(ISO);
    expect(Date.parse(v.provenance!.retrievedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(v.provenance!.verifiedAt)).toBeGreaterThanOrEqual(Date.parse(v.provenance!.retrievedAt!));
  });

  it('a failed retrieval leaves retrievedAt absent', async () => {
    const v = await consensusVerify(CLAIM, { name: 'down-retriever', retrieve: async () => { throw new Error('down'); } } as never, [voter('openai', 'gpt-x', 'supported')]);
    if (v.apiError) {
      expect(v.provenance).toBeUndefined();
    } else {
      expect(v.provenance!.provider).toBe('consensus');
      expect('retrievedAt' in v.provenance!).toBe(false);
      expect('retriever' in v.provenance!).toBe(false);
    }
  });
});
