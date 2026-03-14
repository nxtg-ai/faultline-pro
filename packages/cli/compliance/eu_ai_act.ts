import type { Claim, ClaimStatus, VerificationResult } from '../types';

/**
 * EU AI Act risk tiers per Articles 5-7 and Annexes I-III.
 *
 * Reference: Regulation (EU) 2024/1689 of the European Parliament
 * - Article 5: Prohibited AI practices (Unacceptable)
 * - Article 6 + Annex III: High-risk AI systems
 * - Article 50: Transparency obligations (Limited)
 * - Recital 32: Minimal-risk systems
 */
export type EURiskLevel = 'unacceptable' | 'high' | 'limited' | 'minimal';

export interface EURiskCategory {
  level: EURiskLevel;
  title: string;
  description: string;
  articles: string[];
  requiredActions: string[];
}

export const EU_RISK_CATEGORIES: Record<EURiskLevel, EURiskCategory> = {
  unacceptable: {
    level: 'unacceptable',
    title: 'Unacceptable Risk (Prohibited)',
    description:
      'AI practices that pose a clear threat to safety, livelihoods, or rights. These are banned under the EU AI Act.',
    articles: ['Article 5'],
    requiredActions: [
      'Cease deployment immediately',
      'Report to national supervisory authority',
      'Conduct fundamental rights impact assessment',
    ],
  },
  high: {
    level: 'high',
    title: 'High Risk',
    description:
      'AI systems in critical domains (health, safety, fundamental rights) that require conformity assessment and ongoing monitoring.',
    articles: ['Article 6', 'Article 9-15', 'Annex III'],
    requiredActions: [
      'Implement risk management system (Article 9)',
      'Ensure data governance and quality (Article 10)',
      'Maintain technical documentation (Article 11)',
      'Enable human oversight (Article 14)',
      'Register in EU database before deployment (Article 49)',
    ],
  },
  limited: {
    level: 'limited',
    title: 'Limited Risk',
    description:
      'AI systems with transparency obligations — users must be informed they are interacting with AI-generated content.',
    articles: ['Article 50'],
    requiredActions: [
      'Disclose AI-generated content to users',
      'Label synthetic media (deepfakes)',
      'Ensure content is identifiable as AI-generated',
    ],
  },
  minimal: {
    level: 'minimal',
    title: 'Minimal Risk',
    description:
      'AI systems posing negligible risk. No mandatory requirements, though voluntary codes of conduct are encouraged.',
    articles: ['Recital 32'],
    requiredActions: [
      'Consider adopting voluntary codes of conduct',
    ],
  },
};

/**
 * Domain keywords that indicate a claim touches a high-risk area
 * per Annex III of the EU AI Act.
 */
const HIGH_RISK_DOMAINS: ReadonlyArray<{ pattern: RegExp; annexRef: string }> = [
  { pattern: /\b(biometric|facial recognition|face identification)\b/i, annexRef: 'Annex III §1' },
  { pattern: /\b(critical infrastructure|energy grid|water supply|transport safety)\b/i, annexRef: 'Annex III §2' },
  { pattern: /\b(education|student|academic scoring|admission)\b/i, annexRef: 'Annex III §3' },
  { pattern: /\b(employment|recruitment|hiring|worker|termination)\b/i, annexRef: 'Annex III §4' },
  { pattern: /\b(credit scor\w*|insurance|financial risk|loan)\b/i, annexRef: 'Annex III §5' },
  { pattern: /\b(law enforcement|predictive policing|criminal)\b/i, annexRef: 'Annex III §6' },
  { pattern: /\b(migration|asylum|border control|visa)\b/i, annexRef: 'Annex III §7' },
  { pattern: /\b(justice|judicial|sentencing|parole)\b/i, annexRef: 'Annex III §8' },
  { pattern: /\b(election|democratic|voting|political campaign)\b/i, annexRef: 'Annex III §8' },
];

/**
 * Keywords indicating prohibited (unacceptable) AI practices per Article 5.
 */
