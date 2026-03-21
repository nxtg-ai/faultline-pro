/**
 * Hardcoded demo scan result for `faultline scan --demo`.
 *
 * Showcases the full product experience — claims, mixed verdicts, EU AI Act
 * compliance findings, sources, confidence distribution, and trust score —
 * without requiring any API keys.
 */
import type { ScanResult } from './scan.js';
import type { ClaimRiskMapping } from '../compliance/eu_ai_act.js';

const DEMO_INPUT =
  'Our AI-powered hiring system has a 95% accuracy rate and has been adopted by ' +
  'over 10,000 companies worldwide. Independent audits found no evidence of gender ' +
  'or racial bias in its scoring algorithm. The system fully complies with the EU AI ' +
  'Act and has received certification from all major regulatory bodies. Users report ' +
  '40% faster time-to-hire compared to manual screening processes.';

export function getDemoResult(): ScanResult {
  return {
    input: DEMO_INPUT,
    provider: 'Demo Mode (no API key required)',
    claims: [
      {
        id: 'c1',
        text: 'The AI hiring system has a 95% accuracy rate.',
        type: 'fact',
        importance: 5,
      },
      {
        id: 'c2',
        text: 'The system has been adopted by over 10,000 companies worldwide.',
        type: 'fact',
        importance: 4,
      },
      {
        id: 'c3',
        text: 'Independent audits found no evidence of gender or racial bias in the scoring algorithm.',
        type: 'fact',
        importance: 5,
      },
      {
        id: 'c4',
        text: 'The system fully complies with the EU AI Act and has received certification from all major regulatory bodies.',
        type: 'fact',
        importance: 5,
      },
      {
        id: 'c5',
        text: 'Users report 40% faster time-to-hire compared to manual screening processes.',
        type: 'fact',
        importance: 3,
      },
    ],
    verifications: {
      c1: {
        claimId: 'c1',
        status: 'mixed',
        explanation:
          '"Accuracy" in hiring AI is rarely defined rigorously — figures vary widely depending ' +
          'on dataset, task framing, and evaluation methodology. No independent replication of ' +
          'the 95% figure was found.',
        sources: [
          {
            title: 'ACM FAccT 2023: Benchmarking Hiring AI Accuracy Claims',
            uri: 'https://dl.acm.org/doi/10.1145/3593013',
          },
          {
            title: 'MIT Technology Review: The AI Hiring Problem',
            uri: 'https://www.technologyreview.com/2021/07/21/1029461/ai-hiring-bias',
          },
        ],
      },
      c2: {
        claimId: 'c2',
        status: 'unverified',
        explanation:
          'Adoption figures for AI hiring tools are self-reported and not independently verified. ' +
          'The "10,000 companies" claim could not be corroborated via public records.',
        sources: [],
      },
      c3: {
        claimId: 'c3',
        status: 'contradicted',
        explanation:
          'Multiple peer-reviewed studies have documented proxy discrimination in AI hiring ' +
          'systems trained on historical hiring data. Algorithmic audits often miss indirect ' +
          'bias pathways. The categorical claim of "no evidence" is not defensible.',
        sources: [
          {
            title: 'Amazon AI Recruiting Tool Bias — Reuters',
            uri: 'https://www.reuters.com/article/us-amazon-com-jobs-automation-insight',
          },
          {
            title: 'Raghavan et al. (2020): Mitigating Bias in Algorithmic Hiring',
            uri: 'https://arxiv.org/abs/1906.09208',
          },
          {
            title: 'EEOC Guidance on AI in Employment Decision-Making (2023)',
            uri: 'https://www.eeoc.gov/laws/guidance/questions-and-answers-clarify-and-provide',
          },
        ],
      },
      c4: {
        claimId: 'c4',
        status: 'contradicted',
        explanation:
          'The EU AI Act designates AI systems used in employment and recruitment as high-risk ' +
          '(Annex III §4), requiring mandatory conformity assessments and human oversight. No ' +
          'recognised EU AI Act certification body had issued approvals as of the Act\'s entry ' +
          'into force in August 2024.',
        sources: [
          {
            title: 'EU AI Act — Annex III High-Risk AI Systems',
            uri: 'https://artificialintelligenceact.eu/annex/3/',
          },
          {
            title: 'EU AI Act Enforcement Timeline — European Commission',
            uri: 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
          },
        ],
      },
      c5: {
        claimId: 'c5',
        status: 'supported',
        explanation:
          'Efficiency gains in time-to-hire from automated screening are well-documented across ' +
          'multiple independent HR technology studies, with reported improvements of 30–50% ' +
          'compared to fully manual processes.',
        sources: [
          {
            title: 'LinkedIn Talent Trends 2023: AI in Recruiting',
            uri: 'https://business.linkedin.com/talent-solutions/resources/talent-trends',
          },
          {
            title: 'SHRM: Automating the Hiring Process — Efficiency Gains',
            uri: 'https://www.shrm.org/resourcesandtools/hr-topics/talent-acquisition',
          },
        ],
      },
    },
    overallRisk: 'high',
    complianceReport: {
      generatedAt: new Date().toISOString(),
      overallRiskLevel: 'high',
      euRiskSummary: {
        unacceptable: 0,
        high: 2,
        limited: 2,
        minimal: 1,
        totalClaims: 5,
        highestTier: 'high',
      },
      claimMappings: [
        {
          claimId: 'c1',
          claimText: 'The AI hiring system has a 95% accuracy rate.',
          verificationStatus: 'mixed',
          riskLevel: 'limited',
          category: { level: 'limited', title: 'Limited Risk', description: 'AI with transparency obligations.', articles: ['Article 50'], requiredActions: ['Disclose AI use'] },
          matchedPatterns: [],
          confidence: 'medium',
          confidenceScore: 0.63,
        } as ClaimRiskMapping,
        {
          claimId: 'c2',
          claimText: 'The system has been adopted by over 10,000 companies worldwide.',
          verificationStatus: 'unverified',
          riskLevel: 'limited',
          category: { level: 'limited', title: 'Limited Risk', description: 'AI with transparency obligations.', articles: ['Article 50'], requiredActions: ['Disclose AI use'] },
          matchedPatterns: [],
          confidence: 'low',
          confidenceScore: 0.4,
        } as ClaimRiskMapping,
        {
          claimId: 'c3',
          claimText: 'Independent audits found no evidence of gender or racial bias in the scoring algorithm.',
          verificationStatus: 'contradicted',
          riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: 'Employment AI — Annex III §4.', articles: ['Article 10', 'Annex III §4'], requiredActions: ['Conformity assessment', 'Human oversight'] },
          matchedPatterns: ['hiring', 'bias'],
          confidence: 'high',
          confidenceScore: 0.91,
        } as ClaimRiskMapping,
        {
          claimId: 'c4',
          claimText: 'The system fully complies with the EU AI Act and has received certification from all major regulatory bodies.',
          verificationStatus: 'contradicted',
          riskLevel: 'high',
          category: { level: 'high', title: 'High Risk', description: 'Employment AI — Annex III §4.', articles: ['Article 6', 'Article 43', 'Annex III §4'], requiredActions: ['Conformity assessment', 'Notified body certification'] },
          matchedPatterns: ['eu ai act', 'certification'],
          confidence: 'high',
          confidenceScore: 0.88,
        } as ClaimRiskMapping,
        {
          claimId: 'c5',
          claimText: 'Users report 40% faster time-to-hire compared to manual screening processes.',
          verificationStatus: 'supported',
          riskLevel: 'minimal',
          category: { level: 'minimal', title: 'Minimal Risk', description: 'General-purpose AI applications.', articles: [], requiredActions: [] },
          matchedPatterns: [],
          confidence: 'medium',
          confidenceScore: 0.72,
        } as ClaimRiskMapping,
      ],
      triggeredArticles: [
        {
          article: 'Annex III §4 — Employment and Recruitment AI',
          reason:
            'AI systems used to filter, rank, or score candidates in employment contexts are ' +
            'designated high-risk and subject to mandatory conformity assessment, human oversight, ' +
            'and transparency obligations.',
          claimIds: ['c1', 'c3', 'c4'],
        },
        {
          article: 'Article 10 — Data and Data Governance',
          reason:
            'High-risk AI systems must use training, validation, and testing data that is free ' +
            'from discriminatory patterns. Bias audit claims require documented data governance.',
          claimIds: ['c3'],
        },
        {
          article: 'Article 43 — Conformity Assessment',
          reason:
            'High-risk AI systems listed in Annex III must undergo a conformity assessment before ' +
            'market placement. No recognised notified body certifications were found.',
          claimIds: ['c4'],
        },
      ],
      mitigations: [
        'Commission an independent third-party bias audit using a diverse holdout dataset with documented demographic breakdowns.',
        'Initiate a formal EU AI Act conformity assessment with an accredited notified body before making compliance claims.',
        'Replace unqualified accuracy percentages with task-specific, methodology-documented performance metrics.',
        'Implement mandatory human review for all AI-generated hiring scores before adverse employment decisions.',
      ],
      confidenceDistribution: {
        high: 2,
        medium: 2,
        low: 1,
      },
    },
    ruleFindings: [],
  };
}
