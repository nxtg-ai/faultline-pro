import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @google/genai before importing the service
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

import { extractClaims, verifyClaim, generateCritiqueAndPrompt } from '../services/geminiService';
import type { Claim } from '../types';

describe('geminiService.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── cleanJson (tested indirectly through exported functions) ───

  describe('extractClaims', () => {
    it('should return empty array when text and image are both empty', async () => {
      const result = await extractClaims('', 'test-key');
      expect(result).toEqual([]);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should return empty array when apiKey is empty', async () => {
      const result = await extractClaims('some text', '');
      expect(result).toEqual([]);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should return empty array when both text and apiKey are empty', async () => {
      const result = await extractClaims('', '');
      expect(result).toEqual([]);
    });

    it('should parse valid JSON array response', async () => {
      const mockClaims = [
        { id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 3 },
        { id: 'c2', text: 'It looks nice.', type: 'opinion', importance: 1 },
      ];
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockClaims),
      });

      const result = await extractClaims('The sky is blue. It looks nice.', 'test-key');
      expect(result).toEqual(mockClaims);
      expect(result).toHaveLength(2);
    });

    it('should parse JSON wrapped in markdown code blocks', async () => {
      const mockClaims = [{ id: 'c1', text: 'Test claim', type: 'fact', importance: 4 }];
      mockGenerateContent.mockResolvedValueOnce({
        text: '```json\n' + JSON.stringify(mockClaims) + '\n```',
      });

      const result = await extractClaims('Test text', 'test-key');
      expect(result).toEqual(mockClaims);
    });

    it('should parse JSON with surrounding text/whitespace', async () => {
      const mockClaims = [{ id: 'c1', text: 'Claim', type: 'fact', importance: 5 }];
      mockGenerateContent.mockResolvedValueOnce({
        text: 'Here are the claims:\n' + JSON.stringify(mockClaims) + '\nDone.',
      });

      const result = await extractClaims('Input text', 'test-key');
      expect(result).toEqual(mockClaims);
    });

    it('should return empty array when response is not an array', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ id: 'c1', text: 'Single object', type: 'fact', importance: 3 }),
      });

      const result = await extractClaims('Input', 'test-key');
      expect(result).toEqual([]);
    });

    it('should return empty array on invalid JSON', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: 'this is not valid json at all',
      });

      const result = await extractClaims('Input', 'test-key');
      expect(result).toEqual([]);
    });

    it('should return empty array on API error', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('API rate limit'));

      const result = await extractClaims('Input', 'test-key');
      expect(result).toEqual([]);
    });

    it('should return empty array when response.text is null', async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: null });

      const result = await extractClaims('Input', 'test-key');
      expect(result).toEqual([]);
    });

    it('should return empty array when response.text is empty string', async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: '' });

      const result = await extractClaims('Input', 'test-key');
      expect(result).toEqual([]);
    });

    it('should include image data in request when image is provided', async () => {
      const mockClaims = [{ id: 'c1', text: 'Chart shows growth.', type: 'interpretation', importance: 4 }];
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockClaims),
      });

      const image = { data: 'base64data', mimeType: 'image/png' };
      const result = await extractClaims('', 'test-key', image);
      expect(result).toEqual(mockClaims);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      // Verify the call included image parts
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.contents.parts).toBeDefined();
      expect(callArgs.contents.parts[0]).toEqual({
        inlineData: { mimeType: 'image/png', data: 'base64data' },
      });
    });

    it('should use gemini-2.5-flash model', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: '[]',
      });

      await extractClaims('Input', 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.model).toBe('gemini-2.5-flash');
    });

    it('should request JSON response schema', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: '[]',
      });

      await extractClaims('Input', 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.responseMimeType).toBe('application/json');
      expect(callArgs.config.responseSchema).toBeDefined();
      expect(callArgs.config.responseSchema.type).toBe('ARRAY');
    });

    it('should handle response with only text (no image)', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: '[{"id":"c1","text":"Claim","type":"fact","importance":3}]',
      });

      await extractClaims('Just text', 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      // Should not have inlineData part
      expect(callArgs.contents.parts).toHaveLength(1);
      expect(callArgs.contents.parts[0].text).toBeDefined();
    });
  });

  describe('verifyClaim', () => {
    const mockClaim: Claim = { id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 4 };

    it('should throw when apiKey is empty', async () => {
      await expect(verifyClaim(mockClaim, '')).rejects.toThrow('API Key required');
    });

    it('should return supported result on valid JSON response', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'Evidence confirms.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.claimId).toBe('c1');
      expect(result.status).toBe('supported');
      expect(result.explanation).toBe('Evidence confirms.');
    });

    it('should return contradicted result', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'contradicted', explanation: 'Evidence disagrees.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.status).toBe('contradicted');
    });

    it('should return mixed result', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'mixed', explanation: 'Inconclusive.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.status).toBe('mixed');
    });

    it('should extract grounding sources from response', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
        candidates: [{
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'Wikipedia', uri: 'https://en.wikipedia.org/wiki/Sky' } },
              { web: { title: 'NASA', uri: 'https://nasa.gov/sky' } },
            ],
          },
        }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources).toHaveLength(2);
      expect(result.sources[0].title).toBe('Wikipedia');
      expect(result.sources[1].uri).toBe('https://nasa.gov/sky');
    });

    it('should deduplicate sources by URI', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'Source A', uri: 'https://example.com' } },
              { web: { title: 'Source B', uri: 'https://example.com' } },
              { web: { title: 'Source C', uri: 'https://other.com' } },
            ],
          },
        }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources).toHaveLength(2);
    });

    it('should limit sources to 3', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'S1', uri: 'https://1.com' } },
              { web: { title: 'S2', uri: 'https://2.com' } },
              { web: { title: 'S3', uri: 'https://3.com' } },
              { web: { title: 'S4', uri: 'https://4.com' } },
            ],
          },
        }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources).toHaveLength(3);
    });

    it('should fallback to mixed status when JSON parse fails', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: 'The claim appears partially correct but lacks full evidence.',
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.status).toBe('mixed');
      expect(result.explanation).toContain('The claim appears partially correct');
    });

    it('should default to unverified when status is missing', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ explanation: 'No clear evidence.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.status).toBe('unverified');
    });

    it('should default explanation when missing', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.explanation).toBe('No structural analysis provided.');
    });

    it('should handle API error gracefully', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('Network error'));

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.claimId).toBe('c1');
      expect(result.status).toBe('unverified');
      expect(result.explanation).toBe('Stress-test failed due to technical error.');
      expect(result.sources).toEqual([]);
    });

    it('should handle missing groundingMetadata', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{}],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources).toEqual([]);
    });

    it('should handle missing candidates entirely', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources).toEqual([]);
    });

    it('should skip non-web grounding chunks', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{
          groundingMetadata: {
            groundingChunks: [
              { notWeb: { some: 'data' } },
              { web: { title: 'Valid', uri: 'https://valid.com' } },
            ],
          },
        }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].title).toBe('Valid');
    });

    it('should use "Source" as default title for web chunks without title', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://notitle.com' } },
            ],
          },
        }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      expect(result.sources[0].title).toBe('Source');
    });

    it('should configure google search tool in request', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      await verifyClaim(mockClaim, 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.tools).toEqual([{ googleSearch: {} }]);
    });

    it('should handle empty JSON response text', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: '',
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const result = await verifyClaim(mockClaim, 'test-key');
      // Empty text leads to cleanJson returning '' which throws, falls to mixed fallback
      // But '' is falsy so the outer condition makes it throw "Empty JSON", then fallback
      expect(result.status).toBe('unverified');
    });
  });

  describe('generateCritiqueAndPrompt', () => {
    const failedClaims: Claim[] = [
      { id: 'c1', text: 'GDP grew 10%.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Unemployment is 2%.', type: 'fact', importance: 4 },
    ];

    it('should return auth error when apiKey is empty', async () => {
      const result = await generateCritiqueAndPrompt('some text', failedClaims, '');
      expect(result.critique).toBe('Auth Error');
      expect(result.improvedPrompt).toBe('Missing API Key');
    });

    it('should parse valid critique response', async () => {
      const mockResponse = {
        critique: 'Foundation unstable — two load-bearing facts fractured.',
        improvedPrompt: 'Provide GDP data with World Bank sources.',
      };
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockResponse),
      });

      const result = await generateCritiqueAndPrompt('Original text', failedClaims, 'test-key');
      expect(result.critique).toBe(mockResponse.critique);
      expect(result.improvedPrompt).toBe(mockResponse.improvedPrompt);
    });

    it('should handle API error gracefully', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('Timeout'));

      const result = await generateCritiqueAndPrompt('Text', failedClaims, 'test-key');
      expect(result.critique).toBe('Analysis incomplete.');
      expect(result.improvedPrompt).toBe('Verify facts before trusting AI outputs.');
    });

    it('should use responseMimeType application/json', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ critique: 'OK', improvedPrompt: 'Better' }),
      });

      await generateCritiqueAndPrompt('Text', failedClaims, 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.responseMimeType).toBe('application/json');
    });

    it('should truncate original text to 500 chars in prompt', async () => {
      const longText = 'A'.repeat(1000);
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ critique: 'OK', improvedPrompt: 'Better' }),
      });

      await generateCritiqueAndPrompt(longText, failedClaims, 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      // The prompt content includes substring(0, 500)
      expect(callArgs.contents).toContain('A'.repeat(500));
      expect(callArgs.contents).not.toContain('A'.repeat(501));
    });

    it('should include failed claim texts in prompt', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ critique: 'OK', improvedPrompt: 'Better' }),
      });

      await generateCritiqueAndPrompt('Text', failedClaims, 'test-key');
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.contents).toContain('GDP grew 10%.');
      expect(callArgs.contents).toContain('Unemployment is 2%.');
    });

    it('should handle JSON wrapped in markdown code blocks', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: '```json\n{"critique":"Fragile","improvedPrompt":"Cite sources"}\n```',
      });

      const result = await generateCritiqueAndPrompt('Text', failedClaims, 'test-key');
      expect(result.critique).toBe('Fragile');
      expect(result.improvedPrompt).toBe('Cite sources');
    });
  });
});
