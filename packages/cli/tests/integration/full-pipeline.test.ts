import { describe, it, expect, vi, beforeEach } from 'vitest';

// Validates: N-01 (Multi-Provider Pipeline), N-03 (EU AI Act Compliance Module)

// MOCK JUSTIFIED: @google/genai is an external LLM API. Mocked to exercise the
// full extract→verify→risk-score→EU-tier→compliance-report pipeline with controlled
// claim text and verdicts. The real compliance and risk modules are NOT mocked —
// only the LLM network call. Deterministic input enables precise tier assertions
// (e.g. social-scoring claim → 'unacceptable' tier).
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

import { createGeminiProvider } from '../../providers/gemini_provider';
import { mapClaimToRiskCategory } from '../../compliance/eu_ai_act';
import { generateComplianceReport } from '../../compliance/report_generator';
import type { Claim, VerificationResult, AnalysisState } from '../../types';

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

describe('Integration: Full Pipeline — Extract → Score → Map → Report', () => {
  const provider = createGeminiProvider('test-key');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('golden path: 3 claims → extract, verify, risk score, EU mapping, compliance report', async () => {
    // --- Step 1: Extract ---
    const extractedClaims: Claim[] = [
      { id: 'c1', text: 'France has 67 million people.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'The hiring algorithm is bias-free.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'Coffee tastes great.', type: 'opinion', importance: 2 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(extractedClaims) });

    const claims = await provider.extractClaims('Text about France and hiring AI');
    expect(claims).toHaveLength(3);

    // --- Step 2: Filter + Verify ---
    const toVerify = filterClaimsForVerification(claims);
    expect(toVerify).toHaveLength(2); // c1 (fact, 5), c2 (fact, 4); c3 is opinion

    // c1 → supported
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'Census confirms.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 'INSEE', uri: 'https://insee.fr' } }] } }],
    });
    // c2 → contradicted (hiring claim is wrong)
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'contradicted', explanation: 'Audit found bias.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await provider.verifyClaim(claim);
    }

    expect(verifications['c1'].status).toBe('supported');
    expect(verifications['c2'].status).toBe('contradicted');

    // --- Step 3: Risk score ---
    const risk = calculateRisk(verifications);
    expect(risk).toBe('high');

    // --- Step 4: EU AI Act mapping ---
    const mappings = toVerify.map((c) => mapClaimToRiskCategory(c, verifications[c.id]));
    expect(mappings).toHaveLength(2);

    // c1 (generic supported fact) → minimal
    expect(mappings[0].riskLevel).toBe('minimal');
    // c2 (hiring + contradicted) → high (Annex III §4)
    expect(mappings[1].riskLevel).toBe('high');
    expect(mappings[1].matchedPatterns.some((p) => p.includes('Annex III'))).toBe(true);

    // --- Step 5: Compliance report ---
    const report = generateComplianceReport(toVerify, verifications, risk);
    expect(report.overallRiskLevel).toBe('high');
    expect(report.euRiskSummary.high).toBe(1);
    expect(report.euRiskSummary.minimal).toBe(1);
    expect(report.euRiskSummary.highestTier).toBe('high');
    expect(report.triggeredArticles.length).toBeGreaterThan(0);
    expect(report.mitigations.length).toBeGreaterThan(0);
  });

  it('all-supported path: low risk, minimal EU tier, voluntary mitigations', async () => {
    const extractedClaims: Claim[] = [
      { id: 'c1', text: 'Water boils at 100C at sea level.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'The Earth orbits the Sun.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'Gravity is 9.8 m/s².', type: 'fact', importance: 3 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(extractedClaims) });

    const claims = await provider.extractClaims('Science facts');
    const toVerify = filterClaimsForVerification(claims);
    expect(toVerify).toHaveLength(3);

    for (const claim of toVerify) {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
    }

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await provider.verifyClaim(claim);
    }

    const risk = calculateRisk(verifications);
    expect(risk).toBe('low');

    const report = generateComplianceReport(toVerify, verifications, risk);
    expect(report.euRiskSummary.highestTier).toBe('minimal');
    expect(report.euRiskSummary.minimal).toBe(3);
    expect(report.mitigations.some((m) => m.includes('voluntary'))).toBe(true);
  });

  it('critical path: 3 contradictions → critical risk, limited EU tier', async () => {
    const extractedClaims: Claim[] = [
      { id: 'c1', text: 'The moon is made of cheese.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'The sun orbits Earth.', type: 'fact', importance: 5 },
      { id: 'c3', text: 'Humans have 3 lungs.', type: 'fact', importance: 4 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(extractedClaims) });

    const claims = await provider.extractClaims('Bad science');
    const toVerify = filterClaimsForVerification(claims);

    for (const claim of toVerify) {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ status: 'contradicted', explanation: 'Completely wrong.' }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      });
    }

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await provider.verifyClaim(claim);
    }

    const risk = calculateRisk(verifications);
    expect(risk).toBe('critical');

    const report = generateComplianceReport(toVerify, verifications, risk);
    expect(report.euRiskSummary.highestTier).toBe('limited');
    expect(report.euRiskSummary.limited).toBe(3);
    expect(report.mitigations.some((m) => m.includes('Article 50'))).toBe(true);
  });

  it('unacceptable path: social scoring claim → compliance report flags prohibited', async () => {
    const extractedClaims: Claim[] = [
      { id: 'c1', text: 'The system uses social scoring to rank citizens by trustworthiness.', type: 'fact', importance: 5 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(extractedClaims) });

    const claims = await provider.extractClaims('Text about social scoring');
    const toVerify = filterClaimsForVerification(claims);

    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'System does rank citizens.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await provider.verifyClaim(claim);
    }

    const risk = calculateRisk(verifications);
    const report = generateComplianceReport(toVerify, verifications, risk);

    expect(report.euRiskSummary.unacceptable).toBe(1);
    expect(report.euRiskSummary.highestTier).toBe('unacceptable');
    expect(report.mitigations.some((m) => m.includes('CRITICAL'))).toBe(true);
    expect(report.triggeredArticles.some((a) => a.article.includes('Article 5'))).toBe(true);
  });

  it('extraction failure → empty report with no-claims mitigation', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('API down'));

    const claims = await provider.extractClaims('Some input');
    expect(claims).toEqual([]);

    const report = generateComplianceReport(claims, {}, 'low');
    expect(report.euRiskSummary.totalClaims).toBe(0);
    expect(report.mitigations.some((m) => m.includes('No verified claims'))).toBe(true);
  });

  it('mixed verification results → report reflects multiple tiers', async () => {
    const extractedClaims: Claim[] = [
      { id: 'c1', text: 'AI scores student admission applications.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Paris population is 12 million.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'The sky is blue.', type: 'fact', importance: 3 },
    ];
    mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(extractedClaims) });

    const claims = await provider.extractClaims('Mixed input');
    const toVerify = filterClaimsForVerification(claims);

    // c1 → supported (but high-risk domain: education)
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'System does this.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    // c2 → contradicted (generic)
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'contradicted', explanation: 'Population is 2.1M.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    // c3 → supported (generic)
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({ status: 'supported', explanation: 'Confirmed.' }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    const verifications: Record<string, VerificationResult> = {};
    for (const claim of toVerify) {
      verifications[claim.id] = await provider.verifyClaim(claim);
    }

    const risk = calculateRisk(verifications);
    expect(risk).toBe('high');

    const report = generateComplianceReport(toVerify, verifications, risk);
    expect(report.euRiskSummary.high).toBe(1);     // c1: education domain
    expect(report.euRiskSummary.limited).toBe(1);   // c2: contradicted generic
    expect(report.euRiskSummary.minimal).toBe(1);   // c3: supported generic
    expect(report.euRiskSummary.highestTier).toBe('high');
  });
});
