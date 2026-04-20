import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';

type ClaimStatus = 'supported' | 'contradicted' | 'mixed' | 'unverified' | 'loading' | 'skipped';

interface Claim {
  id: string;
  text: string;
  type: string;
  importance: number;
}

interface VerificationResult {
  claimId: string;
  status: ClaimStatus;
  explanation: string;
  sources: Array<{ title: string; uri: string }>;
}

interface ComplianceReport {
  claimMappings?: Array<{ claimId: string; confidenceScore: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ClaimFragility {
  claimId: string;
  claimText: string;
  claimType: string;
  importance: number;
  status: ClaimStatus;
  confidenceScore: number;
  fragilityScore: number;
  fragilityReason: string;
}

interface WeakestLinkAnalysis {
  weakestClaim: ClaimFragility | null;
  rankedClaims: ClaimFragility[];
  argumentStrength: 'resilient' | 'stable' | 'fragile' | 'critical';
  strengthScore: number;
  summary: string;
}

interface WeakestBody {
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  complianceReport: ComplianceReport;
}

// Verbatim port of FW lib/weakest-link.ts

const VERDICT_SCORES: Record<ClaimStatus, number> = {
  contradicted: 1.0,
  mixed:        0.6,
  unverified:   0.4,
  loading:      0.3,
  skipped:      0.2,
  supported:    0.0,
};

const FRAGILITY_REASONS: Record<string, string> = {
  contradicted: 'Contradicted by search results — high risk to argument integrity',
  mixed:        'Mixed evidence — sources partially support and partially contradict',
  unverified:   'No corroborating evidence found — claim unverifiable',
  supported:    'Supported by evidence — low fragility',
};

const DEFAULT_FRAGILITY_REASON = 'Insufficient data to assess fragility';
const DEFAULT_CONFIDENCE_SCORE = 0.5;

function lookupConfidenceScore(claimId: string, complianceReport: ComplianceReport): number {
  const mapping = (complianceReport.claimMappings ?? []).find((m) => m.claimId === claimId);
  return mapping !== undefined ? mapping.confidenceScore : DEFAULT_CONFIDENCE_SCORE;
}

function computeFragilityScore(status: ClaimStatus, confidenceScore: number, importance: number): number {
  const verdictScore = VERDICT_SCORES[status] ?? 0;
  const uncertaintyScore = 1 - confidenceScore;
  const importanceFactor = importance / 5;
  return (verdictScore * 0.6 + uncertaintyScore * 0.4) * importanceFactor;
}

function getFragilityReason(status: ClaimStatus): string {
  return FRAGILITY_REASONS[status] ?? DEFAULT_FRAGILITY_REASON;
}

function classifyArgumentStrength(worstFragilityScore: number): WeakestLinkAnalysis['argumentStrength'] {
  if (worstFragilityScore >= 0.7) return 'critical';
  if (worstFragilityScore >= 0.45) return 'fragile';
  if (worstFragilityScore >= 0.2) return 'stable';
  return 'resilient';
}

function buildSummary(weakestClaim: ClaimFragility | null, argumentStrength: string): string {
  if (weakestClaim === null) return 'No verified claims to analyze.';
  const truncatedText = weakestClaim.claimText.length > 80
    ? `${weakestClaim.claimText.substring(0, 80)}...` : weakestClaim.claimText;
  return `Weakest link: "${truncatedText}" — ${weakestClaim.status}, importance ${weakestClaim.importance}/5 (fragility: ${weakestClaim.fragilityScore.toFixed(2)}). Argument strength: ${argumentStrength.toUpperCase()}.`;
}

export function analyzeWeakestLinks(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
  complianceReport: ComplianceReport,
): WeakestLinkAnalysis {
  const fragilityList: ClaimFragility[] = [];
  for (const claim of claims) {
    const verification = verifications[claim.id];
    if (!verification) continue;
    const confidenceScore = lookupConfidenceScore(claim.id, complianceReport);
    const fragilityScore = computeFragilityScore(verification.status, confidenceScore, claim.importance);
    fragilityList.push({
      claimId: claim.id,
      claimText: claim.text,
      claimType: claim.type,
      importance: claim.importance,
      status: verification.status,
      confidenceScore,
      fragilityScore,
      fragilityReason: getFragilityReason(verification.status),
    });
  }
  const rankedClaims = [...fragilityList].sort((a, b) => b.fragilityScore - a.fragilityScore);
  const weakestClaim = rankedClaims.length > 0 ? rankedClaims[0] : null;
  const worstFragilityScore = weakestClaim?.fragilityScore ?? 0;
  const argumentStrength = classifyArgumentStrength(worstFragilityScore);
  const strengthScore = Math.max(0, 1 - worstFragilityScore);
  const summary = buildSummary(weakestClaim, argumentStrength);
  return { weakestClaim, rankedClaims, argumentStrength, strengthScore, summary };
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['claims', 'verifications', 'complianceReport'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text', 'type', 'importance'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          type: { type: 'string' },
          importance: { type: 'number' },
        },
      },
    },
    verifications: { type: 'object' },
    complianceReport: { type: 'object' },
  },
  additionalProperties: false,
} as const;

export async function weakestRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: WeakestBody }>(
    '/weakest',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Analysis'],
        summary: 'Weakest-link analysis for a set of verified claims',
        body: BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const { claims, verifications, complianceReport } = request.body;
      return reply.status(200).send(analyzeWeakestLinks(claims, verifications, complianceReport));
    },
  );
}
