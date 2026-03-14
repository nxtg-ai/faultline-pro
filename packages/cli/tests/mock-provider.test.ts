import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @google/genai so provider imports don't fail
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

// Mock fetch so claude_provider can be imported
vi.stubGlobal('fetch', vi.fn());

import { createMockProvider } from '../providers/mock_provider';
import { getProvider, listProviders, registerProvider } from '../providers/registry';
import type { LLMProvider, ProviderFactory } from '../providers/base_provider';
import type { Claim } from '../types';

describe('MockProvider — Interface Compliance', () => {
  it('should implement LLMProvider interface', () => {
    const provider = createMockProvider('');
    expect(provider.name).toBeDefined();
    expect(provider.modelId).toBeDefined();
    expect(typeof provider.extractClaims).toBe('function');
    expect(typeof provider.verifyClaim).toBe('function');
    expect(typeof provider.generateCritiqueAndPrompt).toBe('function');
  });

  it('should expose correct provider name', () => {
    const provider = createMockProvider('');
    expect(provider.name).toBe('Mock Provider');
  });

  it('should expose correct model ID', () => {
    const provider = createMockProvider('');
    expect(provider.modelId).toBe('mock-v1');
  });

  it('factory should satisfy ProviderFactory type', () => {
    const factory: ProviderFactory = createMockProvider;
    const provider = factory('');
    expect(provider.name).toBe('Mock Provider');
  });

  it('should create independent instances', () => {
    const p1 = createMockProvider('');
    const p2 = createMockProvider('');
    expect(p1).not.toBe(p2);
  });
});

describe('MockProvider — extractClaims', () => {
  it('should extract claims from text', async () => {
    const provider = createMockProvider('');
    const claims = await provider.extractClaims('First sentence. Second sentence.');
    expect(claims).toHaveLength(2);
    expect(claims[0].id).toBe('c1');
    expect(claims[0].text).toBe('First sentence');
    expect(claims[0].type).toBe('fact');
    expect(claims[0].importance).toBeGreaterThanOrEqual(3);
    expect(claims[1].id).toBe('c2');
  });

  it('should return empty array for empty input', async () => {
    const provider = createMockProvider('');
    const claims = await provider.extractClaims('');
    expect(claims).toEqual([]);
  });

  it('should handle multiple sentence terminators', async () => {
    const provider = createMockProvider('');
    const claims = await provider.extractClaims('Question? Exclamation! Statement.');
    expect(claims).toHaveLength(3);
  });

  it('should assign increasing importance (capped at 5)', async () => {
    const provider = createMockProvider('');
    const claims = await provider.extractClaims('A. B. C. D. E. F. G.');
    expect(claims[0].importance).toBe(3);
    expect(claims[1].importance).toBe(3);
    expect(claims[2].importance).toBe(4);
    // importance caps at 5
    expect(claims.every(c => c.importance <= 5)).toBe(true);
  });
});

describe('MockProvider — verifyClaim', () => {
  it('should return supported status for any claim', async () => {
    const provider = createMockProvider('');
    const claim: Claim = { id: 'c1', text: 'Test claim', type: 'fact', importance: 5 };
    const result = await provider.verifyClaim(claim);
    expect(result.claimId).toBe('c1');
    expect(result.status).toBe('supported');
    expect(result.explanation).toContain('Mock');
    expect(result.sources).toEqual([]);
  });

  it('should use the claim ID from input', async () => {
    const provider = createMockProvider('');
    const claim: Claim = { id: 'xyz', text: 'Any', type: 'fact', importance: 1 };
    const result = await provider.verifyClaim(claim);
    expect(result.claimId).toBe('xyz');
  });
});

describe('MockProvider — generateCritiqueAndPrompt', () => {
  it('should return deterministic critique', async () => {
    const provider = createMockProvider('');
    const result = await provider.generateCritiqueAndPrompt('text', []);
    expect(result.critique).toBe('Mock assessment: stable.');
    expect(result.improvedPrompt).toBe('No changes needed.');
  });
});

describe('Provider Registry — Mock Provider Integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should list mock as a registered provider', () => {
    const providers = listProviders();
    expect(providers).toContain('mock');
  });

  it('should return mock provider via getProvider', () => {
    const provider = getProvider('', 'mock');
    expect(provider.name).toBe('Mock Provider');
    expect(provider.modelId).toBe('mock-v1');
  });

  it('should return gemini by default (not mock)', () => {
    const provider = getProvider('test-key');
    expect(provider.name).toBe('Google Gemini');
  });

  it('should use FAULTLINE_PROVIDER=mock env var', () => {
    process.env.FAULTLINE_PROVIDER = 'mock';
    const provider = getProvider('');
    expect(provider.name).toBe('Mock Provider');
  });

  it('should prefer explicit name over env var for mock', () => {
    process.env.FAULTLINE_PROVIDER = 'gemini';
    const provider = getProvider('', 'mock');
    expect(provider.name).toBe('Mock Provider');
  });

  it('mock provider should not require an API key', () => {
    expect(() => getProvider('', 'mock')).not.toThrow();
  });

  it('should switch between providers seamlessly', () => {
    const mock = getProvider('', 'mock');
    const gemini = getProvider('test-key', 'gemini');
    const claude = getProvider('test-key', 'claude');

    expect(mock.name).toBe('Mock Provider');
    expect(gemini.name).toBe('Google Gemini');
    expect(claude.name).toBe('Anthropic Claude');

    // All share the same interface
    for (const p of [mock, gemini, claude]) {
      expect(typeof p.extractClaims).toBe('function');
      expect(typeof p.verifyClaim).toBe('function');
      expect(typeof p.generateCritiqueAndPrompt).toBe('function');
    }
  });

  it('should support fallback to mock when other providers would fail', async () => {
    // Mock provider works with empty API key — no network calls
    const provider = getProvider('', 'mock');
    const claims = await provider.extractClaims('Test sentence.');
    expect(claims.length).toBeGreaterThan(0);

    const verification = await provider.verifyClaim(claims[0]);
    expect(verification.status).toBe('supported');
  });
});
