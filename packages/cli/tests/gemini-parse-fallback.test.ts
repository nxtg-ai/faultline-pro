// Validates: prereg G0 §3 (docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md): the `mixed` confound flag
/**
 * geminiService.verifyClaim falls back to status 'mixed' when the model's reply
 * is not JSON. `parseFallback` marks that case so the accuracy run can split
 * "inconclusive" from "unparseable". The flag must never change the status, and
 * every other result must keep its previous shape (no parseFallback key at all).
 *
 * The SDK is mocked at the module boundary, as in every gemini test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ reply: { text: '' } as { text?: string } | Error }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        if (sdk.reply instanceof Error) throw sdk.reply;
        return { ...sdk.reply, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
      },
    };
  },
}));

import { verifyClaim } from '../services/geminiService.js';
import type { Claim } from '../types.js';

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 };

describe('geminiService.verifyClaim — parseFallback', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('non-JSON reply: status mixed AND parseFallback true', async () => {
    sdk.reply = { text: 'I think this is probably true but sources disagree.' };
    const result = await verifyClaim(CLAIM, 'key');
    expect(result.status).toBe('mixed');
    expect(result.parseFallback).toBe(true);
    expect(result.apiError).toBeUndefined();
  });

  it('JSON reply saying mixed: status mixed, no parseFallback', async () => {
    sdk.reply = { text: '{"status":"mixed","explanation":"Studies disagree."}' };
    const result = await verifyClaim(CLAIM, 'key');
    expect(result.status).toBe('mixed');
    expect(result.parseFallback).toBeUndefined();
  });

  it('JSON reply (fenced or bare): parsed status, and the result has no parseFallback key', async () => {
    for (const text of [
      '{"status":"supported","explanation":"Confirmed."}',
      '```json\n{"status":"contradicted","explanation":"Refuted."}\n```',
    ]) {
      sdk.reply = { text };
      const result = await verifyClaim(CLAIM, 'key');
      expect(['supported', 'contradicted']).toContain(result.status);
      expect('parseFallback' in result).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['claimId', 'explanation', 'sources', 'status']);
    }
  });

  it('empty reply: unverified, not a parse fallback (no text to fall back on)', async () => {
    sdk.reply = { text: '' };
    const result = await verifyClaim(CLAIM, 'key');
    expect(result.status).toBe('unverified');
    expect(result.parseFallback).toBeUndefined();
  });

  it('provider error: apiError, not a parse fallback', async () => {
    sdk.reply = new Error('503 overloaded');
    const result = await verifyClaim(CLAIM, 'key');
    expect(result.apiError).toBe(true);
    expect(result.parseFallback).toBeUndefined();
  });
});
