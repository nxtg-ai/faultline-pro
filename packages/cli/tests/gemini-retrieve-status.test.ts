// Validates: typed secondary retrieval status (the Gemini grounding retriever tells a failed search apart from one that found nothing)
/**
 * retrieveSourcesWithStatus reports how a Gemini grounded search ended. A
 * missing key, an upstream error, a cut-off reply, a safety stop or a reply
 * that is not a candidate list is never zero; zero is a completed search that
 * returned no grounding chunks. retrieveSources keeps returning [] for every
 * failure, for its consensus callers. Only the SDK call is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ reply: {} as unknown, error: null as unknown }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        if (sdk.error) throw sdk.error;
        return sdk.reply;
      },
    };
  },
}));

import { retrieveSources, retrieveSourcesWithStatus } from '../services/geminiService';
import { GeminiGroundingRetriever } from '../providers/gemini_provider';

const CLAIM = 'The Eiffel Tower was completed in 1889.';
const chunk = (uri: string) => ({ web: { title: 'G', uri } });
const grounded = (finishReason: string, chunks: unknown[] | undefined) => ({
  text: 'summary',
  candidates: [{ finishReason, groundingMetadata: chunks === undefined ? undefined : { groundingChunks: chunks } }],
});

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sdk.reply = {};
  sdk.error = null;
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('retrieveSourcesWithStatus', () => {
  it('hits: grounding chunks come back as sources', async () => {
    sdk.reply = grounded('STOP', [chunk('https://example.org/a'), chunk('https://example.org/a'), chunk('https://example.org/b')]);
    const out = await retrieveSourcesWithStatus(CLAIM, 'k');
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out).toEqual({ status: 'hits', sources: [{ title: 'G', uri: 'https://example.org/a' }, { title: 'G', uri: 'https://example.org/b' }] });
  });

  it('zero: a completed reply with no grounding chunks', async () => {
    sdk.reply = grounded('STOP', undefined);
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'zero', sources: [] });
    sdk.reply = grounded('STOP', []);
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'zero', sources: [] });
  });

  it('provider_error: a missing key, with no call made', async () => {
    sdk.error = new Error('must not be called');
    expect(await retrieveSourcesWithStatus(CLAIM, '')).toEqual({ status: 'provider_error', sources: [], detail: 'missing api key' });
    expect(await new GeminiGroundingRetriever('').retrieveWithStatus(CLAIM)).toEqual({ status: 'provider_error', sources: [], detail: 'missing api key' });
    await expect(new GeminiGroundingRetriever('').retrieve(CLAIM)).resolves.toEqual([]);
  });

  it('provider_error: an upstream error, with its status code as the only detail and nothing of its body logged', async () => {
    sdk.error = Object.assign(new Error('SECRET CLAIM sk-secret upstream body'), { status: 503 });
    const out = await retrieveSourcesWithStatus(CLAIM, 'k');
    expect(out).toEqual({ status: 'provider_error', sources: [], detail: 'http 503' });
    expect(await new GeminiGroundingRetriever('k').retrieveWithStatus(CLAIM)).toEqual(out);
    await expect(retrieveSources(CLAIM, 'k')).resolves.toEqual([]);
    const logged = errorLog.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('sk-secret');
    expect(logged).not.toContain(CLAIM);
    sdk.error = new TypeError('fetch failed');
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'provider_error', sources: [], detail: 'request failed' });
  });

  it('timeout: the call was stopped by a deadline', async () => {
    sdk.error = new DOMException('The operation timed out.', 'TimeoutError');
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'timeout', sources: [], detail: 'deadline reached' });
  });

  it('provider_error: a reply cut off at its ceiling, even with chunks', async () => {
    sdk.reply = grounded('MAX_TOKENS', [chunk('https://example.org/a')]);
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'provider_error', sources: [], detail: 'output truncated' });
    await expect(retrieveSources(CLAIM, 'k')).resolves.toEqual([]);
  });

  it('policy_block: a safety stop or a blocked prompt, even with chunks', async () => {
    sdk.reply = grounded('SAFETY', [chunk('https://example.org/a')]);
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'policy_block', sources: [], detail: 'safety stop' });
    sdk.reply = { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] };
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'policy_block', sources: [], detail: 'prompt blocked' });
  });

  it('provider_error: any other unfinished candidate', async () => {
    sdk.reply = grounded('OTHER', [chunk('https://example.org/a')]);
    expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'provider_error', sources: [], detail: 'candidate not finished' });
  });

  it('parse_error: a reply that is not a candidate list, or carries malformed chunks', async () => {
    for (const reply of [null, 'text', {}, { candidates: 'bad' }, { candidates: [null] }, grounded('STOP', 'bad' as never), grounded('STOP', [null]), grounded('STOP', [{ web: { uri: 7 } }])]) {
      sdk.reply = reply;
      expect(await retrieveSourcesWithStatus(CLAIM, 'k')).toEqual({ status: 'parse_error', sources: [], detail: 'unexpected shape' });
    }
    sdk.reply = null;
    await expect(retrieveSources(CLAIM, 'k')).resolves.toEqual([]);
  });
});
