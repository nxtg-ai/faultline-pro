// Validates: N-157 (EU AI Act Compliance Report Generator — Art. 9/13/50 evidence, PDF + JSON)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock @google/genai so provider imports don't blow up
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

vi.stubGlobal('fetch', vi.fn());

import { main } from '../cli/index.js';
import {
  buildEuComplianceReport,
  renderComplianceReportJson,
  renderComplianceReportPdf,
  evaluateComplianceGate,
  renderCiGateOutput,
  diffComplianceReports,
  renderComplianceDiffOutput,
  getRemediations,
  renderComplianceBadgeSvg,
  renderComplianceReportMarkdown,
  renderComplianceReportSarif,
  renderComplianceReportHtml,
  loadComplianceConfig,
  type EuAiActComplianceReport,
  type CiGateResult,
  type ComplianceDiffResult,
  type GateOptions,
  type ComplianceConfig,
} from '../cli/compliance-report.js';
import type { ScanResult } from '../cli/scan.js';
import type { ComplianceReport } from '../compliance/report_generator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeComplianceReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    generatedAt: new Date().toISOString(),
    overallRiskLevel: 'low',
    euRiskSummary: {
      unacceptable: 0, high: 0, limited: 0, minimal: 2, totalClaims: 2, highestTier: 'minimal',
    },
    claimMappings: [],
    triggeredArticles: [],
    mitigations: [],
    confidenceDistribution: { high: 1, medium: 1, low: 0 },
    ...overrides,
  };
}

