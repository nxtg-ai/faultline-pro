// Validates: N-234 (EP4 Amendment 2 item 6: provenance and evidence in SARIF, guard JSON and CSV; emma-soul al:193832a732e0b82e)
/**
 * Every export that carries a verdict also carries who checked it and when,
 * what each source said when it was read, and the independent passages,
 * kept apart. The guard's human table prints the engine's verdict word,
 * never "VERIFIED".
 */
import { describe, it, expect } from 'vitest';
import { evaluateGuard, formatGuardJson, formatGuardReport } from '../cli/guard.js';
import { renderReportAs } from '../cli/report.js';
import { renderCsv } from '../cli/export.js';
import { auditTrail } from '../cli/audit-trail.js';
import type { ScanResult } from '../cli/scan.js';
import type { HistoryEntry } from '../history/store.js';
import type { VerificationResult } from '../types.js';

const PROVENANCE = { provider: 'gemini', model: 'gemini-2.5-flash-001', verifiedAt: '2026-10-14T05:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-14T05:00:00.000Z' };
const GROUNDED = { title: 'g', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a', evidence: { status: 'not_fetched' as const, reason: 'provider_terms' as const, passage: null } };
const INDEPENDENT = {
  retriever: 'openai-web-search', model: 'gpt-4o-mini', retrievedAt: '2026-10-14T05:00:01.000Z',
  sources: [{ title: 'K', uri: 'https://kestrel.example/a', evidence: { status: 'ok' as const, passage: 'Completed in 1889 for the Fair.', fetchedAt: '2026-10-14T05:00:02.000Z', contentSha256: 'a'.repeat(64) } }],
};

function verdict(status: VerificationResult['status'], over: Partial<VerificationResult> = {}): VerificationResult {
  return { claimId: 'c1', status, explanation: 'ok', sources: [GROUNDED], provenance: PROVENANCE, independentEvidence: INDEPENDENT, ...over };
}

function scanOf(v: VerificationResult): ScanResult {
  return {
    input: 'text', provider: 'gemini',
    claims: [{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 }],
    verifications: { c1: v },
    overallRisk: 'medium',
    complianceReport: { claimMappings: [], euRiskSummary: { highestTier: 'minimal', totalClaims: 1 }, confidenceDistribution: {} } as unknown as ScanResult['complianceReport'],
    ruleFindings: [], verificationErrors: 0, degraded: false,
  } as ScanResult;
}

describe('auditTrail', () => {
  it('carries provenance, each source with its evidence, and the independent passages apart', () => {
    const t = auditTrail(verdict('supported'));
    expect(t.provenance).toEqual(PROVENANCE);
    expect(t.sources).toEqual([{ uri: GROUNDED.uri, title: 'g', evidence: GROUNDED.evidence }]);
    expect(t.independentEvidence).toEqual(INDEPENDENT);
  });

  it('says null rather than inventing what was not recorded', () => {
    expect(auditTrail(undefined)).toEqual({ provenance: null, sources: [], independentEvidence: null });
    const bare = auditTrail({ claimId: 'c1', status: 'unverified', explanation: '', sources: [{ title: 't', uri: 'https://x.example/' }], apiError: true });
    expect(bare).toEqual({ provenance: null, sources: [{ uri: 'https://x.example/', title: 't', evidence: null }], independentEvidence: null });
  });
});

describe('guard', () => {
  it('the table prints the verdict word and who checked it, never VERIFIED', () => {
    const out = formatGuardReport(evaluateGuard(scanOf(verdict('supported'))), undefined);
    expect(out).toMatch(/\[OK\] SUPPORTED/);
    expect(out).not.toMatch(/VERIFIED/);
    expect(out).toContain('checked by gemini (gemini-2.5-flash-001) at 2026-10-14T05:00:00.000Z, sources from gemini-grounding');
  });

  it('the JSON keeps the gate vocabulary and adds status, provenance, sources with evidence and independent evidence', () => {
    const parsed = JSON.parse(formatGuardJson(evaluateGuard(scanOf(verdict('supported'))), undefined));
    const c = parsed.claims[0];
    expect(c.verdict).toBe('VERIFIED');
    expect(c.status).toBe('supported');
    expect(c.provenance).toEqual(PROVENANCE);
    expect(c.sources[0].evidence).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null });
    expect(c.independent_evidence.sources[0].evidence.passage).toBe('Completed in 1889 for the Fair.');
  });
});

describe('SARIF', () => {
  it('each verification result carries provenance, sources with evidence and independent evidence', () => {
    const sarif = JSON.parse(renderReportAs(scanOf(verdict('contradicted')), 'sarif'));
    const r = sarif.runs[0].results.find((x: { ruleId: string }) => x.ruleId === 'faultline/verification/contradicted');
    expect(r).toBeDefined();
    expect(r.properties.provenance).toEqual(PROVENANCE);
    expect(r.properties.sources[0].evidence.reason).toBe('provider_terms');
    expect(r.properties.independentEvidence.retriever).toBe('openai-web-search');
  });
});

describe('CSV', () => {
  it('appends who checked each claim, when, and the evidence, after the existing columns', () => {
    const entry: HistoryEntry = {
      timestamp: '2026-10-14T05:00:05.000Z', file: 'f.txt', provider: 'gemini', overallRisk: 'medium',
      findingCount: 0, claimCount: 1, verificationCount: 1, ruleFindings: [], scanResult: scanOf(verdict('supported')),
    };
    const [header, row] = renderCsv([entry]).trim().split('\n');
    const cols = header.split(',');
    expect(cols.slice(0, 14)).toEqual(['scan_timestamp', 'file', 'provider', 'overall_risk', 'claim_id', 'claim_text', 'claim_type', 'claim_importance', 'verdict', 'confidence', 'explanation', 'sources_count', 'rule_findings_count', 'latency_ms']);
    expect(cols.slice(14)).toEqual(['checked_by_provider', 'checked_by_model', 'verified_at', 'retriever', 'retrieved_at', 'evidence_json', 'independent_evidence_json']);
    expect(row).toContain('gemini-2.5-flash-001');
    expect(row).toContain('2026-10-14T05:00:00.000Z');
    expect(row).toContain('provider_terms');
    expect(row).toContain('Completed in 1889 for the Fair.');
  });
});

describe('item 6 seat findings, pinned', () => {
  it('a claim whose check never ran has status null in the guard JSON, not its placeholder "unverified"', () => {
    const parsed = JSON.parse(formatGuardJson(evaluateGuard(scanOf(verdict('unverified', { apiError: true, provenance: undefined }))), undefined));
    expect(parsed.claims[0].verdict).toBe('UNCHECKED');
    expect(parsed.claims[0].status).toBeNull();
  });

  it('the gate line names the verdict word and the --fail-on word', () => {
    const out = formatGuardReport(evaluateGuard(scanOf(verdict('contradicted')), 'refuted'), 'refuted');
    expect(out).toMatch(/1 CONTRADICTED \(refuted\)/);
  });

  it('a scan with no claims still writes a row as wide as the header', () => {
    const entry: HistoryEntry = {
      timestamp: '2026-10-14T05:00:05.000Z', file: 'f.txt', provider: 'gemini', overallRisk: 'low',
      findingCount: 0, claimCount: 0, verificationCount: 0, ruleFindings: [], scanResult: { ...scanOf(verdict('supported')), claims: [], verifications: {} },
    };
    const [header, row] = renderCsv([entry]).trim().split('\n');
    expect(row.split(',')).toHaveLength(header.split(',').length);
  });
});
