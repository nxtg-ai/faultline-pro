import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from '../providers/base_provider';
import type { Claim } from '../types';

// Mock global fetch for Anthropic API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createClaudeProvider } from '../providers/claude_provider';

function mockAnthropicResponse(text: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => ({
      content: [{ type: 'text', text }],
    }),
  };
}

describe('ClaudeProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FAULTLINE_CLAUDE_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('interface compliance', () => {
    it('should implement LLMProvider interface', () => {
      const provider = createClaudeProvider('test-key');
      expect(provider.name).toBeDefined();
      expect(provider.modelId).toBeDefined();
      expect(typeof provider.extractClaims).toBe('function');
      expect(typeof provider.verifyClaim).toBe('function');
      expect(typeof provider.generateCritiqueAndPrompt).toBe('function');
    });

    it('should expose correct provider name', () => {
      const provider = createClaudeProvider('test-key');
      expect(provider.name).toBe('Anthropic Claude');
    });

    it('should expose correct model ID', () => {
      const provider = createClaudeProvider('test-key');
      expect(provider.modelId).toBe('claude-sonnet-4-6');
    });

    it('factory should satisfy ProviderFactory type', () => {
      const factory: ProviderFactory = createClaudeProvider;
      const provider = factory('test-key');
      expect(provider.name).toBe('Anthropic Claude');
    });

    it('should create independent instances', () => {
      const p1 = createClaudeProvider('key-1');
      const p2 = createClaudeProvider('key-2');
      expect(p1).not.toBe(p2);
    });
  });

  describe('extractClaims', () => {
    it('should return parsed claims from API response', async () => {
      const mockClaims = [
        { id: 'c1', text: 'Water boils at 100C', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Coffee tastes good', type: 'opinion', importance: 2 },
      ];
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(mockClaims)));

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Some text about water and coffee');
      expect(result).toEqual(mockClaims);
      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty input', async () => {
      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('');
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle markdown-wrapped JSON response', async () => {
      const claims = [{ id: 'c1', text: 'Claim', type: 'fact', importance: 5 }];
      const wrapped = '```json\n' + JSON.stringify(claims) + '\n```';
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(wrapped));

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Input text');
      expect(result).toEqual(claims);
    });

    it('should pass image input in API call', async () => {
      const claims = [{ id: 'c1', text: 'Image claim', type: 'fact', importance: 3 }];
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(claims)));

      const provider = createClaudeProvider('test-key');
      const image: ImageInput = { data: 'base64data', mimeType: 'image/png' };
      const result = await provider.extractClaims('', image);
      expect(result).toEqual(claims);

      // Verify the fetch call included image content
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0].content[0].type).toBe('image');
      expect(body.messages[0].content[0].source.data).toBe('base64data');
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ not: 'an array' })),
      );

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });

    it('should send correct headers with API key', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('sk-ant-test-key');
      await provider.extractClaims('Test');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.headers['x-api-key']).toBe('sk-ant-test-key');
      expect(options.headers['anthropic-version']).toBe('2023-06-01');
    });
  });

  describe('verifyClaim', () => {
    it('should return verification result', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(
          JSON.stringify({ status: 'supported', explanation: 'Confirmed by sources.' }),
        ),
      );

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c1', text: 'Water is wet', type: 'fact', importance: 5 };
      const result = await provider.verifyClaim(claim);

      expect(result.claimId).toBe('c1');
      expect(result.status).toBe('supported');
      expect(result.explanation).toBe('Confirmed by sources.');
      expect(result.sources).toEqual([]);
    });

    it('should handle contradicted status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(
          JSON.stringify({ status: 'contradicted', explanation: 'Not accurate.' }),
        ),
      );

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c2', text: 'Bad claim', type: 'fact', importance: 4 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('contradicted');
    });

    it('should fallback to unverified on API error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Rate limit'));

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c3', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);

      expect(result.claimId).toBe('c3');
      expect(result.status).toBe('unverified');
      expect(result.explanation).toContain('technical error');
    });

    it('should fallback to unverified on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c4', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });
  });

  describe('generateCritiqueAndPrompt', () => {
    it('should return critique and improved prompt', async () => {
      const mockResult = {
        critique: 'Foundation shows fractures.',
        improvedPrompt: 'Please cite sources.',
      };
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(mockResult)));

      const provider = createClaudeProvider('test-key');
      const claims: Claim[] = [{ id: 'c1', text: 'Bad claim', type: 'fact', importance: 5 }];
      const result = await provider.generateCritiqueAndPrompt('original text', claims);

      expect(result.critique).toBe('Foundation shows fractures.');
      expect(result.improvedPrompt).toBe('Please cite sources.');
    });

    it('should return fallback on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('API down'));

      const provider = createClaudeProvider('test-key');
      const result = await provider.generateCritiqueAndPrompt('text', []);

      expect(result.critique).toBe('Analysis incomplete.');
      expect(result.improvedPrompt).toContain('Verify facts');
    });

    it('should truncate long original text to 500 chars', async () => {
      const longText = 'A'.repeat(1000);
      const mockResult = { critique: 'Assessment.', improvedPrompt: 'Prompt.' };
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(mockResult)));

      const provider = createClaudeProvider('test-key');
      await provider.generateCritiqueAndPrompt(longText, [
        { id: 'c1', text: 'Claim', type: 'fact', importance: 5 },
      ]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const messageText = body.messages[0].content[0].text;
      expect(messageText).not.toContain('A'.repeat(501));
    });

    it('should include failed claims in the prompt', async () => {
      const mockResult = { critique: 'Bad.', improvedPrompt: 'Fix.' };
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(mockResult)));

      const provider = createClaudeProvider('test-key');
      const claims: Claim[] = [
        { id: 'c1', text: 'Claim one is wrong', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Claim two is wrong', type: 'fact', importance: 4 },
      ];
      await provider.generateCritiqueAndPrompt('original', claims);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const messageText = body.messages[0].content[0].text;
      expect(messageText).toContain('Claim one is wrong');
      expect(messageText).toContain('Claim two is wrong');
    });

    it('should handle markdown-wrapped JSON in critique response', async () => {
      const mockResult = { critique: 'Issues found.', improvedPrompt: 'Be more specific.' };
      const wrapped = '```json\n' + JSON.stringify(mockResult) + '\n```';
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(wrapped));

      const provider = createClaudeProvider('test-key');
      const result = await provider.generateCritiqueAndPrompt('text', [
        { id: 'c1', text: 'Bad', type: 'fact', importance: 5 },
      ]);

      expect(result.critique).toBe('Issues found.');
      expect(result.improvedPrompt).toBe('Be more specific.');
    });
  });

  describe('FAULTLINE_CLAUDE_MODEL env var', () => {
    it('should use default model when env var is not set', () => {
      const provider = createClaudeProvider('test-key');
      expect(provider.modelId).toBe('claude-sonnet-4-6');
    });

    it('should use custom model from FAULTLINE_CLAUDE_MODEL', () => {
      process.env.FAULTLINE_CLAUDE_MODEL = 'claude-opus-4-20250514';
      const provider = createClaudeProvider('test-key');
      expect(provider.modelId).toBe('claude-opus-4-20250514');
    });

    it('should send custom model in API request body', async () => {
      process.env.FAULTLINE_CLAUDE_MODEL = 'claude-haiku-3-20250307';
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('claude-haiku-3-20250307');
    });

    it('should fall back to default when env var is empty string', () => {
      process.env.FAULTLINE_CLAUDE_MODEL = '';
      const provider = createClaudeProvider('test-key');
      expect(provider.modelId).toBe('claude-sonnet-4-6');
    });

    it('different instances can have different models if env changes between constructions', () => {
      const p1 = createClaudeProvider('key-1');
      process.env.FAULTLINE_CLAUDE_MODEL = 'claude-opus-4-20250514';
      const p2 = createClaudeProvider('key-2');
      expect(p1.modelId).toBe('claude-sonnet-4-6');
      expect(p2.modelId).toBe('claude-opus-4-20250514');
    });
  });

  describe('API call structure', () => {
    it('should use POST method', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    });

    it('should use correct API endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    });

    it('should include model in request body', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('claude-sonnet-4-6');
    });

    it('should set max_tokens in request body', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(4096);
    });

    it('should include anthropic-version header', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      const options = mockFetch.mock.calls[0][1];
      expect(options.headers['anthropic-version']).toBe('2023-06-01');
    });

    it('should include Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      await provider.extractClaims('Test');

      const options = mockFetch.mock.calls[0][1];
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('should handle empty content array in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ content: [] }),
      });

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });

    it('should handle missing content in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
      });

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });
  });

  describe('extractJson edge cases', () => {
    it('should handle JSON with surrounding prose', async () => {
      const claims = [{ id: 'c1', text: 'Claim', type: 'fact', importance: 5 }];
      const withProse = 'Here are the claims:\n' + JSON.stringify(claims) + '\nEnd.';
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(withProse));

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Input');
      expect(result).toEqual(claims);
    });

    it('should handle JSON object with surrounding prose', async () => {
      const obj = { status: 'supported', explanation: 'Good.' };
      const withProse = 'Result: ' + JSON.stringify(obj) + ' Done.';
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(withProse));

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c1', text: 'Test', type: 'fact', importance: 5 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('supported');
    });

    it('should return empty array for completely empty response', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(''));

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Input');
      expect(result).toEqual([]);
    });

    it('should handle response with only whitespace', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('   \n\n  '));

      const provider = createClaudeProvider('test-key');
      const result = await provider.extractClaims('Input');
      expect(result).toEqual([]);
    });
  });

  describe('verifyClaim additional cases', () => {
    it('should handle mixed status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(
          JSON.stringify({ status: 'mixed', explanation: 'Partially true.' }),
        ),
      );

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c5', text: 'Partial claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('mixed');
      expect(result.explanation).toBe('Partially true.');
    });

    it('should default to unverified when status is missing', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ explanation: 'No status field.' })),
      );

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c6', text: 'Claim', type: 'fact', importance: 2 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });

    it('should provide default explanation when missing', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'supported' })),
      );

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c7', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.explanation).toBe('No structural analysis provided.');
    });

    it('should always return empty sources array', async () => {
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(
          JSON.stringify({ status: 'supported', explanation: 'Good.' }),
        ),
      );

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c8', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.sources).toEqual([]);
    });

    it('should handle 500 server error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c9', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });

    it('should handle 401 unauthorized error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const provider = createClaudeProvider('test-key');
      const claim: Claim = { id: 'c10', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });
  });

  describe('extractClaims with image', () => {
    it('should set correct media_type from image input', async () => {
      const claims = [{ id: 'c1', text: 'Image claim', type: 'fact', importance: 3 }];
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(claims)));

      const provider = createClaudeProvider('test-key');
      const image: ImageInput = { data: 'base64jpeg', mimeType: 'image/jpeg' };
      await provider.extractClaims('caption', image);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0].content[0].source.media_type).toBe('image/jpeg');
      expect(body.messages[0].content[0].source.type).toBe('base64');
    });

    it('should include both image and text content blocks', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('[]'));

      const provider = createClaudeProvider('test-key');
      const image: ImageInput = { data: 'data', mimeType: 'image/png' };
      await provider.extractClaims('Some caption', image);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0].content).toHaveLength(2);
      expect(body.messages[0].content[0].type).toBe('image');
      expect(body.messages[0].content[1].type).toBe('text');
    });

    it('should handle image-only input (no text)', async () => {
      const claims = [{ id: 'c1', text: 'Visual claim', type: 'fact', importance: 4 }];
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(claims)));

      const provider = createClaudeProvider('test-key');
      const image: ImageInput = { data: 'imgdata', mimeType: 'image/webp' };
      const result = await provider.extractClaims('', image);
      expect(result).toEqual(claims);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
