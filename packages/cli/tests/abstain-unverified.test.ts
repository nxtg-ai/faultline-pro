/**
 * Absence of evidence is "unverified", never "contradicted" (fw al:3dc2e0b227eaedd6:
 * EP4 c4, a true court fact shown as contradicted with "No search results were
 * found"; G0 on 47b72f0 answered unverified 1 time in 661). Ruling Dx3 d8f5c369.
 *
 * Two layers: every verify prompt states the rule, and a grounded Gemini
 * verdict (supported, contradicted or mixed) with no grounding source the reader
 * can open becomes "unverified". Only the second is deterministic; the prompt's
 * effect is measured by the G0 re-run.
 */
// Validates: N-234 (verdict honesty, GoPMO 1.18.7.3.1)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { Claim } from '../types';

const sdk = vi.hoisted(() => ({ reply: {} as Record<string, unknown>, prompts: [] as string[] }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { contents: string }) => {
        sdk.prompts.push(req.contents);
        return { ...sdk.reply, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
      },
    };
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { verifyClaim, verifyClaimGrounded } from '../services/geminiService';
import { buildGroundedPrompt } from '../providers/grounded_prompt';
import { createOpenAIProvider } from '../providers/openai_provider';
import { createClaudeProvider } from '../providers/claude_provider';
import { createPerplexityProvider } from '../providers/perplexity_provider';
import { NO_SOURCE_EXPLANATION, isBillableVerdict } from '../lib/verdict-guard';

const CLAIM: Claim = { id: 'c4', text: 'The underlying pro se complaint had cited 32 cases.', type: 'fact', importance: 3 };
const NO_RESULTS = '{"status":"contradicted","explanation":"No search results were found that identify an underlying pro se complaint citing 32 cases."}';
/** sha256 (first 16 hex) of each verify prompt for CLAIM, as measured by G0 on 47b72f0 (BA 0.763). */
const FINGERPRINTS = {
  geminiGrounded: 'a02663d97aeb677f',
  geminiConsensus: 'a32aa1bab5a7acde',
  sharedConsensus: 'b122686a73d834a9',
  openai: '0fda1aedb7347549',
  claude: 'a10708b4c1450e76',
  perplexity: '904b182957b1e4ff',
};

beforeEach(() => {
  sdk.prompts = [];
  mockFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('grounded Gemini backstop', () => {
  it('contradicted with no grounding source becomes unverified (EP4 c4)', async () => {
    sdk.reply = { text: NO_RESULTS, candidates: [{ groundingMetadata: { groundingChunks: [] } }] };
    const r = await verifyClaim(CLAIM, 'k');
    expect(r.status).toBe('unverified');
    expect(r.noSourceAbstain).toBe(true);
    expect(r.apiError).toBeUndefined();
    expect(r.sources).toEqual([]);
    sdk.reply = { text: NO_RESULTS, candidates: [] };
    expect((await verifyClaim(CLAIM, 'k')).status).toBe('unverified');
  });

  it('contradicted with a grounding source stays contradicted', async () => {
    sdk.reply = {
      text: '{"status":"contradicted","explanation":"The record shows 30 cases."}',
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 'Court', uri: 'https://court.example/op' } }] } }],
    };
    const r = await verifyClaim(CLAIM, 'k');
    expect(r.status).toBe('contradicted');
    expect('noSourceAbstain' in r).toBe(false);
    expect(r.sources).toEqual([{ title: 'Court', uri: 'https://court.example/op' }]);
  });

  it('an unverified reply with no source stays unverified and is not flagged', async () => {
    sdk.reply = { text: '{"status":"unverified","explanation":"x"}', candidates: [] };
    const r = await verifyClaim(CLAIM, 'k');
    expect(r.status).toBe('unverified');
    expect(r.explanation).toBe('x');
    expect('noSourceAbstain' in r).toBe(false);
  });
});