/** Build a type-safe ClaimRiskMapping with required fields defaulted. */
function makeClaimMapping(overrides: Partial<import('../compliance/eu_ai_act.js').ClaimRiskMapping> & Pick<import('../compliance/eu_ai_act.js').ClaimRiskMapping, 'claimId' | 'riskLevel' | 'matchedPatterns'>): import('../compliance/eu_ai_act.js').ClaimRiskMapping {
  return {
    claimText: 'Test claim.',
    verificationStatus: 'supported',
    category: { level: overrides.riskLevel ?? 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
    confidence: 'high',
    confidenceScore: 0.9,
    ...overrides,
  } as import('../compliance/eu_ai_act.js').ClaimRiskMapping;
}

function makeScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    input: 'Water boils at 100 degrees Celsius.',
    provider: 'Mock Provider',
    claims: [
      { id: 'c1', text: 'Water boils at 100 degrees Celsius.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'The sky is blue.', type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
      c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: makeComplianceReport(),
    ruleFindings: [],
    ...overrides,
  };
}

// ── Unit tests: buildEuComplianceReport ───────────────────────────────────────

describe('buildEuComplianceReport()', () => {
  it('returns a report with articleEvidence array', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.articleEvidence).toBeDefined();
    expect(Array.isArray(report.articleEvidence)).toBe(true);
    expect(report.articleEvidence.length).toBeGreaterThan(0);
  });

  it('always includes Article 9, 10, 11, 12, 13, 14, and 50', () => {
    const report = buildEuComplianceReport(makeScan());
    const articles = report.articleEvidence.map(e => e.article);
    expect(articles.some(a => a.includes('Article 9'))).toBe(true);
    expect(articles.some(a => a.includes('Article 10'))).toBe(true);
    expect(articles.some(a => a.includes('Article 11'))).toBe(true);
    expect(articles.some(a => a.includes('Article 12'))).toBe(true);
    expect(articles.some(a => a.includes('Article 13'))).toBe(true);
    expect(articles.some(a => a.includes('Article 14'))).toBe(true);
    expect(articles.some(a => a.includes('Article 50'))).toBe(true);
  });

  it('Article 50 disclosure section is always present with not-applicable status', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.article50Disclosure).toBeDefined();
    expect(report.article50Disclosure.status).toBe('not-applicable');
    expect(report.article50Disclosure.voiceAudioDisclosure.toLowerCase()).toContain('not applicable');
  });

  it('Article 9 is non-compliant when many contradicted claims exist', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Claim one.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Claim two.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Claim three.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.status).toBe('non-compliant');
  });

  it('Article 9 findings include contradicted claim count', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'False claim.', type: 'fact', importance: 4 }],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Disproved.', sources: [] },
      },
      overallRisk: 'high',
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('contradicted'))).toBe(true);
  });

  it('Article 10 is compliant when no bias, PII, or contradicted claims exist', () => {
    const report = buildEuComplianceReport(makeScan());
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10).toBeDefined();
    expect(art10?.status).toBe('compliant');
    expect(art10?.requirement).toContain('Training');
  });

  it('Article 10 is non-compliant when bias findings exist', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Gender bias detected.', match: 'bias', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('non-compliant');
    expect(art10?.findings.some(f => f.includes('bias'))).toBe(true);
  });

  it('Article 10 flags contradicted claims as data quality issue', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'False claim.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'high',
    });
    const report = buildEuComplianceReport(scan);
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('partial');
    expect(art10?.findings.some(f => f.includes('contradicted'))).toBe(true);
    expect(art10?.findings.some(f => f.includes('data quality'))).toBe(true);
  });

  it('Article 10 flags high-importance unverified claims as data completeness issue', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Important claim.', type: 'fact', importance: 5 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'No source.', sources: [] },
      },
      overallRisk: 'medium',
    });
    const report = buildEuComplianceReport(scan);
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('partial');
    expect(art10?.findings.some(f => f.includes('high-importance'))).toBe(true);
  });

  it('Article 10 includes PII findings for special category data', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'pii-detection', severity: 'high', message: 'Email found.', match: 'user@test.com', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art10 = report.articleEvidence.find(e => e.article.includes('Article 10'));
    expect(art10?.status).toBe('partial');
    expect(art10?.findings.some(f => f.includes('PII'))).toBe(true);
  });

  // ── N-193: Article 11 & 12 evidence mapping ────────────────────────────
  it('Article 11 is compliant when claims have explanations and sources', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11).toBeDefined();
    expect(art11?.status).toBe('compliant');
    expect(art11?.findings.some(f => f.includes('explanations'))).toBe(true);
    expect(art11?.findings.some(f => f.includes('sources'))).toBe(true);
  });

  it('Article 11 is partial when claims have explanations but no sources', () => {
    const report = buildEuComplianceReport(makeScan());
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('partial');
  });

  it('Article 11 is gap when claims have no explanations or sources', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.articleEvidence.find(e => e.article.includes('Article 11'));
    expect(art11?.status).toBe('gap');
  });

  it('Article 12 is compliant when provider and claims are present', () => {
    const report = buildEuComplianceReport(makeScan());
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    expect(art12).toBeDefined();
    expect(art12?.status).toBe('compliant');
    expect(art12?.findings.some(f => f.includes('Provider recorded'))).toBe(true);
    expect(art12?.findings.some(f => f.includes('claim(s) extracted'))).toBe(true);
  });

  it('Article 12 includes rule findings when present', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'bias-detection', severity: 'high', message: 'Bias found.', match: 'bias', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art12 = report.articleEvidence.find(e => e.article.includes('Article 12'));
    expect(art12?.status).toBe('compliant');
    expect(art12?.findings.some(f => f.includes('rule finding'))).toBe(true);
  });

  it('Article 11 and 12 appear in article evidence array', () => {
    const report = buildEuComplianceReport(makeScan());
    const articles = report.articleEvidence.map(e => e.article);
    expect(articles.some(a => a.includes('Article 11'))).toBe(true);
    expect(articles.some(a => a.includes('Article 12'))).toBe(true);
  });

  it('Article 13 is compliant when all fact claims are supported', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('compliant');
  });

  it('Article 13 is gap when all claims are unverified', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Some claim.', type: 'fact', importance: 3 }],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'No sources.', sources: [] },
      },
      overallRisk: 'medium',
    });
    const report = buildEuComplianceReport(scan);
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.status).toBe('gap');
  });

  it('opinion claims map to Article 50 with partial status', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'AI should run the economy.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'Opinion.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art50 = report.articleEvidence.find(e => e.article.includes('Article 50'));
    expect(art50?.status).toBe('partial');
    expect(art50?.findings.some(f => f.includes('opinion'))).toBe(true);
  });

  it('interpretation claims map to Article 14 (partial status)', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'This suggests bias.', type: 'interpretation', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'mixed', explanation: 'Conflicting.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art14 = report.articleEvidence.find(e => e.article.includes('Article 14'));
    expect(art14?.status).toBe('partial');
  });

  it('Article 5 is included only when unacceptable tier is triggered', () => {
    const scanClean = makeScan();
    const reportClean = buildEuComplianceReport(scanClean);
    expect(reportClean.articleEvidence.some(e => e.article.includes('Article 5 –'))).toBe(false);

    const scanDirty = makeScan({
      complianceReport: makeComplianceReport({
        euRiskSummary: {
          unacceptable: 1, high: 0, limited: 0, minimal: 0, totalClaims: 1, highestTier: 'unacceptable',
        },
      }),
    });
    const reportDirty = buildEuComplianceReport(scanDirty);
    expect(reportDirty.articleEvidence.some(e => e.article.includes('Article 5 –'))).toBe(true);
    const art5 = reportDirty.articleEvidence.find(e => e.article.includes('Article 5 –'));
    expect(art5?.status).toBe('non-compliant');
  });

  it('PII findings appear in Article 9 with OWASP A06 reference', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'PII found', match: 'user@example.com', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('PII') && f.includes('A06'))).toBe(true);
  });

  // ── Article 6 — Classification Rules for High-Risk AI Systems ───────────────

  it('Article 6 is always in articleEvidence', () => {
    const report = buildEuComplianceReport(makeScan());
    const art6 = report.articleEvidence.find(a => a.article.includes('Article 6'));
    expect(art6).toBeDefined();
    expect(art6?.article).toBe('Article 6 – Classification Rules for High-Risk AI Systems');
  });

  it('Article 6 is not-applicable when no high-risk domain claims present', () => {
    const report = buildEuComplianceReport(makeScan());
    const art6 = report.articleEvidence.find(a => a.article.includes('Article 6'));
    expect(art6?.status).toBe('not-applicable');
  });

  it('Article 6 is partial when claims touch Annex III high-risk domains', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'The system uses biometric facial recognition to identify individuals.', type: 'fact', importance: 5 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
      },
      complianceReport: makeComplianceReport({
        claimMappings: [
          {
            claimId: 'c1',
            claimText: 'The system uses biometric facial recognition to identify individuals.',
            verificationStatus: 'supported',
            riskLevel: 'high',
            category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
            matchedPatterns: ['Annex III §1'],
            confidence: 'high',
            confidenceScore: 0.9,
          },
        ],
        euRiskSummary: { unacceptable: 0, high: 1, limited: 0, minimal: 0, totalClaims: 1, highestTier: 'high' },
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(a => a.article.includes('Article 6'));
    expect(art6?.status).toBe('partial');
    expect(art6?.findings.some(f => f.includes('Annex III'))).toBe(true);
  });

  it('Article 6 remediations include conformity assessment guidance when high-risk', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'The system uses biometric identification.', type: 'fact', importance: 5 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
      },
      complianceReport: makeComplianceReport({
        claimMappings: [
          {
            claimId: 'c1',
            claimText: 'The system uses biometric identification.',
            verificationStatus: 'supported',
            riskLevel: 'high',
            category: { level: 'high', title: 'High Risk', description: '', articles: [], requiredActions: [] },
            matchedPatterns: ['Annex III §1'],
            confidence: 'high',
            confidenceScore: 0.9,
          },
        ],
        euRiskSummary: { unacceptable: 0, high: 1, limited: 0, minimal: 0, totalClaims: 1, highestTier: 'high' },
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.articleEvidence.find(a => a.article.includes('Article 6'));
    expect(art6?.remediations.length).toBeGreaterThan(0);
    expect(art6?.remediations.some(r => r.includes('conformity assessment'))).toBe(true);
  });

  // ── Article 15 — Accuracy, Robustness, and Cybersecurity ───────────────────

  it('Article 15 is always in articleEvidence', () => {
    const report = buildEuComplianceReport(makeScan());
    const art15 = report.articleEvidence.find(a => a.article.includes('Article 15'));
    expect(art15).toBeDefined();
    expect(art15?.article).toBe('Article 15 – Accuracy, Robustness, and Cybersecurity');
  });

  it('Article 15 is compliant when no accuracy/robustness/cybersecurity issues', () => {
    const report = buildEuComplianceReport(makeScan());
    const art15 = report.articleEvidence.find(a => a.article.includes('Article 15'));
    expect(art15?.status).toBe('compliant');
  });

  it('Article 15 is non-compliant when contradiction rate exceeds 30%', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Claim 1.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Claim 2.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Claim 3.', type: 'fact', importance: 4 },
        { id: 'c4', text: 'Claim 4.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c3: { claimId: 'c3', status: 'supported', explanation: 'OK.', sources: [] },
        c4: { claimId: 'c4', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art15 = report.articleEvidence.find(a => a.article.includes('Article 15'));
    expect(art15?.status).toBe('non-compliant');
    expect(art15?.findings.some(f => f.includes('contradicted'))).toBe(true);
  });

  it('Article 15 is partial when some claims contradicted but below 30% threshold', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Claim 1.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Claim 2.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Claim 3.', type: 'fact', importance: 4 },
        { id: 'c4', text: 'Claim 4.', type: 'fact', importance: 3 },
        { id: 'c5', text: 'Claim 5.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
        c3: { claimId: 'c3', status: 'supported', explanation: 'OK.', sources: [] },
        c4: { claimId: 'c4', status: 'supported', explanation: 'OK.', sources: [] },
        c5: { claimId: 'c5', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art15 = report.articleEvidence.find(a => a.article.includes('Article 15'));
    expect(art15?.status).toBe('partial');
  });

  it('Article 15 is non-compliant when injection findings present', () => {
    const scan = makeScan({
      ruleFindings: [
        { ruleId: 'injection-detection', severity: 'critical', message: 'Prompt injection pattern detected', match: '$(cmd)', offset: 0 },
      ],
    });
    const report = buildEuComplianceReport(scan);
    const art15 = report.articleEvidence.find(a => a.article.includes('Article 15'));
    expect(art15?.status).toBe('non-compliant');
    expect(art15?.findings.some(f => f.includes('injection'))).toBe(true);
  });

  it('Article 15 remediations include accuracy guidance for contradicted claims', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'C1.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'C2.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'C3.', type: 'fact', importance: 4 },
        { id: 'c4', text: 'C4.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'X.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'X.', sources: [] },
        c3: { claimId: 'c3', status: 'supported', explanation: 'OK.', sources: [] },
        c4: { claimId: 'c4', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art15 = report.articleEvidence.find(a => a.article.includes('Article 15'));
    expect(art15?.remediations.length).toBeGreaterThan(0);
    expect(art15?.remediations.some(r => r.includes('accuracy') || r.includes('contradicted'))).toBe(true);
  });

  it('Article 15 is included in articleEvidence before Article 50', () => {
    const report = buildEuComplianceReport(makeScan());
    const art15Idx = report.articleEvidence.findIndex(a => a.article.includes('Article 15'));
    const art50Idx = report.articleEvidence.findIndex(a => a.article.includes('Article 50'));
    expect(art15Idx).toBeGreaterThanOrEqual(0);
    expect(art50Idx).toBeGreaterThanOrEqual(0);
    expect(art15Idx).toBeLessThan(art50Idx);
  });

  it('testCategoryMappings reflects claim types correctly', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'A fact.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'An opinion.', type: 'opinion', importance: 3 },
        { id: 'c3', text: 'An interpretation.', type: 'interpretation', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Opinion.', sources: [] },
        c3: { claimId: 'c3', status: 'mixed', explanation: 'Partial.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const categories = report.testCategoryMappings.map(m => m.category);
    expect(categories).toContain('fact (supported)');
    expect(categories).toContain('opinion');
    expect(categories).toContain('interpretation');
  });

  // ── TC1–TC8: Articles 10/11/12 test-category mappings ─────────────────────
  it('TC1: Art. 10 mapping appears for bias rule findings', () => {
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'bias-detection', severity: 'high', message: 'Bias detected', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const articles = report.testCategoryMappings.map(m => m.euArticle);
    expect(articles.some(a => a.includes('Article 10'))).toBe(true);
    const art10 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 10') && m.category === 'bias finding(s)');
    expect(art10).toBeDefined();
    expect(art10!.status).toBe('non-compliant');
    expect(art10!.owaspRef).toContain('A05');
  });

  it('TC2: Art. 10 mapping appears for high-importance unverified claims', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Critical claim.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Normal claim.', type: 'fact', importance: 2 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art10 = report.testCategoryMappings.find(
      m => m.euArticle.includes('Article 10') && m.category.includes('high-importance'),
    );
    expect(art10).toBeDefined();
    expect(art10!.claimCount).toBe(1);
    expect(art10!.status).toBe('partial');
  });

  it('TC3: Art. 10 mapping absent when no bias findings and no high-importance unverified', () => {
    const report = buildEuComplianceReport(makeScan());
    const art10Mappings = report.testCategoryMappings.filter(m => m.euArticle.includes('Article 10'));
    expect(art10Mappings).toHaveLength(0);
  });

  it('TC4: Art. 11 mapping appears when claims have explanation or sources', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed by source.', sources: [{ title: 'Src', uri: 'http://example.com' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 11'));
    expect(art11).toBeDefined();
    expect(art11!.status).toBe('compliant');
    expect(art11!.claimCount).toBeGreaterThan(0);
  });

  it('TC5: Art. 11 mapping absent when no claims have documentation', () => {
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: '', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art11 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 11'));
    expect(art11).toBeUndefined();
  });

  it('TC6: Art. 12 mapping appears when claims are present', () => {
    const report = buildEuComplianceReport(makeScan());
    const art12 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 12'));
    expect(art12).toBeDefined();
    expect(art12!.category).toBe('claim(s) with structured metadata');
    expect(art12!.claimCount).toBe(2);
    expect(art12!.status).toBe('compliant');
  });

  it('TC7: Art. 12 mapping absent when no claims', () => {
    const scan = makeScan({ claims: [], verifications: {} });
    const report = buildEuComplianceReport(scan);
    const art12 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 12'));
    expect(art12).toBeUndefined();
  });

  it('TC8: Art. 10/11/12 all appear in testCategoryMappings for a rich scan', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Critical claim.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Normal claim.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'No evidence.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [{ title: 'Src', uri: 'http://src.com' }] },
      },
      ruleFindings: [{ ruleId: 'bias-detection', severity: 'high', message: 'Bias', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const articles = report.testCategoryMappings.map(m => m.euArticle);
    expect(articles.some(a => a.includes('Article 10'))).toBe(true);
    expect(articles.some(a => a.includes('Article 11'))).toBe(true);
    expect(articles.some(a => a.includes('Article 12'))).toBe(true);
  });

  // ── TCA1–TCA2: Art. 6 testCategoryMappings ───────────────────────────────
  it('TCA1: Art. 6 entry appears in testCategoryMappings when claimMappings has high-risk domain claim', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [
          makeClaimMapping({ claimId: 'c1', riskLevel: 'high', matchedPatterns: ['Annex III §4 – employment screening'] }),
        ],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art6 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 6'));
    expect(art6).toBeDefined();
    expect(art6!.category).toBe('high-risk domain claim(s)');
    expect(art6!.claimCount).toBe(1);
    expect(art6!.status).toBe('partial');
  });

  it('TCA2: Art. 6 entry absent from testCategoryMappings when no high-risk claimMappings', () => {
    const report = buildEuComplianceReport(makeScan());
    const art6 = report.testCategoryMappings.find(m => m.euArticle.includes('Article 6'));
    expect(art6).toBeUndefined();
  });

  // ── A52-1–A52-6: Article 52 articleEvidence ───────────────────────────────
  it('A52-1: Article 52 is always present in articleEvidence', () => {
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(a => a.article.includes('Article 52'));
    expect(art52).toBeDefined();
    expect(art52!.article).toBe('Article 52 – Transparency Obligations for Specific AI System Types');
  });

  it('A52-2: Article 52 is not-applicable for clean scan with no AI system type signals', () => {
    const report = buildEuComplianceReport(makeScan());
    const art52 = report.articleEvidence.find(a => a.article.includes('Article 52'));
    expect(art52!.status).toBe('not-applicable');
  });

  it('A52-3: Article 52 is partial when opinion claims present (chatbot §1)', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'I think AI will transform healthcare.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'unverified', explanation: 'Opinion.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(a => a.article.includes('Article 52'));
    expect(art52!.status).toBe('partial');
    expect(art52!.findings.some(f => f.includes('opinion'))).toBe(true);
  });

  it('A52-4: Article 52 is partial when emotion ruleFindings present (§2)', () => {
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'emotion-detection', severity: 'high', message: 'Emotion detected', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(a => a.article.includes('Article 52'));
    expect(art52!.status).toBe('partial');
    expect(art52!.findings.some(f => f.includes('emotion'))).toBe(true);
  });

  it('A52-5: Article 52 is partial when biometric claimMappings present (§2)', () => {
    const scan = makeScan({
      complianceReport: makeComplianceReport({
        claimMappings: [
          makeClaimMapping({ claimId: 'c1', riskLevel: 'high', matchedPatterns: ['Annex III §1 – biometric identification'] }),
        ],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(a => a.article.includes('Article 52'));
    expect(art52!.status).toBe('partial');
    expect(art52!.findings.some(f => f.includes('biometric'))).toBe(true);
  });

  it('A52-6: Article 52 is partial when synthetic ruleFindings present (§3)', () => {
    const scan = makeScan({
      ruleFindings: [{ ruleId: 'synthetic-media-detection', severity: 'high', message: 'Synthetic content', match: '', offset: 0 }],
    });
    const report = buildEuComplianceReport(scan);
    const art52 = report.articleEvidence.find(a => a.article.includes('Article 52'));
    expect(art52!.status).toBe('partial');
    expect(art52!.findings.some(f => f.includes('synthetic'))).toBe(true);
  });

  it('summary counts are correct', () => {
    const report = buildEuComplianceReport(makeScan());
    const total =
      report.summary.compliantArticles +
      report.summary.nonCompliantArticles +
      report.summary.partialArticles +
      report.summary.gapArticles;
    // not-applicable articles are not in any count — total should be <= articleEvidence.length
    expect(total).toBeLessThanOrEqual(report.articleEvidence.length);
    expect(report.summary.totalClaimsAnalyzed).toBe(2);
  });

  it('documentRef has FP-EUACT- prefix', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.documentRef).toMatch(/^FP-EUACT-\d+$/);
  });

  it('uses provided projectName', () => {
    const report = buildEuComplianceReport(makeScan(), { projectName: 'MySystem v2' });
    expect(report.projectName).toBe('MySystem v2');
  });

  it('complianceScore is 0-100 number', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(typeof report.complianceScore).toBe('number');
    expect(report.complianceScore).toBeGreaterThanOrEqual(0);
    expect(report.complianceScore).toBeLessThanOrEqual(100);
  });

  it('complianceScore is high for compliant low-risk scan', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.complianceScore).toBeGreaterThanOrEqual(50);
  });

  it('complianceScore is low for non-compliant critical scan', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    expect(report.complianceScore).toBeLessThan(80);
  });

  it('complianceScore appears in JSON output', () => {
    const report = buildEuComplianceReport(makeScan());
    const json = renderComplianceReportJson(report);
    const parsed = JSON.parse(json);
    expect(typeof parsed.complianceScore).toBe('number');
  });

  it('complianceScore appears in CI gate output', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('/100');
  });

  it('defaults projectName when not provided', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.projectName).toBeTruthy();
  });

  // ── N-187: Evidence strength scoring ──────────────────────────────────────
  it('every articleEvidence entry has evidenceCount, sourceCount, strengthScore', () => {
    const report = buildEuComplianceReport(makeScan());
    for (const ev of report.articleEvidence) {
      expect(typeof ev.evidenceCount).toBe('number');
      expect(typeof ev.sourceCount).toBe('number');
      expect(typeof ev.strengthScore).toBe('number');
      expect(ev.evidenceCount).toBeGreaterThanOrEqual(0);
      expect(ev.sourceCount).toBeGreaterThanOrEqual(0);
      expect(ev.strengthScore).toBeGreaterThanOrEqual(0);
      expect(ev.strengthScore).toBeLessThanOrEqual(1);
    }
  });

  it('Article 13 has non-zero evidence for supported claims', () => {
    const report = buildEuComplianceReport(makeScan());
    const art13 = report.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13?.evidenceCount).toBeGreaterThan(0);
    expect(art13?.strengthScore).toBeGreaterThan(0);
  });

  it('Article 9 strengthScore is higher with more contradicted claims', () => {
    const scanFew = makeScan({
      claims: [{ id: 'c1', text: 'X.', type: 'fact', importance: 4 }],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'high',
    });
    const scanMany = makeScan({
      claims: [
        { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
        { id: 'c4', text: 'W.', type: 'fact', importance: 4 },
        { id: 'c5', text: 'V.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [{ title: 'S1', uri: 'http://s1.com' }] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [{ title: 'S2', uri: 'http://s2.com' }] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
        c4: { claimId: 'c4', status: 'contradicted', explanation: 'No.', sources: [] },
        c5: { claimId: 'c5', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const reportFew = buildEuComplianceReport(scanFew);
    const reportMany = buildEuComplianceReport(scanMany);
    const art9Few = reportFew.articleEvidence.find(e => e.article.includes('Article 9'));
    const art9Many = reportMany.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9Many!.strengthScore).toBeGreaterThan(art9Few!.strengthScore);
    expect(art9Many!.evidenceCount).toBeGreaterThan(art9Few!.evidenceCount);
  });

  it('strengthScore is 0 when no relevant claims exist for an article', () => {
    const report = buildEuComplianceReport(makeScan());
    // Article 14 is not-applicable for the default scan (no interpretation/mixed claims)
    const art14 = report.articleEvidence.find(e => e.article.includes('Article 14'));
    expect(art14?.evidenceCount).toBe(0);
    expect(art14?.strengthScore).toBe(0);
  });

  it('sources increase strengthScore', () => {
    const scanNoSources = makeScan({
      claims: [{ id: 'c1', text: 'A.', type: 'fact', importance: 4 }],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Yes.', sources: [] },
      },
    });
    const scanWithSources = makeScan({
      claims: [{ id: 'c1', text: 'A.', type: 'fact', importance: 4 }],
      verifications: {
        c1: {
          claimId: 'c1', status: 'supported', explanation: 'Yes.',
          sources: [
            { title: 'Wikipedia', uri: 'http://wiki.com' },
            { title: 'Nature', uri: 'http://nature.com' },
            { title: 'Science', uri: 'http://science.com' },
          ],
        },
      },
    });
    const reportNone = buildEuComplianceReport(scanNoSources);
    const reportWith = buildEuComplianceReport(scanWithSources);
    const art13None = reportNone.articleEvidence.find(e => e.article.includes('Article 13'));
    const art13With = reportWith.articleEvidence.find(e => e.article.includes('Article 13'));
    expect(art13With!.sourceCount).toBeGreaterThan(art13None!.sourceCount);
    expect(art13With!.strengthScore).toBeGreaterThan(art13None!.strengthScore);
  });

  it('complianceScore is weighted by evidence strength', () => {
    // This test verifies the weighted scoring produces valid results
    const report = buildEuComplianceReport(makeScan());
    expect(report.complianceScore).toBeGreaterThanOrEqual(0);
    expect(report.complianceScore).toBeLessThanOrEqual(100);
  });

  // ── N-190: Annex III Conformity Assessment Checklist ────────────────────
  it('annexIIIChecklist is not applicable for low risk', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.annexIIIChecklist).toBeDefined();
    expect(report.annexIIIChecklist.applicable).toBe(false);
    expect(report.annexIIIChecklist.items).toHaveLength(0);
  });

  it('annexIIIChecklist is applicable for high risk', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'high',
    });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.applicable).toBe(true);
    expect(report.annexIIIChecklist.items.length).toBe(8);
  });

  it('annexIIIChecklist is applicable for critical risk', () => {
    const scan = makeScan({ overallRisk: 'critical' });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.applicable).toBe(true);
    expect(report.annexIIIChecklist.items.length).toBe(8);
  });

  it('annexIIIChecklist is applicable when Art. 6 detects Annex III domain content (medium risk)', () => {
    const scan = makeScan({
      overallRisk: 'medium',
      complianceReport: makeComplianceReport({
        claimMappings: [
          makeClaimMapping({ claimId: 'c1', riskLevel: 'high', matchedPatterns: ['Annex III §1 – biometric identification'] }),
        ],
      }),
    });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.applicable).toBe(true);
    expect(report.annexIIIChecklist.items.length).toBe(8);
    const art6Item = report.annexIIIChecklist.items.find(i => i.id === 'annex-iii-0');
    expect(art6Item).toBeDefined();
    expect(art6Item!.article).toBe('Article 6');
    expect(art6Item!.status).toBe('partial');
  });

  it('annexIIIChecklist items cover all 8 requirements including Art. 6', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const articles = report.annexIIIChecklist.items.map(i => i.article);
    expect(articles).toContain('Article 6');
    expect(articles).toContain('Article 9');
    expect(articles).toContain('Article 10');
    expect(articles).toContain('Article 11');
    expect(articles).toContain('Article 12');
    expect(articles).toContain('Article 13');
    expect(articles).toContain('Article 14');
    expect(articles).toContain('Article 15');
  });

  it('annexIIIChecklist annex-iii-0 is first item and maps to Article 6', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.items[0].id).toBe('annex-iii-0');
    expect(report.annexIIIChecklist.items[0].article).toBe('Article 6');
  });

  it('annexIIIChecklist passRate is between 0 and 1', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.passRate).toBeGreaterThanOrEqual(0);
    expect(report.annexIIIChecklist.passRate).toBeLessThanOrEqual(1);
  });

  it('annexIIIChecklist Art.15 fails when many claims contradicted', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'A.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'B.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'C.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'supported', explanation: 'Yes.', sources: [] },
      },
      overallRisk: 'high',
    });
    const report = buildEuComplianceReport(scan);
    const art15 = report.annexIIIChecklist.items.find(i => i.article === 'Article 15');
    // 2/3 contradicted = 66% > 30% threshold → fail
    expect(art15?.status).toBe('fail');
  });

  it('annexIIIChecklist Art.15 passes when no claims contradicted', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const art15 = report.annexIIIChecklist.items.find(i => i.article === 'Article 15');
    expect(art15?.status).toBe('pass');
  });

  it('annexIIIChecklist JSON appears in rendered output', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const json = renderComplianceReportJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.annexIIIChecklist).toBeDefined();
    expect(parsed.annexIIIChecklist.applicable).toBe(true);
    expect(parsed.annexIIIChecklist.items.length).toBe(8);
  });
});

