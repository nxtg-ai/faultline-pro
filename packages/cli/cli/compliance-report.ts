import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScanResult } from './scan.js';
import type { Claim, VerificationResult } from '../types.js';
import type { Finding } from '../rules/base_rule.js';
import type { ClaimRiskMapping } from '../compliance/eu_ai_act.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EvidenceStatus = 'compliant' | 'non-compliant' | 'partial' | 'gap' | 'not-applicable';

export interface EuArticleEvidence {
  article: string;
  requirement: string;
  status: EvidenceStatus;
  findings: string[];
  remediations: string[];
  owaspRef?: string;
  /** Number of claims that contributed evidence for this article assessment. */
  evidenceCount: number;
  /** Number of verification sources backing the evidence. */
  sourceCount: number;
  /** Confidence strength of the article assessment (0.0–1.0). Higher = more evidence. */
  strengthScore: number;
}

export interface TestCategoryMapping {
  category: string;
  claimCount: number;
  euArticle: string;
  status: EvidenceStatus;
  owaspRef?: string;
}

export type AnnexCheckStatus = 'pass' | 'fail' | 'partial' | 'not-assessed';

export interface AnnexIIICheckItem {
  /** Requirement ID (e.g. 'annex-iii-1'). */
  id: string;
  /** EU AI Act article reference. */
  article: string;
  /** Requirement description. */
  requirement: string;
  /** Assessment result. */
  status: AnnexCheckStatus;
  /** Evidence source (article evidence status or specific finding). */
  evidence: string;
}

export interface AnnexIIIChecklist {
  /** Whether the checklist was triggered (only for high/critical risk). */
  applicable: boolean;
  /** Overall pass rate (0.0–1.0). */
  passRate: number;
  /** Individual check items. */
  items: AnnexIIICheckItem[];
}

export interface EuAiActComplianceReport {
  generatedAt: string;
  documentRef: string;
  projectName: string;
  provider: string;
  overallRisk: string;
  articleEvidence: EuArticleEvidence[];
  article50Disclosure: {
    status: 'not-applicable';
    note: string;
    voiceAudioDisclosure: string;
  };
  testCategoryMappings: TestCategoryMapping[];
  complianceScore: number;
  annexIIIChecklist: AnnexIIIChecklist;
  summary: {
    compliantArticles: number;
    nonCompliantArticles: number;
    partialArticles: number;
    gapArticles: number;
    totalClaimsAnalyzed: number;
    highRiskFindings: number;
  };
}

// ── Test-Category → EU Article Mapping ───────────────────────────────────────

function buildTestCategoryMappings(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
  ruleFindings: Finding[] = [],
  claimMappings: ClaimRiskMapping[] = [],
): TestCategoryMapping[] {
  const mappings: TestCategoryMapping[] = [];

  // fact + supported → Art. 13 transparency compliance evidence
  const factSupported = claims.filter(
    c => c.type === 'fact' && verifications[c.id]?.status === 'supported',
  );
  if (factSupported.length > 0) {
    mappings.push({
      category: 'fact (supported)',
      claimCount: factSupported.length,
      euArticle: 'Article 13 – Transparency and Provision of Information',
      status: 'compliant',
    });
  }

  // fact + contradicted → Art. 9 risk finding
  const factContradicted = claims.filter(
    c => c.type === 'fact' && verifications[c.id]?.status === 'contradicted',
  );
  if (factContradicted.length > 0) {
    mappings.push({
      category: 'fact (contradicted)',
      claimCount: factContradicted.length,
      euArticle: 'Article 9 – Risk Management System',
      status: 'non-compliant',
      owaspRef: 'OWASP Agentic AI A01: Prompt Injection',
    });
  }

  // fact + unverified/mixed → Art. 13 transparency gap
  const factUnverified = claims.filter(
    c => c.type === 'fact' && ['unverified', 'mixed'].includes(verifications[c.id]?.status ?? ''),
  );
  if (factUnverified.length > 0) {
    mappings.push({
      category: 'fact (unverified/mixed)',
      claimCount: factUnverified.length,
      euArticle: 'Article 13 – Transparency (gap)',
      status: 'gap',
    });
  }

  // opinion → Art. 50 GPAI disclosure
  const opinionClaims = claims.filter(c => c.type === 'opinion');
  if (opinionClaims.length > 0) {
    mappings.push({
      category: 'opinion',
      claimCount: opinionClaims.length,
      euArticle: 'Article 50 – GPAI Transparency Obligations',
      status: 'partial',
    });
  }

  // interpretation → Art. 9 + Art. 14 human oversight
  const interpretationClaims = claims.filter(c => c.type === 'interpretation');
  if (interpretationClaims.length > 0) {
    mappings.push({
      category: 'interpretation',
      claimCount: interpretationClaims.length,
      euArticle: 'Article 9 + Article 14 – Risk Management & Human Oversight',
      status: 'partial',
      owaspRef: 'OWASP Agentic AI A03: Excessive Agency',
    });
  }

  // bias findings → Art. 10 data governance
  const biasFindings = ruleFindings.filter(f => f.ruleId.toLowerCase().includes('bias'));
  if (biasFindings.length > 0) {
    mappings.push({
      category: 'bias finding(s)',
      claimCount: biasFindings.length,
      euArticle: 'Article 10 – Data and Data Governance',
      status: 'non-compliant',
      owaspRef: 'OWASP Agentic AI A05: Improper Output Handling',
    });
  }

  // high-importance unverified claims → Art. 10 data completeness
  const highImportanceUnverified = claims.filter(
    c => (c.importance ?? 0) >= 4 && ['unverified', 'mixed'].includes(verifications[c.id]?.status ?? ''),
  );
  if (highImportanceUnverified.length > 0) {
    mappings.push({
      category: 'fact (high-importance, unverified)',
      claimCount: highImportanceUnverified.length,
      euArticle: 'Article 10 – Data and Data Governance (data completeness)',
      status: 'partial',
    });
  }

  // claims with verification documentation → Art. 11 technical documentation
  const claimsWithDocumentation = claims.filter(c => {
    const v = verifications[c.id];
    return v && ((v.explanation && v.explanation.length > 0) || (v.sources && v.sources.length > 0));
  });
  if (claimsWithDocumentation.length > 0) {
    mappings.push({
      category: 'claim(s) with verification documentation',
      claimCount: claimsWithDocumentation.length,
      euArticle: 'Article 11 – Technical Documentation',
      status: 'compliant',
    });
  }

  // structured claim metadata present → Art. 12 record-keeping
  if (claims.length > 0) {
    mappings.push({
      category: 'claim(s) with structured metadata',
      claimCount: claims.length,
      euArticle: 'Article 12 – Record-Keeping',
      status: 'compliant',
    });
  }

  // high-risk domain claims → Art. 6 Classification Rules
  const highRiskMappings = claimMappings.filter(
    m => m.riskLevel === 'high' || m.riskLevel === 'unacceptable',
  );
  if (highRiskMappings.length > 0) {
    mappings.push({
      category: 'high-risk domain claim(s)',
      claimCount: highRiskMappings.length,
      euArticle: 'Article 6 – Classification Rules for High-Risk AI Systems',
      status: 'partial',
    });
  }

  return mappings;
}

// ── Compliance Config File ───────────────────────────────────────────────────

export interface ComplianceConfig {
  projectName?: string;
  threshold?: number;
  strict?: boolean;
  requiredArticles?: string[];
}

const CONFIG_FILENAMES = ['.faultline-compliance.json', 'faultline-compliance.json'];

/**
 * Load compliance config from the current directory or a specified path.
 * Returns null if no config file is found.
 */
export function loadComplianceConfig(configPath?: string): ComplianceConfig | null {
  if (configPath) {
    const p = resolve(configPath);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
  }

  for (const name of CONFIG_FILENAMES) {
    const p = resolve(name);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
    }
  }
  return null;
}

// ── Remediation Recommendations ─────────────────────────────────────────────

