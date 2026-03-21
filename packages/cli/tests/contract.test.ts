/**
 * Contract oracle for Faultline Pro claim forensics (CRUCIBLE Gate — oracle triangulation).
 *
 * Validates that every data shape produced by the claim forensics pipeline
 * conforms to its declared schema at runtime, not just at compile time.
 * TypeScript types are erased at runtime; this file catches:
 *   - LLM providers returning unexpected shapes (wrong keys, bad enums)
 *   - Compliance report generator emitting malformed output
 *   - Scan pipeline assembling an invalid ScanResult
 *   - Demo data that drifts from the live schema
 *
 * Oracle type: CONTRACT (Zod schema validation) — closes the third oracle gap
 * identified in CRUCIBLE audit N-58.
 *
 * Schemas mirror types in:
 *   packages/cli/types.ts
 *   packages/cli/cli/scan.ts (ScanResult)
 *   packages/cli/compliance/report_generator.ts (ComplianceReport)
 *   packages/cli/compliance/eu_ai_act.ts (ClaimRiskMapping)
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { scan } from '../cli/scan.js';
import { getDemoResult } from '../cli/demo.js';
import { generateComplianceReport } from '../compliance/report_generator.js';
import { mapClaimToRiskCategory } from '../compliance/eu_ai_act.js';
import type { Claim, VerificationResult } from '../types.js';

// ── Zod schemas (mirror the TypeScript types) ─────────────────────────────────

const ClaimTypeSchema = z.enum(['fact', 'opinion', 'interpretation']);
const ClaimStatusSchema = z.enum(['supported', 'contradicted', 'mixed', 'unverified', 'loading', 'skipped']);
const OverallRiskSchema = z.enum(['low', 'medium', 'high', 'critical']);
const EURiskLevelSchema = z.enum(['unacceptable', 'high', 'limited', 'minimal']);
const ConfidenceLabelSchema = z.enum(['high', 'medium', 'low']);

const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  type: ClaimTypeSchema,
  importance: z.number().int().min(1).max(5),
});

const VerificationResultSchema = z.object({
  claimId: z.string().min(1),
  status: ClaimStatusSchema,
  explanation: z.string(),
  sources: z.array(z.object({
    title: z.string(),
    uri: z.string(),
  })),
});

const EURiskCategorySchema = z.object({
  level: EURiskLevelSchema,
  title: z.string(),
  description: z.string(),
  articles: z.array(z.string()),
  requiredActions: z.array(z.string()),
});

const ClaimRiskMappingSchema = z.object({
  claimId: z.string().min(1),
  claimText: z.string(),
  verificationStatus: ClaimStatusSchema,
  riskLevel: EURiskLevelSchema,
  category: EURiskCategorySchema,
  matchedPatterns: z.array(z.string()),
  confidence: ConfidenceLabelSchema,
  confidenceScore: z.number().min(0).max(1),
});

const EURiskSummarySchema = z.object({
  unacceptable: z.number().int().min(0),
  high: z.number().int().min(0),
  limited: z.number().int().min(0),
  minimal: z.number().int().min(0),
  totalClaims: z.number().int().min(0),
  highestTier: EURiskLevelSchema,
});

const ConfidenceDistributionSchema = z.object({
  high: z.number().int().min(0),
  medium: z.number().int().min(0),
  low: z.number().int().min(0),
});

const TriggeredArticleSchema = z.object({
  article: z.string().min(1),
  reason: z.string(),
  claimIds: z.array(z.string()),
});

const ComplianceReportSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  overallRiskLevel: OverallRiskSchema,
  euRiskSummary: EURiskSummarySchema,
  claimMappings: z.array(ClaimRiskMappingSchema),
  triggeredArticles: z.array(TriggeredArticleSchema),
  mitigations: z.array(z.string()),
  confidenceDistribution: ConfidenceDistributionSchema,
});

const FindingSchema = z.object({
  ruleId: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  message: z.string(),
  claimId: z.string().optional(),
});

const ScanResultSchema = z.object({
  input: z.string(),
  provider: z.string().min(1),
  claims: z.array(ClaimSchema),
  verifications: z.record(z.string(), VerificationResultSchema),
  overallRisk: OverallRiskSchema,
  complianceReport: ComplianceReportSchema,
  ruleFindings: z.array(FindingSchema),
});

// ── Helper ────────────────────────────────────────────────────────────────────

function assertValid<T>(schema: z.ZodSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} failed schema validation:\n${result.error.toString()}`);
  }
  return result.data;
}

// ── Claim schema tests ────────────────────────────────────────────────────────

describe('Contract: ClaimSchema', () => {
  it('accepts a valid fact claim', () => {
    const claim = { id: 'c1', text: 'AI will cure cancer by 2025.', type: 'fact', importance: 5 };
    expect(() => assertValid(ClaimSchema, claim, 'Claim')).not.toThrow();
  });

  it('accepts all three claim types', () => {
    for (const type of ['fact', 'opinion', 'interpretation'] as const) {
      const claim = { id: 'c1', text: 'Some text.', type, importance: 3 };
      expect(() => assertValid(ClaimSchema, claim, 'Claim')).not.toThrow();
    }
  });

  it('rejects importance outside 1–5', () => {
    const bad = { id: 'c1', text: 'Some text.', type: 'fact', importance: 0 };
    expect(ClaimSchema.safeParse(bad).success).toBe(false);

    const bad2 = { id: 'c1', text: 'Some text.', type: 'fact', importance: 6 };
    expect(ClaimSchema.safeParse(bad2).success).toBe(false);
  });

  it('rejects unknown claim type', () => {
    const bad = { id: 'c1', text: 'Some text.', type: 'rumour', importance: 3 };
    expect(ClaimSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty id', () => {
    const bad = { id: '', text: 'Some text.', type: 'fact', importance: 3 };
    expect(ClaimSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty text', () => {
    const bad = { id: 'c1', text: '', type: 'fact', importance: 3 };
    expect(ClaimSchema.safeParse(bad).success).toBe(false);
  });
});

// ── VerificationResult schema tests ──────────────────────────────────────────

describe('Contract: VerificationResultSchema', () => {
  it('accepts all valid statuses', () => {
    for (const status of ['supported', 'contradicted', 'mixed', 'unverified', 'loading', 'skipped'] as const) {
      const v = { claimId: 'c1', status, explanation: 'ok', sources: [] };
      expect(() => assertValid(VerificationResultSchema, v, 'VerificationResult')).not.toThrow();
    }
  });

  it('rejects unknown status', () => {
    const bad = { claimId: 'c1', status: 'pending', explanation: 'ok', sources: [] };
    expect(VerificationResultSchema.safeParse(bad).success).toBe(false);
  });

  it('validates sources array shape', () => {
    const good = { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [{ title: 'Reuters', uri: 'https://reuters.com' }] };
    expect(() => assertValid(VerificationResultSchema, good, 'VerificationResult')).not.toThrow();

    const bad = { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [{ url: 'bad shape' }] };
    expect(VerificationResultSchema.safeParse(bad).success).toBe(false);
  });
});

// ── ClaimRiskMapping schema tests ─────────────────────────────────────────────

describe('Contract: ClaimRiskMappingSchema (mapClaimToRiskCategory output)', () => {
  const fixtures: Array<{ claim: Claim; status: VerificationResult['status'] }> = [
    { claim: { id: 'c1', text: 'The hiring AI has 95% accuracy.', type: 'fact', importance: 5 }, status: 'contradicted' },
    { claim: { id: 'c2', text: 'Users report 40% faster time-to-hire.', type: 'fact', importance: 3 }, status: 'supported' },
    { claim: { id: 'c3', text: 'The system uses social scoring to rank workers.', type: 'fact', importance: 4 }, status: 'contradicted' },
    { claim: { id: 'c4', text: 'This product helps companies with recruitment decisions.', type: 'fact', importance: 4 }, status: 'mixed' },
    { claim: { id: 'c5', text: 'The quarterly results were positive this year.', type: 'opinion', importance: 2 }, status: 'unverified' },
  ];

  for (const { claim, status } of fixtures) {
    it(`mapClaimToRiskCategory output conforms to schema [${claim.id}: ${status}]`, () => {
      const verification: VerificationResult = { claimId: claim.id, status, explanation: 'test', sources: [] };
      const result = mapClaimToRiskCategory(claim, verification);
      expect(() => assertValid(ClaimRiskMappingSchema, result, 'ClaimRiskMapping')).not.toThrow();
    });
  }
});

// ── ComplianceReport schema tests ─────────────────────────────────────────────

describe('Contract: ComplianceReportSchema (generateComplianceReport output)', () => {
  const claims: Claim[] = [
    { id: 'c1', text: 'AI hiring systems can perpetuate bias in recruitment.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'The model achieves 92% accuracy on benchmark tasks.', type: 'fact', importance: 4 },
    { id: 'c3', text: 'Users prefer AI-assisted screening over manual review.', type: 'opinion', importance: 2 },
  ];

  const verifications: Record<string, VerificationResult> = {
    c1: { claimId: 'c1', status: 'contradicted', explanation: 'Evidence shows bias.', sources: [{ title: 'Study', uri: 'https://example.com' }] },
    c2: { claimId: 'c2', status: 'mixed', explanation: 'Results vary by task.', sources: [] },
    c3: { claimId: 'c3', status: 'unverified', explanation: 'No studies found.', sources: [] },
  };

  it('report with contradicted claim conforms to schema', () => {
    const report = generateComplianceReport(claims, verifications, 'high');
    expect(() => assertValid(ComplianceReportSchema, report, 'ComplianceReport')).not.toThrow();
  });

  it('report with all supported claims conforms to schema', () => {
    const allSupported: Record<string, VerificationResult> = Object.fromEntries(
      claims.map(c => [c.id, { claimId: c.id, status: 'supported' as const, explanation: 'ok', sources: [] }])
    );
    const report = generateComplianceReport(claims, allSupported, 'low');
    expect(() => assertValid(ComplianceReportSchema, report, 'ComplianceReport')).not.toThrow();
  });

  it('report with empty claims array conforms to schema', () => {
    const report = generateComplianceReport([], {}, 'low');
    expect(() => assertValid(ComplianceReportSchema, report, 'ComplianceReport')).not.toThrow();
  });

  it('report with minConfidence filter conforms to schema', () => {
    const report = generateComplianceReport(claims, verifications, 'high', 0.8);
    expect(() => assertValid(ComplianceReportSchema, report, 'ComplianceReport')).not.toThrow();
  });

  it('generatedAt field is a valid ISO 8601 timestamp', () => {
    const report = generateComplianceReport(claims, verifications, 'medium');
    const parsed = ComplianceReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(new Date(parsed.data.generatedAt).getTime()).not.toBeNaN();
    }
  });
});

// ── ScanResult schema tests (full pipeline) ───────────────────────────────────

describe('Contract: ScanResultSchema (scan() pipeline output)', () => {
  it('single-sentence scan output conforms to schema', async () => {
    const result = await scan('AI will cure cancer by 2025.', 'mock');
    expect(() => assertValid(ScanResultSchema, result, 'ScanResult')).not.toThrow();
  });

  it('multi-sentence scan output conforms to schema', async () => {
    const result = await scan(
      'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.',
      'mock',
    );
    expect(() => assertValid(ScanResultSchema, result, 'ScanResult')).not.toThrow();
  });

  it('scan with rule names conforms to schema', async () => {
    const result = await scan('AI will cure cancer.', 'mock', undefined, ['pii']);
    expect(() => assertValid(ScanResultSchema, result, 'ScanResult')).not.toThrow();
  });

  it('verifications map keys match claim IDs', async () => {
    const result = await scan('AI will cure cancer by 2025.', 'mock');
    const verifiedIds = new Set(Object.keys(result.verifications));
    for (const claim of result.claims) {
      // Only fact claims with importance >= 3 are verified
      if (claim.type === 'fact' && claim.importance >= 3) {
        expect(verifiedIds.has(claim.id)).toBe(true);
      }
    }
  });

  it('overallRisk is consistent with verifications (no contradiction → not high/critical)', async () => {
    const result = await scan('AI will cure cancer by 2025.', 'mock');
    const verdicts = Object.values(result.verifications).map(v => v.status);
    const hasContradicted = verdicts.includes('contradicted');
    if (!hasContradicted) {
      expect(['low', 'medium']).toContain(result.overallRisk);
    }
  });

  it('compliance report inside ScanResult conforms to schema', async () => {
    const result = await scan('GPT-5 has 98% accuracy on all benchmarks.', 'mock');
    expect(() => assertValid(ComplianceReportSchema, result.complianceReport, 'ComplianceReport')).not.toThrow();
  });
});

// ── Demo data contract tests ──────────────────────────────────────────────────

describe('Contract: getDemoResult() conforms to ScanResultSchema', () => {
  it('full demo result passes ScanResultSchema', () => {
    const result = getDemoResult();
    expect(() => assertValid(ScanResultSchema, result, 'DemoScanResult')).not.toThrow();
  });

  it('all demo claims pass ClaimSchema', () => {
    const result = getDemoResult();
    for (const claim of result.claims) {
      expect(() => assertValid(ClaimSchema, claim, `Claim[${claim.id}]`)).not.toThrow();
    }
  });

  it('all demo verifications pass VerificationResultSchema', () => {
    const result = getDemoResult();
    for (const [id, v] of Object.entries(result.verifications)) {
      expect(() => assertValid(VerificationResultSchema, v, `Verification[${id}]`)).not.toThrow();
    }
  });

  it('demo complianceReport passes ComplianceReportSchema', () => {
    const result = getDemoResult();
    expect(() => assertValid(ComplianceReportSchema, result.complianceReport, 'DemoComplianceReport')).not.toThrow();
  });
});