// ── JSON renderer ─────────────────────────────────────────────────────────────

describe('renderComplianceReportJson()', () => {
  it('returns valid JSON string', () => {
    const report = buildEuComplianceReport(makeScan());
    const json = renderComplianceReportJson(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('serialized JSON contains articleEvidence', () => {
    const report = buildEuComplianceReport(makeScan());
    const parsed = JSON.parse(renderComplianceReportJson(report)) as EuAiActComplianceReport;
    expect(Array.isArray(parsed.articleEvidence)).toBe(true);
    expect(parsed.articleEvidence.length).toBeGreaterThan(0);
  });

  it('serialized JSON contains article50Disclosure with not-applicable status', () => {
    const report = buildEuComplianceReport(makeScan());
    const parsed = JSON.parse(renderComplianceReportJson(report)) as EuAiActComplianceReport;
    expect(parsed.article50Disclosure.status).toBe('not-applicable');
  });

  it('serialized JSON contains testCategoryMappings', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'A fact.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'An opinion.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Opinion.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const parsed = JSON.parse(renderComplianceReportJson(report)) as EuAiActComplianceReport;
    expect(Array.isArray(parsed.testCategoryMappings)).toBe(true);
    expect(parsed.testCategoryMappings.length).toBeGreaterThan(0);
  });
});

// ── PDF renderer ──────────────────────────────────────────────────────────────

describe('renderComplianceReportPdf()', () => {
  it('returns a non-empty Buffer', async () => {
    const report = buildEuComplianceReport(makeScan());
    const buf = await renderComplianceReportPdf(report);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('PDF starts with %PDF- magic bytes', async () => {
    const report = buildEuComplianceReport(makeScan());
    const buf = await renderComplianceReportPdf(report);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('generates PDF for high-risk scan without throwing', async () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'AI systems replace judges.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'AI should monitor citizens.', type: 'opinion', importance: 4 },
        { id: 'c3', text: 'This suggests bias.', type: 'interpretation', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Disproved.', sources: [] },
        c2: { claimId: 'c2', status: 'unverified', explanation: 'Opinion.', sources: [] },
        c3: { claimId: 'c3', status: 'mixed', explanation: 'Partial.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    await expect(renderComplianceReportPdf(report)).resolves.toBeInstanceOf(Buffer);
  });

  it('generates PDF with Annex III for high-risk scan', async () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.applicable).toBe(true);
    const buf = await renderComplianceReportPdf(report);
    expect(buf).toBeInstanceOf(Buffer);
    // PDF is larger with Annex III section
    expect(buf.length).toBeGreaterThan(5000);
  });

  it('low-risk PDF omits Annex III section but still succeeds', async () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.annexIIIChecklist.applicable).toBe(false);
    const buf = await renderComplianceReportPdf(report);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});

// ── CLI integration ───────────────────────────────────────────────────────────

describe('CLI: compliance-report command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-cr-test-'));
  });

  it('requires --input or --text flag', async () => {
    const { exitCode, output } = await main(['compliance-report']);
    expect(exitCode).toBe(1);
    expect(output).toContain('--input');
  });

  it('returns error for missing input file', async () => {
    const { exitCode, output } = await main(['compliance-report', '--input', '/nonexistent/path.json']);
    expect(exitCode).toBe(1);
    expect(output).toContain('not found');
  });

  it('reads existing scan JSON and outputs compliance report JSON', async () => {
    const scanData = makeScan();
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(scanData));

    const { exitCode, output } = await main(['compliance-report', '--input', scanFile]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    expect(Array.isArray(parsed.articleEvidence)).toBe(true);
    expect(parsed.article50Disclosure.status).toBe('not-applicable');
  });

  it('--output flag writes JSON to file', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    const outFile = join(tmpDir, 'report.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--output', outFile,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(output).toContain(outFile);
  });

  it('--format pdf writes a PDF file', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    const outFile = join(tmpDir, 'report.pdf');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--format', 'pdf', '--output', outFile,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(output).toContain(outFile);
  });

  it('--text + --provider mock runs scan then produces JSON report', async () => {
    const { exitCode, output } = await main([
      'compliance-report',
      '--text', 'Water boils at 100 degrees Celsius.',
      '--provider', 'mock',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    expect(parsed.articleEvidence.length).toBeGreaterThan(0);
    expect(parsed.summary.totalClaimsAnalyzed).toBeGreaterThanOrEqual(0);
  });

  it('--project-name is reflected in report', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--project-name', 'Acme AI Judge v3',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    expect(parsed.projectName).toBe('Acme AI Judge v3');
  });

  it('output JSON contains OWASP references in article findings', async () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'False claim.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      ruleFindings: [
        { ruleId: 'pii-email', severity: 'high', message: 'PII found', match: 'x@y.com', offset: 0 },
      ],
      overallRisk: 'high',
    });
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(scan));

    const { exitCode, output } = await main(['compliance-report', '--input', scanFile]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as EuAiActComplianceReport;
    const art9 = parsed.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9?.findings.some(f => f.includes('A06') || f.includes('OWASP'))).toBe(true);
  });

  it('compliance-report appears in help output', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('compliance-report');
  });

  it('--ci flag: exits 0 for compliant low-risk scan', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--ci',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('PASS');
    expect(output).toContain('Exit code: 0');
  });

  it('--ci flag: exits 1 for non-compliant scan', async () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Wrong claim.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Very wrong.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(scan));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanFile, '--ci',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('Exit code: 1');
  });

  it('--ci + --output writes JSON report alongside gate output', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    const outFile = join(tmpDir, 'ci-report.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { exitCode } = await main([
      'compliance-report', '--input', scanFile, '--ci', '--output', outFile,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    const parsed = JSON.parse(require('fs').readFileSync(outFile, 'utf-8'));
    expect(parsed.articleEvidence).toBeDefined();
  });

  it('--ci shows article-by-article results', async () => {
    const scanFile = join(tmpDir, 'scan.json');
    writeFileSync(scanFile, JSON.stringify(makeScan()));

    const { output } = await main([
      'compliance-report', '--input', scanFile, '--ci',
    ]);
    expect(output).toContain('Article 9');
    expect(output).toContain('Article 13');
    expect(output).toContain('[PASS]');
  });

  it('--ci help text visible in usage', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('--ci');
  });
});

