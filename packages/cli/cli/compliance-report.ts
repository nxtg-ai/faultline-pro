import type { ScanResult } from './scan.js';
import type { Claim, VerificationResult } from '../types.js';
import type { Finding } from '../rules/base_rule.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EvidenceStatus = 'compliant' | 'non-compliant' | 'partial' | 'gap' | 'not-applicable';

export interface EuArticleEvidence {
  article: string;
  requirement: string;
  status: EvidenceStatus;
  findings: string[];
  owaspRef?: string;
}

export interface TestCategoryMapping {
  category: string;
  claimCount: number;
  euArticle: string;
  status: EvidenceStatus;
  owaspRef?: string;
}

export interface EuAiActComplianceReport {
  generatedAt: string;
  documentRef: string;
  projectName: string;
  provider: string;
  overallRisk: string;
  articleEvidence: EuArticleEvidence[];
  article50Disclosure: {
    status: 'placeholder';
    note: string;
    voiceAudioDisclosure: string;
  };
  testCategoryMappings: TestCategoryMapping[];
  complianceScore: number;
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

  return mappings;
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
    articleEvidence.push({
      article: 'Article 5 – Prohibited AI Practices',
      requirement:
        'AI systems engaging in prohibited practices (subliminal manipulation, social scoring, ' +
        'mass surveillance, emotion recognition in workplace) are forbidden under EU AI Act.',
      status: 'non-compliant',
      findings: [
        `${unacceptableCount} claim(s) flagged for prohibited AI practice patterns — ` +
        `immediate legal review required before deployment.`,
      ],
    });
  }

  articleEvidence.push({
    article: 'Article 9 – Risk Management System',
    requirement:
      'Establish and maintain a continuous risk management system throughout the AI system lifecycle, ' +
      'including identification, analysis, estimation, evaluation, and treatment of risks.',
    status: art9Status,
    findings:
      art9Findings.length > 0
        ? art9Findings
        : ['No risk management findings. All claims verified within acceptable thresholds.'],
    owaspRef: 'OWASP Agentic AI A01: Prompt Injection, A06: Sensitive Information Disclosure',
  });

  articleEvidence.push({
    article: 'Article 13 – Transparency and Provision of Information',
    requirement:
      'AI system must be sufficiently transparent to enable users to understand its capabilities, ' +
      'limitations, purpose, and the logic behind significant outputs.',
    status: art13Status,
    findings: art13Findings.length > 0 ? art13Findings : ['No transparency gaps detected.'],
    owaspRef: 'OWASP Agentic AI A02: Insecure Output Handling',
  });

  articleEvidence.push({
    article: 'Article 14 – Human Oversight',
    requirement:
      'AI system design must enable natural persons to effectively oversee and intervene during ' +
      'operation to prevent or minimise risks to health, safety, or fundamental rights.',
    status: art14Status,
    findings:
      art14Findings.length > 0
        ? art14Findings
        : ['No human oversight requirements triggered by this scan.'],
    owaspRef: 'OWASP Agentic AI A03: Excessive Agency',
  });

  // Article 50 — GPAI transparency (always included; opinion claims drive severity)
  const opinionClaims = claims.filter(c => c.type === 'opinion');
  const art50Findings: string[] = [
    'Article 50(4) voice/audio AI disclosure obligations: PLACEHOLDER — ' +
    'will be populated when voice testing ships.',
  ];
  if (opinionClaims.length > 0) {
    art50Findings.unshift(
      `${opinionClaims.length} opinion claim(s) detected — AI-generated opinion content ` +
      `requires transparency labelling per Art. 50 GPAI obligations.`,
    );
  }
  const art50Status: EvidenceStatus = opinionClaims.length > 0 ? 'partial' : 'not-applicable';

  articleEvidence.push({
    article: 'Article 50 – Transparency Obligations for GPAI Models',
    requirement:
      'AI-generated content must be disclosed to users. Synthetic, opinion-based, or GPAI-produced ' +
      'content requires explicit machine-generated labelling.',
    status: art50Status,
    findings: art50Findings,
  });

  // ── Test Category Mappings ─────────────────────────────────────────────────
  const testCategoryMappings = buildTestCategoryMappings(claims, verifications);

  // ── Article 50 Disclosure Object ──────────────────────────────────────────
  const article50Disclosure = {
    status: 'placeholder' as const,
    note:
      'Article 50 GPAI transparency obligations are partially tracked via claim-type analysis. ' +
      'Art. 50(4) voice/audio disclosure obligations will be populated when voice testing ships.',
    voiceAudioDisclosure:
      'PLACEHOLDER — Art. 50(4): AI-generated voice and audio content must be marked as ' +
      'machine-generated. Voice testing not yet implemented in this release.',
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

  // ── Compliance Score (0–100) ─────────────────────────────────────────────
  const scoreMap: Record<string, number> = {
    'compliant': 100,
    'not-applicable': 100,
    'partial': 50,
    'gap': 25,
    'non-compliant': 0,
  };
  const scoredArticles = articleEvidence.filter(a => a.status !== 'not-applicable');
  const complianceScore = scoredArticles.length > 0
    ? Math.round(scoredArticles.reduce((sum, a) => sum + (scoreMap[a.status] ?? 50), 0) / scoredArticles.length)
    : 100;

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
}

/**
 * Evaluate a compliance report against a CI gate.
 * Fails if any article is non-compliant OR overall risk is high/critical.
 */
export function evaluateComplianceGate(report: EuAiActComplianceReport): CiGateResult {
  const articles: CiGateArticleResult[] = report.articleEvidence.map(ev => ({
    article: ev.article,
    status: ev.status,
    pass: ev.status !== 'non-compliant',
  }));

  const nonCompliantCount = articles.filter(a => !a.pass).length;
  const riskFail = report.overallRisk === 'high' || report.overallRisk === 'critical';
  const pass = nonCompliantCount === 0 && !riskFail;

  return {
    pass,
    overallRisk: report.overallRisk,
    articles,
    nonCompliantCount,
    totalArticles: articles.length,
    exitCode: pass ? 0 : 1,
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
  lines.push(`Score:        ${report.complianceScore}/100`);
  lines.push(`Project:      ${report.projectName}`);
  lines.push(`Document:     ${report.documentRef}`);
  lines.push('');

  for (const a of gate.articles) {
    const icon = a.pass ? '[PASS]' : '[FAIL]';
    lines.push(`  ${icon} ${a.article} — ${a.status.toUpperCase()}`);
  }

  lines.push('');
  lines.push(`Articles: ${gate.totalArticles - gate.nonCompliantCount}/${gate.totalArticles} passing`);

  if (!gate.pass) {
    lines.push('');
    if (gate.nonCompliantCount > 0) {
      lines.push(`${gate.nonCompliantCount} non-compliant article(s) found.`);
    }
    if (report.overallRisk === 'high' || report.overallRisk === 'critical') {
      lines.push(`Overall risk is ${report.overallRisk.toUpperCase()} — gate fails on high/critical risk.`);
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
      .text('Article 9 (Risk Management) · Article 13 (Transparency) · Article 50 (GPAI)', { align: 'center' });

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

    // ── APPENDIX ─────────────────────────────────────────────────────────────
    doc.addPage();
    addPageHeader();
    doc.moveDown(1.5);

    sectionHeader('3. Appendix — OWASP Agentic AI 2026 Cross-References');

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
