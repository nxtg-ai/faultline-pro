import { describe, it, expect, vi, beforeEach } from 'vitest';

// Validates: N-01 (Multi-Provider Pipeline — shape contract for Gemini/Claude/OpenAI)

// MOCK JUSTIFIED: @google/genai is an external LLM API; global fetch is used by
// Claude/OpenAI providers. Mocked to verify all three provider implementations
// return the same Claim/VerificationResult shape without live credentials.
// Network behaviour is out of scope; shape contract and error normalisation are.
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

// Mock fetch for Claude provider
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createGeminiProvider } from '../../providers/gemini_provider';
import { createClaudeProvider } from '../../providers/claude_provider';
import { createOpenAIProvider } from '../../providers/openai_provider';
import { getProvider } from '../../providers/registry';
import type { Claim, VerificationResult } from '../../types';
import type { LLMProvider, CritiqueResult } from '../../providers/base_provider';

function mockAnthropicResponse(text: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ content: [{ type: 'text', text }] }),
  };
}

function mockOpenAIResponse(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const SAMPLE_CLAIMS: Claim[] = [
  { id: 'c1', text: 'The Earth is round.', type: 'fact', importance: 5 },
  { id: 'c2', text: 'Water freezes at 0C.', type: 'fact', importance: 4 },
];

describe('Integration: Multi-Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Gemini, Claude, and OpenAI should all extract claims with valid shapes', async () => {
    // Gemini extraction
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(SAMPLE_CLAIMS) });
    const gemini = createGeminiProvider('gemini-key');
    const geminiClaims = await gemini.extractClaims('Science facts');

    // Claude extraction
    mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(SAMPLE_CLAIMS)));
    const claude = createClaudeProvider('claude-key');
    const claudeClaims = await claude.extractClaims('Science facts');

    // OpenAI extraction
    mockFetch.mockResolvedValueOnce(mockOpenAIResponse(JSON.stringify({ claims: SAMPLE_CLAIMS })));
    const openai = createOpenAIProvider('openai-key');
    const openaiClaims = await openai.extractClaims('Science facts');

    // All should return valid Claim[] arrays
    for (const claims of [geminiClaims, claudeClaims, openaiClaims]) {
      expect(Array.isArray(claims)).toBe(true);
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim).toHaveProperty('id');
        expect(claim).toHaveProperty('text');
        expect(claim).toHaveProperty('type');
        expect(claim).toHaveProperty('importance');
        expect(['fact', 'opinion', 'interpretation']).toContain(claim.type);
        expect(claim.importance).toBeGreaterThanOrEqual(1);
        expect(claim.importance).toBeLessThanOrEqual(5);
      }
    }
  });

  it('Gemini, Claude, and OpenAI should all verify claims with valid shapes', async () => {
    const claim: Claim = { id: 'c1', text: 'Earth is round.', type: 'fact', importance: 5 };

    // Gemini verification
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    const gemini = createGeminiProvider('gemini-key');
    const geminiResult = await gemini.verifyClaim(claim);

    // Claude verification
    mockFetch.mockResolvedValueOnce(
      mockAnthropicResponse(JSON.stringify({ status: 'supported', explanation: 'Well established.' })),
    );
    const claude = createClaudeProvider('claude-key');
    const claudeResult = await claude.verifyClaim(claim);

    // OpenAI verification
    mockFetch.mockResolvedValueOnce(
      mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'Scientifically proven.' })),
    );
    const openai = createOpenAIProvider('openai-key');
    const openaiResult = await openai.verifyClaim(claim);

    // All should return valid VerificationResult
    for (const result of [geminiResult, claudeResult, openaiResult]) {
      expect(result).toHaveProperty('claimId');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('explanation');
      expect(result).toHaveProperty('sources');
      expect(result.claimId).toBe('c1');
      expect(['supported', 'contradicted', 'mixed', 'unverified']).toContain(result.status);
      expect(typeof result.explanation).toBe('string');
      expect(Array.isArray(result.sources)).toBe(true);
    }
  });

  it('Gemini, Claude, and OpenAI should all generate critiques with valid shapes', async () => {
    const failedClaims: Claim[] = [{ id: 'c1', text: 'Wrong claim.', type: 'fact', importance: 5 }];

    // Gemini critique
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ critique: 'Weak foundation.', improvedPrompt: 'Add sources.' }),
    });
    const gemini = createGeminiProvider('gemini-key');
    const geminiCritique = await gemini.generateCritiqueAndPrompt('original', failedClaims);

    // Claude critique
    mockFetch.mockResolvedValueOnce(
      mockAnthropicResponse(JSON.stringify({ critique: 'Unstable structure.', improvedPrompt: 'Cite evidence.' })),
    );
    const claude = createClaudeProvider('claude-key');
    const claudeCritique = await claude.generateCritiqueAndPrompt('original', failedClaims);

    // OpenAI critique
    mockFetch.mockResolvedValueOnce(
      mockOpenAIResponse(JSON.stringify({ critique: 'Needs reinforcement.', improvedPrompt: 'Provide references.' })),
    );
    const openai = createOpenAIProvider('openai-key');
    const openaiCritique = await openai.generateCritiqueAndPrompt('original', failedClaims);

    // All should return valid CritiqueResult
    for (const critique of [geminiCritique, claudeCritique, openaiCritique]) {
      expect(critique).toHaveProperty('critique');
      expect(critique).toHaveProperty('improvedPrompt');
      expect(typeof critique.critique).toBe('string');
      expect(typeof critique.improvedPrompt).toBe('string');
      expect(critique.critique.length).toBeGreaterThan(0);
      expect(critique.improvedPrompt.length).toBeGreaterThan(0);
    }
  });

  it('registry should return distinct providers with correct names', () => {
    const gemini = getProvider('key', 'gemini');
    const claude = getProvider('key', 'claude');
    const openai = getProvider('key', 'openai');

    expect(gemini.name).toBe('Google Gemini');
    expect(claude.name).toBe('Anthropic Claude');
    expect(openai.name).toBe('OpenAI');
    expect(gemini.modelId).not.toBe(claude.modelId);
    expect(openai.modelId).not.toBe(claude.modelId);
  });

  it('all providers should handle extraction errors identically (empty array)', async () => {
    // Gemini error
    mockGenerateContent.mockRejectedValueOnce(new Error('Gemini down'));
    const gemini = createGeminiProvider('key');
    const geminiResult = await gemini.extractClaims('Input');

    // Claude error
    mockFetch.mockRejectedValueOnce(new Error('Claude down'));
    const claude = createClaudeProvider('key');
    const claudeResult = await claude.extractClaims('Input');

    // OpenAI error
    mockFetch.mockRejectedValueOnce(new Error('OpenAI down'));
    const openai = createOpenAIProvider('key');
    const openaiResult = await openai.extractClaims('Input');

    expect(geminiResult).toEqual([]);
    expect(claudeResult).toEqual([]);
    expect(openaiResult).toEqual([]);
  });

  it('all providers should handle verification errors identically (unverified)', async () => {
    const claim: Claim = { id: 'c1', text: 'Claim.', type: 'fact', importance: 5 };

    // Gemini error
    mockGenerateContent.mockRejectedValueOnce(new Error('Timeout'));
    const gemini = createGeminiProvider('key');
    const geminiResult = await gemini.verifyClaim(claim);

    // Claude error
    mockFetch.mockRejectedValueOnce(new Error('Timeout'));
    const claude = createClaudeProvider('key');
    const claudeResult = await claude.verifyClaim(claim);

    // OpenAI error
    mockFetch.mockRejectedValueOnce(new Error('Timeout'));
    const openai = createOpenAIProvider('key');
    const openaiResult = await openai.verifyClaim(claim);

    expect(geminiResult.status).toBe('unverified');
    expect(claudeResult.status).toBe('unverified');
    expect(openaiResult.status).toBe('unverified');
    expect(geminiResult.claimId).toBe('c1');
    expect(claudeResult.claimId).toBe('c1');
    expect(openaiResult.claimId).toBe('c1');
  });

  it('all providers should handle critique errors identically (fallback)', async () => {
    // Gemini error
    mockGenerateContent.mockRejectedValueOnce(new Error('API error'));
    const gemini = createGeminiProvider('key');
    const geminiResult = await gemini.generateCritiqueAndPrompt('text', []);

    // Claude error
    mockFetch.mockRejectedValueOnce(new Error('API error'));
    const claude = createClaudeProvider('key');
    const claudeResult = await claude.generateCritiqueAndPrompt('text', []);

    // OpenAI error
    mockFetch.mockRejectedValueOnce(new Error('API error'));
    const openai = createOpenAIProvider('key');
    const openaiResult = await openai.generateCritiqueAndPrompt('text', []);

    // All return the same fallback structure
    for (const result of [geminiResult, claudeResult, openaiResult]) {
      expect(result.critique).toBe('Analysis incomplete.');
      expect(result.improvedPrompt).toBeTruthy();
    }
  });
});
