import { randomUUID } from 'node:crypto';

export interface ComplianceRule {
  id: string;
  name: string;
  description: string;
  claimPatterns: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface ComplianceTemplate {
  id: string;
  name: string;
  industry: string;
  regulations: string[];
  rules: ComplianceRule[];
  riskThresholds: { critical: number; high: number; medium: number };
  custom: boolean;
  createdAt: string;
}

export interface ComplianceResult {
  templateId: string;
  templateName: string;
  industry: string;
  regulations: string[];
  overallRisk: string;
  triggeredRules: Array<{
    rule: ComplianceRule;
    matchedClaims: string[];
    recommendation: string;
  }>;
  summary: string;
  generatedAt: string;
}

// ── Built-in templates ────────────────────────────────────────────────────────

const BUILTIN_TEMPLATES: ComplianceTemplate[] = [
  {
    id: 'healthcare',
    name: 'Healthcare (HIPAA)',
    industry: 'Healthcare',
    regulations: ['HIPAA', '45 CFR 164', 'HITECH Act'],
    custom: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    riskThresholds: { critical: 1, high: 2, medium: 3 },
    rules: [
      {
        id: 'hc-phi-disclosure',
        name: 'PHI Disclosure Risk',
        description: 'Claims that may disclose protected health information without authorisation.',
        claimPatterns: ['patient', 'PHI', 'health record', 'medical record'],
        severity: 'critical',
      },
      {
        id: 'hc-diagnosis',
        name: 'Unauthorised Medical Diagnosis',
        description: 'Claims making diagnostic assertions that require licensed medical professional review.',
        claimPatterns: ['diagnosis', 'diagnosed', 'prescription', 'prescribed'],
        severity: 'high',
      },
      {
        id: 'hc-treatment',
        name: 'Treatment Recommendation',
        description: 'Claims recommending specific medical treatments or procedures.',
        claimPatterns: ['treatment', 'medical', 'therapy', 'clinical'],
        severity: 'high',
      },
    ],
  },
  {
    id: 'finance',
    name: 'Finance (SOX/FINRA)',
    industry: 'Finance',
    regulations: ['SOX', 'FINRA Rule 2210', '15 USC 78j', 'Regulation FD'],
    custom: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    riskThresholds: { critical: 1, high: 2, medium: 4 },
    rules: [
      {
        id: 'fin-investment-advice',
        name: 'Unregistered Investment Advice',
        description: 'Claims providing specific investment advice without proper disclaimers or registration.',
        claimPatterns: ['investment', 'returns', 'stock', 'buy', 'sell'],
        severity: 'critical',
      },
      {
        id: 'fin-earnings',
        name: 'Unsubstantiated Earnings Claims',
        description: 'Claims about earnings, revenue, or profit without adequate evidential support.',
        claimPatterns: ['earnings', 'revenue', 'profit', 'financial forecast'],
        severity: 'high',
      },
      {
        id: 'fin-projection',
        name: 'Forward-Looking Financial Projection',
        description: 'Claims making financial projections without safe-harbour disclosures.',
        claimPatterns: ['projected', 'forecast', 'expected growth', 'future value'],
        severity: 'medium',
      },
    ],
  },
  {
    id: 'education',
    name: 'Education (FERPA)',
    industry: 'Education',
    regulations: ['FERPA', '20 USC 1232g', '34 CFR Part 99'],
    custom: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    riskThresholds: { critical: 1, high: 2, medium: 4 },
    rules: [
      {
        id: 'edu-student-records',
        name: 'Student Record Exposure',
        description: 'Claims that may reference or expose personally identifiable student information.',
        claimPatterns: ['student', 'enrollment', 'transcript'],
        severity: 'critical',
      },
      {
        id: 'edu-academic-performance',
        name: 'Academic Performance Claims',
        description: 'Claims disclosing or inferring individual student academic performance without consent.',
        claimPatterns: ['grades', 'GPA', 'academic performance', 'test scores'],
        severity: 'high',
      },
      {
        id: 'edu-institution',
        name: 'Institutional Academic Claims',
        description: 'Claims about academic standing or institutional metrics that may mislead.',
        claimPatterns: ['academic', 'graduation rate', 'degree', 'accreditation'],
        severity: 'medium',
      },
    ],
  },
  {
    id: 'government',
    name: 'Government (FOIA/Data Privacy)',
    industry: 'Government',
    regulations: ['FOIA', '5 USC 552', 'Privacy Act', 'E-Government Act'],
    custom: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    riskThresholds: { critical: 1, high: 3, medium: 5 },
    rules: [
      {
        id: 'gov-classified',
        name: 'Classified Information Risk',
        description: 'Claims that may reference or disclose information that could be classified or sensitive.',
        claimPatterns: ['classified', 'top secret', 'confidential government'],
        severity: 'critical',
      },
      {
        id: 'gov-official-data',
        name: 'Unverified Official Statistics',
        description: 'Claims citing official government data or statistics without proper attribution.',
        claimPatterns: ['government data', 'official statistics', 'federal data'],
        severity: 'high',
      },
      {
        id: 'gov-policy',
        name: 'Policy and Regulatory Misrepresentation',
        description: 'Claims about government policy, regulation, or law that may be inaccurate.',
        claimPatterns: ['policy', 'regulation', 'federal', 'legislation', 'mandate'],
        severity: 'medium',
      },
    ],
  },
];

// ── Risk calculation helpers ──────────────────────────────────────────────────

function computeOverallRisk(
  triggeredRules: Array<{ rule: ComplianceRule }>,
  thresholds: { critical: number; high: number; medium: number },
): string {
  const criticalCount = triggeredRules.filter(t => t.rule.severity === 'critical').length;
  const highCount = triggeredRules.filter(t => t.rule.severity === 'high').length;
  const mediumCount = triggeredRules.filter(t => t.rule.severity === 'medium').length;

  if (criticalCount >= thresholds.critical) return 'critical';
  if (highCount >= thresholds.high) return 'high';
  if (mediumCount >= thresholds.medium) return 'medium';
  if (triggeredRules.length > 0) return 'low';
  return 'low';
}

function recommendationFor(rule: ComplianceRule): string {
  switch (rule.severity) {
    case 'critical':
      return `Immediate review required. Claims matching "${rule.name}" pose critical compliance risk under ${rule.description}`;
    case 'high':
      return `Legal review recommended for claims matching "${rule.name}". Ensure proper disclaimers and authorisation are in place.`;
    case 'medium':
      return `Flag for compliance review: "${rule.name}". Consider adding appropriate disclosures.`;
    default:
      return `Monitor claims related to "${rule.name}" for ongoing compliance.`;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

class ComplianceTemplateStore {
  private custom = new Map<string, ComplianceTemplate>();

  list(): ComplianceTemplate[] {
    return [...BUILTIN_TEMPLATES, ...Array.from(this.custom.values())];
  }

  get(id: string): ComplianceTemplate | undefined {
    const builtin = BUILTIN_TEMPLATES.find(t => t.id === id);
    if (builtin) return builtin;
    return this.custom.get(id);
  }

  addCustom(
    template: Omit<ComplianceTemplate, 'id' | 'createdAt' | 'custom'>,
  ): ComplianceTemplate {
    const created: ComplianceTemplate = {
      ...template,
      id: randomUUID(),
      custom: true,
      createdAt: new Date().toISOString(),
    };
    this.custom.set(created.id, created);
    return created;
  }

  deleteCustom(id: string): boolean {
    return this.custom.delete(id);
  }

  applyTemplate(
    template: ComplianceTemplate,
    claims: Array<{ text: string }>,
    verifications: Record<string, { status?: string }>,
  ): ComplianceResult {
    const triggeredRules: ComplianceResult['triggeredRules'] = [];

    for (const rule of template.rules) {
      const matched: string[] = [];
      for (const claim of claims) {
        const lower = claim.text.toLowerCase();
        if (rule.claimPatterns.some(p => lower.includes(p.toLowerCase()))) {
          matched.push(claim.text);
        }
      }
      if (matched.length > 0) {
        triggeredRules.push({
          rule,
          matchedClaims: matched,
          recommendation: recommendationFor(rule),
        });
      }
    }

    const overallRisk = computeOverallRisk(triggeredRules, template.riskThresholds);

    // Count verification statuses for summary
    const statuses = Object.values(verifications).map(v => v.status ?? 'unverified');
    const contradicted = statuses.filter(s => s === 'contradicted').length;
    const supported = statuses.filter(s => s === 'supported').length;

    const summary =
      triggeredRules.length === 0
        ? `No compliance rules triggered for ${template.name}. ${supported} claim(s) verified.`
        : `${triggeredRules.length} compliance rule(s) triggered under ${template.name} (${template.regulations.join(', ')}). ` +
          `Overall risk: ${overallRisk}. ${contradicted} contradicted claim(s) detected.`;

    return {
      templateId: template.id,
      templateName: template.name,
      industry: template.industry,
      regulations: template.regulations,
      overallRisk,
      triggeredRules,
      summary,
      generatedAt: new Date().toISOString(),
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let instance: ComplianceTemplateStore | null = null;

export function getComplianceTemplateStore(): ComplianceTemplateStore {
  if (!instance) instance = new ComplianceTemplateStore();
  return instance;
}

export function resetComplianceTemplateStore(): void {
  instance = new ComplianceTemplateStore();
}
