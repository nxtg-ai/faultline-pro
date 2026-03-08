import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @google/genai before importing providers
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

import { createGeminiProvider } from '../providers/gemini_provider';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from '../providers/base_provider';
import type { Claim, VerificationResult } from '../types';

describe('Provider Abstraction Layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('base_provider.ts — Interface Compliance', () => {
    it('GeminiProvider should implement LLMProvider interface', () => {
      const provider = createGeminiProvider('test-key');
      expect(provider.name).toBeDefined();
      expect(provider.modelId).toBeDefined();
      expect(typeof provider.extractClaims).toBe('function');
      expect(typeof provider.verifyClaim).toBe('function');
      expect(typeof provider.generateCritiqueAndPrompt).toBe('function');
    });

    it('should expose correct provider name', () => {
      const provider = createGeminiProvider('test-key');
      expect(provider.name).toBe('Google Gemini');
    });

    it('should expose correct model ID', () => {
      const provider = createGeminiProvider('test-key');
      expect(provider.modelId).toBe('gemini-2.5-flash');
    });

    it('name and modelId should be string properties', () => {
      const provider = createGeminiProvider('test-key');
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.modelId).toBe('string');
      expect(provider.name.length).toBeGreaterThan(0);
      expect(provider.modelId.length).toBeGreaterThan(0);
    });
  });

  describe('createGeminiProvider factory', () => {
    it('should return an LLMProvider instance', () => {
      const provider = createGeminiProvider('test-key');
      expect(provider).toBeDefined();
      expect(provider.name).toBe('Google Gemini');
    });

    it('should accept an API key parameter', () => {
      // Should not throw
      expect(() => createGeminiProvider('any-key')).not.toThrow();
    });

    it('should create independent instances', () => {
      const provider1 = createGeminiProvider('key-1');
      const provider2 = createGeminiProvider('key-2');
      expect(provider1).not.toBe(provider2);
    });

    it('factory should satisfy ProviderFactory type', () => {
      const factory: ProviderFactory = createGeminiProvider;
      const provider = factory('test-key');
      expect(provider.name).toBe('Google Gemini');
    });
  });

  describe('GeminiProvider.extractClaims', () => {
    it('should delegate to geminiService extractClaims', async () => {
      const mockClaims = [
        { id: 'c1', text: 'Test claim', type: 'fact', importance: 4 },
      ];
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockClaims),
      });

      const provider = createGeminiProvider('test-key');
      const result = await provider.extractClaims('Test text');
      expect(result).toEqual(mockClaims);
    });

    it('should pass image input through', async () => {
      const mockClaims = [{ id: 'c1', text: 'Image claim', type: 'fact', importance: 3 }];
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockClaims),
      });

      const provider = createGeminiProvider('test-key');
      const image: ImageInput = { data: 'base64', mimeType: 'image/png' };
      const result = await provider.extractClaims('', image);
      expect(result).toEqual(mockClaims);
    });

    it('should return empty array for empty input', async () => {
      const provider = createGeminiProvider('test-key');
      const result = await provider.extractClaims('');
      expect(result).toEqual([]);
    });
  });

  describe('GeminiProvider.verifyClaim', () => {
    it('should delegate to geminiService verifyClaim', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const provider = createGeminiProvider('test-key');
      const claim: Claim = { id: 'c1', text: 'Test', type: 'fact', importance: 5 };
      const result = await provider.verifyClaim(claim);
      expect(result.claimId).toBe('c1');
      expect(result.status).toBe('supported');
    });

    it('should handle verification errors gracefully', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('Timeout'));

      const provider = createGeminiProvider('test-key');
      const claim: Claim = { id: 'c2', text: 'Test', type: 'fact', importance: 3 };
      const result = await provider.verifyClaim(claim);
      expect(result.status).toBe('unverified');
    });
  });

  describe('GeminiProvider.generateCritiqueAndPrompt', () => {
    it('should delegate to geminiService generateCritiqueAndPrompt', async () => {
      const mockResult = {
        critique: 'Foundation fragile.',
        improvedPrompt: 'Add citations.',
      };
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockResult),
      });

      const provider = createGeminiProvider('test-key');
      const claims: Claim[] = [{ id: 'c1', text: 'Bad claim', type: 'fact', importance: 5 }];
      const result = await provider.generateCritiqueAndPrompt('original', claims);
      expect(result.critique).toBe('Foundation fragile.');
      expect(result.improvedPrompt).toBe('Add citations.');
    });

    it('should handle errors with fallback response', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('API error'));

      const provider = createGeminiProvider('test-key');
      const result = await provider.generateCritiqueAndPrompt('text', []);
      expect(result.critique).toBe('Analysis incomplete.');
    });
  });
});
