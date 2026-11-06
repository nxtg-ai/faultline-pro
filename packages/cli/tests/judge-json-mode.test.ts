// NEXUS: 1.18.11.7.117 (the parallel judge's reply could not be read)
//
// The parallel-mode judge (verifyClaimGrounded) calls Gemini with no search
// tool, so it can and must use JSON response mode. Without it the judge
// sometimes quoted a source inside its explanation without escaping the
// quotes: the reply below is verbatim from a local reproduction on 2026-11-06
// (1 of 40 calls) and is not valid JSON.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Claim } from '../types';

const sdk = vi.hoisted(() => ({ requests: [] as Array<Record<string, any>>, text: '' }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: Record<string, any>) => {
        sdk.requests.push(req);
        return { text: sdk.text, candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    };
  },
}));

import { verifyClaimGrounded } from '../services/geminiService';
import { readVerdictReply } from '../providers/verdict-reply';

const CLAIM: Claim = { id: 'c1', text: 'Deep neural networks now dominate image recognition benchmarks.', type: 'fact', importance: 3 };
const SOURCES = [{ title: 'ImageNet classification', uri: 'https://example.org/a', snippet: 'achieved by far the best results' }];

/** Verbatim shape of the unreadable reply: unescaped quotes inside "explanation". */
const UNESCAPED_REPLY = '{\n  "status": "supported",\n  "sourcesAddressClaim": true,\n  "explanation": "Sources say DCNNs have achieved "by far the best results" on ImageNet."\n}';

beforeEach(() => { sdk.requests.length = 0; });

describe('parallel judge uses JSON response mode', () => {
  it('the reproduced reply is not readable JSON (the cause)', () => {
    expect(readVerdictReply(UNESCAPED_REPLY)).toBeNull();
  });

  it('verifyClaimGrounded asks Gemini for application/json and sends no search tool', async () => {
    sdk.text = '{"status":"supported","sourcesAddressClaim":true,"explanation":"Sources say DCNNs achieved \\"by far the best results\\"."}';
    const result = await verifyClaimGrounded(CLAIM, SOURCES, 'k', { withExcerpts: true, sourcesRule: true });
    expect(sdk.requests).toHaveLength(1);
    const config = sdk.requests[0].config ?? {};
    expect(config.responseMimeType).toBe('application/json');
    expect(config.tools).toBeUndefined();
    // The ceiling fields are still there alongside JSON mode.
    expect(typeof config.maxOutputTokens).toBe('number');
    expect(result.status).toBe('supported');
    expect(result.explanation).toContain('by far the best results');
  });

  it('the consensus call of the same judge (no sources rule) also uses JSON mode', async () => {
    sdk.text = '{"status":"mixed","explanation":"Inconclusive."}';
    await verifyClaimGrounded(CLAIM, SOURCES, 'k');
    expect(sdk.requests[0].config?.responseMimeType).toBe('application/json');
  });
});