// ── CI Gate unit tests ───────────────────────────────────────────────────────

describe('evaluateComplianceGate()', () => {
  it('returns pass=true for all-compliant low-risk report', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.exitCode).toBe(0);
    expect(gate.nonCompliantCount).toBe(0);
  });

  it('returns pass=false when articles are non-compliant', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.nonCompliantCount).toBeGreaterThan(0);
  });

  it('fails on high overall risk even if no non-compliant articles', () => {
    const scan = makeScan({ overallRisk: 'high' });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.overallRisk).toBe('high');
  });

  it('totalArticles matches articleEvidence length', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.totalArticles).toBe(report.articleEvidence.length);
  });

  it('each article result has pass boolean and status', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    for (const a of gate.articles) {
      expect(typeof a.pass).toBe('boolean');
      expect(typeof a.status).toBe('string');
      expect(typeof a.article).toBe('string');
    }
  });

  // ── CG1–CG5: Art. 6 conformity trigger in default-mode CI gate ────────────
  it('CG1: gate fails in default mode when Art. 6 detects Annex III domain (medium risk)', () => {
    const scan = makeScan({
      overallRisk: 'medium',
      complianceReport: makeComplianceReport({
        claimMappings: [
          makeClaimMapping({ claimId: 'c1', riskLevel: 'high', matchedPatterns: ['Annex III §1'] }),
        ],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.art6ConformityRequired).toBe(true);
  });

  it('CG2: gate passes in default mode when Art. 6 is not-applicable (no domain content)', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.art6ConformityRequired).toBe(false);
  });

  it('CG3: art6ConformityRequired is false when riskFail already fires (high risk)', () => {
    const scan = makeScan({
      overallRisk: 'high',
      complianceReport: makeComplianceReport({
        claimMappings: [
          makeClaimMapping({ claimId: 'c1', riskLevel: 'high', matchedPatterns: ['Annex III §3'] }),
        ],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(false);
    // riskFail handles this — art6ConformityRequired is false to avoid double-counting
    expect(gate.art6ConformityRequired).toBe(false);
  });

  it('CG4: gate result always includes art6ConformityRequired boolean', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(typeof gate.art6ConformityRequired).toBe('boolean');
  });

  it('CG5: renderCiGateOutput mentions conformity assessment when Art. 6 triggers gate fail', () => {
    const scan = makeScan({
      overallRisk: 'medium',
      complianceReport: makeComplianceReport({
        claimMappings: [
          makeClaimMapping({ claimId: 'c1', riskLevel: 'high', matchedPatterns: ['Annex III §4'] }),
        ],
      }),
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('conformity assessment required');
    expect(output).toContain('FAIL');
  });
});

describe('renderCiGateOutput()', () => {
  it('includes PASS for passing gate', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('PASS');
    expect(output).toContain('Exit code: 0');
  });

  it('includes FAIL for failing gate', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'X.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Y.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Z.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('FAIL');
    expect(output).toContain('Exit code: 1');
    expect(output).toContain('non-compliant');
  });

  it('lists all articles with [PASS] or [FAIL] prefix', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    for (const a of gate.articles) {
      expect(output).toContain(a.article);
    }
    expect(output).toContain('[PASS]');
  });

  it('shows article pass ratio', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain(`/${gate.totalArticles} passing`);
  });

  it('shows Annex III checklist for high-risk scans', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Annex III Conformity Assessment');
    expect(output).toContain('Pass rate:');
    expect(output).toContain('Article 9');
    expect(output).toContain('Article 15');
  });

  it('omits Annex III checklist for low-risk scans', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).not.toContain('Annex III Conformity Assessment');
  });
});

