/**
 * Tests for `faultline scan --demo` (MAXOUT BURN directive)
 *
 * Verifies that the demo mode:
 *  - exits 0 without any API keys
 *  - contains representative claim text
 *  - renders verdict icons ([OK], [!!], [??])
 *  - includes EU AI Act compliance sections
 *  - works with both default (markdown) and explicit output formats
 */
import { describe, it, expect } from 'vitest';
import { main } from '../cli/index.js';
import { getDemoResult } from '../cli/demo.js';

// ── getDemoResult unit tests ──────────────────────────────────────────────────

describe('getDemoResult', () => {
  it('returns a ScanResult with 5 claims', () => {
    const result = getDemoResult();
    expect(result.claims).toHaveLength(5);
  });

  it('all claims have id, text, type, and importance', () => {
    const result = getDemoResult();
    for (const claim of result.claims) {
      expect(claim.id).toBeTruthy();
      expect(claim.text.length).toBeGreaterThan(10);
      expect(['fact', 'opinion', 'interpretation']).toContain(claim.type);
      expect(claim.importance).toBeGreaterThanOrEqual(1);
      expect(claim.importance).toBeLessThanOrEqual(5);
    }
  });

  it('has at least one contradicted verification', () => {
    const result = getDemoResult();
    const statuses = Object.values(result.verifications).map(v => v.status);
    expect(statuses).toContain('contradicted');
  });

  it('has at least one supported verification', () => {
    const result = getDemoResult();
    const statuses = Object.values(result.verifications).map(v => v.status);
    expect(statuses).toContain('supported');
  });

  it('has at least one mixed or unverified verification', () => {
    const result = getDemoResult();
    const statuses = Object.values(result.verifications).map(v => v.status);
    expect(statuses.some(s => s === 'mixed' || s === 'unverified')).toBe(true);
  });

  it('overallRisk is high or critical given contradicted claims', () => {
    const result = getDemoResult();
    expect(['high', 'critical']).toContain(result.overallRisk);
  });

  it('complianceReport has triggeredArticles', () => {
    const result = getDemoResult();
    expect(result.complianceReport.triggeredArticles.length).toBeGreaterThanOrEqual(1);
  });

  it('complianceReport includes EU AI Act Annex III reference', () => {
    const result = getDemoResult();
    const articles = result.complianceReport.triggeredArticles.map(a => a.article);
    expect(articles.some(a => /annex iii/i.test(a))).toBe(true);
  });

  it('complianceReport has mitigations', () => {
    const result = getDemoResult();
    expect(result.complianceReport.mitigations.length).toBeGreaterThanOrEqual(1);
  });

  it('provider name indicates demo mode', () => {
    const result = getDemoResult();
    expect(result.provider.toLowerCase()).toContain('demo');
  });

  it('verifications map covers all claim IDs', () => {
    const result = getDemoResult();
    for (const claim of result.claims) {
      expect(result.verifications[claim.id]).toBeDefined();
    }
  });

  it('contradicted verifications include sources', () => {
    const result = getDemoResult();
    const contradicted = Object.values(result.verifications).filter(v => v.status === 'contradicted');
    expect(contradicted.length).toBeGreaterThanOrEqual(1);
    for (const v of contradicted) {
      expect(v.sources.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('supported verifications include sources', () => {
    const result = getDemoResult();
    const supported = Object.values(result.verifications).filter(v => v.status === 'supported');
    expect(supported.length).toBeGreaterThanOrEqual(1);
    for (const v of supported) {
      expect(v.sources.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('confidenceDistribution sums to totalClaims', () => {
    const result = getDemoResult();
    const cd = result.complianceReport.confidenceDistribution;
    const total = (cd.high ?? 0) + (cd.medium ?? 0) + (cd.low ?? 0);
    expect(total).toBe(result.complianceReport.euRiskSummary.totalClaims);
  });

  it('euRiskSummary totalClaims matches claims array length', () => {
    const result = getDemoResult();
    expect(result.complianceReport.euRiskSummary.totalClaims).toBe(result.claims.length);
  });
});

// ── CLI integration tests — faultline scan --demo ─────────────────────────────

describe('faultline scan --demo', () => {
  it('exits 0 without any API key', async () => {
    const { exitCode } = await main(['scan', '--demo']);
    expect(exitCode).toBe(0);
  });

  it('output contains claim text (hiring AI)', async () => {
    const { output } = await main(['scan', '--demo']);
    expect(output.toLowerCase()).toMatch(/hir|recruit|bias|eu ai act/);
  });

  it('output contains contradicted verdict indicator', async () => {
    // Markdown renderer uses emoji; plaintext uses [!!]
    const { output } = await main(['scan', '--demo']);
    expect(output).toMatch(/contradicted|❌|\[!!\]/);
  });

  it('output contains supported verdict indicator', async () => {
    const { output } = await main(['scan', '--demo']);
    expect(output).toMatch(/supported|✅|\[OK\]/);
  });

  it('output contains mixed or unverified verdict indicator', async () => {
    const { output } = await main(['scan', '--demo']);
    expect(output).toMatch(/mixed|unverified|⚠️|➖|\[??\]/);
  });

  it('output shows Overall Risk section', async () => {
    const { output } = await main(['scan', '--demo']);
    expect(output).toMatch(/overall risk/i);
  });

  it('output shows EU AI Act compliance section', async () => {
    const { output } = await main(['scan', '--demo']);
    expect(output).toMatch(/eu ai act|annex iii/i);
  });

  it('output shows provider as Demo Mode', async () => {
    const { output } = await main(['scan', '--demo']);
    expect(output.toLowerCase()).toContain('demo');
  });

  it('--output-format json returns valid JSON', async () => {
    const { exitCode, output } = await main(['scan', '--demo', '--output-format', 'json']);
    expect(exitCode).toBe(0);
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.claims).toHaveLength(5);
  });

  it('--output-format json contains overallRisk', async () => {
    const { output } = await main(['scan', '--demo', '--output-format', 'json']);
    const parsed = JSON.parse(output);
    expect(['high', 'critical']).toContain(parsed.overallRisk);
  });

  it('--output-format html returns HTML string', async () => {
    const { exitCode, output } = await main(['scan', '--demo', '--output-format', 'html']);
    expect(exitCode).toBe(0);
    expect(output).toContain('<html');
  });

  it('demo flag is boolean — no value needed', async () => {
    // Passing --demo with no following argument must not error
    const { exitCode } = await main(['scan', '--demo']);
    expect(exitCode).toBe(0);
  });
});
