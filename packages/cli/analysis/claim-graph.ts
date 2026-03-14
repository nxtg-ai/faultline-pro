import type { Claim, ClaimStatus, VerificationResult } from '../types.js';
import type { ComplianceReport } from '../compliance/report_generator.js';
import type { ClaimRiskMapping } from '../compliance/eu_ai_act.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GraphNodeStatus = 'supported' | 'contradicted' | 'mixed' | 'unverified' | 'loading' | 'skipped';

export type EURiskTier = 'unacceptable' | 'high' | 'limited' | 'minimal' | 'unverified';

export interface ClaimNode {
  /** Safe graph ID: 'c' + index (e.g. 'c0', 'c1'). */
  nodeId: string;
  /** Original claim.id from the extraction pipeline. */
  claimId: string;
  /** First 60 characters of claim.text (truncated with '...' if longer). */
  label: string;
  claimType: Claim['type'];
  importance: number;
  status: GraphNodeStatus;
  /** EU AI Act risk tier from claimMappings, defaults to 'unverified'. */
  euTier: EURiskTier;
  /** Confidence score from claimMappings, defaults to 0.5. */
  confidenceScore: number;
}

export interface ClaimGraph {
  nodes: ClaimNode[];
  /** Claims grouped by EU risk tier. Every tier key is always present. */
  nodesByTier: Record<EURiskTier, ClaimNode[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Status-to-colour mapping (hex). */
export const STATUS_COLORS: Record<GraphNodeStatus, string> = {
  supported: '#22c55e',
  contradicted: '#ef4444',
  mixed: '#f59e0b',
  unverified: '#6b7280',
  loading: '#94a3b8',
  skipped: '#94a3b8',
};

/** Tier-to-colour mapping (hex) for cluster backgrounds. */
export const TIER_COLORS: Record<EURiskTier, string> = {
  unacceptable: '#fecaca',
  high: '#fee2e2',
  limited: '#fef3c7',
  minimal: '#dcfce7',
  unverified: '#f1f5f9',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical sort order for EU risk tiers (most severe first). */
const TIER_ORDER: readonly EURiskTier[] = [
  'unacceptable',
  'high',
  'limited',
  'minimal',
  'unverified',
] as const;

/** Human-readable tier labels used in Mermaid subgraphs and DOT clusters. */
const TIER_LABELS: Record<EURiskTier, string> = {
  unacceptable: 'UNACCEPTABLE',
  high: 'HIGH RISK',
  limited: 'LIMITED RISK',
  minimal: 'MINIMAL RISK',
  unverified: 'UNVERIFIED',
};

/** DOT cluster identifier prefix per tier. */
const TIER_CLUSTER_NAMES: Record<EURiskTier, string> = {
  unacceptable: 'cluster_unacceptable',
  high: 'cluster_high',
  limited: 'cluster_limited',
  minimal: 'cluster_minimal',
  unverified: 'cluster_unverified',
};

const DEFAULT_CONFIDENCE = 0.5;
const LABEL_MAX_LENGTH = 60;
const LABEL_TRUNCATED_LENGTH = 57;

/**
 * Truncate text to at most 60 characters.
 *
 * If the text exceeds 60 characters it is cut at 57 and '...' is appended.
 */
function truncateLabel(text: string): string {
  if (text.length > LABEL_MAX_LENGTH) {
    return text.substring(0, LABEL_TRUNCATED_LENGTH) + '...';
  }
  return text;
}

/**
 * Look up a claim's verification status.
 *
 * Falls back to 'unverified' when the claim has no matching entry.
 */
function resolveStatus(
  claimId: string,
  verifications: Record<string, VerificationResult>,
): GraphNodeStatus {
  const v = verifications[claimId];
  return v ? v.status : 'unverified';
}

/**
 * Look up a claim's risk mapping from the compliance report.
 *
 * Returns the matching ClaimRiskMapping or undefined when the claim
 * is not present in the report.
 */
function resolveMapping(
  claimId: string,
  complianceReport: ComplianceReport,
): ClaimRiskMapping | undefined {
  return complianceReport.claimMappings.find((m) => m.claimId === claimId);
}

/**
 * Build an empty nodesByTier record with every tier initialised to [].
 */
function emptyNodesByTier(): Record<EURiskTier, ClaimNode[]> {
  return {
    unacceptable: [],
    high: [],
    limited: [],
    minimal: [],
    unverified: [],
  };
}

// ---------------------------------------------------------------------------
// buildClaimGraph
// ---------------------------------------------------------------------------

/**
 * Build a ClaimGraph from pipeline outputs.
 *
 * Every claim is included regardless of whether it has a verification
 * result or a compliance mapping. Missing data is filled with safe
 * defaults (status='unverified', euTier='unverified', confidence=0.5).
 *
 * Nodes are sorted by tier severity (unacceptable first) then by
 * importance descending within each tier.
 */
export function buildClaimGraph(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
  complianceReport: ComplianceReport,
): ClaimGraph {
  const nodes: ClaimNode[] = claims.map((claim, index) => {
    const status = resolveStatus(claim.id, verifications);
    const mapping = resolveMapping(claim.id, complianceReport);
    const euTier: EURiskTier = mapping ? mapping.riskLevel : 'unverified';
    const confidenceScore = mapping ? mapping.confidenceScore : DEFAULT_CONFIDENCE;

    return {
      nodeId: `c${index}`,
      claimId: claim.id,
      label: truncateLabel(claim.text),
      claimType: claim.type,
      importance: claim.importance,
      status,
      euTier,
      confidenceScore,
    };
  });

  // Sort: tier severity first, then importance descending within tier.
  nodes.sort((a, b) => {
    const tierDiff = TIER_ORDER.indexOf(a.euTier) - TIER_ORDER.indexOf(b.euTier);
    if (tierDiff !== 0) return tierDiff;
    return b.importance - a.importance;
  });

  // Group into tier buckets.
  const nodesByTier = emptyNodesByTier();
  for (const node of nodes) {
    nodesByTier[node.euTier].push(node);
  }

  return { nodes, nodesByTier };
}

// ---------------------------------------------------------------------------
// renderMermaid
// ---------------------------------------------------------------------------

/**
 * Render a ClaimGraph as a Mermaid graph definition.
 *
 * Only non-empty tiers are emitted as subgraphs. The classDef block
 * for all six status types is always included.
 */
export function renderMermaid(graph: ClaimGraph): string {
  const lines: string[] = ['graph TD'];

  for (const tier of TIER_ORDER) {
    const tierNodes = graph.nodesByTier[tier];
    if (tierNodes.length === 0) continue;

    const label = TIER_LABELS[tier];
    lines.push(`  subgraph ${label.replace(/ /g, '_')}["${label}"]`);
    for (const node of tierNodes) {
      const nodeLabel = `${node.label}\\n${node.claimType} • imp:${node.importance} • ${node.status.toUpperCase()}`;
      lines.push(`    ${node.nodeId}["${nodeLabel}"]`);
    }
    lines.push('  end');
  }

  // classDef block — always present with all six status types.
  lines.push(`  classDef supported fill:${STATUS_COLORS.supported},color:#fff,stroke:#15803d`);
  lines.push(`  classDef contradicted fill:${STATUS_COLORS.contradicted},color:#fff,stroke:#b91c1c`);
  lines.push(`  classDef mixed fill:${STATUS_COLORS.mixed},color:#fff,stroke:#b45309`);
  lines.push(`  classDef unverified fill:${STATUS_COLORS.unverified},color:#fff,stroke:#374151`);
  lines.push(`  classDef loading fill:${STATUS_COLORS.loading},color:#fff,stroke:#475569`);
  lines.push(`  classDef skipped fill:${STATUS_COLORS.skipped},color:#fff,stroke:#475569`);

  // class assignments — one per node.
  for (const node of graph.nodes) {
    lines.push(`  class ${node.nodeId} ${node.status}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderDot
// ---------------------------------------------------------------------------

/**
 * Render a ClaimGraph as a Graphviz DOT definition.
 *
 * Only non-empty tiers are emitted as clusters. Each node is coloured
 * according to its verification status.
 */
export function renderDot(graph: ClaimGraph): string {
  const lines: string[] = [
    'digraph ClaimGraph {',
    '  rankdir=TB;',
    '  compound=true;',
    '  node [fontname="Arial", fontsize=11];',
  ];

  for (const tier of TIER_ORDER) {
    const tierNodes = graph.nodesByTier[tier];
    if (tierNodes.length === 0) continue;

    const clusterName = TIER_CLUSTER_NAMES[tier];
    const clusterLabel = TIER_LABELS[tier];
    const clusterColor = TIER_COLORS[tier];

    lines.push(`  subgraph ${clusterName} {`);
    lines.push(`    label="${clusterLabel}";`);
    lines.push('    style=filled;');
    lines.push(`    fillcolor="${clusterColor}";`);

    for (const node of tierNodes) {
      const nodeLabel = `${node.label}\\n${node.claimType} | imp:${node.importance} | ${node.status.toUpperCase()}`;
      const fillColor = STATUS_COLORS[node.status];
      lines.push(
        `    "${node.nodeId}" [label="${nodeLabel}", shape=box, style=filled, fillcolor="${fillColor}", fontcolor=white];`,
      );
    }

    lines.push('  }');
  }

  lines.push('}');
  return lines.join('\n');
}
