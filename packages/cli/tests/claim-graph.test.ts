import { describe, it, expect } from 'vitest';
import type { Claim, ClaimStatus, VerificationResult } from '../types';
import type { ComplianceReport } from '../compliance/report_generator';
import type { ClaimRiskMapping, EURiskLevel } from '../compliance/eu_ai_act';
import {
  buildClaimGraph,
  renderMermaid,
  renderDot,
  STATUS_COLORS,
  TIER_COLORS,
  type ClaimNode,
  type ClaimGraph,
  type EURiskTier,
  type GraphNodeStatus,
} from '../analysis/claim-graph';

// ---------------------------------------------------------------------------
// Test helpers (factories)
// ---------------------------------------------------------------------------

function makeClaim(overrides?: Partial<Claim>): Claim {
  return {
    id: 'claim-1',
    text: 'Default test claim text.',
    type: 'fact',
    importance: 3,
    ...overrides,
  };
}

function makeVerification(
  claimId: string,
  status: ClaimStatus,
): VerificationResult {
  return {
    claimId,
    status,
    explanation: 'Test explanation.',
    sources: [],
  };
}

function makeComplianceReport(
  mappings?: Array<{ claimId: string; confidenceScore: number; riskLevel: EURiskLevel }>,
): ComplianceReport {
  const claimMappings: ClaimRiskMapping[] = (mappings ?? []).map((m) => ({
    claimId: m.claimId,
    claimText: 'mapped claim',
    verificationStatus: 'supported' as ClaimStatus,
    riskLevel: m.riskLevel,
    category: {
      level: m.riskLevel,
      title: m.riskLevel,
      description: '',
      articles: [],
      requiredActions: [],
    },
    matchedPatterns: [],
    confidence: 'medium' as const,
    confidenceScore: m.confidenceScore,
  }));

  return {
    generatedAt: new Date().toISOString(),
    overallRiskLevel: 'low',
    euRiskSummary: {
      unacceptable: 0,
      high: 0,
      limited: 0,
      minimal: 0,
      totalClaims: claimMappings.length,
      highestTier: 'minimal',
    },
    claimMappings,
    triggeredArticles: [],
    mitigations: [],
    confidenceDistribution: { high: 0, medium: 0, low: 0 },
  };
}

// ---------------------------------------------------------------------------
// 1. STATUS_COLORS (3 tests)
// ---------------------------------------------------------------------------

describe('STATUS_COLORS', () => {
  it('should map supported to green (#22c55e)', () => {
    expect(STATUS_COLORS.supported).toBe('#22c55e');
  });

  it('should map contradicted to red (#ef4444)', () => {
    expect(STATUS_COLORS.contradicted).toBe('#ef4444');
  });

  it('should map unverified to gray (#6b7280)', () => {
    expect(STATUS_COLORS.unverified).toBe('#6b7280');
  });
});

// ---------------------------------------------------------------------------
// 2. TIER_COLORS (3 tests)
// ---------------------------------------------------------------------------

describe('TIER_COLORS', () => {
  it('should map high to a red-ish colour (#fee2e2)', () => {
    expect(TIER_COLORS.high).toBe('#fee2e2');
  });

  it('should map minimal to a green-ish colour (#dcfce7)', () => {
    expect(TIER_COLORS.minimal).toBe('#dcfce7');
  });

  it('should map unverified to slate (#f1f5f9)', () => {
    expect(TIER_COLORS.unverified).toBe('#f1f5f9');
  });
});

// ---------------------------------------------------------------------------
// 3. buildClaimGraph — basic (5 tests)
// ---------------------------------------------------------------------------

