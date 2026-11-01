/**
 * ExtractionError: a failed claim extraction throws instead of returning [].
 *
 * Before this, every provider's extractClaims swallowed its error and returned
 * [], and scan() then filled one synthetic claim per sentence, so a 429, a
 * network error or JSON cut off mid-output looked like a normal scan (measured
 * 2026-10-13: two 150k-char documents "extracted" 945 and 1,049 synthetic
 * claims after truncation, docs/research/data/extraction-cost/README.md).
 *
 * Covers the shared module (classification, safe message, parsing) and the
 * Gemini path (services/geminiService.ts extractClaims, used by
 * providers/gemini_provider.ts). The HTTP providers are covered in their own
 * provider test files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

import {
  ExtractionError,
  classifyApiError,
  isExtractionError,
  parseExtractedClaims,
} from '../providers/extraction-error.js';
import { MAX_CLAIM_ID_LENGTH } from '../lib/verdict-guard.js';
import { classifyApiError as verifyRunnerClassify } from '../cli/verify-runner.js';
import { extractClaims } from '../services/geminiService.js';
import { createGeminiProvider } from '../providers/gemini_provider.js';

const RAW_QUOTA_BLOB = '[429 Too Many Requests] {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric generativelanguage.googleapis.com/generate_content_free_tier_requests, model gemini-2.5-flash"}}';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExtractionError', () => {
  it('carries reason and cause, and its message never echoes the raw provider error', () => {
    const raw = new Error(RAW_QUOTA_BLOB);
    const err = ExtractionError.fromProviderError(raw);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ExtractionError');
    expect(err.reason).toBe('rate_limited');
    expect(err.cause).toBe(raw);
    expect(err.message).toMatch(/^Claim extraction failed/);
    expect(err.message).not.toMatch(/RESOURCE_EXHAUSTED|gemini-2\.5|quota|googleapis/i);
  });

  it('classifies like the verify stage: 429, timeout, 503, other', () => {
    expect(ExtractionError.fromProviderError(new Error('OpenAI API error: 429 Too Many Requests')).reason).toBe('rate_limited');
    expect(ExtractionError.fromProviderError(new Error('request timed out after 30000ms')).reason).toBe('timeout');
    expect(ExtractionError.fromProviderError(new Error('Anthropic API error: 503 Service Unavailable')).reason).toBe('provider_unavailable');
    expect(ExtractionError.fromProviderError(new Error('fetch failed')).reason).toBe('provider_error');
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(ExtractionError.fromProviderError(abort).reason).toBe('timeout');
  });

  it('does not re-wrap an ExtractionError', () => {
    const inner = new ExtractionError('invalid_output');
    expect(ExtractionError.fromProviderError(inner)).toBe(inner);
  });

  it('verify-runner still exports the same classifier (one implementation)', () => {
    expect(verifyRunnerClassify).toBe(classifyApiError);
  });

  it('isExtractionError recognises the class and a same-shaped copy, and rejects other errors', () => {
    expect(isExtractionError(new ExtractionError('timeout'))).toBe(true);
    const copy = Object.assign(new Error('x'), { name: 'ExtractionError', reason: 'timeout' });
    expect(isExtractionError(copy)).toBe(true);
    expect(isExtractionError(new Error('No API key found for "gemini".'))).toBe(false);
    expect(isExtractionError(Object.assign(new Error('x'), { name: 'ExtractionError' }))).toBe(false);
    expect(isExtractionError('ExtractionError')).toBe(false);
  });
});

describe('parseExtractedClaims', () => {
  const claim = { id: 'c1', text: 'Water boils at 100 C at sea level.', type: 'fact', importance: 4 };

  it('returns the claims of a bare array', () => {
    const claims = parseExtractedClaims(JSON.stringify([claim]));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims).toEqual([claim]);
  });

  it('unwraps a { claims } envelope only when asked', () => {
    const wrapped = JSON.stringify({ claims: [claim] });
    expect(parseExtractedClaims(wrapped, true)).toEqual([claim]);
    expect(() => parseExtractedClaims(wrapped)).toThrow(ExtractionError);
  });

  it('returns [] for a valid empty array', () => {
    expect(parseExtractedClaims('[]')).toEqual([]);
    expect(parseExtractedClaims('{"claims":[]}', true)).toEqual([]);
  });

  it('throws invalid_output with the SyntaxError as cause on truncated JSON', () => {
    const err = (() => {
      try { parseExtractedClaims('[{"id":"c1","text":"The Eiffel Tower was completed in 18'); } catch (e) { return e; }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).reason).toBe('invalid_output');
    expect((err as ExtractionError).cause).toBeInstanceOf(SyntaxError);
  });

  it('rejects a claims array holding a malformed item: invalid_output, cause names index and field, no claim text (codex E1)', () => {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ claims: [{ text: 'UPSTREAM_ERROR_SENTINEL', type: 'error' }] }), 'id'],
      [JSON.stringify({ claims: [{}] }), 'id'],
      [JSON.stringify({ claims: [claim, null] }), 'object'],
      [JSON.stringify({ claims: [claim, 'a string'] }), 'object'],
      [JSON.stringify({ claims: [{ ...claim, text: '  ' }] }), 'text'],
      [JSON.stringify({ claims: [{ ...claim, type: 'error' }] }), 'type'],
      [JSON.stringify({ claims: [{ ...claim, importance: 0 }] }), 'importance'],
      [JSON.stringify({ claims: [{ ...claim, importance: 6 }] }), 'importance'],
      [JSON.stringify({ claims: [{ ...claim, importance: 2.5 }] }), 'importance'],
      [JSON.stringify({ claims: [{ ...claim, importance: '4' }] }), 'importance'],
    ];
    for (const [raw, field] of cases) {
      let err: unknown;
      try { parseExtractedClaims(raw, true); } catch (e) { err = e; }
      expect(err, raw).toBeInstanceOf(ExtractionError);
      expect((err as ExtractionError).reason).toBe('invalid_output');
      expect(String(((err as ExtractionError).cause as Error).message)).toContain(field);
      expect(String(((err as ExtractionError).cause as Error).message)).not.toContain('SENTINEL');
    }
  });

  it('one bad item fails the whole list, even beside valid claims', () => {
    const raw = JSON.stringify([claim, { ...claim, id: 'c2', type: 'error' }]);
    expect(() => parseExtractedClaims(raw)).toThrow(expect.objectContaining({ reason: 'invalid_output' }));
  });

  it('accepts a numeric id as a string and keeps every valid claim unchanged', () => {
    const claims = parseExtractedClaims(JSON.stringify([{ ...claim, id: 7 }, { ...claim, id: 'c2', type: 'opinion', importance: 1 }]));
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({ ...claim, id: '7' });
    expect(claims[1]).toMatchObject({ id: 'c2', type: 'opinion', importance: 1 });
  });

  it('accepts an id of exactly MAX_CLAIM_ID_LENGTH (58) characters', () => {
    expect(MAX_CLAIM_ID_LENGTH).toBe(58);
    const id = 'a'.repeat(MAX_CLAIM_ID_LENGTH);
    const claims = parseExtractedClaims(JSON.stringify([{ ...claim, id }]));
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe(id);
  });

  it('rejects an id longer than MAX_CLAIM_ID_LENGTH: invalid_output, cause names index and field, no claim text', () => {
    const raw = JSON.stringify([claim, { ...claim, id: 'b'.repeat(MAX_CLAIM_ID_LENGTH + 1), text: 'SENTINEL claim text' }]);
    let err: unknown;
    try { parseExtractedClaims(raw); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).reason).toBe('invalid_output');
    expect(((err as ExtractionError).cause as Error).message).toBe('claim 1: invalid or missing id');
    expect(((err as ExtractionError).cause as Error).message).not.toContain('SENTINEL');
  });

  it('rejects two claims sharing an id, naming the second index; a numeric id and its string form are the same id', () => {
    const cases: Array<[unknown[], string]> = [
      [[claim, { ...claim, id: 'c2' }, { ...claim, id: 'c1', text: 'SENTINEL claim text' }], 'claim 2: duplicate id'],
      [[{ ...claim, id: 7 }, { ...claim, id: '7', text: 'SENTINEL claim text' }], 'claim 1: duplicate id'],
    ];
    for (const [items, cause] of cases) {
      let err: unknown;
      try { parseExtractedClaims(JSON.stringify(items)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ExtractionError);
      expect((err as ExtractionError).reason).toBe('invalid_output');
      expect(((err as ExtractionError).cause as Error).message).toBe(cause);
      expect(((err as ExtractionError).cause as Error).message).not.toContain('SENTINEL');
    }
  });

  it('distinct ids that differ only in case are kept', () => {
    const claims = parseExtractedClaims(JSON.stringify([claim, { ...claim, id: 'C1' }]));
    expect(claims.map((c) => c.id)).toEqual(['c1', 'C1']);
  });

  it('throws invalid_output for JSON that holds no array', () => {
    for (const raw of ['{"not":"an array"}', 'null', '42', '"text"', '{"claims":null}']) {
      expect(() => parseExtractedClaims(raw, true), raw).toThrow(expect.objectContaining({ reason: 'invalid_output' }));
    }
  });
});

describe('Gemini extractClaims (services/geminiService.ts)', () => {
  const claims = [
    { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 },
    { id: 'c2', text: 'It opened in 1889.', type: 'fact', importance: 3 },
  ];

  it('returns the extracted claims on a valid reply', async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(claims) });
    const result = await extractClaims('The Eiffel Tower is in Paris. It opened in 1889.', 'test-key');
    expect(result.length).toBe(2);
    expect(result).toEqual(claims);
  });

  it('returns [] for a valid empty array (zero claims is not an error)', async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: '[]' });
    await expect(extractClaims('Hello there friend.', 'test-key')).resolves.toEqual([]);
  });

  it('keeps the empty-input early return: no text and no image returns [] without a call', async () => {
    await expect(extractClaims('', 'test-key')).resolves.toEqual([]);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('throws rate_limited on a 429 / RESOURCE_EXHAUSTED rejection, with the raw error only on cause', async () => {
    const raw = new Error(RAW_QUOTA_BLOB);
    mockGenerateContent.mockRejectedValueOnce(raw);
    const err = await extractClaims('Some text here.', 'test-key').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).reason).toBe('rate_limited');
    expect((err as ExtractionError).cause).toBe(raw);
    expect((err as ExtractionError).message).not.toContain('RESOURCE_EXHAUSTED');
  });

  it('throws provider_unavailable on a 503 rejection', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('[503 Service Unavailable] The model is overloaded.'));
    await expect(extractClaims('Some text here.', 'test-key'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'provider_unavailable' });
  });

  it('throws timeout on a timed-out call', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('Request timed out'));
    await expect(extractClaims('Some text here.', 'test-key'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'timeout' });
  });

  it('throws invalid_output on JSON cut off mid-output (the 150k-char document case)', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: '[{"id":"c1","text":"The Eiffel Tower is in Paris.","type":"fact","importance":4},{"id":"c2","text":"It opened in 18',
    });
    const err = await extractClaims('Some text here.', 'test-key').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).reason).toBe('invalid_output');
    expect((err as ExtractionError).cause).toBeInstanceOf(SyntaxError);
  });

  it('throws invalid_output for a non-array reply', async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: '{"not":"an array"}' });
    await expect(extractClaims('Some text here.', 'test-key'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'invalid_output' });
  });

  it('throws invalid_output for an empty reply (blocked or cut off), not []', async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: '' });
    await expect(extractClaims('Some text here.', 'test-key'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'invalid_output' });
    mockGenerateContent.mockResolvedValueOnce({});
    await expect(extractClaims('Some text here.', 'test-key'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'invalid_output' });
  });

  it('the Gemini provider adapter propagates the ExtractionError', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    await expect(createGeminiProvider('test-key').extractClaims('Some text here.'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'rate_limited' });
  });
});

// Codex E1 repro through a real provider and the real scan(): a claims array of
// malformed items must fail extraction, not be padded with synthetic claims.
describe('a malformed claims array through a real provider (codex E1)', () => {
  it('OpenAI extractClaims rejects the sentinel reply with invalid_output (scan() then verifies nothing: scan-extraction-failure.test.ts)', async () => {
    const { createOpenAIProvider } = await import('../providers/openai_provider.js');
    const provider = createOpenAIProvider('sk-test');
    const sentinel = JSON.stringify({ claims: [{ text: 'UPSTREAM_ERROR_SENTINEL', type: 'error' }] });
    vi.spyOn(provider as unknown as { callAPI: () => Promise<string> }, 'callAPI').mockResolvedValue(sentinel);
    const verify = vi.spyOn(provider, 'verifyClaim');
    await expect(provider.extractClaims('The Eiffel Tower is in Paris. Water boils at 100 C.'))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'invalid_output' });
    expect(verify).not.toHaveBeenCalled();
  });
});