export function getRemediations(article: string, status: EvidenceStatus, findings: string[]): string[] {
  if (status === 'compliant' || status === 'not-applicable') return [];

  const rems: string[] = [];

  if (article.includes('Article 5') && !article.includes('Article 50')) {
    rems.push('Remove or reclassify claims flagged as prohibited AI practices.');
    rems.push('Conduct Art. 5(1) legal review before deployment.');
    rems.push('Document justification if flagged claims are false positives.');
  } else if (article.includes('Article 50')) {
    rems.push('Add AI-generated content labelling to all outputs.');
    if (findings.some(f => f.includes('opinion'))) {
      rems.push('Implement disclosure mechanisms for AI-generated opinion content.');
    }
    rems.push('Prepare Art. 50(4) voice/audio disclosure when applicable.');
  } else if (article.includes('Article 9')) {
    if (findings.some(f => f.includes('contradicted'))) {
      rems.push('Review and correct contradicted claims with accurate source data.');
    }
    if (findings.some(f => f.includes('injection'))) {
      rems.push('Implement prompt guardrails and input sanitization to prevent injection.');
    }
    if (findings.some(f => f.includes('PII'))) {
      rems.push('Add PII filtering/redaction to the AI output pipeline.');
    }
    if (findings.some(f => f.includes('bias'))) {
      rems.push('Conduct bias audit on training data per Art. 10 Data Governance.');
    }
    if (findings.some(f => f.includes('critical') || f.includes('high') || f.includes('Annex III'))) {
      rems.push('Complete Annex III conformity assessment for high-risk classification.');
    }
    if (findings.some(f => f.includes('interpretation'))) {
      rems.push('Add human oversight review for interpretation claims per Art. 14.');
    }
    if (rems.length === 0) {
      rems.push('Review risk management findings and implement appropriate mitigations.');
    }
  } else if (article.includes('Article 10')) {
    if (findings.some(f => f.includes('bias'))) {
      rems.push('Conduct bias audit on training data sets per Art. 10(2)(f).');
      rems.push('Document bias detection methodology and mitigation measures.');
    }
    if (findings.some(f => f.includes('PII'))) {
      rems.push('Review special category data processing under Art. 10(5) and ensure GDPR compliance.');
    }
    if (findings.some(f => f.includes('contradicted'))) {
      rems.push('Audit training data quality — contradicted outputs indicate potential errors in training data per Art. 10(3).');
    }
    if (findings.some(f => f.includes('unverified'))) {
      rems.push('Review data completeness — unverified high-importance claims suggest gaps in training data coverage.');
    }
    if (rems.length === 0) {
      rems.push('Review data governance practices for Art. 10 compliance.');
    }
  } else if (article.includes('Article 11')) {
    if (findings.some(f => f.includes('insufficient'))) {
      rems.push('Add verification explanations to all AI system outputs per Art. 11(1)(a).');
    }
    if (findings.some(f => f.includes('sources'))) {
      rems.push('Include source citations and evidence provenance in system documentation.');
    }
    rems.push('Maintain technical documentation covering system design, intended purpose, and decision-making logic.');
  } else if (article.includes('Article 12')) {
    if (!findings.some(f => f.includes('Provider recorded'))) {
      rems.push('Record AI system provider and model information for audit trail.');
    }
    if (!findings.some(f => f.includes('rule finding'))) {
      rems.push('Implement monitoring rules to detect anomalies in AI system outputs.');
    }
    rems.push('Enable automatic event logging throughout the AI system lifecycle per Art. 12.');
  } else if (article.includes('Article 13')) {
    if (findings.some(f => f.includes('unverified') || f.includes('mixed'))) {
      rems.push('Add source attribution for unverified claims.');
      rems.push('Implement confidence scoring to flag uncertain outputs.');
    }
    if (findings.some(f => f.includes('No claims extracted'))) {
      rems.push('Ensure AI outputs include verifiable factual statements.');
    }
    rems.push('Document AI system capabilities, limitations, and intended purpose.');
  } else if (article.includes('Article 14')) {
    rems.push('Implement human-in-the-loop review for interpretation and mixed-evidence claims.');
    rems.push('Document oversight procedures and escalation paths.');
  } else if (article.includes('Article 6')) {
    if (findings.some(f => f.includes('Annex III'))) {
      rems.push('Complete an EU AI Act conformity assessment per Article 6 + Annex III.');
      rems.push('Register the high-risk AI system in the EU database per Article 49 before market placement.');
      rems.push('Ensure all Chapter 3 obligations (Articles 9–15) are met for high-risk AI systems.');
    }
    if (rems.length === 0) {
      rems.push('Review Annex III classification criteria against your AI system\'s intended use cases.');
    }
  } else if (article.includes('Article 15')) {
    if (findings.some(f => f.includes('contradicted'))) {
      rems.push('Investigate contradicted claims — accuracy failures may indicate training data or inference issues per Art. 15(1).');
      rems.push('Implement accuracy benchmarking against representative test sets per Art. 15(1).');
    }
    if (findings.some(f => f.includes('robustness') || f.includes('unverified'))) {
      rems.push('Conduct robustness testing against distributional shift and edge cases per Art. 15(2).');
    }
    if (findings.some(f => f.includes('injection') || f.includes('cybersecurity'))) {
      rems.push('Implement prompt injection defenses and input sanitization per Art. 15(3).');
      rems.push('Conduct cybersecurity assessment addressing AI-specific attack vectors (OWASP Agentic AI A01).');
    }
    if (rems.length === 0) {
      rems.push('Document accuracy metrics, robustness test results, and cybersecurity measures per Art. 15.');
    }
  } else if (article.includes('Article 52')) {
    if (findings.some(f => f.includes('chatbot') || f.includes('opinion'))) {
      rems.push('Add explicit disclosure that users are interacting with an AI system at the start of every interaction per Art. 52(1).');
    }
    if (findings.some(f => f.includes('emotion') || f.includes('biometric'))) {
      rems.push('Notify persons subject to emotion recognition or biometric categorisation per Art. 52(2).');
      rems.push('Implement consent mechanisms and provide meaningful disclosure for sensitive biometric processing.');
    }
    if (findings.some(f => f.includes('synthetic') || f.includes('deep-fake') || f.includes('deepfake'))) {
      rems.push('Label all AI-generated deep-fake or synthetic audio, image, and video content as machine-generated per Art. 52(3).');
    }
    if (rems.length === 0) {
      rems.push('Review Art. 52 transparency obligations for your specific AI system type (chatbot, emotion recognition, deep fakes).');
    }
  }

  return rems;
}

// ── Evidence Strength Scoring ────────────────────────────────────────────────

/**
 * Compute evidence strength for an article assessment.
 * @param relevantClaims - claims that contributed to this article's evidence
 * @param verifications  - verification results keyed by claim ID
 * @returns { evidenceCount, sourceCount, strengthScore }
 */
function computeEvidenceStrength(
  relevantClaims: Claim[],
  verifications: Record<string, VerificationResult>,
): { evidenceCount: number; sourceCount: number; strengthScore: number } {
  const evidenceCount = relevantClaims.length;
  let sourceCount = 0;
  for (const c of relevantClaims) {
    const v = verifications[c.id];
    if (v?.sources) sourceCount += v.sources.length;
  }

  // Strength is a function of evidence quantity and verification quality
  // Base: 0.2 for having any findings at all
  // +0.3 scaled by claim count (caps at 10 claims)
  // +0.3 scaled by source count (caps at 20 sources)
  // +0.2 for high verification rate (supported or contradicted = definitive)
  if (evidenceCount === 0) return { evidenceCount: 0, sourceCount: 0, strengthScore: 0.0 };

  const claimScale = Math.min(evidenceCount / 10, 1.0);
  const sourceScale = Math.min(sourceCount / 20, 1.0);
  const definitiveCount = relevantClaims.filter(c => {
    const status = verifications[c.id]?.status;
    return status === 'supported' || status === 'contradicted';
  }).length;
  const definitiveRate = definitiveCount / evidenceCount;

  const strength = 0.2 + (0.3 * claimScale) + (0.3 * sourceScale) + (0.2 * definitiveRate);
  return {
    evidenceCount,
    sourceCount,
    strengthScore: Math.round(strength * 100) / 100,
  };
}

// ── Core Report Builder ───────────────────────────────────────────────────────