// ── Compliance Diff unit tests ───────────────────────────────────────────────

describe('diffComplianceReports()', () => {
  const lowRiskScan = makeScan();
  const highRiskScan = makeScan({
    claims: [
      { id: 'c1', text: 'Wrong.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'Very wrong.', type: 'fact', importance: 4 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
      c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
      c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
    },
    overallRisk: 'critical',
  });

  it('detects improvement when risk decreases', () => {
    const before = buildEuComplianceReport(highRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('improved');
  });

  it('detects regression when risk increases', () => {
    const before = buildEuComplianceReport(lowRiskScan);
    const after = buildEuComplianceReport(highRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('regressed');
  });

  it('shows unchanged when same risk', () => {
    const before = buildEuComplianceReport(lowRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.riskTrend).toBe('unchanged');
  });

  it('returns article-level diffs', () => {
    const before = buildEuComplianceReport(highRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.articles.length).toBeGreaterThan(0);
    for (const a of diff.articles) {
      expect(typeof a.article).toBe('string');
      expect(['improved', 'regressed', 'unchanged', 'new', 'removed']).toContain(a.trend);
    }
  });

  it('counts improved/regressed/unchanged correctly', () => {
    const before = buildEuComplianceReport(highRiskScan);
    const after = buildEuComplianceReport(lowRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.improved + diff.regressed + diff.unchanged).toBeGreaterThan(0);
    expect(diff.improved).toBeGreaterThanOrEqual(0);
  });

  it('includes before/after metadata', () => {
    const before = buildEuComplianceReport(lowRiskScan);
    const after = buildEuComplianceReport(highRiskScan);
    const diff = diffComplianceReports(before, after);
    expect(diff.before.documentRef).toBeTruthy();
    expect(diff.after.documentRef).toBeTruthy();
    expect(diff.before.overallRisk).toBe('low');
    expect(diff.after.overallRisk).toBe('critical');
  });
});

describe('renderComplianceDiffOutput()', () => {
  it('includes risk trend', () => {
    const before = buildEuComplianceReport(makeScan());
    const after = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('REGRESSED');
  });

  it('shows article transitions', () => {
    const before = buildEuComplianceReport(makeScan());
    const after = buildEuComplianceReport(makeScan());
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('Article');
    expect(output).toContain('->');
  });

  it('shows summary counts', () => {
    const before = buildEuComplianceReport(makeScan());
    const after = buildEuComplianceReport(makeScan());
    const diff = diffComplianceReports(before, after);
    const output = renderComplianceDiffOutput(diff);
    expect(output).toContain('improved');
    expect(output).toContain('regressed');
    expect(output).toContain('unchanged');
  });
});

describe('CLI: compliance-report --diff', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-diff-test-'));
  });

  it('compares two scan files and shows diff', async () => {
    const beforeFile = join(tmpDir, 'before.json');
    const afterFile = join(tmpDir, 'after.json');
    writeFileSync(beforeFile, JSON.stringify(makeScan()));
    writeFileSync(afterFile, JSON.stringify(makeScan({ overallRisk: 'high' })));

    const { exitCode, output } = await main([
      'compliance-report', '--diff', `${beforeFile},${afterFile}`,
    ]);
    expect(output).toContain('Compliance Diff');
    expect(output).toContain('->');
    // Regressed = exit 1
    expect(exitCode).toBe(1);
  });

  it('exits 0 when no regressions', async () => {
    const beforeFile = join(tmpDir, 'before.json');
    const afterFile = join(tmpDir, 'after.json');
    writeFileSync(beforeFile, JSON.stringify(makeScan()));
    writeFileSync(afterFile, JSON.stringify(makeScan()));

    const { exitCode } = await main([
      'compliance-report', '--diff', `${beforeFile},${afterFile}`,
    ]);
    expect(exitCode).toBe(0);
  });

  it('--diff with --format json outputs JSON', async () => {
    const beforeFile = join(tmpDir, 'before.json');
    const afterFile = join(tmpDir, 'after.json');
    writeFileSync(beforeFile, JSON.stringify(makeScan()));
    writeFileSync(afterFile, JSON.stringify(makeScan()));

    const { exitCode, output } = await main([
      'compliance-report', '--diff', `${beforeFile},${afterFile}`, '--format', 'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as ComplianceDiffResult;
    expect(parsed.riskTrend).toBe('unchanged');
    expect(Array.isArray(parsed.articles)).toBe(true);
  });

  it('returns error for invalid --diff format', async () => {
    const { exitCode, output } = await main([
      'compliance-report', '--diff', 'only-one-file.json',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('two');
  });

  it('--diff appears in help output', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('--diff');
  });
});

// ── N-166: Remediation Recommendations ──────────────────────────────────────

describe('getRemediations()', () => {
  it('RR1: returns empty array for compliant status', () => {
    const rems = getRemediations('Article 9', 'compliant', ['All good.']);
    expect(rems).toEqual([]);
  });

  it('RR2: returns empty array for not-applicable status', () => {
    const rems = getRemediations('Article 14', 'not-applicable', []);
    expect(rems).toEqual([]);
  });

  it('RR3: Article 5 non-compliant returns legal review remediation', () => {
    const rems = getRemediations('Article 5', 'non-compliant', ['1 claim(s) flagged for prohibited']);
    expect(rems.length).toBeGreaterThan(0);
    expect(rems.some(r => r.includes('legal review'))).toBe(true);
  });

  it('RR4: Article 9 with contradicted claims returns correction remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['2 contradicted claim(s) detected']);
    expect(rems.some(r => r.includes('contradicted'))).toBe(true);
  });

  it('RR5: Article 9 with PII returns filtering remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['1 PII finding(s)']);
    expect(rems.some(r => r.includes('PII'))).toBe(true);
  });

  it('RR6: Article 9 with bias returns audit remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['1 bias finding(s)']);
    expect(rems.some(r => r.includes('bias'))).toBe(true);
  });

  it('RR7: Article 9 with injection returns guardrails remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['Prompt injection pattern detected']);
    expect(rems.some(r => r.includes('guardrails') || r.includes('injection'))).toBe(true);
  });

  it('RR8: Article 9 with high risk returns Annex III remediation', () => {
    const rems = getRemediations('Article 9', 'non-compliant', ['Overall risk assessed as CRITICAL — Annex III']);
    expect(rems.some(r => r.includes('Annex III'))).toBe(true);
  });

  it('RR9: Article 13 gap returns transparency remediation', () => {
    const rems = getRemediations('Article 13', 'gap', ['No claims extracted']);
    expect(rems.some(r => r.includes('verifiable'))).toBe(true);
    expect(rems.some(r => r.includes('capabilities'))).toBe(true);
  });

  it('RR10: Article 13 partial with unverified returns source attribution', () => {
    const rems = getRemediations('Article 13', 'partial', ['2 unverified/mixed claim(s)']);
    expect(rems.some(r => r.includes('source attribution'))).toBe(true);
  });

  it('RR11: Article 14 partial returns human oversight remediation', () => {
    const rems = getRemediations('Article 14', 'partial', ['3 interpretation claims']);
    expect(rems.some(r => r.includes('human-in-the-loop'))).toBe(true);
    expect(rems.some(r => r.includes('oversight'))).toBe(true);
  });

  it('RR12: Article 50 partial with opinions returns labelling remediation', () => {
    const rems = getRemediations('Article 50', 'partial', ['2 opinion claim(s) detected']);
    expect(rems.some(r => r.includes('labelling'))).toBe(true);
    expect(rems.some(r => r.includes('opinion'))).toBe(true);
  });

  it('RR13: Article 9 with interpretation returns Art 14 reference', () => {
    const rems = getRemediations('Article 9', 'partial', ['2 interpretation claim(s) require human oversight']);
    expect(rems.some(r => r.includes('Art. 14'))).toBe(true);
  });

  it('RR14: Article 9 with generic findings returns fallback remediation', () => {
    const rems = getRemediations('Article 9', 'partial', ['Some other finding']);
    expect(rems.length).toBeGreaterThan(0);
  });

  it('RR15: Article 10 with bias returns audit remediation', () => {
    const rems = getRemediations('Article 10', 'non-compliant', ['1 bias finding(s) detected']);
    expect(rems.some(r => r.includes('bias audit'))).toBe(true);
    expect(rems.some(r => r.includes('Art. 10(2)'))).toBe(true);
  });

  it('RR16: Article 10 with PII returns GDPR remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['1 PII finding(s)']);
    expect(rems.some(r => r.includes('special category'))).toBe(true);
    expect(rems.some(r => r.includes('GDPR'))).toBe(true);
  });

  it('RR17: Article 10 with contradicted returns data quality remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['2 contradicted claim(s)']);
    expect(rems.some(r => r.includes('training data quality'))).toBe(true);
  });

  it('RR18: Article 10 with unverified returns data completeness remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['3 high-importance claim(s) remain unverified']);
    expect(rems.some(r => r.includes('data completeness'))).toBe(true);
  });

  it('RR19: Article 10 with generic findings returns fallback remediation', () => {
    const rems = getRemediations('Article 10', 'partial', ['Some other data issue']);
    expect(rems.length).toBeGreaterThan(0);
    expect(rems.some(r => r.includes('Art. 10'))).toBe(true);
  });

  it('RR20: Article 11 with insufficient docs returns documentation remediation', () => {
    const rems = getRemediations('Article 11', 'gap', ['documentation of system decision-making is insufficient']);
    expect(rems.some(r => r.includes('Art. 11'))).toBe(true);
    expect(rems.some(r => r.includes('technical documentation'))).toBe(true);
  });

  it('RR21: Article 12 without monitoring returns logging remediation', () => {
    const rems = getRemediations('Article 12', 'partial', ['Provider recorded: "mock"']);
    expect(rems.some(r => r.includes('Art. 12'))).toBe(true);
    expect(rems.some(r => r.includes('monitoring'))).toBe(true);
  });
});