// A definite verdict needs a source the reader can open, on every status.
describe('grounded Gemini: no definite verdict without a source', () => {
  const QUERIES = ['pro se complaint 32 cases'];
  const ENTRY = { renderedContent: '<div>chip</div>' };
  const reply = (status: string, groundingChunks: unknown[]) => ({
    text: `{"status":"${status}","explanation":"Model says ${status}."}`,
    candidates: [{ groundingMetadata: { groundingChunks, webSearchQueries: QUERIES, searchEntryPoint: ENTRY } }],
  });

  for (const status of ['supported', 'contradicted', 'mixed'] as const) {
    it(`${status} with no grounding chunks becomes unverified, flagged, with the fixed explanation`, async () => {
      sdk.reply = reply(status, []);
      const r = await verifyClaim(CLAIM, 'k');
      expect(r.status).toBe('unverified');
      expect(r.noSourceAbstain).toBe(true);
      expect(r.explanation).toBe(NO_SOURCE_EXPLANATION);
      expect(r.sources).toEqual([]);
      expect(r.apiError).toBeUndefined();
      // Provenance and the Search Suggestions fields are kept as they were.
      expect(r.provenance).toMatchObject({ provider: 'gemini', retriever: 'gemini-grounding' });
      expect(r.webSearchQueries).toEqual(QUERIES);
      expect(r.searchEntryPoint).toEqual(ENTRY);
      expect(isBillableVerdict(r)).toBe(false);
    });

    it(`${status} with grounding chunks that have no web uri becomes unverified, flagged`, async () => {
      sdk.reply = reply(status, [{ web: { title: 'No uri' } }, { web: { title: 'Empty', uri: '' } }, { retrievedContext: { uri: 'x' } }]);
      const r = await verifyClaim(CLAIM, 'k');
      expect(r.status).toBe('unverified');
      expect(r.noSourceAbstain).toBe(true);
      expect(r.explanation).toBe(NO_SOURCE_EXPLANATION);
      expect(r.sources).toEqual([]);
      expect(r.apiError).toBeUndefined();
      expect(r.webSearchQueries).toEqual(QUERIES);
    });

    it(`${status} with one web source stays ${status}`, async () => {
      sdk.reply = reply(status, [{ web: { title: 'Court', uri: 'https://court.example/op' } }]);
      const r = await verifyClaim(CLAIM, 'k');
      expect(r.status).toBe(status);
      expect(r.explanation).toBe(`Model says ${status}.`);
      expect('noSourceAbstain' in r).toBe(false);
      expect(r.sources).toEqual([{ title: 'Court', uri: 'https://court.example/op' }]);
      expect(isBillableVerdict(r)).toBe(true);
    });
  }
});

// Ruling Dx3 67cd2d8b: a prompt or verdict-logic change is measured on G0 on a
// branch before deploy. The 3565df7 prompt rule lowered BA 0.763 to 0.691 and was
// reverted to the 47b72f0 wording. These fingerprints pin that wording: a change
// fails here until its G0 run is published and the hash is updated with it.
describe('verify prompts are the G0-measured wording (47b72f0)', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });
  const reply = '{"status":"unverified","explanation":"x"}';
  const sha = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);

  it('no verify prompt carries the reverted rule, and each matches its fingerprint', async () => {
    sdk.reply = { text: reply, candidates: [] };
    await verifyClaim(CLAIM, 'k');
    await verifyClaimGrounded(CLAIM, [], 'k');
    const bodies: string[] = [];
    mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
      bodies.push(init.body);
      return String(url).includes('anthropic')
        ? ok({ content: [{ type: 'text', text: reply }], usage: {} })
        : ok({ choices: [{ message: { content: reply } }], citations: [] });
    });
    await createOpenAIProvider('k').verifyClaim(CLAIM);
    await createClaudeProvider('k').verifyClaim(CLAIM);
    await createPerplexityProvider('k').verifyClaim(CLAIM);
    const text = (b: string) => { const m = JSON.parse(b).messages[0].content; return typeof m === 'string' ? m : m[0].text; };
    const prompts = {
      geminiGrounded: sdk.prompts[0],
      geminiConsensus: sdk.prompts[1],
      sharedConsensus: buildGroundedPrompt(CLAIM, []),
      openai: text(bodies[0]),
      claude: text(bodies[1]),
      perplexity: text(bodies[2]),
    };
    for (const p of Object.values(prompts)) expect(p).not.toMatch(/UNVERIFIED RULE/);
    expect(Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, sha(v)]))).toEqual(FINGERPRINTS);
  });
});