export function buildEuComplianceReport(
  scan: ScanResult,
  opts: { projectName?: string } = {},
): EuAiActComplianceReport {
  const { claims, verifications, overallRisk, ruleFindings, complianceReport, provider } = scan;

  // ── Article 9 – Risk Management System ─────────────────────────────────────
  const art9Findings: string[] = [];

  const contradictedClaims = claims.filter(c => verifications[c.id]?.status === 'contradicted');
  const interpretationClaims = claims.filter(c => c.type === 'interpretation');
  const piiFindings = ruleFindings.filter(f => f.ruleId.toLowerCase().includes('pii'));
  const biasFindings = ruleFindings.filter(f => f.ruleId.toLowerCase().includes('bias'));
  const injectionFindings = ruleFindings.filter(f => f.ruleId.toLowerCase().includes('injection'));

  if (contradictedClaims.length > 0) {
    art9Findings.push(
      `${contradictedClaims.length} contradicted claim(s) detected — risk management review required.`,
    );
  }
  if (interpretationClaims.length > 0) {
    art9Findings.push(
      `${interpretationClaims.length} interpretation claim(s) require human oversight assessment per Art. 14.`,
    );
  }
  if (piiFindings.length > 0) {
    art9Findings.push(
      `${piiFindings.length} PII finding(s) — GDPR data governance alignment required. ` +
      `(OWASP Agentic AI A06: Sensitive Information Disclosure)`,
    );
  }
  if (biasFindings.length > 0) {
    art9Findings.push(
      `${biasFindings.length} bias finding(s) — training data governance review required (Art. 10).`,
    );
  }
  if (injectionFindings.length > 0) {
    art9Findings.push(
      `Prompt injection pattern detected — risk mitigation required. ` +
      `(OWASP Agentic AI A01: Prompt Injection)`,
    );
  }
  if (overallRisk === 'high' || overallRisk === 'critical') {
    art9Findings.push(
      `Overall risk assessed as ${overallRisk.toUpperCase()} — Annex III conformity assessment required.`,
    );
  }

  const art9Status: EvidenceStatus =
    art9Findings.length === 0 ? 'compliant' :
    (overallRisk === 'critical' || contradictedClaims.length > 2) ? 'non-compliant' : 'partial';

  // ── Article 10 – Data and Data Governance ──────────────────────────────────
  const art10Findings: string[] = [];

  if (biasFindings.length > 0) {
    art10Findings.push(
      `${biasFindings.length} bias finding(s) detected — training data governance review required ` +
      `per Art. 10(2) examination for bias. (OWASP Agentic AI A05: Improper Output Handling)`,
    );
  }
  if (piiFindings.length > 0) {
    art10Findings.push(
      `${piiFindings.length} PII finding(s) — data processing must comply with Art. 10(5) ` +
      `requirements for special category data and GDPR obligations.`,
    );
  }
  if (contradictedClaims.length > 0) {
    art10Findings.push(
      `${contradictedClaims.length} contradicted claim(s) — possible data quality issue per ` +
      `Art. 10(3) requirement for relevant, representative, and error-free training data.`,
    );
  }
  const highImportanceUnverified = claims.filter(
    c => (c.importance ?? 0) >= 4 && ['unverified', 'mixed'].includes(verifications[c.id]?.status ?? ''),
  );
  if (highImportanceUnverified.length > 0) {
    art10Findings.push(
      `${highImportanceUnverified.length} high-importance claim(s) remain unverified — ` +
      `data completeness review recommended per Art. 10(3).`,
    );
  }

  const art10Status: EvidenceStatus =
    art10Findings.length === 0 ? 'compliant' :
    (biasFindings.length > 0 || contradictedClaims.length > 2) ? 'non-compliant' : 'partial';

  // ── Article 11 – Technical Documentation ──────────────────────────────────
  const art11Findings: string[] = [];
  const claimsWithExplanation = claims.filter(c => {
    const v = verifications[c.id];
    return v && v.explanation && v.explanation.length > 0;
  });
  const claimsWithSources = claims.filter(c => {
    const v = verifications[c.id];
    return v && v.sources && v.sources.length > 0;
  });

  if (claimsWithExplanation.length > 0) {
    art11Findings.push(
      `${claimsWithExplanation.length}/${claims.length} claim(s) have verification explanations — ` +
      `decision-making rationale is documented per Art. 11(1)(a).`,
    );
  }
  if (claimsWithSources.length > 0) {
    art11Findings.push(
      `${claimsWithSources.length}/${claims.length} claim(s) cite verification sources — ` +
      `evidence provenance documented per Art. 11(1)(b).`,
    );
  }
  if (claims.length > 0 && claimsWithExplanation.length === 0 && claimsWithSources.length === 0) {
    art11Findings.push(
      'No verification explanations or sources present — technical documentation of system ' +
      'decision-making is insufficient per Art. 11.',
    );
  }

  const docCoverage = claims.length > 0
    ? (claimsWithExplanation.length + claimsWithSources.length) / (claims.length * 2)
    : 0;
  const art11Status: EvidenceStatus =
    claims.length === 0 ? 'not-applicable' :
    docCoverage >= 0.7 ? 'compliant' :
    docCoverage >= 0.3 ? 'partial' : 'gap';

  // ── Article 12 – Record-Keeping ───────────────────────────────────────────
  const art12Findings: string[] = [];

  if (scan.provider) {
    art12Findings.push(
      `Provider recorded: "${provider}" — AI system provenance tracked per Art. 12(1).`,
    );
  }
  if (claims.length > 0) {
    art12Findings.push(
      `${claims.length} claim(s) extracted with structured metadata (id, type, importance) — ` +
      `automatic event logging per Art. 12(2).`,
    );
  }
  if (ruleFindings.length > 0) {
    art12Findings.push(
      `${ruleFindings.length} rule finding(s) recorded — monitoring and anomaly detection active per Art. 12(3).`,
    );
  }

  const hasProvider = !!scan.provider;
  const hasStructuredClaims = claims.length > 0;
  const hasMonitoring = ruleFindings.length > 0;
  const art12Score = (hasProvider ? 1 : 0) + (hasStructuredClaims ? 1 : 0) + (hasMonitoring ? 1 : 0);
  const art12Status: EvidenceStatus =
    art12Score >= 2 ? 'compliant' :
    art12Score === 1 ? 'partial' : 'gap';

  // ── Article 13 – Transparency and Provision of Information ─────────────────
  const art13Findings: string[] = [];

  const supportedClaims = claims.filter(c => verifications[c.id]?.status === 'supported');
  const unverifiedClaims = claims.filter(
    c => ['unverified', 'mixed'].includes(verifications[c.id]?.status ?? ''),
  );

  if (supportedClaims.length > 0) {
    art13Findings.push(
      `${supportedClaims.length} verified fact claim(s) provide transparency compliance evidence — ` +
      `system capabilities are documented. (OWASP Agentic AI A02: Insecure Output Handling — outputs verified)`,
    );
  }
  if (unverifiedClaims.length > 0) {
    art13Findings.push(
      `${unverifiedClaims.length} unverified/mixed claim(s) represent transparency gaps — ` +
      `capabilities or limitations are not fully documented.`,
    );
  }
  if (claims.length === 0) {
    art13Findings.push(
      'No claims extracted — ensure AI system output includes verifiable factual statements ' +
      'per Art. 13 transparency requirements.',
    );
  }

  const hasTransparencyGap = unverifiedClaims.length > 0 || claims.length === 0;
  const art13Status: EvidenceStatus =
    !hasTransparencyGap && supportedClaims.length > 0 ? 'compliant' :
    unverifiedClaims.length > 0 && supportedClaims.length > 0 ? 'partial' : 'gap';

  // ── Article 14 – Human Oversight ───────────────────────────────────────────
  const art14Findings: string[] = [];
  const mixedClaims = claims.filter(c => verifications[c.id]?.status === 'mixed');

  if (interpretationClaims.length > 0) {
    art14Findings.push(
      `${interpretationClaims.length} interpretation claim(s) detected — human oversight ` +
      `mechanisms required. (OWASP Agentic AI A03: Excessive Agency)`,
    );
  }
  if (mixedClaims.length > 0) {
    art14Findings.push(
      `${mixedClaims.length} claim(s) with conflicting evidence — human review recommended before deployment.`,
    );
  }

  const art14Status: EvidenceStatus =
    interpretationClaims.length === 0 && mixedClaims.length === 0 ? 'not-applicable' :
    interpretationClaims.length > 0 ? 'partial' : 'compliant';

  // ── Article Evidence Array ─────────────────────────────────────────────────
  const articleEvidence: EuArticleEvidence[] = [];

  // Article 5 (prohibited) — only if triggered
  const unacceptableCount = complianceReport.euRiskSummary.unacceptable;
  if (unacceptableCount > 0) {
    const art5Findings = [
      `${unacceptableCount} claim(s) flagged for prohibited AI practice patterns — ` +
      `immediate legal review required before deployment.`,
    ];
    const art5Strength = computeEvidenceStrength(claims, verifications);
    articleEvidence.push({
      article: 'Article 5 – Prohibited AI Practices',
      requirement:
        'AI systems engaging in prohibited practices (subliminal manipulation, social scoring, ' +
        'mass surveillance, emotion recognition in workplace) are forbidden under EU AI Act.',
      status: 'non-compliant',
      findings: art5Findings,
      remediations: getRemediations('Article 5', 'non-compliant', art5Findings),
      ...art5Strength,
    });
  }

  // ── Article 6 – Classification Rules for High-Risk AI Systems ─────────────
  const highRiskMappings = complianceReport.claimMappings.filter(
    m => m.riskLevel === 'high' || m.riskLevel === 'unacceptable',
  );
  const highRiskClaimIds = new Set(highRiskMappings.map(m => m.claimId));
  const highRiskClaims = claims.filter(c => highRiskClaimIds.has(c.id));
  const art6Findings: string[] = [];
  if (highRiskMappings.length > 0) {
    const annexRefs = [...new Set(highRiskMappings.flatMap(m => m.matchedPatterns))];
    art6Findings.push(
      `${highRiskMappings.length} claim(s) reference Annex III high-risk domain(s): ` +
      `${annexRefs.slice(0, 3).join('; ')}${annexRefs.length > 3 ? ' (and more)' : ''}.`,
    );
    art6Findings.push(
      'Content touches a high-risk AI application domain per Article 6 + Annex III. ' +
      'Conformity assessment and EU database registration (Art. 49) may be required.',
    );
  }
  const art6Status: EvidenceStatus = highRiskMappings.length > 0 ? 'partial' : 'not-applicable';
  const art6FinalFindings = art6Findings.length > 0
    ? art6Findings
    : ['No Annex III high-risk domain matches detected. Article 6 classification not triggered.'];
  const art6Strength = computeEvidenceStrength(highRiskClaims, verifications);
  articleEvidence.push({
    article: 'Article 6 – Classification Rules for High-Risk AI Systems',
    requirement:
      'AI systems listed in Annex III are classified as high-risk if they pose significant risk to ' +
      'health, safety, or fundamental rights. Article 6 determines whether conformity assessment ' +
      'obligations (Articles 9–15) apply.',
    status: art6Status,
    findings: art6FinalFindings,
    remediations: getRemediations('Article 6', art6Status, art6FinalFindings),
    ...art6Strength,
  });

  const art9FinalFindings = art9Findings.length > 0
    ? art9Findings
    : ['No risk management findings. All claims verified within acceptable thresholds.'];
  const art9Claims = [...new Set([...contradictedClaims, ...interpretationClaims])];
  const art9Strength = computeEvidenceStrength(art9Claims, verifications);
  articleEvidence.push({
    article: 'Article 9 – Risk Management System',
    requirement:
      'Establish and maintain a continuous risk management system throughout the AI system lifecycle, ' +
      'including identification, analysis, estimation, evaluation, and treatment of risks.',
    status: art9Status,
    findings: art9FinalFindings,
    remediations: getRemediations('Article 9', art9Status, art9FinalFindings),
    owaspRef: 'OWASP Agentic AI A01: Prompt Injection, A06: Sensitive Information Disclosure',
    ...art9Strength,
  });

  const art10FinalFindings = art10Findings.length > 0
    ? art10Findings
    : ['No data governance findings. Training data quality indicators within acceptable thresholds.'];
  const art10Claims = [...new Set([...contradictedClaims, ...highImportanceUnverified])];
  const art10Strength = computeEvidenceStrength(art10Claims, verifications);
  articleEvidence.push({
    article: 'Article 10 – Data and Data Governance',
    requirement:
      'Training, validation, and testing data sets shall be relevant, representative, free of errors, ' +
      'and complete. Data governance measures must address bias detection, data quality, and ' +
      'special category data processing in accordance with GDPR.',
    status: art10Status,
    findings: art10FinalFindings,
    remediations: getRemediations('Article 10', art10Status, art10FinalFindings),
    owaspRef: 'OWASP Agentic AI A05: Improper Output Handling',
    ...art10Strength,
  });

  const art11FinalFindings = art11Findings.length > 0
    ? art11Findings
    : ['Technical documentation assessment: no claims to evaluate.'];
  const art11Strength = computeEvidenceStrength(claimsWithExplanation, verifications);
  articleEvidence.push({
    article: 'Article 11 – Technical Documentation',
    requirement:
      'Technical documentation shall be drawn up before the AI system is placed on the market, ' +
      'covering system description, design specifications, and decision-making rationale.',
    status: art11Status,
    findings: art11FinalFindings,
    remediations: getRemediations('Article 11', art11Status, art11FinalFindings),
    ...art11Strength,
  });

  const art12FinalFindings = art12Findings.length > 0
    ? art12Findings
    : ['Record-keeping assessment: no logging evidence found.'];
  const art12Strength = computeEvidenceStrength(claims, verifications);
  articleEvidence.push({
    article: 'Article 12 – Record-Keeping',
    requirement:
      'AI systems shall be designed with capabilities enabling automatic recording of events (logs) ' +
      'throughout their lifecycle, ensuring traceability of system functioning.',
    status: art12Status,
    findings: art12FinalFindings,
    remediations: getRemediations('Article 12', art12Status, art12FinalFindings),
    ...art12Strength,
  });

  const art13FinalFindings = art13Findings.length > 0 ? art13Findings : ['No transparency gaps detected.'];
  const art13Claims = [...new Set([...supportedClaims, ...unverifiedClaims])];
  const art13Strength = computeEvidenceStrength(art13Claims, verifications);
  articleEvidence.push({
    article: 'Article 13 – Transparency and Provision of Information',
    requirement:
      'AI system must be sufficiently transparent to enable users to understand its capabilities, ' +
      'limitations, purpose, and the logic behind significant outputs.',
    status: art13Status,
    findings: art13FinalFindings,
    remediations: getRemediations('Article 13', art13Status, art13FinalFindings),
    owaspRef: 'OWASP Agentic AI A02: Insecure Output Handling',
    ...art13Strength,
  });

  const art14FinalFindings = art14Findings.length > 0
    ? art14Findings
    : ['No human oversight requirements triggered by this scan.'];
  const art14Claims = [...new Set([...interpretationClaims, ...mixedClaims])];
  const art14Strength = computeEvidenceStrength(art14Claims, verifications);
  articleEvidence.push({
    article: 'Article 14 – Human Oversight',
    requirement:
      'AI system design must enable natural persons to effectively oversee and intervene during ' +
      'operation to prevent or minimise risks to health, safety, or fundamental rights.',
    status: art14Status,
    findings: art14FinalFindings,
    remediations: getRemediations('Article 14', art14Status, art14FinalFindings),
    owaspRef: 'OWASP Agentic AI A03: Excessive Agency',
    ...art14Strength,
  });

  // ── Article 15 – Accuracy, Robustness, and Cybersecurity ──────────────────
  const art15Findings: string[] = [];
  const contradictionRate = claims.length > 0 ? contradictedClaims.length / claims.length : 0;

  if (contradictionRate > 0.3) {
    art15Findings.push(
      `${(contradictionRate * 100).toFixed(0)}% of claims contradicted — accuracy requirements ` +
      `not met per Art. 15(1) (${contradictedClaims.length}/${claims.length} claims).`,
    );
  } else if (contradictedClaims.length > 0) {
    art15Findings.push(
      `${contradictedClaims.length} contradicted claim(s) detected — minor accuracy concern ` +
      `per Art. 15(1). Review before deployment.`,
    );
  }
  if (highImportanceUnverified.length > 0) {
    art15Findings.push(
      `${highImportanceUnverified.length} high-importance claim(s) unverified — ` +
      `robustness assessment incomplete per Art. 15(2).`,
    );
  }
  if (injectionFindings.length > 0) {
    art15Findings.push(
      `${injectionFindings.length} injection/attack pattern(s) detected — cybersecurity ` +
      `measures required per Art. 15(3). (OWASP Agentic AI A01: Prompt Injection)`,
    );
  }

  const art15Status: EvidenceStatus =
    injectionFindings.length > 0 || contradictionRate > 0.3 ? 'non-compliant' :
    (contradictedClaims.length > 0 || highImportanceUnverified.length > 0) ? 'partial' :
    (claims.length === 0 ? 'gap' : 'compliant');

  const art15FinalFindings = art15Findings.length > 0
    ? art15Findings
    : ['No accuracy, robustness, or cybersecurity issues detected.'];
  const art15Claims = [...new Set([...contradictedClaims, ...highImportanceUnverified])];
  const art15Strength = computeEvidenceStrength(art15Claims, verifications);
  articleEvidence.push({
    article: 'Article 15 – Accuracy, Robustness, and Cybersecurity',
    requirement:
      'High-risk AI systems shall achieve appropriate levels of accuracy and be resilient against ' +
      'errors, faults, and cybersecurity attacks that could cause the system to behave in an ' +
      'unintended way.',
    status: art15Status,
    findings: art15FinalFindings,
    remediations: getRemediations('Article 15', art15Status, art15FinalFindings),
    owaspRef: 'OWASP Agentic AI A01: Prompt Injection, A07: System Prompt Leakage',
    ...art15Strength,
  });

  // ── Article 52 – Transparency Obligations for Specific AI System Types ───────
  // §1: chatbot/AI-human interaction disclosure; §2: emotion recognition + biometric
  // categorisation disclosure; §3: deep-fake / synthetic media labelling.
  const emotionFindings = ruleFindings.filter(f => /emotion|sentiment/i.test(f.ruleId));
  const syntheticFindings = ruleFindings.filter(f =>
    /synthetic|deepfake|deep.fake|generated/i.test(f.ruleId),
  );
  const biometricMappings = complianceReport.claimMappings.filter(m =>
    m.matchedPatterns.some(p => /biometric/i.test(p)),
  );

  // Reuse opinionClaims computed below for Art. 50; define here so Art. 52 can reference it.
  const opinionClaimsForArt52 = claims.filter(c => c.type === 'opinion');

  const art52Findings: string[] = [];
  if (opinionClaimsForArt52.length > 0) {
    art52Findings.push(
      `${opinionClaimsForArt52.length} AI-generated opinion claim(s) detected — if this system ` +
      `interacts directly with users, disclosure that they are communicating with an AI is ` +
      `required per Art. 52(1).`,
    );
  }
  if (emotionFindings.length > 0) {
    art52Findings.push(
      `${emotionFindings.length} emotion/sentiment finding(s) — persons subject to emotion ` +
      `recognition must be informed per Art. 52(2). ` +
      `(OWASP Agentic AI A06: Sensitive Information Disclosure)`,
    );
  }
  if (biometricMappings.length > 0) {
    art52Findings.push(
      `${biometricMappings.length} biometric categorisation mapping(s) — persons must be ` +
      `informed when biometric data is used to categorise them per Art. 52(2).`,
    );
  }
  if (syntheticFindings.length > 0) {
    art52Findings.push(
      `${syntheticFindings.length} synthetic/deep-fake content finding(s) — machine-generated ` +
      `labelling required for deep-fake audio, image, or video content per Art. 52(3).`,
    );
  }

  const art52Status: EvidenceStatus =
    (emotionFindings.length > 0 || syntheticFindings.length > 0 ||
     biometricMappings.length > 0 || opinionClaimsForArt52.length > 0)
      ? 'partial' : 'not-applicable';

  const art52FinalFindings = art52Findings.length > 0
    ? art52Findings
    : ['No Art. 52 transparency triggers detected (no chatbot interaction, emotion recognition, biometric categorisation, or synthetic media signals).'];

  const art52RelevantClaims = opinionClaimsForArt52;
  const art52Strength = computeEvidenceStrength(art52RelevantClaims, verifications);
  articleEvidence.push({
    article: 'Article 52 – Transparency Obligations for Specific AI System Types',
    requirement:
      'AI systems interacting with humans must disclose they are AI (§1). Systems performing ' +
      'emotion recognition or biometric categorisation must inform the persons concerned (§2). ' +
      'Deep-fake and synthetic media must be labelled as machine-generated (§3).',
    status: art52Status,
    findings: art52FinalFindings,
    remediations: getRemediations('Article 52', art52Status, art52FinalFindings),
    owaspRef: 'OWASP Agentic AI A06: Sensitive Information Disclosure',
    ...art52Strength,
  });

  // Article 50 — GPAI transparency (always included; opinion claims drive severity)
  const opinionClaims = claims.filter(c => c.type === 'opinion');
  const art50Findings: string[] = [];
  if (opinionClaims.length > 0) {
    art50Findings.push(
      `${opinionClaims.length} opinion claim(s) detected — AI-generated opinion content ` +
      `requires transparency labelling per Art. 50 GPAI obligations.`,
    );
  }
  art50Findings.push(
    'Art. 50(4) voice/audio disclosure: not applicable — Faultline scans text only; ' +
    'voice/audio AI outputs are outside this assessment scope.',
  );
  const art50Status: EvidenceStatus = opinionClaims.length > 0 ? 'partial' : 'not-applicable';

  const art50Strength = computeEvidenceStrength(opinionClaims, verifications);
  articleEvidence.push({
    article: 'Article 50 – Transparency Obligations for GPAI Models',
    requirement:
      'AI-generated content must be disclosed to users. Synthetic, opinion-based, or GPAI-produced ' +
      'content requires explicit machine-generated labelling.',
    status: art50Status,
    findings: art50Findings,
    remediations: getRemediations('Article 50', art50Status, art50Findings),
    ...art50Strength,
  });

  // ── Test Category Mappings ─────────────────────────────────────────────────
  const testCategoryMappings = buildTestCategoryMappings(claims, verifications, ruleFindings, complianceReport.claimMappings);

  // ── Article 50 Disclosure Object ──────────────────────────────────────────
  const article50Disclosure = {
    status: 'not-applicable' as const,
    note:
      'Article 50 GPAI transparency obligations are tracked via claim-type analysis. ' +
      'Art. 50(4) voice/audio disclosure is not applicable for text-only scanning.',
    voiceAudioDisclosure:
      'Not applicable — Art. 50(4) applies to AI systems generating voice/audio outputs. ' +
      'Faultline scans text; voice/audio AI outputs are outside this assessment scope.',
  };

  // ── Summary ───────────────────────────────────────────────────────────────
  const compliantCount = articleEvidence.filter(a => a.status === 'compliant').length;
  const nonCompliantCount = articleEvidence.filter(a => a.status === 'non-compliant').length;
  const partialCount = articleEvidence.filter(a => a.status === 'partial').length;
  const gapCount = articleEvidence.filter(a => a.status === 'gap').length;
  const highRiskFindings =
    contradictedClaims.length + piiFindings.length + biasFindings.length + unacceptableCount;

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const documentRef = `FP-EUACT-${ts}`;

  // ── Compliance Score (0–100) — evidence-weighted ────────────────────────
  const scoreMap: Record<string, number> = {
    'compliant': 100,
    'not-applicable': 100,
    'partial': 50,
    'gap': 25,
    'non-compliant': 0,
  };
  const scoredArticles = articleEvidence.filter(a => a.status !== 'not-applicable');
  // Weight each article's score by its evidence strength (minimum weight 0.5 so
  // low-evidence articles still count, but high-evidence articles count more)
  let complianceScore: number;
  if (scoredArticles.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const a of scoredArticles) {
      const weight = 0.5 + (a.strengthScore * 0.5); // range: 0.5–1.0
      weightedSum += (scoreMap[a.status] ?? 50) * weight;
      totalWeight += weight;
    }
    complianceScore = Math.round(weightedSum / totalWeight);
  } else {
    complianceScore = 100;
  }

  // ── Annex III Conformity Assessment Checklist ────────────────────────────
  const articleStatusMap = new Map(articleEvidence.map(a => [a.article, a.status]));

  function artStatus(needle: string): EvidenceStatus | undefined {
    for (const [k, v] of articleStatusMap) {
      if (k.includes(needle)) return v;
    }
    return undefined;
  }

  // Annex III applies when overall risk is high/critical OR when Art. 6 detects
  // Annex III high-risk domain content — a medium-risk scan touching biometrics or
  // employment AI must still undergo conformity assessment.
  const art6StatusVal = artStatus('Article 6');
  const annexApplicable =
    overallRisk === 'high' || overallRisk === 'critical' ||
    art6StatusVal === 'partial' || art6StatusVal === 'non-compliant';

  function toAnnexStatus(s: EvidenceStatus | undefined): AnnexCheckStatus {
    if (!s) return 'not-assessed';
    if (s === 'compliant' || s === 'not-applicable') return 'pass';
    if (s === 'non-compliant') return 'fail';
    return 'partial';
  }

  const annexItems: AnnexIIICheckItem[] = [
    {
      id: 'annex-iii-0',
      article: 'Article 6',
      requirement: 'High-risk classification — Annex III domain match assessed; conformity assessment obligation determined',
      status: toAnnexStatus(art6StatusVal),
      evidence: `Article 6 status: ${art6StatusVal ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-1',
      article: 'Article 9',
      requirement: 'Risk management system — continuous identification, analysis, evaluation, and treatment of risks',
      status: toAnnexStatus(artStatus('Article 9')),
      evidence: `Article 9 status: ${artStatus('Article 9') ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-2',
      article: 'Article 10',
      requirement: 'Data and data governance — training data quality, completeness, bias examination',
      status: toAnnexStatus(artStatus('Article 10')),
      evidence: `Article 10 status: ${artStatus('Article 10') ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-3',
      article: 'Article 11',
      requirement: 'Technical documentation — sufficient for conformity assessment and post-market monitoring',
      status: toAnnexStatus(artStatus('Article 11')),
      evidence: `Article 11 status: ${artStatus('Article 11') ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-4',
      article: 'Article 12',
      requirement: 'Record-keeping — automatic logging of events during AI system operation',
      status: toAnnexStatus(artStatus('Article 12')),
      evidence: `Article 12 status: ${artStatus('Article 12') ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-5',
      article: 'Article 13',
      requirement: 'Transparency — users can interpret and use AI output appropriately',
      status: toAnnexStatus(artStatus('Article 13')),
      evidence: `Article 13 status: ${artStatus('Article 13') ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-6',
      article: 'Article 14',
      requirement: 'Human oversight — effective oversight by natural persons during operation',
      status: toAnnexStatus(artStatus('Article 14')),
      evidence: `Article 14 status: ${artStatus('Article 14') ?? 'not assessed'}`,
    },
    {
      id: 'annex-iii-7',
      article: 'Article 15',
      requirement: 'Accuracy, robustness, and cybersecurity — appropriate to intended purpose',
      status: toAnnexStatus(artStatus('Article 15')),
      evidence: `Article 15 status: ${artStatus('Article 15') ?? 'not assessed'}`,
    },
  ];

  const passCount = annexItems.filter(i => i.status === 'pass').length;
  const annexIIIChecklist: AnnexIIIChecklist = {
    applicable: annexApplicable,
    passRate: annexItems.length > 0 ? Math.round((passCount / annexItems.length) * 100) / 100 : 0,
    items: annexApplicable ? annexItems : [],
  };

  return {
    generatedAt: new Date().toISOString(),
    documentRef,
    projectName: opts.projectName || 'Untitled AI System Assessment',
    provider,
    overallRisk,
    articleEvidence,
    article50Disclosure,
    testCategoryMappings,
    complianceScore,
    annexIIIChecklist,
    summary: {
      compliantArticles: compliantCount,
      nonCompliantArticles: nonCompliantCount,
      partialArticles: partialCount,
      gapArticles: gapCount,
      totalClaimsAnalyzed: claims.length,
      highRiskFindings,
    },
  };
}

// ── CI Gate Evaluation ───────────────────────────────────────────────────────

export interface CiGateArticleResult {
  article: string;
  status: EvidenceStatus;
  pass: boolean;
}

export interface CiGateResult {
  pass: boolean;
  overallRisk: string;
  articles: CiGateArticleResult[];
  nonCompliantCount: number;
  totalArticles: number;
  exitCode: 0 | 1;
  complianceScore: number;
  threshold: number;
  /** True when Art. 6 triggered the Annex III checklist (domain content detected) but
   *  overall risk is not yet high/critical — conformity assessment obligation is active. */
  art6ConformityRequired: boolean;
}

export interface GateOptions {
  /** Minimum compliance score (0–100) to pass. Default: 0 (only non-compliant articles fail). */
  threshold?: number;
  /** When true, every article must be 'compliant' or 'not-applicable' to pass. */
  strict?: boolean;
}

/**
 * Evaluate a compliance report against a CI gate.
 * Default: fails if any article is non-compliant OR overall risk is high/critical.
 * With threshold: also fails if complianceScore < threshold.
 * With strict: every article must be 'compliant' or 'not-applicable'.
 */
export function evaluateComplianceGate(
  report: EuAiActComplianceReport,
  opts: GateOptions = {},
): CiGateResult {
  const threshold = opts.threshold ?? 0;
  const strict = opts.strict ?? false;

  const articles: CiGateArticleResult[] = report.articleEvidence.map(ev => {
    const articlePass = strict
      ? (ev.status === 'compliant' || ev.status === 'not-applicable')
      : ev.status !== 'non-compliant';
    return { article: ev.article, status: ev.status, pass: articlePass };
  });

  const nonCompliantCount = articles.filter(a => !a.pass).length;
  const riskFail = report.overallRisk === 'high' || report.overallRisk === 'critical';
  const scoreFail = threshold > 0 && report.complianceScore < threshold;
  const annexFail = strict && report.annexIIIChecklist.applicable &&
    report.annexIIIChecklist.items.some(i => i.status === 'fail' || i.status === 'not-assessed');
  // Art. 6 domain detection triggers mandatory conformity assessment even when
  // overall risk is not yet high/critical. Block CI in default mode too.
  const art6ConformityRequired =
    report.annexIIIChecklist.applicable &&
    !riskFail &&
    report.annexIIIChecklist.items.some(i => i.id === 'annex-iii-0' && i.status !== 'pass');
  const pass = nonCompliantCount === 0 && !riskFail && !scoreFail && !annexFail && !art6ConformityRequired;

  return {
    pass,
    overallRisk: report.overallRisk,
    articles,
    nonCompliantCount,
    totalArticles: articles.length,
    exitCode: pass ? 0 : 1,
    complianceScore: report.complianceScore,
    threshold,
    art6ConformityRequired,
  };
}

/**
 * Render CI gate output as a human-readable summary for terminal/CI logs.
 */
export function renderCiGateOutput(gate: CiGateResult, report: EuAiActComplianceReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`EU AI Act Compliance Gate — ${gate.pass ? 'PASS' : 'FAIL'}`);
  lines.push('='.repeat(50));
  lines.push(`Overall Risk: ${report.overallRisk.toUpperCase()}`);
  const thresholdLabel = gate.threshold > 0 ? ` (threshold: ${gate.threshold})` : '';
  lines.push(`Score:        ${report.complianceScore}/100${thresholdLabel}`);
  lines.push(`Project:      ${report.projectName}`);
  lines.push(`Document:     ${report.documentRef}`);
  lines.push('');

  for (const a of gate.articles) {
    const icon = a.pass ? '[PASS]' : '[FAIL]';
    lines.push(`  ${icon} ${a.article} — ${a.status.toUpperCase()}`);
  }

  lines.push('');
  lines.push(`Articles: ${gate.totalArticles - gate.nonCompliantCount}/${gate.totalArticles} passing`);

  // Annex III conformity checklist (shown when applicable)
  if (report.annexIIIChecklist.applicable && report.annexIIIChecklist.items.length > 0) {
    lines.push('Annex III Conformity Assessment:');
    for (const item of report.annexIIIChecklist.items) {
      const icon = item.status === 'pass' ? '[PASS]' :
                   item.status === 'fail' ? '[FAIL]' :
                   item.status === 'partial' ? '[PART]' : '[N/A ]';
      lines.push(`  ${icon} ${item.article} — ${item.requirement}`);
    }
    lines.push(`  Pass rate: ${Math.round(report.annexIIIChecklist.passRate * 100)}%`);
    lines.push('');
  }

  if (!gate.pass) {
    lines.push('');
    if (gate.nonCompliantCount > 0) {
      lines.push(`${gate.nonCompliantCount} non-compliant article(s) found.`);
    }
    if (report.overallRisk === 'high' || report.overallRisk === 'critical') {
      lines.push(`Overall risk is ${report.overallRisk.toUpperCase()} — gate fails on high/critical risk.`);
    }
    if (gate.threshold > 0 && report.complianceScore < gate.threshold) {
      lines.push(`Compliance score ${report.complianceScore} is below threshold ${gate.threshold}.`);
    }
    if (gate.art6ConformityRequired) {
      lines.push('Article 6: Annex III high-risk domain content detected — conformity assessment required before deployment.');
    }
    if (report.annexIIIChecklist.applicable) {
      const failing = report.annexIIIChecklist.items.filter(i => i.status === 'fail' || i.status === 'not-assessed');
      if (failing.length > 0) {
        lines.push(`Annex III: ${failing.length} conformity item(s) require attention (${failing.map(f => f.article).join(', ')}).`);
      }
    }

    // Show remediations for failing articles
    const failingArticles = report.articleEvidence.filter(ev => ev.remediations.length > 0);
    if (failingArticles.length > 0) {
      lines.push('');
      lines.push('Recommended Remediations:');
      for (const ev of failingArticles) {
        lines.push(`  ${ev.article}:`);
        for (const rem of ev.remediations) {
          lines.push(`    - ${rem}`);
        }
      }
    }

    lines.push('');
    lines.push('Exit code: 1');
  } else {
    lines.push('');
    lines.push('All articles compliant. Risk within threshold.');
    lines.push('Exit code: 0');
  }

  return lines.join('\n');
}

// ── Compliance Diff ──────────────────────────────────────────────────────────

export type ArticleTrend = 'improved' | 'regressed' | 'unchanged' | 'new' | 'removed';

export interface ArticleDiff {
  article: string;
  before: EvidenceStatus | null;
  after: EvidenceStatus | null;
  trend: ArticleTrend;
}

export interface ComplianceDiffResult {
  before: { documentRef: string; overallRisk: string; generatedAt: string };
  after: { documentRef: string; overallRisk: string; generatedAt: string };
  riskTrend: 'improved' | 'regressed' | 'unchanged';
  articles: ArticleDiff[];
  improved: number;
  regressed: number;
  unchanged: number;
}

const STATUS_RANK: Record<string, number> = {
  'compliant': 0,
  'not-applicable': 1,
  'partial': 2,
  'gap': 3,
  'non-compliant': 4,
};

const RISK_RANK: Record<string, number> = {
  'low': 0,
  'medium': 1,
  'high': 2,
  'critical': 3,
};

/**
 * Compare two compliance reports and produce a structured diff.
 */
export function diffComplianceReports(
  before: EuAiActComplianceReport,
  after: EuAiActComplianceReport,
): ComplianceDiffResult {
  const beforeMap = new Map(before.articleEvidence.map(a => [a.article, a.status]));
  const afterMap = new Map(after.articleEvidence.map(a => [a.article, a.status]));

  const allArticles = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const articles: ArticleDiff[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const article of allArticles) {
    const b = beforeMap.get(article) ?? null;
    const a = afterMap.get(article) ?? null;

    let trend: ArticleTrend;
    if (b === null) {
      trend = 'new';
    } else if (a === null) {
      trend = 'removed';
    } else {
      const bRank = STATUS_RANK[b] ?? 2;
      const aRank = STATUS_RANK[a] ?? 2;
      if (aRank < bRank) { trend = 'improved'; improved++; }
      else if (aRank > bRank) { trend = 'regressed'; regressed++; }
      else { trend = 'unchanged'; unchanged++; }
    }

    articles.push({ article, before: b, after: a, trend });
  }

  const bRisk = RISK_RANK[before.overallRisk] ?? 1;
  const aRisk = RISK_RANK[after.overallRisk] ?? 1;
  const riskTrend = aRisk < bRisk ? 'improved' : aRisk > bRisk ? 'regressed' : 'unchanged';

  return {
    before: { documentRef: before.documentRef, overallRisk: before.overallRisk, generatedAt: before.generatedAt },
    after: { documentRef: after.documentRef, overallRisk: after.overallRisk, generatedAt: after.generatedAt },
    riskTrend,
    articles,
    improved,
    regressed,
    unchanged,
  };
}

/**
 * Render a compliance diff as human-readable text for terminal output.
 */
export function renderComplianceDiffOutput(diff: ComplianceDiffResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`EU AI Act Compliance Diff`);
  lines.push('='.repeat(50));
  lines.push(`Before: ${diff.before.documentRef} (risk: ${diff.before.overallRisk})`);
  lines.push(`After:  ${diff.after.documentRef} (risk: ${diff.after.overallRisk})`);
  lines.push(`Risk trend: ${diff.riskTrend.toUpperCase()}`);
  lines.push('');

  for (const a of diff.articles) {
    const icon = a.trend === 'improved' ? '[+]' :
                 a.trend === 'regressed' ? '[-]' :
                 a.trend === 'new' ? '[N]' :
                 a.trend === 'removed' ? '[R]' : '[ ]';
    const bLabel = a.before?.toUpperCase() ?? 'N/A';
    const aLabel = a.after?.toUpperCase() ?? 'N/A';
    lines.push(`  ${icon} ${a.article}: ${bLabel} -> ${aLabel}`);
  }

  lines.push('');
  lines.push(`Summary: ${diff.improved} improved, ${diff.regressed} regressed, ${diff.unchanged} unchanged`);
  return lines.join('\n');
}

