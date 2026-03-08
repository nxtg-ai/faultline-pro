import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from '../providers/base_provider';
import type { Claim } from '../types';

// Mock global fetch for Perplexity API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createPerplexityProvider } from '../providers/perplexity_provider';

function mockPerplexityResponse(content: string, citations: string[] = [], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => ({
      choices: [{ message: { content } }],
      citations,
    }),
  };
}

describe('PerplexityProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FAULTLINE_PERPLEXITY_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('interface compliance', () => {
    it('should implement LLMProvider interface', () => {
      const provider = createPerplexityProvider('test-key');
      expect(provider.name).toBeDefined();
      expect(provider.modelId).toBeDefined();
      expect(typeof provider.extractClaims).toBe('function');
      expect(typeof provider.verifyClaim).toBe('function');
      expect(typeof provider.generateCritiqueAndPrompt).toBe('function');
    });

    it('should expose correct provider name', () => {
      const provider = createPerplexityProvider('test-key');
      expect(provider.name).toBe('Perplexity');
    });

    it('should expose correct model ID', () => {
      const provider = createPerplexityProvider('test-key');
      expect(provider.modelId).toBe('sonar-pro');
    });

    it('factory should satisfy ProviderFactory type', () => {
      const factory: ProviderFactory = createPerplexityProvider;
      const provider = factory('test-key');
      expect(provider.name).toBe('Perplexity');
    });

    it('should create independent instances', () => {
      const p1 = createPerplexityProvider('key-1');
      const p2 = createPerplexityProvider('key-2');
      expect(p1).not.toBe(p2);
    });
  });

  describe('extractClaims', () => {
    it('should return parsed claims from API response', async () => {
      const mockClaims = [
        { id: 'c1', text: 'Water boils at 100C', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Coffee tastes good', type: 'opinion', importance: 2 },
      ];
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: mockClaims })),
      );

      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('Some text about water and coffee');
      expect(result).toEqual(mockClaims);
      expect(result).toHaveLength(2);
    });

    it('should handle response with direct array (no claims wrapper)', async () => {
      const mockClaims = [
        { id: 'c1', text: 'Claim one', type: 'fact', importance: 5 },
      ];
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify(mockClaims)),
      );

      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('Input text');
      expect(result).toEqual(mockClaims);
    });

    it('should return empty array for empty input', async () => {
      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('');
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should ignore image parameter gracefully (Perplexity is text-only)', async () => {
      const mockClaims = [{ id: 'c1', text: 'Text-only claim', type: 'fact', importance: 3 }];
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: mockClaims })),
      );

      const provider = createPerplexityProvider('test-key');
      const image: ImageInput = { data: 'base64data', mimeType: 'image/png' };
      // image is passed but should be ignored — should not cause an error
      const result = await provider.extractClaims('text with image', image);
      expect(result).toEqual(mockClaims);

      // Verify the fetch call did NOT include an image_url content block
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const contentTypes = body.messages[0].content.map((c: any) => c.type);
      expect(contentTypes).not.toContain('image_url');
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ not: 'an array' })),
      );

      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });

    it('should send correct headers with API key', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: [] })),
      );

      const provider = createPerplexityProvider('pplx-test-key-123');
      await provider.extractClaims('Test');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.perplexity.ai/chat/completions');
      expect(options.headers['Authorization']).toBe('Bearer pplx-test-key-123');
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('should request json_object response format', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: [] })),
      );

      const provider = createPerplexityProvider('test-key');
      await provider.extractClaims('Test');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.model).toBe('sonar-pro');
    });

    it('should handle empty choices array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [], citations: [] }),
      });

      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('Some text');
      expect(result).toEqual([]);
    });
  });

  describe('verifyClaim', () => {
    it('should return verification result', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(
          JSON.stringify({ status: 'supported', explanation: 'Confirmed by sources.' }),
        ),
      );

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c1', text: 'Water is wet', type: 'fact', importance: 5 };
      const result = await provider.verifyClaim(claim);

      expect(result.claimId).toBe('c1');
      expect(result.status).toBe('supported');
      expect(result.explanation).toBe('Confirmed by sources.');
      expect(result.sources).toEqual([]);
    });

    it('should handle contradicted status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(
          JSON.stringify({ status: 'contradicted', explanation: 'Not accurate.' }),
        ),
      );

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c2', text: 'Bad claim', type: 'fact', importance: 4 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('contradicted');
    });

    it('should handle mixed status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(
          JSON.stringify({ status: 'mixed', explanation: 'Partially true.' }),
        ),
      );

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c3', text: 'Partial claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('mixed');
      expect(result.explanation).toBe('Partially true.');
    });

    it('should fallback to unverified on API error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Rate limit'));

      const provider = createPerplexityProvider('test-key');
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

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c4', text: 'Claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });

    it('should default to unverified when status is missing', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ explanation: 'No status field.' })),
      );

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c5', text: 'Claim', type: 'fact', importance: 2 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });
  });

  describe('citation extraction', () => {
    it('should populate sources from citations in API response', async () => {
      const citations = [
        'https://example.com/source1',
        'https://example.com/source2',
      ];
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(
          JSON.stringify({ status: 'supported', explanation: 'Well documented.' }),
          citations,
        ),
      );

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c1', text: 'A verifiable claim', type: 'fact', importance: 5 };
      const result = await provider.verifyClaim(claim);

      expect(result.sources).toEqual(citations);
      expect(result.sources).toHaveLength(2);
    });

    it('should return empty sources when citations array is absent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }) } }],
          // no citations key
        }),
      });

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c1', text: 'A claim', type: 'fact', importance: 4 };
      const result = await provider.verifyClaim(claim);

      expect(result.sources).toEqual([]);
    });

    it('should return empty sources when citations is null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ status: 'mixed', explanation: 'Uncertain.' }) } }],
          citations: null,
        }),
      });

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c2', text: 'A claim', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);

      expect(result.sources).toEqual([]);
    });

    it('should handle multiple citations correctly', async () => {
      const citations = [
        'https://source1.org/article',
        'https://source2.net/paper',
        'https://source3.edu/study',
      ];
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(
          JSON.stringify({ status: 'supported', explanation: 'Extensively documented.' }),
          citations,
        ),
      );

      const provider = createPerplexityProvider('test-key');
      const claim: Claim = { id: 'c10', text: 'Well-cited claim', type: 'fact', importance: 5 };
      const result = await provider.verifyClaim(claim);

      expect(result.sources).toHaveLength(3);
      expect(result.sources[0]).toBe('https://source1.org/article');
      expect(result.sources[2]).toBe('https://source3.edu/study');
    });

    it('extractClaims should NOT expose citations (uses callAPI not callAPIWithCitations)', async () => {
      // extractClaims uses callAPI which doesn't return citations — this is by design
      const mockClaims = [{ id: 'c1', text: 'A claim', type: 'fact', importance: 4 }];
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: mockClaims }), ['https://irrelevant-citation.com']),
      );

      const provider = createPerplexityProvider('test-key');
      const result = await provider.extractClaims('Some text');
      // Claims themselves don't carry citations — only VerificationResult.sources does
      expect(result).toEqual(mockClaims);
    });
  });

  describe('generateCritiqueAndPrompt', () => {
    it('should return critique and improved prompt', async () => {
      const mockResult = {
        critique: 'Foundation shows fractures.',
        improvedPrompt: 'Please cite sources.',
      };
      mockFetch.mockResolvedValueOnce(mockPerplexityResponse(JSON.stringify(mockResult)));

      const provider = createPerplexityProvider('test-key');
      const claims: Claim[] = [{ id: 'c1', text: 'Bad claim', type: 'fact', importance: 5 }];
      const result = await provider.generateCritiqueAndPrompt('original text', claims);

      expect(result.critique).toBe('Foundation shows fractures.');
      expect(result.improvedPrompt).toBe('Please cite sources.');
    });

    it('should return fallback on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('API down'));

      const provider = createPerplexityProvider('test-key');
      const result = await provider.generateCritiqueAndPrompt('text', []);

      expect(result.critique).toBe('Analysis incomplete.');
      expect(result.improvedPrompt).toContain('Verify facts');
    });

    it('should truncate long original text to 500 chars', async () => {
      const longText = 'A'.repeat(1000);
      const mockResult = { critique: 'Assessment.', improvedPrompt: 'Prompt.' };
      mockFetch.mockResolvedValueOnce(mockPerplexityResponse(JSON.stringify(mockResult)));

      const provider = createPerplexityProvider('test-key');
      await provider.generateCritiqueAndPrompt(longText, [
        { id: 'c1', text: 'Claim', type: 'fact', importance: 5 },
      ]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const messageText = body.messages[0].content[0].text;
      // The prompt should contain only the first 500 chars of original text
      expect(messageText).not.toContain('A'.repeat(501));
    });
  });

  describe('FAULTLINE_PERPLEXITY_MODEL env var', () => {
    it('should use default model when env var is not set', () => {
      const provider = createPerplexityProvider('test-key');
      expect(provider.modelId).toBe('sonar-pro');
    });

    it('should use custom model from FAULTLINE_PERPLEXITY_MODEL', () => {
      process.env.FAULTLINE_PERPLEXITY_MODEL = 'sonar-huge';
      const provider = createPerplexityProvider('test-key');
      expect(provider.modelId).toBe('sonar-huge');
    });

    it('should send custom model in API request body', async () => {
      process.env.FAULTLINE_PERPLEXITY_MODEL = 'sonar-huge';
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: [] })),
      );

      const provider = createPerplexityProvider('test-key');
      await provider.extractClaims('Test');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('sonar-huge');
    });

    it('should fall back to default when env var is empty string', () => {
      process.env.FAULTLINE_PERPLEXITY_MODEL = '';
      const provider = createPerplexityProvider('test-key');
      expect(provider.modelId).toBe('sonar-pro');
    });

    it('different instances can have different models if env changes between constructions', () => {
      const p1 = createPerplexityProvider('key-1');
      process.env.FAULTLINE_PERPLEXITY_MODEL = 'sonar-huge';
      const p2 = createPerplexityProvider('key-2');
      expect(p1.modelId).toBe('sonar-pro');
      expect(p2.modelId).toBe('sonar-huge');
    });
  });

  describe('API call structure', () => {
    it('should use POST method', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: [] })),
      );

      const provider = createPerplexityProvider('test-key');
      await provider.extractClaims('Test');

      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    });

    it('should use correct API endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: [] })),
      );

      const provider = createPerplexityProvider('test-key');
      await provider.extractClaims('Test');

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.perplexity.ai/chat/completions');
    });

    it('should include model in request body', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerplexityResponse(JSON.stringify({ claims: [] })),
      );

      const provider = createPerplexityProvider('test-key');
      await provider.extractClaims('Test');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('sonar-pro');
    });
  });
});
