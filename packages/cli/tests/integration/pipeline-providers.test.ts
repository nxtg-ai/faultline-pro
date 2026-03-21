import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Validates: N-01 (Multi-Provider Pipeline — provider registry, registration, listing)

// MOCK JUSTIFIED: @google/genai is an external LLM API; global fetch is used by
// Claude/OpenAI providers. Mocked to verify provider registry operations (register,
// get, list, default) and per-provider extract/verify shapes without live credentials.
const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

// Mock fetch for Claude
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { getProvider, registerProvider, listProviders } from '../../providers/registry';
import { createOpenAIProvider } from '../../providers/openai_provider';
import { generateComplianceReport } from '../../compliance/report_generator';
import { mapClaimToRiskCategory } from '../../compliance/eu_ai_act';
import type { Claim, VerificationResult, AnalysisState } from '../../types';
import type { LLMProvider, CritiqueResult } from '../../providers/base_provider';

// --- Shared helpers ---

function calculateRisk(
  verifications: Record<string, VerificationResult>,
): AnalysisState['overallRisk'] {
  const values = Object.values(verifications);
  const contradicted = values.filter((v) => v.status === 'contradicted').length;
  const mixed = values.filter((v) => v.status === 'mixed').length;
  if (contradicted > 2) return 'critical';
  if (contradicted > 0 || mixed > 2) return 'high';
  if (mixed > 0) return 'medium';
  return 'low';
}

function filterClaimsForVerification(claims: Claim[]): Claim[] {
  return claims
    .filter((c) => c.type === 'fact' && c.importance >= 3)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
}

const SAMPLE_INPUT = 'AI hiring tools screen candidates. Water boils at 100C. Sunsets are beautiful.';

const SAMPLE_CLAIMS: Claim[] = [
  { id: 'c1', text: 'AI hiring tools screen candidates.', type: 'fact', importance: 5 },
  { id: 'c2', text: 'Water boils at 100C at sea level.', type: 'fact', importance: 4 },
  { id: 'c3', text: 'Sunsets are beautiful.', type: 'opinion', importance: 2 },
];

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

/**
 * Run the full pipeline through any LLMProvider: extract → filter → verify → risk → EU map → report.
 */
async function runFullPipeline(provider: LLMProvider) {
  const claims = await provider.extractClaims(SAMPLE_INPUT);
  const toVerify = filterClaimsForVerification(claims);

  const verifications: Record<string, VerificationResult> = {};
  for (const claim of toVerify) {
    verifications[claim.id] = await provider.verifyClaim(claim);
  }

  const risk = calculateRisk(verifications);
  const report = generateComplianceReport(toVerify, verifications, risk);
  return { claims, toVerify, verifications, risk, report };
}

// Note: OpenAI provider is now a real provider (providers/openai_provider.ts)
// registered in the factory by default. We use fetch mocks for its API calls.

// ================================================================