// ── JSON Renderer ─────────────────────────────────────────────────────────────

export function renderComplianceReportJson(report: EuAiActComplianceReport): string {
  return JSON.stringify(report, null, 2);
}

// ── Markdown Renderer (for GitHub PR comments) ─────────────────────────────

/**
 * Render a compliance report as a GitHub-flavored Markdown summary.
 * Ideal for posting as a PR comment in CI pipelines.
 */
export function renderComplianceReportMarkdown(
  report: EuAiActComplianceReport,
  gate: CiGateResult,
): string {
  const icon = gate.pass ? ':white_check_mark:' : ':x:';
  const status = gate.pass ? 'PASS' : 'FAIL';
  const lines: string[] = [];

  lines.push(`## ${icon} EU AI Act Compliance — ${status}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| **Score** | ${report.complianceScore}/100 |`);
  lines.push(`| **Overall Risk** | ${report.overallRisk.toUpperCase()} |`);
  lines.push(`| **Project** | ${report.projectName} |`);
  lines.push(`| **Claims Analysed** | ${report.summary.totalClaimsAnalyzed} |`);
  lines.push(`| **High-Risk Findings** | ${report.summary.highRiskFindings} |`);
  if (gate.threshold > 0) {
    lines.push(`| **Threshold** | ${gate.threshold} |`);
  }
  lines.push('');

  lines.push('### Article Status');
  lines.push('');
  lines.push('| Article | Status | Result |');
  lines.push('|---------|--------|--------|');
  for (const a of gate.articles) {
    const aIcon = a.pass ? ':white_check_mark:' : ':x:';
    lines.push(`| ${a.article} | ${a.status.toUpperCase()} | ${aIcon} |`);
  }
  lines.push('');

  // Add remediations for failing articles
  const failing = report.articleEvidence.filter(ev => ev.remediations.length > 0);
  if (failing.length > 0) {
    lines.push('<details>');
    lines.push('<summary>Recommended Remediations</summary>');
    lines.push('');
    for (const ev of failing) {
      lines.push(`**${ev.article}**`);
      for (const rem of ev.remediations) {
        lines.push(`- ${rem}`);
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  // Annex III conformity checklist
  if (report.annexIIIChecklist.applicable && report.annexIIIChecklist.items.length > 0) {
    lines.push('### Annex III Conformity Assessment');
    lines.push('');
    lines.push('| # | Article | Requirement | Status |');
    lines.push('|---|---------|-------------|--------|');
    for (const item of report.annexIIIChecklist.items) {
      const sIcon = item.status === 'pass' ? ':white_check_mark:' :
                    item.status === 'fail' ? ':x:' :
                    item.status === 'partial' ? ':warning:' : ':grey_question:';
      lines.push(`| ${item.id} | ${item.article} | ${item.requirement} | ${sIcon} ${item.status.toUpperCase()} |`);
    }
    lines.push('');
    lines.push(`**Pass rate:** ${Math.round(report.annexIIIChecklist.passRate * 100)}%`);
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`*Generated by [Faultline Pro](https://github.com/nxtg-ai/faultline-pro) — ${report.documentRef}*`);
  return lines.join('\n');
}

// ── SARIF 2.1.0 Compliance Renderer ─────────────────────────────────────────

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

function complianceStatusToSarifLevel(status: EvidenceStatus): SarifLevel {
  switch (status) {
    case 'non-compliant': return 'error';
    case 'gap': return 'error';
    case 'partial': return 'warning';
    case 'compliant': return 'none';
    case 'not-applicable': return 'none';
    default: return 'warning';
  }
}

/**
 * Render an EU AI Act compliance report as a SARIF 2.1.0 JSON string.
 *
 * Each EU AI Act article maps to a SARIF rule; non-compliant, gap, and partial
 * articles produce SARIF results for integration with GitHub Code Scanning,
 * GitLab SAST, Azure DevOps, and other security tooling.
 */
export function renderComplianceReportSarif(
  report: EuAiActComplianceReport,
  gate: CiGateResult,
): string {
  // Build rule definitions — one per article
  const ruleDefinitions = report.articleEvidence.map((ev) => {
    const articleSlug = ev.article.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      id: `faultline/eu-ai-act/${articleSlug}`,
      name: ev.article.replace(/\s+/g, ''),
      shortDescription: { text: `EU AI Act: ${ev.article}` },
      fullDescription: { text: ev.requirement },
      defaultConfiguration: { level: complianceStatusToSarifLevel(ev.status) },
      properties: { tags: ['eu-ai-act', 'compliance', articleSlug] },
    };
  });

  const ruleIndexMap = new Map<string, number>();
  ruleDefinitions.forEach((r, i) => ruleIndexMap.set(r.id, i));

  // Build results — only for non-passing articles
  const results: Array<Record<string, unknown>> = [];
  for (const ev of report.articleEvidence) {
    if (ev.status === 'compliant' || ev.status === 'not-applicable') continue;

    const articleSlug = ev.article.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const ruleId = `faultline/eu-ai-act/${articleSlug}`;

    const message = ev.findings.length > 0
      ? `${ev.article}: ${ev.status} — ${ev.findings[0]}`
      : `${ev.article}: ${ev.status}`;

    const result: Record<string, unknown> = {
      ruleId,
      ruleIndex: ruleIndexMap.get(ruleId) ?? -1,
      level: complianceStatusToSarifLevel(ev.status),
      message: { text: message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'input', uriBaseId: '%SRCROOT%' },
          region: { startLine: 1 },
        },
      }],
      properties: {
        article: ev.article,
        status: ev.status,
        ...(ev.remediations.length > 0 && { remediations: ev.remediations }),
      },
    };

    results.push(result);
  }

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0' as const,
    runs: [{
      tool: {
        driver: {
          name: 'Faultline Pro',
          version: '0.4.1',
          informationUri: 'https://github.com/nxtg-ai/faultline-pro',
          rules: ruleDefinitions,
        },
      },
      originalUriBaseIds: {
        '%SRCROOT%': { uri: '' },
      },
      results,
      invocations: [{
        executionSuccessful: gate.pass,
        properties: {
          overallRisk: report.overallRisk,
          complianceScore: report.complianceScore,
          threshold: gate.threshold,
          projectName: report.projectName,
          documentRef: report.documentRef,
          ...(report.annexIIIChecklist.applicable && {
            annexIIIPassRate: report.annexIIIChecklist.passRate,
          }),
        },
      }],
    }],
  };

  // Add Annex III conformity items as additional SARIF results
  if (report.annexIIIChecklist.applicable) {
    for (const item of report.annexIIIChecklist.items) {
      if (item.status === 'pass') continue;

      const ruleId = `faultline/eu-ai-act/${item.id}`;
      const level: SarifLevel = item.status === 'fail' ? 'error' :
                                 item.status === 'partial' ? 'warning' : 'note';

      // Add rule definition
      sarif.runs[0].tool.driver.rules.push({
        id: ruleId,
        name: item.id.replace(/-/g, ''),
        shortDescription: { text: `Annex III: ${item.article} — ${item.requirement}` },
        fullDescription: { text: item.evidence },
        defaultConfiguration: { level },
        properties: { tags: ['eu-ai-act', 'annex-iii', 'conformity'] },
      });

      // Add result
      sarif.runs[0].results.push({
        ruleId,
        ruleIndex: sarif.runs[0].tool.driver.rules.length - 1,
        level,
        message: { text: `Annex III conformity gap: ${item.article} — ${item.requirement} (${item.status})` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: 'input', uriBaseId: '%SRCROOT%' },
            region: { startLine: 1 },
          },
        }],
        properties: {
          annexItem: item.id,
          article: item.article,
          status: item.status,
          evidence: item.evidence,
        },
      });
    }
  }

  return JSON.stringify(sarif, null, 2);
}