describe('buildClaimGraph — basic', () => {
  it('should return empty nodes and nodesByTier for empty claims', () => {
    const graph = buildClaimGraph([], {}, makeComplianceReport());
    expect(graph.nodes).toHaveLength(0);
    expect(graph.nodesByTier.unacceptable).toHaveLength(0);
    expect(graph.nodesByTier.high).toHaveLength(0);
    expect(graph.nodesByTier.limited).toHaveLength(0);
    expect(graph.nodesByTier.minimal).toHaveLength(0);
    expect(graph.nodesByTier.unverified).toHaveLength(0);
  });

  it('should default status to unverified and euTier to unverified when claim has no verification or mapping', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const graph = buildClaimGraph(claims, {}, makeComplianceReport());
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].status).toBe('unverified');
    expect(graph.nodes[0].euTier).toBe('unverified');
    expect(graph.nodes[0].confidenceScore).toBe(0.5);
  });

  it('should use the correct verification status when present', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'contradicted') };
    const graph = buildClaimGraph(claims, verifications, makeComplianceReport());
    expect(graph.nodes[0].status).toBe('contradicted');
  });

  it('should use euTier and confidenceScore from claimMappings', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.85, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    expect(graph.nodes[0].euTier).toBe('high');
    expect(graph.nodes[0].confidenceScore).toBe(0.85);
  });

  it('should assign nodeId as c + index', () => {
    const claims = [
      makeClaim({ id: 'alpha' }),
      makeClaim({ id: 'beta' }),
      makeClaim({ id: 'gamma' }),
    ];
    const graph = buildClaimGraph(claims, {}, makeComplianceReport());
    const nodeIds = graph.nodes.map((n) => n.nodeId);
    expect(nodeIds).toContain('c0');
    expect(nodeIds).toContain('c1');
    expect(nodeIds).toContain('c2');
  });
});

// ---------------------------------------------------------------------------
// 4. buildClaimGraph — label truncation (3 tests)
// ---------------------------------------------------------------------------

