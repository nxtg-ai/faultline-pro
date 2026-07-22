/**
 * gemini-usage-e2e.test.ts — BLG-005 fold-2 (Wolf): gemini SDK ALS propagation.
 *
 * gemini is the DEFAULT provider, yet the openai/claude e2e deletes GEMINI_API_KEY,
 * leaving the GoogleGenAI-SDK usage path unproven. This drives a real gemini scan
 * (extraction + verify through geminiService → ai.models.generateContent) inside a
 * captureUsage() scope and asserts the SDK's usageMetadata propagates back as legs.
 *
 * The SDK is mocked at the module boundary (the codebase-wide convention — every
 * gemini test does this), BUT the mock's generateContent resolves across a real
 * setTimeout MACROTASK boundary — exactly where naive context-passing breaks — so
 * this genuinely exercises AsyncLocalStorage propagation through the gemini async
 * chain, not just the recordGeminiUsage wiring.
 *
 * Residual (documented, accepted): the real @google/genai transport (node-fetch vs
 * global fetch) is not exercised — but ALS across standard async/await + timers is
 * a Node platform guarantee, and geminiService uses a plain `await
 * ai.models.generateContent()`, so context propagation through it is what's proven.
 *
 * Validates: BLG-CLX9-20260703-005 (default-provider gemini usage survives ALS)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const tick = () => new Promise((r) => setTimeout(r, 0));

// Mock the SDK: generateContent returns usageMetadata AFTER a real macrotask.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (_params: unknown) => {
        await tick(); // real async boundary — ALS store must survive it
        return {
          text: '[{"id":"1","text":"The Eiffel Tower was completed in 1889.","type":"fact","importance":3}]',
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
        };
      },
    };
  },
}));

import { scan } from '../cli/scan.js';
import { captureUsage } from '../lib/usage-sink.js';

const TEXT =
  'The Eiffel Tower was completed in 1889. Mount Everest is the highest mountain above sea level.';

describe('gemini SDK usage propagation (e2e through scan())', () => {
  const saved = process.env.GEMINI_API_KEY;
  beforeAll(() => { process.env.GEMINI_API_KEY = 'test-gemini'; });
  afterAll(() => { if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved; });

  it('GUE-01: gemini SDK usageMetadata propagates back as legs (default provider, ALS across macrotask)', async () => {
    const { legs } = await captureUsage(() => scan(TEXT, 'gemini'));
    // legs came back → ALS survived scan()'s Promise.all + the SDK call's await/timer
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.provider === 'gemini')).toBe(true);
    // the REAL SDK-reported usageMetadata (150/40), not a text-length estimate
    expect(legs.some((l) => l.model === 'gemini-2.5-flash' && l.inputTokens === 150 && l.outputTokens === 40)).toBe(true);
  });
});