// ── HTML Compliance Renderer ────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlStatusColor(status: EvidenceStatus): string {
  switch (status) {
    case 'compliant': return '#16a34a';
    case 'partial': return '#ca8a04';
    case 'gap': return '#ea580c';
    case 'non-compliant': return '#dc2626';
    case 'not-applicable': return '#6b7280';
    default: return '#6b7280';
  }
}

/**
 * Render an EU AI Act compliance report as a standalone HTML page.
 *
 * Designed for viewing in a browser, archiving, or embedding in a build
 * artifact. Includes summary cards, article status table, remediations,
 * and Faultline Pro branding.
 */
export function renderComplianceReportHtml(
  report: EuAiActComplianceReport,
  gate: CiGateResult,
): string {
  const statusIcon = gate.pass ? '&#x2705;' : '&#x274C;';
  const statusText = gate.pass ? 'PASS' : 'FAIL';

  const articleRows = report.articleEvidence.map(ev => {
    const badge = `<span class="badge" style="background:${htmlStatusColor(ev.status)}">${escapeHtml(ev.status)}</span>`;
    const remList = ev.remediations.length > 0
      ? `<ul>${ev.remediations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
      : '—';
    return `<tr><td>${escapeHtml(ev.article)}</td><td>${badge}</td><td>${escapeHtml(ev.requirement)}</td><td>${remList}</td></tr>`;
  }).join('\n');

  const thresholdCard = gate.threshold > 0
    ? `<div class="summary-card"><div class="label">Threshold</div><div class="value">${gate.threshold}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EU AI Act Compliance — ${escapeHtml(report.projectName)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; color: #fff; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .summary-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.75rem 1rem; }
  .summary-card .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-card .value { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; }
  ul { padding-left: 1.5rem; margin-bottom: 0.5rem; }
  li { margin-bottom: 0.25rem; font-size: 0.8rem; }
  footer { margin-top: 2rem; font-size: 0.75rem; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
<h1>${statusIcon} EU AI Act Compliance — ${statusText}</h1>

<div class="summary-grid">
  <div class="summary-card"><div class="label">Score</div><div class="value">${report.complianceScore}/100</div></div>
  <div class="summary-card"><div class="label">Overall Risk</div><div class="value">${escapeHtml(report.overallRisk.toUpperCase())}</div></div>
  <div class="summary-card"><div class="label">Project</div><div class="value">${escapeHtml(report.projectName)}</div></div>
  <div class="summary-card"><div class="label">Claims</div><div class="value">${report.summary.totalClaimsAnalyzed}</div></div>
  <div class="summary-card"><div class="label">High-Risk</div><div class="value">${report.summary.highRiskFindings}</div></div>
  ${thresholdCard}
</div>

<h2>Article Status</h2>
<table>
  <thead><tr><th>Article</th><th>Status</th><th>Requirement</th><th>Remediations</th></tr></thead>
  <tbody>${articleRows}</tbody>
</table>

${report.annexIIIChecklist.applicable && report.annexIIIChecklist.items.length > 0 ? `
<h2>Annex III Conformity Assessment</h2>
<div class="summary-grid">
  <div class="summary-card"><div class="label">Applicable</div><div class="value">Yes</div></div>
  <div class="summary-card"><div class="label">Pass Rate</div><div class="value">${Math.round(report.annexIIIChecklist.passRate * 100)}%</div></div>
</div>
<table>
  <thead><tr><th>#</th><th>Article</th><th>Requirement</th><th>Status</th><th>Evidence</th></tr></thead>
  <tbody>${report.annexIIIChecklist.items.map(item => {
    const color = item.status === 'pass' ? '#16a34a' : item.status === 'fail' ? '#dc2626' : item.status === 'partial' ? '#ca8a04' : '#6b7280';
    return `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.article)}</td><td>${escapeHtml(item.requirement)}</td><td><span class="badge" style="background:${color}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.evidence)}</td></tr>`;
  }).join('\n')}</tbody>
</table>` : ''}

<footer>Generated by Faultline Pro &mdash; ${escapeHtml(report.documentRef)}</footer>
</body>
</html>`;
}