describe('remediations in buildEuComplianceReport()', () => {
  it('RR15: every articleEvidence entry has a remediations array', () => {
    const report = buildEuComplianceReport(makeScan());
    for (const ev of report.articleEvidence) {
      expect(Array.isArray(ev.remediations)).toBe(true);
    }
  });

  it('RR16: compliant articles have empty remediations', () => {
    const report = buildEuComplianceReport(makeScan());
    const compliant = report.articleEvidence.filter(ev => ev.status === 'compliant');
    expect(compliant.length).toBeGreaterThan(0);
    for (const ev of compliant) {
      expect(ev.remediations).toEqual([]);
    }
  });

  it('RR17: non-compliant scan has non-empty remediations', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'False claim.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Another false.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Also wrong.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'Wrong.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'Wrong.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const art9 = report.articleEvidence.find(e => e.article.includes('Article 9'));
    expect(art9!.status).toBe('non-compliant');
    expect(art9!.remediations.length).toBeGreaterThan(0);
  });

  it('RR18: CI gate output includes remediations when failing', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Wrong.', type: 'fact', importance: 5 },
        { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Still wrong.', type: 'fact', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
      overallRisk: 'critical',
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report);
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Recommended Remediations');
    expect(output).toContain('Article 9');
  });
});

// ── N-167: Compliance Threshold Configuration ───────────────────────────────

describe('evaluateComplianceGate() threshold/strict options', () => {
  it('TH1: default gate passes for compliant scan', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.threshold).toBe(0);
  });

  it('TH2: threshold=100 fails when score is below 100', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Claim.', type: 'opinion', importance: 3 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    // Opinion claims → Art. 50 partial → score < 100
    expect(report.complianceScore).toBeLessThan(100);
    const gate = evaluateComplianceGate(report, { threshold: 100 });
    expect(gate.pass).toBe(false);
    expect(gate.exitCode).toBe(1);
  });

  it('TH3: threshold=0 (default) passes even with partial score', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Opinion.', type: 'opinion', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { threshold: 0 });
    expect(gate.pass).toBe(true);
  });

  it('TH4: strict mode fails on partial articles', () => {
    const scan = makeScan({
      claims: [
        { id: 'c1', text: 'Interpretation.', type: 'interpretation', importance: 3 },
      ],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    // Art. 14 will be partial (interpretation triggers it)
    const gate = evaluateComplianceGate(report, { strict: true });
    expect(gate.pass).toBe(false);
    const art14 = gate.articles.find(a => a.article.includes('Article 14'));
    expect(art14!.pass).toBe(false);
  });

  it('TH5: strict mode passes when all articles are compliant/not-applicable', () => {
    // Provide sources so Art. 11 (Technical Documentation) reaches 'compliant' threshold
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { strict: true });
    expect(gate.pass).toBe(true);
  });

  it('TH6: gate result includes complianceScore and threshold', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 80 });
    expect(typeof gate.complianceScore).toBe('number');
    expect(gate.threshold).toBe(80);
  });

  it('TH7: threshold below score passes', () => {
    const report = buildEuComplianceReport(makeScan());
    expect(report.complianceScore).toBeGreaterThanOrEqual(80);
    const gate = evaluateComplianceGate(report, { threshold: 50 });
    expect(gate.pass).toBe(true);
  });

  it('TH8: CI gate output shows threshold when set', () => {
    const report = buildEuComplianceReport(makeScan());
    const gate = evaluateComplianceGate(report, { threshold: 80 });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('threshold: 80');
  });

  it('TH9: CI gate output shows score below threshold message', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Opinion.', type: 'opinion', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { threshold: 100 });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('below threshold');
  });

  it('TH10: strict + threshold can be combined', () => {
    const scan = makeScan({
      claims: [{ id: 'c1', text: 'Interp.', type: 'interpretation', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { strict: true, threshold: 90 });
    expect(gate.pass).toBe(false);
  });

  it('TH11: strict mode fails when Annex III has non-pass items (high risk)', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    expect(report.annexIIIChecklist.applicable).toBe(true);
    // Art.11 is partial (explanations but no sources) — strict gate should fail
    const nonPass = report.annexIIIChecklist.items.filter(i => i.status !== 'pass');
    expect(nonPass.length).toBeGreaterThan(0);
    const gate = evaluateComplianceGate(report, { strict: true });
    expect(gate.pass).toBe(false);
  });

  it('TH12: non-strict mode ignores Annex III not-assessed items', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }));
    // Without strict, Annex III status shouldn't affect the gate
    // Note: high risk itself already fails the gate, so we check annexFail doesn't add to reasons
    const gate = evaluateComplianceGate(report);
    // Gate fails because of high risk, not annex
    expect(gate.pass).toBe(false);
  });

  it('TH13: strict mode with low risk ignores Annex III (not applicable)', () => {
    // Provide sources so Art. 11 reaches 'compliant' — test is about Annex III, not Art.11
    const scan = makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    });
    const report = buildEuComplianceReport(scan);
    expect(report.annexIIIChecklist.applicable).toBe(false);
    const gate = evaluateComplianceGate(report, { strict: true });
    expect(gate.pass).toBe(true);
  });

  it('TH14: CI gate output shows Annex III failure details for high-risk', () => {
    // Use a scan that produces Annex III fail items (many contradictions → Art.15 fail)
    const scan = makeScan({
      overallRisk: 'high',
      claims: [
        { id: 'c1', text: 'Wrong.', type: 'fact', importance: 4 },
        { id: 'c2', text: 'Also wrong.', type: 'fact', importance: 4 },
        { id: 'c3', text: 'Very wrong.', type: 'fact', importance: 4 },
      ],
      verifications: {
        c1: { claimId: 'c1', status: 'contradicted', explanation: 'No.', sources: [] },
        c2: { claimId: 'c2', status: 'contradicted', explanation: 'No.', sources: [] },
        c3: { claimId: 'c3', status: 'contradicted', explanation: 'No.', sources: [] },
      },
    });
    const report = buildEuComplianceReport(scan);
    const gate = evaluateComplianceGate(report, { strict: true });
    const output = renderCiGateOutput(gate, report);
    expect(output).toContain('Annex III');
    expect(output).toContain('conformity item(s) require attention');
  });
});

// ── N-168: Compliance Badge SVG ─────────────────────────────────────────────

describe('renderComplianceBadgeSvg()', () => {
  it('BG1: returns valid SVG with xmlns', () => {
    const svg = renderComplianceBadgeSvg(100, true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('BG2: passing badge shows PASS and green color', () => {
    const svg = renderComplianceBadgeSvg(95, true);
    expect(svg).toContain('PASS');
    expect(svg).toContain('#4c1'); // bright green for score >= 80
  });

  it('BG3: failing badge shows FAIL and red color', () => {
    const svg = renderComplianceBadgeSvg(25, false);
    expect(svg).toContain('FAIL');
    expect(svg).toContain('#e05d44'); // red for score < 50
  });

  it('BG4: default label is "EU AI Act"', () => {
    const svg = renderComplianceBadgeSvg(80, true);
    expect(svg).toContain('EU AI Act');
  });

  it('BG5: custom label overrides default', () => {
    const svg = renderComplianceBadgeSvg(80, true, { label: 'Compliance' });
    expect(svg).toContain('Compliance');
    expect(svg).not.toContain('EU AI Act');
  });

  it('BG6: score is displayed in badge', () => {
    const svg = renderComplianceBadgeSvg(73, true);
    expect(svg).toContain('73');
  });

  it('BG7: yellow color for failing but score >= 50', () => {
    const svg = renderComplianceBadgeSvg(65, false);
    expect(svg).toContain('#dfb317');
  });

  it('BG8: light green for passing but score < 80', () => {
    const svg = renderComplianceBadgeSvg(70, true);
    expect(svg).toContain('#a3c51c');
  });

  it('BG9: includes aria-label for accessibility', () => {
    const svg = renderComplianceBadgeSvg(90, true);
    expect(svg).toContain('aria-label');
  });

  it('BG10: includes title element', () => {
    const svg = renderComplianceBadgeSvg(90, true);
    expect(svg).toContain('<title>');
  });
});

// ── N-170: Compliance Config File ───────────────────────────────────────────

describe('loadComplianceConfig()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-cfg-'));
  });

  it('CF1: returns null when no config file exists', () => {
    const result = loadComplianceConfig(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('CF2: loads config from explicit path', () => {
    const cfgPath = join(tmpDir, 'custom-compliance.json');
    writeFileSync(cfgPath, JSON.stringify({ projectName: 'MyProject', threshold: 80, strict: true }));
    const config = loadComplianceConfig(cfgPath);
    expect(config).not.toBeNull();
    expect(config!.projectName).toBe('MyProject');
    expect(config!.threshold).toBe(80);
    expect(config!.strict).toBe(true);
  });

  it('CF3: returns null for invalid JSON', () => {
    const cfgPath = join(tmpDir, 'bad.json');
    writeFileSync(cfgPath, 'not json {{{');
    const result = loadComplianceConfig(cfgPath);
    expect(result).toBeNull();
  });

  it('CF4: loads threshold as number', () => {
    const cfgPath = join(tmpDir, 'threshold.json');
    writeFileSync(cfgPath, JSON.stringify({ threshold: 75 }));
    const config = loadComplianceConfig(cfgPath);
    expect(config!.threshold).toBe(75);
  });

  it('CF5: loads requiredArticles array', () => {
    const cfgPath = join(tmpDir, 'articles.json');
    writeFileSync(cfgPath, JSON.stringify({ requiredArticles: ['Article 9', 'Article 13'] }));
    const config = loadComplianceConfig(cfgPath);
    expect(config!.requiredArticles).toEqual(['Article 9', 'Article 13']);
  });

  it('CF6: config with no fields returns empty object', () => {
    const cfgPath = join(tmpDir, 'empty.json');
    writeFileSync(cfgPath, '{}');
    const config = loadComplianceConfig(cfgPath);
    expect(config).toEqual({});
  });

  it('CF7: returns null when path does not exist and no auto-discovery', () => {
    // loadComplianceConfig with no args checks CWD �� should be null in test env
    const result = loadComplianceConfig(join(tmpDir, 'nope.json'));
    expect(result).toBeNull();
  });
});

describe('CLI --ci with config file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-ci-cfg-'));
  });

  it('CF8: --config loads project name from config file', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const cfgPath = join(tmpDir, '.faultline-compliance.json');
    writeFileSync(cfgPath, JSON.stringify({ projectName: 'ConfigProject' }));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--ci', '--config', cfgPath,
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('ConfigProject');
  });

  it('CF9: CLI --project-name overrides config projectName', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const cfgPath = join(tmpDir, '.faultline-compliance.json');
    writeFileSync(cfgPath, JSON.stringify({ projectName: 'FromConfig' }));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--ci',
      '--config', cfgPath, '--project-name', 'FromCLI',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('FromCLI');
  });

  it('CF10: config threshold applied in --ci mode', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan({
      claims: [{ id: 'c1', text: 'Opinion.', type: 'opinion', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
    })));
    const cfgPath = join(tmpDir, '.faultline-compliance.json');
    writeFileSync(cfgPath, JSON.stringify({ threshold: 100 }));

    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--ci', '--config', cfgPath,
    ]);
    // Opinion makes Art. 50 partial → score < 100 → fails threshold
    expect(exitCode).toBe(1);
    expect(output).toContain('FAIL');
  });
});

