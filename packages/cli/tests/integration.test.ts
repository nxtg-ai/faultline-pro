import { describe, it, expect, vi, beforeEach } from 'vitest';

// Validates: N-01 (Multi-Provider Pipeline), N-02 (CLI Tool)

// MOCK JUSTIFIED: @google/genai is an external LLM API — mocked to keep tests
// deterministic and key-free. These tests exercise CLI pipeline logic (claim
// extraction shape, verification result handling, risk scoring, critique
// generation), not the Gemini network layer. Provider integration is covered
// by real provider tests in pipeline-providers.test.ts.
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
import { createGeminiProvider } from '../providers/gemini_provider';
import type { Claim, VerificationResult, AnalysisState } from '../types';

/**
 * Replicates calculateRisk from App.tsx
 */
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

/**
 * Replicates claim filtering from App.tsx
 */
function filterClaimsForVerification(claims: Claim[]): Claim[] {
  return claims
    .filter((c) => c.type === 'fact' && c.importance >= 3)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
}

describe('Integration: Full Pipeline (Mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run extract → filter → verify → risk scoring pipeline', async () => {
    // Step 1: Mock extraction response
    const extractedClaims: Claim[] = [
      { id: 'c1', text: 'The population of France is 67 million.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Paris is beautiful.', type: 'opinion', importance: 2 },
      { id: 'c3', text: 'GDP growth suggests recovery.', type: 'interpretation', importance: 4 },
      { id: 'c4', text: 'The Eiffel Tower is 330m tall.', type: 'fact', importance: 4 },
      { id: 'c5', text: 'France borders Italy.', type: 'fact', importance: 3 },
    ];

    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify(extractedClaims),
    });

    // Step 1: Extract
    const claims = await extractClaims('Some text about France', 'test-key');
    expect(claims).toHaveLength(5);

    // Step 2: Filter (only facts with importance >= 3)
    const toVerify = filterClaimsForVerification(claims);
    expect(toVerify).toHaveLength(3);
    expect(toVerify[0].id).toBe('c1'); // importance 5
    expect(toVerify[1].id).toBe('c4'); // importance 4
    expect(toVerify[2].id).toBe('c5'); // importance 3

    // Step 3: Verify each claim
    // c1 → supported
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'Confirmed by census data.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 'INSEE', uri: 'https://insee.fr' } }] } }],
    });
    // c4 → contradicted
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'contradicted', explanation: 'Actually 330m including antenna.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    // c5 → supported
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'Confirmed by geography.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await verifyClaim(claim, 'test-key');
    }

    expect(verifications['c1'].status).toBe('supported');
    expect(verifications['c4'].status).toBe('contradicted');
    expect(verifications['c5'].status).toBe('supported');

    // Step 4: Risk scoring
    const risk = calculateRisk(verifications);
    expect(risk).toBe('high'); // 1 contradicted → high
  });

  it('should produce low risk when all claims are supported', async () => {
    const claims: Claim[] = [
      { id: 'c1', text: 'Water is H2O.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Earth orbits the Sun.', type: 'fact', importance: 4 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(claims) });

    const extracted = await extractClaims('Science facts', 'test-key');
    const toVerify = filterClaimsForVerification(extracted);
    expect(toVerify).toHaveLength(2); // CRUCIBLE Gate 2: assert non-empty before verifying

    // All supported
    for (const claim of toVerify) {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
    }

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await verifyClaim(claim, 'test-key');
    }

    expect(calculateRisk(verifications)).toBe('low');
  });

  it('should produce critical risk with 3+ contradictions', async () => {
    const claims: Claim[] = [
      { id: 'c1', text: 'Claim A', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Claim B', type: 'fact', importance: 5 },
      { id: 'c3', text: 'Claim C', type: 'fact', importance: 5 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(claims) });

    const extracted = await extractClaims('Bad info', 'test-key');
    const toVerify = filterClaimsForVerification(extracted);

    for (const claim of toVerify) {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'contradicted', explanation: 'Wrong.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
    }

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await verifyClaim(claim, 'test-key');
    }

    expect(calculateRisk(verifications)).toBe('critical');
  });

  it('should handle extraction failure gracefully in pipeline', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('API down'));

    const claims = await extractClaims('Input', 'test-key');
    expect(claims).toEqual([]);

    // No claims → no verifications → low risk
    const toVerify = filterClaimsForVerification(claims);
    expect(toVerify).toHaveLength(0);
    expect(calculateRisk({})).toBe('low');
  });

  it('should handle verification failure gracefully in pipeline', async () => {
    const claims: Claim[] = [{ id: 'c1', text: 'Claim', type: 'fact', importance: 5 }];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(claims) });

    const extracted = await extractClaims('Test', 'test-key');
    const toVerify = filterClaimsForVerification(extracted);

    // Verification fails
    mockGenerateContent.mockRejectedValueOnce(new Error('Rate limit'));

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await verifyClaim(claim, 'test-key');
    }

    // Failed verification → unverified → low risk (not contradicted)
    expect(verifications['c1'].status).toBe('unverified');
    expect(calculateRisk(verifications)).toBe('low');
  });

  it('should run full pipeline through provider abstraction', async () => {
    const provider = createGeminiProvider('test-key');

    // Extraction
    const mockClaims = [
      { id: 'c1', text: 'Fact claim.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Opinion claim.', type: 'opinion', importance: 3 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(mockClaims) });
    const claims = await provider.extractClaims('Test input');
    expect(claims).toHaveLength(2);

    // Verify through provider
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'OK.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    const verification = await provider.verifyClaim(claims[0]);
    expect(verification.status).toBe('supported');

    // Critique through provider
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ critique: 'Stable.', improvedPrompt: 'Good as-is.' }),
    });
    const critique = await provider.generateCritiqueAndPrompt('original', [claims[0]]);
    expect(critique.critique).toBe('Stable.');
  });

  it('should filter opinions and low-importance facts from verification', async () => {
    const claims: Claim[] = [
      { id: 'c1', text: 'Important fact', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Unimportant fact', type: 'fact', importance: 1 },
      { id: 'c3', text: 'Strong opinion', type: 'opinion', importance: 5 },
      { id: 'c4', text: 'Interpretation', type: 'interpretation', importance: 5 },
      { id: 'c5', text: 'Borderline fact', type: 'fact', importance: 3 },
    ];

    const toVerify = filterClaimsForVerification(claims);
    expect(toVerify).toHaveLength(2);
    expect(toVerify.map(c => c.id)).toEqual(['c1', 'c5']);
  });
});