// ── Badge SVG Renderer ──────────────────────────────────────────────────────

/**
 * Generate a shields.io-style SVG badge showing EU AI Act compliance status.
 */
export function renderComplianceBadgeSvg(
  score: number,
  pass: boolean,
  opts: { label?: string } = {},
): string {
  const label = opts.label ?? 'EU AI Act';
  const value = pass ? `${score}%20PASS` : `${score}%20FAIL`;
  const displayValue = pass ? `${score} PASS` : `${score} FAIL`;
  const color = pass
    ? (score >= 80 ? '#4c1' : '#a3c51c')
    : (score >= 50 ? '#dfb317' : '#e05d44');

  const labelWidth = Math.max(label.length * 6.5 + 10, 60);
  const valueWidth = Math.max(displayValue.length * 6.8 + 10, 60);
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${displayValue}">
  <title>${label}: ${displayValue}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text aria-hidden="true" x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${displayValue}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${displayValue}</text>
  </g>
</svg>`;
}

// ── PDF Renderer ──────────────────────────────────────────────────────────────

const EU_BLUE = '#003399';
const EU_GOLD = '#FFDD00';
const DARK = '#111827';
const GRAY = '#6b7280';
const RED = '#dc2626';
const GREEN = '#16a34a';
const AMBER = '#d97706';
const BLUE_MUTED = '#1d4ed8';

function statusColor(status: EvidenceStatus): string {
  switch (status) {
    case 'compliant': return GREEN;
    case 'non-compliant': return RED;
    case 'partial': return AMBER;
    case 'gap': return AMBER;
    case 'not-applicable': return GRAY;
    default: return GRAY;
  }
}

function statusLabel(status: EvidenceStatus): string {
  switch (status) {
    case 'compliant': return 'COMPLIANT';
    case 'non-compliant': return 'NON-COMPLIANT';
    case 'partial': return 'PARTIAL';
    case 'gap': return 'GAP';
    case 'not-applicable': return 'N/A';
    default: return 'UNKNOWN';
  }
}

function riskBadgeColor(risk: string): string {
  if (risk === 'critical' || risk === 'high') return RED;
  if (risk === 'medium') return AMBER;
  return GREEN;
}

export async function renderComplianceReportPdf(
  report: EuAiActComplianceReport,
): Promise<Buffer> {
  const PDFDocumentModule = await import('pdfkit');
  const PDFDocument = PDFDocumentModule.default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;

    function addPageHeader() {
      doc.rect(0, 0, pageWidth, 8).fill(EU_BLUE);
      doc.rect(0, 8, pageWidth, 4).fill(EU_GOLD);
    }

    function addPageFooter(pageLabel: string) {
      doc.rect(0, doc.page.height - 30, pageWidth, 30).fill('#f0f4ff');
      doc.font('Helvetica').fontSize(9).fillColor(GRAY)
        .text(
          `Faultline Pro — EU AI Act Compliance Evidence Report | ${pageLabel} | Reg. (EU) 2024/1689`,
          0,
          doc.page.height - 20,
          { align: 'center' },
        );
    }

    function sectionHeader(title: string) {
      if (doc.y > doc.page.height - 140) {
        doc.addPage();
        addPageHeader();
        doc.moveDown(1.5);
      }
      doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK).text(title, 50);
      doc.moveDown(0.2);
      doc.moveTo(50, doc.y).lineTo(pageWidth - 50, doc.y).strokeColor('#e5e7eb').stroke();
      doc.moveDown(0.5);
    }

    // ── COVER PAGE ──────────────────────────────────────────────────────────
    addPageHeader();
    doc.moveDown(3);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(EU_BLUE)
      .text('EUROPEAN UNION ARTIFICIAL INTELLIGENCE ACT — Reg. (EU) 2024/1689', { align: 'center' });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK)
      .text('Compliance Evidence Report', { align: 'center' });
    doc.font('Helvetica').fontSize(11).fillColor(GRAY)
      .text('Articles 5/9/10/11/12/13/14/50 · Annex III Conformity Assessment', { align: 'center' });

    doc.moveDown(1.5);

    // Risk badge
    const badgeColor = riskBadgeColor(report.overallRisk);
    const badgeLabel = `OVERALL RISK: ${report.overallRisk.toUpperCase()}`;
    const badgeX = (pageWidth - 220) / 2;
    doc.roundedRect(badgeX, doc.y, 220, 30, 4).fill(badgeColor);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
      .text(badgeLabel, badgeX, doc.y - 20, { width: 220, align: 'center' });

    doc.moveDown(2);

    // Metadata box
    const boxX = 80;
    const boxW = pageWidth - 160;
    const metaTop = doc.y;
    doc.roundedRect(boxX, metaTop, boxW, 140, 6).strokeColor('#e5e7eb').stroke();
    const innerTop = metaTop + 16;
    const labels = ['Document Ref', 'Project', 'Assessment Date', 'Provider', 'Claims Analysed', 'High-Risk Findings'];
    const values = [
      report.documentRef,
      report.projectName,
      report.generatedAt.split('T')[0],
      report.provider,
      String(report.summary.totalClaimsAnalyzed),
      String(report.summary.highRiskFindings),
    ];
    labels.forEach((label, i) => {
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(label, boxX + 20, innerTop + i * 20);
      const val = values[i];
      const valColor = i === 5 && report.summary.highRiskFindings > 0 ? RED : DARK;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(valColor)
        .text(val, boxX + 175, innerTop + i * 20);
    });

    doc.moveDown(9);
    addPageFooter(report.documentRef);

    // ── ARTICLE EVIDENCE ────────────────────────────────────────────────────
    doc.addPage();
    addPageHeader();
    doc.moveDown(1.5);

    sectionHeader('1. Article Evidence');

    for (const ev of report.articleEvidence) {
      if (doc.y > doc.page.height - 130) {
        doc.addPage();
        addPageHeader();
        doc.moveDown(1.5);
      }

      // Article badge + title
      const color = statusColor(ev.status);
      const label = statusLabel(ev.status);
      doc.roundedRect(50, doc.y, 90, 15, 3).fill(color);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
        .text(label, 52, doc.y - 11, { width: 86, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK)
        .text(ev.article, 150, doc.y - 12);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9).fillColor(GRAY)
        .text(ev.requirement, 50, doc.y, { width: pageWidth - 100 });
      doc.moveDown(0.3);

      for (const finding of ev.findings) {
        if (doc.y > doc.page.height - 80) {
          doc.addPage();
          addPageHeader();
          doc.moveDown(1);
        }
        doc.font('Helvetica').fontSize(9).fillColor(DARK)
          .text(`• ${finding}`, 60, doc.y, { width: pageWidth - 120 });
        doc.moveDown(0.2);
      }
      if (ev.remediations.length > 0) {
        if (doc.y > doc.page.height - 80) {
          doc.addPage();
          addPageHeader();
          doc.moveDown(1);
        }
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(AMBER)
          .text('Remediations:', 60, doc.y);
        doc.moveDown(0.15);
        for (const rem of ev.remediations) {
          if (doc.y > doc.page.height - 60) {
            doc.addPage();
            addPageHeader();
            doc.moveDown(1);
          }
          doc.font('Helvetica').fontSize(8.5).fillColor(DARK)
            .text(`→ ${rem}`, 70, doc.y, { width: pageWidth - 130 });
          doc.moveDown(0.15);
        }
        doc.moveDown(0.2);
      }
      if (ev.owaspRef) {
        doc.font('Helvetica').fontSize(8.5).fillColor(BLUE_MUTED)
          .text(`  Ref: ${ev.owaspRef}`, 60, doc.y, { width: pageWidth - 120 });
        doc.moveDown(0.2);
      }
      doc.moveDown(0.5);
    }

    addPageFooter(report.documentRef);

    // ── TEST CATEGORY MAPPINGS ───────────────────────────────────────────────
    if (report.testCategoryMappings.length > 0) {
      doc.addPage();
      addPageHeader();
      doc.moveDown(1.5);

      sectionHeader('2. Test Category → EU Article Mappings');

      // Table header
      const colX = { cat: 50, count: 220, article: 265, status: 460 };
      const headerY = doc.y;
      doc.rect(50, headerY, pageWidth - 100, 18).fill('#f0f4ff');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(EU_BLUE);
      doc.text('CLAIM CATEGORY', colX.cat + 2, headerY + 4);
      doc.text('COUNT', colX.count + 2, headerY + 4);
      doc.text('EU ARTICLE', colX.article + 2, headerY + 4);
      doc.text('STATUS', colX.status + 2, headerY + 4);

      let rowY = headerY + 22;
      for (const row of report.testCategoryMappings) {
        if (rowY > doc.page.height - 80) {
          doc.addPage();
          addPageHeader();
          rowY = 60;
        }
        doc.moveTo(50, rowY - 1).lineTo(pageWidth - 50, rowY - 1).strokeColor('#f3f4f6').stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(row.category, colX.cat + 2, rowY, { width: 165 });
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(String(row.claimCount), colX.count + 2, rowY);
        doc.font('Helvetica').fontSize(8.5).fillColor(EU_BLUE).text(row.euArticle, colX.article + 2, rowY, { width: 190 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(statusColor(row.status))
          .text(statusLabel(row.status), colX.status + 2, rowY);
        rowY += 20;
      }

      doc.moveDown(2);
      addPageFooter(report.documentRef);
    }

    // ── ANNEX III CONFORMITY ASSESSMENT ────────────────────────────────────
    if (report.annexIIIChecklist.applicable && report.annexIIIChecklist.items.length > 0) {
      doc.addPage();
      addPageHeader();
      doc.moveDown(1.5);

      sectionHeader('3. Annex III Conformity Assessment');

      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
        .text('High-risk AI systems require a conformity assessment under Annex III of the EU AI Act (Reg. 2024/1689).', 50, doc.y, { width: pageWidth - 100 });
      doc.moveDown(0.5);

      // Pass rate badge
      const passRate = Math.round(report.annexIIIChecklist.passRate * 100);
      const prColor = passRate >= 80 ? GREEN : passRate >= 50 ? AMBER : RED;
      doc.roundedRect(50, doc.y, 180, 20, 3).fill(prColor);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
        .text(`PASS RATE: ${passRate}%`, 52, doc.y - 14, { width: 176, align: 'center' });
      doc.moveDown(1);

      // Table header
      const annexColX = { id: 50, article: 120, req: 200, status: 430 };
      const annexHeaderY = doc.y;
      doc.rect(50, annexHeaderY, pageWidth - 100, 18).fill('#f0f4ff');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(EU_BLUE);
      doc.text('#', annexColX.id + 2, annexHeaderY + 4);
      doc.text('ARTICLE', annexColX.article + 2, annexHeaderY + 4);
      doc.text('REQUIREMENT', annexColX.req + 2, annexHeaderY + 4);
      doc.text('STATUS', annexColX.status + 2, annexHeaderY + 4);

      let annexRowY = annexHeaderY + 22;
      for (const item of report.annexIIIChecklist.items) {
        if (annexRowY > doc.page.height - 80) {
          doc.addPage();
          addPageHeader();
          annexRowY = 60;
        }
        doc.moveTo(50, annexRowY - 1).lineTo(pageWidth - 50, annexRowY - 1).strokeColor('#f3f4f6').stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(item.id, annexColX.id + 2, annexRowY, { width: 65 });
        doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(item.article, annexColX.article + 2, annexRowY, { width: 75 });
        doc.font('Helvetica').fontSize(8).fillColor(DARK).text(item.requirement, annexColX.req + 2, annexRowY, { width: 225 });
        const sColor = item.status === 'pass' ? GREEN : item.status === 'fail' ? RED : item.status === 'partial' ? AMBER : GRAY;
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(sColor)
          .text(item.status.toUpperCase(), annexColX.status + 2, annexRowY);
        annexRowY += 22;
      }

      doc.moveDown(2);
      addPageFooter(report.documentRef);
    }

    // ── APPENDIX ─────────────────────────────────────────────────────────────
    doc.addPage();
    addPageHeader();
    doc.moveDown(1.5);

    const appendixNum = report.annexIIIChecklist.applicable ? '4' : '3';
    sectionHeader(`${appendixNum}. Appendix — OWASP Agentic AI 2026 Cross-References`);

    const owaspRefs = [
      { id: 'A01', name: 'Prompt Injection', euArticle: 'Art. 9 – Risk Management', note: 'Adversarial prompts that cause unintended AI behaviour require risk controls.' },
      { id: 'A02', name: 'Insecure Output Handling', euArticle: 'Art. 13 – Transparency', note: 'AI outputs that are not verified or sanitised violate transparency obligations.' },
      { id: 'A03', name: 'Excessive Agency', euArticle: 'Art. 14 – Human Oversight', note: 'AI systems acting beyond intended scope require human oversight mechanisms.' },
      { id: 'A06', name: 'Sensitive Information Disclosure', euArticle: 'Art. 9 + GDPR', note: 'PII or sensitive data in AI outputs requires data governance controls.' },
      { id: 'A10', name: 'Model Theft / Supply Chain', euArticle: 'Art. 9 – Risk Management', note: 'Supply chain integrity must be addressed in the risk management system.' },
    ];

    for (const ref of owaspRefs) {
      doc.roundedRect(50, doc.y, 50, 15, 3).fill(BLUE_MUTED);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
        .text(ref.id, 52, doc.y - 11, { width: 46, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(ref.name, 110, doc.y - 12);
      doc.font('Helvetica').fontSize(8.5).fillColor(EU_BLUE)
        .text(`EU: ${ref.euArticle}`, 110, doc.y, { width: pageWidth - 160 });
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9).fillColor(GRAY)
        .text(ref.note, 110, doc.y, { width: pageWidth - 160 });
      doc.moveDown(0.8);
    }

    doc.moveDown(0.5);
    sectionHeader('Article 50 Voice / Audio Disclosure (Placeholder)');

    doc.font('Helvetica').fontSize(10).fillColor(AMBER)
      .text(report.article50Disclosure.voiceAudioDisclosure, 50, doc.y, { width: pageWidth - 100 });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
      .text(report.article50Disclosure.note, 50, doc.y, { width: pageWidth - 100 });

    addPageFooter(report.documentRef);

    doc.end();
  });
}
