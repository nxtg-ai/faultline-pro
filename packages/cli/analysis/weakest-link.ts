import type { Claim, ClaimStatus, VerificationResult } from '../types.js';
import type { ComplianceReport } from '../compliance/report_generator.js';

/**
 * Fragility assessment for a single verified claim.
 *
 * Captures the claim's metadata alongside a computed fragility score
 * that quantifies how vulnerable the claim is to being overturned.
 */
export interface ClaimFragility {
  claimId: string;
  claimText: string;
  claimType: Claim['type'];
  importance: number;
  status: ClaimStatus;
  confidenceScore: number;
  fragilityScore: number;
  fragilityReason: string;
}

/**
 * Overall weakest-link analysis across all verified claims.
 *
 * Identifies the single most fragile claim, ranks all claims by fragility,
 * and classifies the overall argument strength.
 */
export interface WeakestLinkAnalysis {
  weakestClaim: ClaimFragility | null;
  rankedClaims: ClaimFragility[];
  argumentStrength: 'resilient' | 'stable' | 'fragile' | 'critical';
  strengthScore: number;
  summary: string;
}

/**
 * Verdict-to-score mapping for the fragility algorithm.
 *
 * Higher scores indicate greater fragility risk.
 * - contradicted: 1.0 (maximum risk)
 * - mixed: 0.6
 * - unverified: 0.4
 * - loading: 0.3
 * - skipped: 0.2
 * - supported: 0.0 (no risk from verdict)
 */
export const VERDICT_SCORES: Record<ClaimStatus, number> = {
  contradicted: 1.0,
  mixed: 0.6,
  unverified: 0.4,
  loading: 0.3,
  skipped: 0.2,
  supported: 0.0,
};

const FRAGILITY_REASONS: Record<string, string> = {
  contradicted: 'Contradicted by search results \u2014 high risk to argument integrity',
  mixed: 'Mixed evidence \u2014 sources partially support and partially contradict',
  unverified: 'No corroborating evidence found \u2014 claim unverifiable',
  supported: 'Supported by evidence \u2014 low fragility',
};

const DEFAULT_FRAGILITY_REASON = 'Insufficient data to assess fragility';

const DEFAULT_CONFIDENCE_SCORE = 0.5;

/**
 * Look up the confidence score for a claim from the compliance report.
 *
 * Falls back to DEFAULT_CONFIDENCE_SCORE when the claim is not present
 * in the report's claimMappings array.
 */
function lookupConfidenceScore(
  claimId: string,
  complianceReport: ComplianceReport,
): number {
  const mapping = complianceReport.claimMappings.find(
    (m) => m.claimId === claimId,
  );
  return mapping !== undefined ? mapping.confidenceScore : DEFAULT_CONFIDENCE_SCORE;
}

/**
 * Compute the fragility score for a single claim.
 *
 * Formula:
 *   fragilityScore = (verdictScore * 0.6 + uncertaintyScore * 0.4) * importanceFactor
 *
 * Where:
 *   verdictScore = VERDICT_SCORES[status]
 *   uncertaintyScore = 1 - confidenceScore
 *   importanceFactor = importance / 5
 */
function computeFragilityScore(
  status: ClaimStatus,
  confidenceScore: number,
  importance: number,
): number {
  const verdictScore = VERDICT_SCORES[status] ?? 0;
  const uncertaintyScore = 1 - confidenceScore;
  const importanceFactor = importance / 5;
  return (verdictScore * 0.6 + uncertaintyScore * 0.4) * importanceFactor;
}

/**
 * Get the human-readable fragility reason for a given claim status.
 */
function getFragilityReason(status: ClaimStatus): string {
  return FRAGILITY_REASONS[status] ?? DEFAULT_FRAGILITY_REASON;
}

/**
 * Classify overall argument strength based on the worst fragility score.
 *
 * Thresholds:
 *   >= 0.7  -> 'critical'
 *   >= 0.45 -> 'fragile'
 *   >= 0.2  -> 'stable'
 *   < 0.2   -> 'resilient'
 */
function classifyArgumentStrength(
  worstFragilityScore: number,
): WeakestLinkAnalysis['argumentStrength'] {
  if (worstFragilityScore >= 0.7) return 'critical';
  if (worstFragilityScore >= 0.45) return 'fragile';
  if (worstFragilityScore >= 0.2) return 'stable';
  return 'resilient';
}

/**
 * Build the summary string for the analysis result.
 */
function buildSummary(weakestClaim: ClaimFragility | null, argumentStrength: string): string {
  if (weakestClaim === null) {
    return 'No verified claims to analyze.';
  }

  const truncatedText = weakestClaim.claimText.length > 80
    ? `${weakestClaim.claimText.substring(0, 80)}...`
    : weakestClaim.claimText;

  return (
    `Weakest link: "${truncatedText}" \u2014 ${weakestClaim.status}, ` +
    `importance ${weakestClaim.importance}/5 ` +
    `(fragility: ${weakestClaim.fragilityScore.toFixed(2)}). ` +
    `Argument strength: ${argumentStrength.toUpperCase()}.`
  );
}

/**
 * Analyze claims for weakest-link detection.
 *
 * Computes a fragility score for every claim that has a matching verification
 * result, ranks them from most fragile to least fragile, and classifies the
 * overall argument strength.
 *
 * Claims without a corresponding entry in the verifications record are excluded
 * from the analysis entirely.
 *
 * @param claims - All extracted claims
 * @param verifications - Verification results keyed by claim ID
 * @param complianceReport - Compliance report containing confidence scores
 * @returns Weakest-link analysis with ranked claims and overall strength
 */
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
    const fragilityScore = computeFragilityScore(
      verification.status,
      confidenceScore,
      claim.importance,
    );

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

  // Sort descending by fragilityScore (stable sort preserves relative order for ties)
  const rankedClaims = [...fragilityList].sort(
    (a, b) => b.fragilityScore - a.fragilityScore,
  );

  const weakestClaim = rankedClaims.length > 0 ? rankedClaims[0] : null;
  const worstFragilityScore = weakestClaim?.fragilityScore ?? 0;
  const argumentStrength = classifyArgumentStrength(worstFragilityScore);
  const strengthScore = Math.max(0, 1 - worstFragilityScore);
  const summary = buildSummary(weakestClaim, argumentStrength);

  return {
    weakestClaim,
    rankedClaims,
    argumentStrength,
    strengthScore,
    summary,
  };
}