describe('Integration: Multi-Provider Pipeline', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // --- 1. Full pipeline per provider ---

  describe('full pipeline per provider', () => {
    it('Gemini: extract → filter → verify → risk → EU map → report', async () => {
      // Extraction
      mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(SAMPLE_CLAIMS) });
      // c1 → supported
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
      // c2 → contradicted
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'contradicted', explanation: 'Actually 99.97C.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      const provider = getProvider('gemini-key', 'gemini');
      const { claims, toVerify, verifications, risk, report } = await runFullPipeline(provider);

      expect(claims).toHaveLength(3);
      expect(toVerify).toHaveLength(2); // c3 is opinion
      expect(verifications['c1'].status).toBe('supported');
      expect(verifications['c2'].status).toBe('contradicted');
      expect(risk).toBe('high');
      expect(report.euRiskSummary.highestTier).toBe('high'); // c1 matches employment/hiring domain
      expect(report.claimMappings).toHaveLength(2);
    });

    it('Claude: extract → filter → verify → risk → EU map → report', async () => {
      // Extraction
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(SAMPLE_CLAIMS)));
      // c1 → supported
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'supported', explanation: 'Confirmed.' })),
      );
      // c2 → mixed
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'mixed', explanation: 'Depends on pressure.' })),
      );

      const provider = getProvider('claude-key', 'claude');
      const { claims, toVerify, verifications, risk, report } = await runFullPipeline(provider);

      expect(claims).toHaveLength(3);
      expect(toVerify).toHaveLength(2);
      expect(verifications['c1'].status).toBe('supported');
      expect(verifications['c2'].status).toBe('mixed');
      expect(risk).toBe('medium');
      expect(report.euRiskSummary.limited).toBe(1); // c2 mixed → limited
      expect(report.claimMappings).toHaveLength(2);
    });

    it('OpenAI: extract → filter → verify → risk → EU map → report', async () => {
      // Extraction
      mockFetch.mockResolvedValueOnce(mockOpenAIResponse(JSON.stringify({ claims: SAMPLE_CLAIMS })));
      // c1 → supported
      mockFetch.mockResolvedValueOnce(
        mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'Confirmed.' })),
      );
      // c2 → supported
      mockFetch.mockResolvedValueOnce(
        mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'Correct.' })),
      );

      const provider = getProvider('openai-key', 'openai');
      expect(provider.name).toBe('OpenAI');

      const { claims, toVerify, verifications, risk, report } = await runFullPipeline(provider);

      expect(claims).toHaveLength(3);
      expect(toVerify).toHaveLength(2);
      expect(verifications['c1'].status).toBe('supported');
      expect(verifications['c2'].status).toBe('supported');
      expect(risk).toBe('low');
      expect(report.euRiskSummary.totalClaims).toBe(2);
      expect(report.mitigations.length).toBeGreaterThan(0);
    });
  });

  // --- 2. Provider switching ---

  describe('provider switching via registry', () => {
    it('same input produces valid reports regardless of provider', async () => {
      // Gemini
      mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(SAMPLE_CLAIMS) });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });

      // Claude
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(SAMPLE_CLAIMS)));
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );

      // OpenAI
      mockFetch.mockResolvedValueOnce(mockOpenAIResponse(JSON.stringify({ claims: SAMPLE_CLAIMS })));
      mockFetch.mockResolvedValueOnce(
        mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );
      mockFetch.mockResolvedValueOnce(
        mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );

      const reports = [];
      for (const name of ['gemini', 'claude', 'openai']) {
        const provider = getProvider('key', name);
        const result = await runFullPipeline(provider);
        reports.push(result.report);
      }

      // All 3 reports have valid structure
      for (const report of reports) {
        expect(report.generatedAt).toBeTruthy();
        expect(report.euRiskSummary).toBeDefined();
        expect(report.claimMappings).toBeDefined();
        expect(report.triggeredArticles).toBeDefined();
        expect(report.mitigations).toBeDefined();
        expect(report.euRiskSummary.totalClaims).toBe(2);
      }
    });

    it('registry env var switches provider without code changes', async () => {
      process.env.FAULTLINE_PROVIDER = 'claude';

      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(SAMPLE_CLAIMS)));
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );
      mockFetch.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );

      // getProvider with no explicit name should use env var
      const provider = getProvider('key');
      expect(provider.name).toBe('Anthropic Claude');

      const { report } = await runFullPipeline(provider);
      expect(report.euRiskSummary.totalClaims).toBe(2);
    });

    it('openai provider is registered by default and integrates with full pipeline', async () => {
      expect(listProviders()).toContain('openai');

      // Mock all three fetch calls: extract + 2 verifications
      mockFetch.mockResolvedValueOnce(mockOpenAIResponse(JSON.stringify({ claims: SAMPLE_CLAIMS })));
      mockFetch.mockResolvedValueOnce(
        mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );
      mockFetch.mockResolvedValueOnce(
        mockOpenAIResponse(JSON.stringify({ status: 'supported', explanation: 'OK.' })),
      );

      const provider = getProvider('key', 'openai');
      const { report } = await runFullPipeline(provider);

      expect(report.overallRiskLevel).toBe('low');
      expect(report.euRiskSummary.highestTier).toBe('high'); // c1 hiring → high domain
    });
  });

  // --- 3. Error propagation ---

  describe('error propagation through pipeline', () => {
    it('Gemini extraction failure → empty report with mitigation', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('Gemini 500'));

      const provider = getProvider('key', 'gemini');
      const { claims, report } = await runFullPipeline(provider);

      expect(claims).toEqual([]);
      expect(report.euRiskSummary.totalClaims).toBe(0);
      expect(report.mitigations.some((m) => m.includes('No verified claims'))).toBe(true);
    });

    it('Claude extraction failure → empty report with mitigation', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Claude 429'));

      const provider = getProvider('key', 'claude');
      const { claims, report } = await runFullPipeline(provider);

      expect(claims).toEqual([]);
      expect(report.euRiskSummary.totalClaims).toBe(0);
      expect(report.mitigations.some((m) => m.includes('No verified claims'))).toBe(true);
    });

    it('Gemini verification failure mid-pipeline → unverified + low risk report', async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(SAMPLE_CLAIMS) });
      // Both verifications fail
      mockGenerateContent.mockRejectedValueOnce(new Error('Rate limited'));
      mockGenerateContent.mockRejectedValueOnce(new Error('Rate limited'));

      const provider = getProvider('key', 'gemini');
      const { verifications, risk, report } = await runFullPipeline(provider);

      expect(verifications['c1'].status).toBe('unverified');
      expect(verifications['c2'].status).toBe('unverified');
      expect(risk).toBe('low');
      // c1 "hiring" still matches Annex III domain even when unverified
      expect(report.euRiskSummary.high).toBe(1);
      expect(report.euRiskSummary.minimal).toBe(1);
    });

    it('Claude verification failure mid-pipeline → unverified + low risk report', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse(JSON.stringify(SAMPLE_CLAIMS)));
      mockFetch.mockRejectedValueOnce(new Error('Timeout'));
      mockFetch.mockRejectedValueOnce(new Error('Timeout'));

      const provider = getProvider('key', 'claude');
      const { verifications, risk, report } = await runFullPipeline(provider);

      expect(verifications['c1'].status).toBe('unverified');
      expect(verifications['c2'].status).toBe('unverified');
      expect(risk).toBe('low');
      // Same domain matching behavior as Gemini
      expect(report.euRiskSummary.high).toBe(1);
      expect(report.euRiskSummary.minimal).toBe(1);
    });

    it('partial verification failure → report includes both verified and unverified', async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(SAMPLE_CLAIMS) });
      // c1 succeeds
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'contradicted', explanation: 'Wrong.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
      // c2 fails
      mockGenerateContent.mockRejectedValueOnce(new Error('Timeout'));

      const provider = getProvider('key', 'gemini');
      const { verifications, risk, report } = await runFullPipeline(provider);

      expect(verifications['c1'].status).toBe('contradicted');
      expect(verifications['c2'].status).toBe('unverified');
      expect(risk).toBe('high'); // 1 contradicted
      expect(report.claimMappings).toHaveLength(2);
    });

    it('unknown provider → throws structured error', () => {
      expect(() => getProvider('key', 'bedrock')).toThrow(/Unknown provider "bedrock"/);
      expect(() => getProvider('key', 'bedrock')).toThrow(/Available:/);
    });
  });
});
