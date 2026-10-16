/**
 * Absence of evidence is "unverified", never "contradicted" (fw al:3dc2e0b227eaedd6:
 * EP4 c4, a true court fact shown as contradicted with "No search results were
 * found"; G0 on 47b72f0 answered unverified 1 time in 661). Ruling Dx3 d8f5c369.
 *
 * Two layers: every verify prompt states the rule, and a grounded Gemini
 * "contradicted" with no grounding source at all becomes "unverified". Only the
 * second is deterministic; the prompt's effect is measured by the G0 re-run.
 */
// Validates: N-234 (verdict honesty, GoPMO 1.18.7.3.1)
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const CLAIM: Claim = { id: 'c4', text: 'The underlying pro se complaint had cited 32 cases.', type: 'fact', importance: 3 };
const NO_RESULTS = '{"status":"contradicted","explanation":"No search results were found that identify an underlying pro se complaint citing 32 cases."}';
const RULE = /UNVERIFIED RULE: "contradicted" requires .* Absence of evidence is never "contradicted"\./;

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

  it('other statuses with no source are left as given', async () => {
    for (const status of ['supported', 'mixed', 'unverified']) {
      sdk.reply = { text: `{"status":"${status}","explanation":"x"}`, candidates: [] };
      expect((await verifyClaim(CLAIM, 'k')).status).toBe(status);
    }
  });
});

describe('every verify prompt states the unverified rule', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });
  const reply = '{"status":"unverified","explanation":"x"}';

  it('Gemini grounded verify and Gemini consensus vote', async () => {
    sdk.reply = { text: reply, candidates: [] };
    await verifyClaim(CLAIM, 'k');
    await verifyClaimGrounded(CLAIM, [], 'k');
    expect(sdk.prompts).toHaveLength(2);
    for (const p of sdk.prompts) expect(p).toMatch(RULE);
  });

  it('the shared consensus prompt', () => {
    expect(buildGroundedPrompt(CLAIM, [])).toMatch(RULE);
  });

  it('OpenAI, Claude and Perplexity verify', async () => {
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
    expect(bodies).toHaveLength(3);
    for (const b of bodies) expect(JSON.parse(b).messages[0].content[0]?.text ?? JSON.parse(b).messages[0].content).toMatch(RULE);
  });
});