// ── Markdown Renderer (N-172) ─────────────────────────────────────────────────

describe('renderComplianceReportMarkdown()', () => {
  function makeReport(overrides: Partial<EuAiActComplianceReport> = {}): EuAiActComplianceReport {
    return buildEuComplianceReport(makeScan(), { projectName: 'TestProject', ...overrides });
  }

  function makeGate(overrides: Partial<CiGateResult> = {}): CiGateResult {
    return {
      pass: true,
      overallRisk: 'low',
      articles: [
        { article: 'Article 9', status: 'compliant' as const, pass: true },
        { article: 'Article 13', status: 'compliant' as const, pass: true },
        { article: 'Article 14', status: 'compliant' as const, pass: true },
        { article: 'Article 50', status: 'compliant' as const, pass: true },
      ],
      nonCompliantCount: 0,
      totalArticles: 4,
      exitCode: 0,
      complianceScore: 100,
      threshold: 0,
      art6ConformityRequired: false,
      ...overrides,
    };
  }

  it('MD1: returns a non-empty string', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate());
    expect(md.length).toBeGreaterThan(0);
  });

  it('MD2: contains H2 heading with PASS status', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate());
    expect(md).toContain('## ');
    expect(md).toContain('PASS');
    expect(md).toContain(':white_check_mark:');
  });

  it('MD3: contains H2 heading with FAIL status when gate fails', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate({ pass: false, exitCode: 1 }));
    expect(md).toContain('FAIL');
    expect(md).toContain(':x:');
  });

  it('MD4: contains metrics table with score and risk', () => {
    const report = makeReport();
    const gate = makeGate();
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain(`| **Score** | ${report.complianceScore}/100 |`);
    expect(md).toContain('| **Overall Risk** |');
    expect(md).toContain('| **Project** | TestProject |');
  });

  it('MD5: contains article status table with all articles', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate());
    expect(md).toContain('### Article Status');
    expect(md).toContain('| Article | Status | Result |');
    expect(md).toContain('Article 9');
    expect(md).toContain('Article 13');
    expect(md).toContain('Article 50');
  });

  it('MD6: shows threshold in metrics table when non-zero', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate({ threshold: 80 }));
    expect(md).toContain('| **Threshold** | 80 |');
  });

  it('MD7: omits threshold row when threshold is 0', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate({ threshold: 0 }));
    expect(md).not.toContain('**Threshold**');
  });

  it('MD8: includes collapsible remediations when articles have them', () => {
    const report = makeReport();
    // Inject remediations into an article
    report.articleEvidence[0].remediations = ['Fix issue A', 'Fix issue B'];
    const md = renderComplianceReportMarkdown(report, makeGate({ pass: false, exitCode: 1 }));
    expect(md).toContain('<details>');
    expect(md).toContain('Recommended Remediations');
    expect(md).toContain('- Fix issue A');
    expect(md).toContain('- Fix issue B');
    expect(md).toContain('</details>');
  });

  it('MD9: omits remediations section when no articles have them', () => {
    const report = makeReport();
    // Ensure no remediations on any article
    for (const ev of report.articleEvidence) {
      ev.remediations = [];
    }
    const md = renderComplianceReportMarkdown(report, makeGate());
    expect(md).not.toContain('<details>');
    expect(md).not.toContain('Recommended Remediations');
  });

  it('MD10: contains Faultline Pro attribution footer', () => {
    const report = makeReport();
    const md = renderComplianceReportMarkdown(report, makeGate());
    expect(md).toContain('Faultline Pro');
    expect(md).toContain(report.documentRef);
  });

  it('MD11: claims analysed count matches report summary', () => {
    const report = makeReport();
    const md = renderComplianceReportMarkdown(report, makeGate());
    expect(md).toContain(`| **Claims Analysed** | ${report.summary.totalClaimsAnalyzed} |`);
  });

  it('MD12: high-risk findings shown in metrics table', () => {
    const report = makeReport();
    const md = renderComplianceReportMarkdown(report, makeGate());
    expect(md).toContain(`| **High-Risk Findings** | ${report.summary.highRiskFindings} |`);
  });

  it('MD13: shows Annex III table for high-risk reports', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }), { projectName: 'TestProject' });
    const gate = evaluateComplianceGate(report);
    const md = renderComplianceReportMarkdown(report, gate);
    expect(md).toContain('### Annex III Conformity Assessment');
    expect(md).toContain('annex-iii-1');
    expect(md).toContain('**Pass rate:**');
  });

  it('MD14: omits Annex III for low-risk reports', () => {
    const md = renderComplianceReportMarkdown(makeReport(), makeGate());
    expect(md).not.toContain('Annex III');
  });
});

// ── CLI --format markdown (N-172) ─────────────────────────────────────────────

describe('compliance-report --format markdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-md-'));
  });

  it('MD-CLI1: outputs markdown to stdout', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'markdown',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('## ');
    expect(output).toContain('EU AI Act Compliance');
    expect(output).toContain('Article Status');
    expect(output).toContain('Faultline Pro');
  });

  it('MD-CLI2: writes markdown to file with --output', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const outPath = join(tmpDir, 'report.md');
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'markdown', '--output', outPath,
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('Markdown');
    expect(existsSync(outPath)).toBe(true);
  });

  it('MD-CLI3: markdown includes project name from --project-name', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'markdown',
      '--project-name', 'MyAISystem',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('MyAISystem');
  });

  it('MD-CLI4: markdown respects --threshold flag', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'markdown', '--threshold', '80',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('**Threshold**');
    expect(output).toContain('80');
  });
});

// ── SARIF Compliance Renderer (N-173) ─────────────────────────────────────────