const UNACCEPTABLE_PATTERNS: ReadonlyArray<{ pattern: RegExp; articleRef: string }> = [
  { pattern: /\b(social scoring|citizen score|social credit)\b/i, articleRef: 'Article 5(1)(c)' },
  { pattern: /\b(subliminal|manipulat(e|ion|ive) (beyond|awareness))\b/i, articleRef: 'Article 5(1)(a)' },
  { pattern: /\b(exploit.*(vulnerabilit|age|disability|economic))\b/i, articleRef: 'Article 5(1)(b)' },
  { pattern: /\b(mass surveillance|untargeted scraping|real.?time.*biometric.*public)\b/i, articleRef: 'Article 5(1)(d)' },
  { pattern: /\b(emotion recognition.*(workplace|education))\b/i, articleRef: 'Article 5(1)(f)' },
];

export interface ClaimRiskMapping {
  claimId: string;
  claimText: string;
  verificationStatus: ClaimStatus;
  riskLevel: EURiskLevel;
  category: EURiskCategory;
  matchedPatterns: string[];
  confidence: 'high' | 'medium' | 'low';
  /** Numeric confidence score (0.0-1.0) for the risk classification. */
  confidenceScore: number;
}

/**
 * Map a verified claim to an EU AI Act risk category.
 *
 * Logic:
 * 1. Check if claim text matches any prohibited (unacceptable) patterns
 * 2. Check if claim text matches any Annex III high-risk domain
 * 3. If the claim is contradicted and high-importance, escalate one tier
 * 4. Default to limited (AI-generated content transparency) or minimal
 */
export function mapClaimToRiskCategory(
  claim: Claim,
  verification: VerificationResult,
): ClaimRiskMapping {
  const matchedPatterns: string[] = [];

  // Check for unacceptable (prohibited) patterns
  for (const { pattern, articleRef } of UNACCEPTABLE_PATTERNS) {
    if (pattern.test(claim.text)) {
      matchedPatterns.push(articleRef);
      return {
        claimId: claim.id,
        claimText: claim.text,
        verificationStatus: verification.status,
        riskLevel: 'unacceptable',
        category: EU_RISK_CATEGORIES.unacceptable,
        matchedPatterns,
        confidence: 'high',
        confidenceScore: 0.95,
      };
    }
  }

  // Check for high-risk domain matches
  for (const { pattern, annexRef } of HIGH_RISK_DOMAINS) {
    if (pattern.test(claim.text)) {
      matchedPatterns.push(annexRef);
    }
  }

  if (matchedPatterns.length > 0) {
    // Contradicted high-importance claims in high-risk domains are more severe
    const isEscalated =
      verification.status === 'contradicted' && claim.importance >= 4;

    return {
      claimId: claim.id,
      claimText: claim.text,
      verificationStatus: verification.status,
      riskLevel: 'high',
      category: EU_RISK_CATEGORIES.high,
      matchedPatterns,
      confidence: isEscalated ? 'high' : 'medium',
      confidenceScore: isEscalated ? 0.9 : 0.7,
    };
  }

  // AI-generated content with contradictions or mixed results → limited risk
  // (transparency obligation: users should know the content may be inaccurate)
  if (
    verification.status === 'contradicted' ||
    verification.status === 'mixed'
  ) {
    return {
      claimId: claim.id,
      claimText: claim.text,
      verificationStatus: verification.status,
      riskLevel: 'limited',
      category: EU_RISK_CATEGORIES.limited,
      matchedPatterns: ['Article 50 (AI-generated content)'],
      confidence: verification.status === 'contradicted' ? 'high' : 'medium',
      confidenceScore: verification.status === 'contradicted' ? 0.85 : 0.6,
    };
  }

  // Default: minimal risk
  return {
    claimId: claim.id,
    claimText: claim.text,
    verificationStatus: verification.status,
    riskLevel: 'minimal',
    category: EU_RISK_CATEGORIES.minimal,
    matchedPatterns: [],
    confidence: 'low',
    confidenceScore: 0.3,
  };
}
