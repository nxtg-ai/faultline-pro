import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @google/genai so gemini_provider can be imported
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

// Mock fetch so claude_provider can be imported
vi.stubGlobal('fetch', vi.fn());

import { getProvider, registerProvider, listProviders } from '../providers/registry';
import type { LLMProvider, ProviderFactory } from '../providers/base_provider';

describe('Provider Registry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getProvider', () => {
    it('should return Gemini provider by default', () => {
      const provider = getProvider('test-key');
      expect(provider.name).toBe('Google Gemini');
    });

    it('should return Gemini provider when explicitly requested', () => {
      const provider = getProvider('test-key', 'gemini');
      expect(provider.name).toBe('Google Gemini');
    });

    it('should return Claude provider when requested', () => {
      const provider = getProvider('test-key', 'claude');
      expect(provider.name).toBe('Anthropic Claude');
    });

    it('should throw for unknown provider', () => {
      expect(() => getProvider('test-key', 'gpt-5')).toThrow('Unknown provider "gpt-5"');
    });

    it('should include available providers in error message', () => {
      expect(() => getProvider('test-key', 'nonexistent')).toThrow(/Available:.*gemini.*claude/);
    });

    it('should use FAULTLINE_PROVIDER env var as fallback', () => {
      process.env.FAULTLINE_PROVIDER = 'claude';
      const provider = getProvider('test-key');
      expect(provider.name).toBe('Anthropic Claude');
    });

    it('should prefer explicit name over env var', () => {
      process.env.FAULTLINE_PROVIDER = 'claude';
      const provider = getProvider('test-key', 'gemini');
      expect(provider.name).toBe('Google Gemini');
    });
  });

  describe('registerProvider', () => {
    it('should register a custom provider', () => {
      const mockFactory: ProviderFactory = (apiKey: string): LLMProvider => ({
        name: 'Custom Provider',
        modelId: 'custom-v1',
        extractClaims: vi.fn(),
        verifyClaim: vi.fn(),
        generateCritiqueAndPrompt: vi.fn(),
      });

      registerProvider('custom', mockFactory);
      const provider = getProvider('test-key', 'custom');
      expect(provider.name).toBe('Custom Provider');
    });
  });

  describe('listProviders', () => {
    it('should include gemini and claude', () => {
      const providers = listProviders();
      expect(providers).toContain('gemini');
      expect(providers).toContain('claude');
    });

    it('should return an array of strings', () => {
      const providers = listProviders();
      expect(Array.isArray(providers)).toBe(true);
      providers.forEach((p) => expect(typeof p).toBe('string'));
    });
  });
});