describe('renderComplianceReportSarif()', () => {
  function makeReport(overrides: Partial<EuAiActComplianceReport> = {}): EuAiActComplianceReport {
    return buildEuComplianceReport(makeScan(), { projectName: 'TestProject', ...overrides });
  }

  function makeGate(overrides: Partial<CiGateResult> = {}): CiGateResult {
    return {
      pass: true,
      overallRisk: 'low',
      articles: [
        { article: 'Article 9', status: 'compliant' as const, pass: true },
        { article: 'Article 13', status: 'compliant' as const, pass: true },
        { article: 'Article 14', status: 'compliant' as const, pass: true },
        { article: 'Article 50', status: 'compliant' as const, pass: true },
      ],
      nonCompliantCount: 0,
      totalArticles: 4,
      exitCode: 0,
      complianceScore: 100,
      threshold: 0,
      art6ConformityRequired: false,
      ...overrides,
    };
  }

  it('SF1: returns valid JSON', () => {
    const sarif = renderComplianceReportSarif(makeReport(), makeGate());
    const parsed = JSON.parse(sarif);
    expect(parsed).toBeDefined();
  });

  it('SF2: contains SARIF 2.1.0 schema and version', () => {
    const parsed = JSON.parse(renderComplianceReportSarif(makeReport(), makeGate()));
    expect(parsed.$schema).toContain('sarif-schema-2.1.0');
    expect(parsed.version).toBe('2.1.0');
  });

  it('SF3: has runs array with one run', () => {
    const parsed = JSON.parse(renderComplianceReportSarif(makeReport(), makeGate()));
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.runs.length).toBe(1);
  });

  it('SF4: tool driver is Faultline Pro', () => {
    const parsed = JSON.parse(renderComplianceReportSarif(makeReport(), makeGate()));
    const driver = parsed.runs[0].tool.driver;
    expect(driver.name).toBe('Faultline Pro');
    expect(driver.informationUri).toContain('faultline-pro');
  });

  it('SF5: rules array has one entry per article', () => {
    const report = makeReport();
    const parsed = JSON.parse(renderComplianceReportSarif(report, makeGate()));
    const rules = parsed.runs[0].tool.driver.rules;
    expect(rules.length).toBe(report.articleEvidence.length);
  });

  it('SF6: rule IDs use slugified article names', () => {
    const parsed = JSON.parse(renderComplianceReportSarif(makeReport(), makeGate()));
    const rules = parsed.runs[0].tool.driver.rules;
    for (const rule of rules) {
      expect(rule.id).toMatch(/^faultline\/eu-ai-act\//);
      expect(rule.properties.tags).toContain('eu-ai-act');
    }
  });

  it('SF7: no results when all articles compliant', () => {
    // Provide sources so Art. 11 reaches 'compliant' — avoids partial SARIF result
    const report = buildEuComplianceReport(makeScan({
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://a.com', title: 'A' }] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [{ uri: 'http://b.com', title: 'B' }] },
      },
    }), { projectName: 'TestProject' });
    const parsed = JSON.parse(renderComplianceReportSarif(report, makeGate()));
    expect(parsed.runs[0].results.length).toBe(0);
  });

  it('SF8: partial article produces warning result', () => {
    const report = makeReport();
    report.articleEvidence[0].status = 'partial';
    report.articleEvidence[0].findings = ['Some gap detected'];
    const parsed = JSON.parse(renderComplianceReportSarif(report, makeGate({ pass: false })));
    const results = parsed.runs[0].results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].level).toBe('warning');
    expect(results[0].message.text).toContain('partial');
  });

  it('SF9: non-compliant article produces error result', () => {
    const report = makeReport();
    report.articleEvidence[0].status = 'non-compliant';
    report.articleEvidence[0].findings = ['Critical gap'];
    const parsed = JSON.parse(renderComplianceReportSarif(report, makeGate({ pass: false })));
    const results = parsed.runs[0].results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].level).toBe('error');
  });

  it('SF10: invocations include compliance metadata', () => {
    const parsed = JSON.parse(renderComplianceReportSarif(makeReport(), makeGate()));
    const inv = parsed.runs[0].invocations[0];
    expect(inv.executionSuccessful).toBe(true);
    expect(inv.properties.complianceScore).toBeDefined();
    expect(inv.properties.projectName).toBe('TestProject');
  });

  it('SF11: remediations included in result properties', () => {
    const report = makeReport();
    report.articleEvidence[0].status = 'gap';
    report.articleEvidence[0].remediations = ['Fix this', 'Fix that'];
    const parsed = JSON.parse(renderComplianceReportSarif(report, makeGate({ pass: false })));
    const result = parsed.runs[0].results[0];
    expect(result.properties.remediations).toEqual(['Fix this', 'Fix that']);
  });

  it('SF12: results have physicalLocation with artifactLocation', () => {
    const report = makeReport();
    report.articleEvidence[0].status = 'non-compliant';
    const parsed = JSON.parse(renderComplianceReportSarif(report, makeGate({ pass: false })));
    const loc = parsed.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe('input');
    expect(loc.artifactLocation.uriBaseId).toBe('%SRCROOT%');
  });

  it('SF13: adds Annex III conformity gap results for high-risk reports', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }), { projectName: 'TestProject' });
    const gate = evaluateComplianceGate(report);
    const parsed = JSON.parse(renderComplianceReportSarif(report, gate));
    const rules = parsed.runs[0].tool.driver.rules;
    const annexRules = rules.filter((r: { id: string }) => r.id.includes('annex-iii'));
    // Not-assessed items (Art.11, Art.12) should appear as conformity gaps
    expect(annexRules.length).toBeGreaterThan(0);
    expect(annexRules[0].properties.tags).toContain('annex-iii');
  });

  it('SF14: Annex III passRate in invocation properties for high-risk', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }), { projectName: 'TestProject' });
    const gate = evaluateComplianceGate(report);
    const parsed = JSON.parse(renderComplianceReportSarif(report, gate));
    expect(parsed.runs[0].invocations[0].properties.annexIIIPassRate).toBeDefined();
  });

  it('SF15: no Annex III rules for low-risk reports', () => {
    const parsed = JSON.parse(renderComplianceReportSarif(makeReport(), makeGate()));
    const rules = parsed.runs[0].tool.driver.rules;
    const annexRules = rules.filter((r: { id: string }) => r.id.includes('annex-iii'));
    expect(annexRules.length).toBe(0);
  });
});

// ── CLI --format sarif (N-173) ────────────────────────────────────────────────

describe('compliance-report --format sarif', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-sarif-'));
  });

  it('SF-CLI1: outputs valid SARIF JSON to stdout', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'sarif',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0].tool.driver.name).toBe('Faultline Pro');
  });

  it('SF-CLI2: writes SARIF to file with --output', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const outPath = join(tmpDir, 'report.sarif');
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'sarif', '--output', outPath,
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('SARIF');
    expect(existsSync(outPath)).toBe(true);
  });

  it('SF-CLI3: SARIF includes project name from --project-name', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'sarif',
      '--project-name', 'SarifProject',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].invocations[0].properties.projectName).toBe('SarifProject');
  });

  it('SF-CLI4: SARIF respects --threshold', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'sarif', '--threshold', '90',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].invocations[0].properties.threshold).toBe(90);
  });
});

// ── HTML Compliance Renderer (N-175) ──────────────────────────────────────────

describe('renderComplianceReportHtml()', () => {
  function makeReport(overrides: Partial<EuAiActComplianceReport> = {}): EuAiActComplianceReport {
    return buildEuComplianceReport(makeScan(), { projectName: 'HTMLProject', ...overrides });
  }

  function makeGate(overrides: Partial<CiGateResult> = {}): CiGateResult {
    return {
      pass: true, overallRisk: 'low',
      articles: [
        { article: 'Article 9', status: 'compliant' as const, pass: true },
        { article: 'Article 50', status: 'compliant' as const, pass: true },
      ],
      nonCompliantCount: 0, totalArticles: 4, exitCode: 0, complianceScore: 100, threshold: 0,
      art6ConformityRequired: false,
      ...overrides,
    };
  }

  it('HT1: returns valid HTML document', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('HT2: title contains project name', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate());
    expect(html).toContain('<title>EU AI Act Compliance');
    expect(html).toContain('HTMLProject');
  });

  it('HT3: shows PASS status when gate passes', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate());
    expect(html).toContain('PASS');
  });

  it('HT4: shows FAIL status when gate fails', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate({ pass: false, exitCode: 1 }));
    expect(html).toContain('FAIL');
  });

  it('HT5: contains summary cards with score and risk', () => {
    const report = makeReport();
    const html = renderComplianceReportHtml(report, makeGate());
    expect(html).toContain(`${report.complianceScore}/100`);
    expect(html).toContain('Overall Risk');
    expect(html).toContain('Claims');
  });

  it('HT6: contains article status table', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate());
    expect(html).toContain('Article Status');
    expect(html).toContain('Article 9');
    expect(html).toContain('Article 50');
  });

  it('HT7: escapes HTML in user content', () => {
    const report = makeReport();
    report.projectName = '<script>alert(1)</script>';
    const html = renderComplianceReportHtml(report, makeGate());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HT8: includes remediations when articles have them', () => {
    const report = makeReport();
    report.articleEvidence[0].remediations = ['Fix XSS', 'Add CSRF'];
    const html = renderComplianceReportHtml(report, makeGate());
    expect(html).toContain('Fix XSS');
    expect(html).toContain('Add CSRF');
  });

  it('HT9: shows threshold card when non-zero', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate({ threshold: 80 }));
    expect(html).toContain('Threshold');
    expect(html).toContain('80');
  });

  it('HT10: omits threshold card when zero', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate({ threshold: 0 }));
    expect(html).not.toContain('Threshold');
  });

  it('HT11: footer contains Faultline Pro and document ref', () => {
    const report = makeReport();
    const html = renderComplianceReportHtml(report, makeGate());
    expect(html).toContain('Faultline Pro');
    expect(html).toContain(report.documentRef);
  });

  it('HT12: status badges use colored spans', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate());
    expect(html).toContain('class="badge"');
  });

  it('HT13: shows Annex III section for high-risk reports', () => {
    const report = buildEuComplianceReport(makeScan({ overallRisk: 'high' }), { projectName: 'HTMLProject' });
    const gate = evaluateComplianceGate(report);
    const html = renderComplianceReportHtml(report, gate);
    expect(html).toContain('Annex III Conformity Assessment');
    expect(html).toContain('Pass Rate');
    expect(html).toContain('annex-iii-1');
  });

  it('HT14: omits Annex III section for low-risk reports', () => {
    const html = renderComplianceReportHtml(makeReport(), makeGate());
    expect(html).not.toContain('Annex III Conformity Assessment');
  });
});

// ── CLI --format html (N-175) ────────────────────────────────────────────────

describe('compliance-report --format html', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-html-'));
  });

  it('HT-CLI1: writes HTML file by default', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'html',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain('HTML');
    expect(output).toContain('.html');
  });

  it('HT-CLI2: writes HTML to custom output path', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const outPath = join(tmpDir, 'report.html');
    const { exitCode, output } = await main([
      'compliance-report', '--input', scanPath, '--format', 'html', '--output', outPath,
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  it('HT-CLI3: HTML contains project name', async () => {
    const scanPath = join(tmpDir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify(makeScan()));
    const outPath = join(tmpDir, 'report.html');
    const { exitCode } = await main([
      'compliance-report', '--input', scanPath, '--format', 'html',
      '--output', outPath, '--project-name', 'TestHtmlProject',
    ]);
    expect(exitCode).toBe(0);
    const { readFileSync: readFs } = await import('node:fs');
    const content = readFs(outPath, 'utf-8');
    expect(content).toContain('TestHtmlProject');
  });
});