describe('buildClaimGraph — label truncation', () => {
  it('should not truncate text that is 60 characters or fewer', () => {
    const shortText = 'Short claim text.';
    const claims = [makeClaim({ id: 'c1', text: shortText })];
    const graph = buildClaimGraph(claims, {}, makeComplianceReport());
    expect(graph.nodes[0].label).toBe(shortText);
  });

  it('should truncate text longer than 60 characters at 57 + ...', () => {
    const longText = 'A'.repeat(80);
    const claims = [makeClaim({ id: 'c1', text: longText })];
    const graph = buildClaimGraph(claims, {}, makeComplianceReport());
    expect(graph.nodes[0].label).toBe('A'.repeat(57) + '...');
    expect(graph.nodes[0].label).toHaveLength(60);
  });

  it('should not truncate text that is exactly 60 characters', () => {
    const exactText = 'B'.repeat(60);
    const claims = [makeClaim({ id: 'c1', text: exactText })];
    const graph = buildClaimGraph(claims, {}, makeComplianceReport());
    expect(graph.nodes[0].label).toBe(exactText);
    expect(graph.nodes[0].label).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------
// 5. buildClaimGraph — sorting (4 tests)
// ---------------------------------------------------------------------------

describe('buildClaimGraph — sorting', () => {
  it('should sort unacceptable tier before high before limited before minimal', () => {
    const claims = [
      makeClaim({ id: 'c-minimal', importance: 5 }),
      makeClaim({ id: 'c-high', importance: 5 }),
      makeClaim({ id: 'c-unacceptable', importance: 5 }),
      makeClaim({ id: 'c-limited', importance: 5 }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c-minimal', confidenceScore: 0.3, riskLevel: 'minimal' },
      { claimId: 'c-high', confidenceScore: 0.7, riskLevel: 'high' },
      { claimId: 'c-unacceptable', confidenceScore: 0.95, riskLevel: 'unacceptable' },
      { claimId: 'c-limited', confidenceScore: 0.6, riskLevel: 'limited' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    const tiers = graph.nodes.map((n) => n.euTier);
    expect(tiers).toEqual(['unacceptable', 'high', 'limited', 'minimal']);
  });

  it('should sort higher importance first within the same tier', () => {
    const claims = [
      makeClaim({ id: 'c-low', importance: 1 }),
      makeClaim({ id: 'c-high', importance: 5 }),
      makeClaim({ id: 'c-mid', importance: 3 }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c-low', confidenceScore: 0.5, riskLevel: 'high' },
      { claimId: 'c-high', confidenceScore: 0.5, riskLevel: 'high' },
      { claimId: 'c-mid', confidenceScore: 0.5, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    const importances = graph.nodes.map((n) => n.importance);
    expect(importances).toEqual([5, 3, 1]);
  });

  it('should place unverified tier last', () => {
    const claims = [
      makeClaim({ id: 'c-unverified', importance: 5 }),
      makeClaim({ id: 'c-minimal', importance: 1 }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c-minimal', confidenceScore: 0.3, riskLevel: 'minimal' },
      // c-unverified has no mapping -> defaults to 'unverified' tier
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    expect(graph.nodes[0].euTier).toBe('minimal');
    expect(graph.nodes[1].euTier).toBe('unverified');
  });

  it('should group nodes correctly in nodesByTier after sorting', () => {
    const claims = [
      makeClaim({ id: 'c1', importance: 3 }),
      makeClaim({ id: 'c2', importance: 5 }),
      makeClaim({ id: 'c3', importance: 1 }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
      { claimId: 'c2', confidenceScore: 0.6, riskLevel: 'limited' },
      { claimId: 'c3', confidenceScore: 0.3, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    expect(graph.nodesByTier.high).toHaveLength(2);
    expect(graph.nodesByTier.limited).toHaveLength(1);
    expect(graph.nodesByTier.minimal).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. buildClaimGraph — nodesByTier (3 tests)
// ---------------------------------------------------------------------------

describe('buildClaimGraph — nodesByTier', () => {
  it('should have empty arrays for tiers with no nodes (not missing keys)', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.5, riskLevel: 'minimal' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    expect(graph.nodesByTier.unacceptable).toEqual([]);
    expect(graph.nodesByTier.high).toEqual([]);
    expect(graph.nodesByTier.limited).toEqual([]);
    expect(graph.nodesByTier.unverified).toEqual([]);
    expect(graph.nodesByTier.minimal).toHaveLength(1);
  });

  it('should group 3 claims in high tier correctly', () => {
    const claims = [
      makeClaim({ id: 'c1', importance: 5 }),
      makeClaim({ id: 'c2', importance: 3 }),
      makeClaim({ id: 'c3', importance: 1 }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
      { claimId: 'c2', confidenceScore: 0.6, riskLevel: 'high' },
      { claimId: 'c3', confidenceScore: 0.5, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    expect(graph.nodesByTier.high).toHaveLength(3);
    // Verify they are sorted by importance desc within the tier
    expect(graph.nodesByTier.high[0].importance).toBe(5);
    expect(graph.nodesByTier.high[1].importance).toBe(3);
    expect(graph.nodesByTier.high[2].importance).toBe(1);
  });

  it('should place claims into the correct tier buckets when mixed', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
      makeClaim({ id: 'c3' }),
      makeClaim({ id: 'c4' }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.95, riskLevel: 'unacceptable' },
      { claimId: 'c2', confidenceScore: 0.7, riskLevel: 'high' },
      { claimId: 'c3', confidenceScore: 0.6, riskLevel: 'limited' },
      { claimId: 'c4', confidenceScore: 0.3, riskLevel: 'minimal' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    expect(graph.nodesByTier.unacceptable).toHaveLength(1);
    expect(graph.nodesByTier.high).toHaveLength(1);
    expect(graph.nodesByTier.limited).toHaveLength(1);
    expect(graph.nodesByTier.minimal).toHaveLength(1);
    expect(graph.nodesByTier.unverified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. renderMermaid — structure (5 tests)
// ---------------------------------------------------------------------------

describe('renderMermaid — structure', () => {
  it('should start with graph TD', () => {
    const graph = buildClaimGraph([], {}, makeComplianceReport());
    const mermaid = renderMermaid(graph);
    expect(mermaid.startsWith('graph TD')).toBe(true);
  });

  it('should include a subgraph for each non-empty tier', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
      { claimId: 'c2', confidenceScore: 0.3, riskLevel: 'minimal' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    const mermaid = renderMermaid(graph);
    expect(mermaid).toContain('subgraph HIGH_RISK["HIGH RISK"]');
    expect(mermaid).toContain('subgraph MINIMAL_RISK["MINIMAL RISK"]');
  });

  it('should NOT include subgraph for empty tiers', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, verifications, report);
    const mermaid = renderMermaid(graph);
    // Only HIGH RISK subgraph should be present
    expect(mermaid).not.toContain('subgraph UNACCEPTABLE');
    expect(mermaid).not.toContain('subgraph LIMITED_RISK');
    expect(mermaid).not.toContain('subgraph MINIMAL_RISK');
    expect(mermaid).not.toContain('subgraph UNVERIFIED');
  });

  it('should include claimType, importance, and status in node labels', () => {
    const claims = [makeClaim({ id: 'c1', text: 'Test claim', type: 'fact', importance: 4 })];
    const verifications = { c1: makeVerification('c1', 'contradicted') };
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, verifications, report);
    const mermaid = renderMermaid(graph);
    expect(mermaid).toContain('fact');
    expect(mermaid).toContain('imp:4');
    expect(mermaid).toContain('CONTRADICTED');
  });

  it('should always include all 6 classDef entries', () => {
    const graph = buildClaimGraph([], {}, makeComplianceReport());
    const mermaid = renderMermaid(graph);
    expect(mermaid).toContain('classDef supported');
    expect(mermaid).toContain('classDef contradicted');
    expect(mermaid).toContain('classDef mixed');
    expect(mermaid).toContain('classDef unverified');
    expect(mermaid).toContain('classDef loading');
    expect(mermaid).toContain('classDef skipped');
  });
});

// ---------------------------------------------------------------------------
// 8. renderMermaid — class assignments (3 tests)
// ---------------------------------------------------------------------------

describe('renderMermaid — class assignments', () => {
  it('should assign supported class to a supported node', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.3, riskLevel: 'minimal' },
    ]);
    const graph = buildClaimGraph(claims, verifications, report);
    const mermaid = renderMermaid(graph);
    expect(mermaid).toContain('class c0 supported');
  });

  it('should assign contradicted class to a contradicted node', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'contradicted') };
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, verifications, report);
    const mermaid = renderMermaid(graph);
    expect(mermaid).toContain('class c0 contradicted');
  });

  it('should have matching node IDs between subgraph definition and class assignment', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'mixed'),
    };
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.3, riskLevel: 'minimal' },
      { claimId: 'c2', confidenceScore: 0.6, riskLevel: 'limited' },
    ]);
    const graph = buildClaimGraph(claims, verifications, report);
    const mermaid = renderMermaid(graph);

    // Extract node IDs from subgraph definitions (e.g. "    c0[...")
    const subgraphNodeIds = [...mermaid.matchAll(/^\s{4}(c\d+)\[/gm)].map((m) => m[1]);
    // Extract node IDs from class assignments (e.g. "  class c0 supported")
    const classNodeIds = [...mermaid.matchAll(/class (c\d+) /gm)].map((m) => m[1]);

    expect(subgraphNodeIds.sort()).toEqual(classNodeIds.sort());
  });
});

// ---------------------------------------------------------------------------
// 9. renderDot — structure (4 tests)
// ---------------------------------------------------------------------------

describe('renderDot — structure', () => {
  it('should start with digraph ClaimGraph {', () => {
    const graph = buildClaimGraph([], {}, makeComplianceReport());
    const dot = renderDot(graph);
    expect(dot.startsWith('digraph ClaimGraph {')).toBe(true);
  });

  it('should include subgraph cluster_X for non-empty tiers', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
    ];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
      { claimId: 'c2', confidenceScore: 0.3, riskLevel: 'minimal' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    const dot = renderDot(graph);
    expect(dot).toContain('subgraph cluster_high');
    expect(dot).toContain('subgraph cluster_minimal');
  });

  it('should colour each node with fillcolor matching STATUS_COLORS', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'mixed') };
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.6, riskLevel: 'limited' },
    ]);
    const graph = buildClaimGraph(claims, verifications, report);
    const dot = renderDot(graph);
    expect(dot).toContain(`fillcolor="${STATUS_COLORS.mixed}"`);
  });

  it('should colour each cluster with fillcolor matching TIER_COLORS', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const report = makeComplianceReport([
      { claimId: 'c1', confidenceScore: 0.7, riskLevel: 'high' },
    ]);
    const graph = buildClaimGraph(claims, {}, report);
    const dot = renderDot(graph);
    expect(dot).toContain(`fillcolor="${TIER_COLORS.high}"`);
  });
});

// ---------------------------------------------------------------------------
// 10. renderDot — empty graph (2 tests)
// ---------------------------------------------------------------------------

describe('renderDot — empty graph', () => {
  it('should produce a digraph with no subgraphs when there are no claims', () => {
    const graph = buildClaimGraph([], {}, makeComplianceReport());
    const dot = renderDot(graph);
    expect(dot).not.toContain('subgraph');
  });

  it('should produce valid DOT syntax (starts with digraph, ends with })', () => {
    const graph = buildClaimGraph([], {}, makeComplianceReport());
    const dot = renderDot(graph);
    expect(dot.startsWith('digraph')).toBe(true);
    expect(dot.trimEnd().endsWith('}')).toBe(true);
  });
});
