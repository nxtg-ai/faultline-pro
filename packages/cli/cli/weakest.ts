/**
 * Weakest-Link Analysis formatter — pure ASCII output, no I/O, no side effects.
 *
 * Formats a WeakestLinkAnalysis into a human-readable ASCII report suitable
 * for terminal display. Uses fixed-width bar charts and status icons.
 */

// ---------------------------------------------------------------------------
// Types (mirrored from analysis/weakest-link.ts to avoid compile-time coupling)
// ---------------------------------------------------------------------------

export interface ClaimFragility {
  claimId: string;
  claimText: string;
  claimType: 'fact' | 'opinion' | 'interpretation';
  importance: number;
  status: string;
  confidenceScore: number;
  fragilityScore: number;
  fragilityReason: string;
}

export interface WeakestLinkAnalysis {
  weakestClaim: ClaimFragility | null;
  rankedClaims: ClaimFragility[];
  argumentStrength: 'resilient' | 'stable' | 'fragile' | 'critical';
  strengthScore: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRENGTH_ICONS: Record<WeakestLinkAnalysis['argumentStrength'], string> = {
  resilient: '[OK]',
  stable: '[~~]',
  fragile: '[!]',
  critical: '[!!]',
};

const STATUS_ICONS: Record<string, string> = {
  contradicted: '[X]',
  mixed: '[?]',
  unverified: '[?]',
  supported: '[v]',
};

const BAR_LENGTH = 10;
const BAR_FILLED = '\u2588';   // full block
const BAR_EMPTY = '\u2591';    // light shade

const DEFAULT_TOP_N = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fixed-width bar of BAR_LENGTH characters representing a 0-1 ratio.
 *
 * @param ratio - Value between 0.0 and 1.0
 * @returns A string like "[████████░░]"
 */
function fragilityBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * BAR_LENGTH);
  const empty = BAR_LENGTH - filled;
  return '[' + BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(empty) + ']';
}

/**
 * Return the status icon for a given claim status string.
 */
function statusIcon(status: string): string {
  const normalised = status.toLowerCase();
  return STATUS_ICONS[normalised] ?? '[?]';
}

/**
 * Format a single ranked claim entry.
 *
 * @param claim - The claim fragility data
 * @param rank - 1-based rank number
 * @param isWeakest - Whether to append the "<< WEAKEST LINK" label
 */
function formatClaimEntry(claim: ClaimFragility, rank: number, isWeakest: boolean): string {
  const icon = statusIcon(claim.status);
  const label = isWeakest ? '  << WEAKEST LINK' : '';
  const fragilityPct = Math.round(claim.fragilityScore * 100);
  const confidencePct = Math.round(claim.confidenceScore * 100);
  const bar = fragilityBar(claim.fragilityScore);

  const lines: string[] = [];
  lines.push(`  ${rank}. ${icon} Importance: ${claim.importance}/5${label}`);
  lines.push(`     "${claim.claimText}"`);
  lines.push(`     Fragility: ${bar} ${fragilityPct}%  |  Confidence: ${confidencePct}%`);
  lines.push(`     ${claim.fragilityReason}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a WeakestLinkAnalysis into a human-readable ASCII report.
 *
 * @param analysis - The weakest-link analysis result
 * @param topN - Maximum number of fragile claims to display (default 5)
 * @returns Formatted ASCII string suitable for terminal output
 */
export function formatWeakestLinkAnalysis(analysis: WeakestLinkAnalysis, topN: number = DEFAULT_TOP_N): string {
  if (!analysis.weakestClaim) {
    return 'No verified claims to analyze for weakest-link detection.';
  }

  const strengthIcon = STRENGTH_ICONS[analysis.argumentStrength];
  const strengthLabel = analysis.argumentStrength.toUpperCase();
  const scoreFormatted = analysis.strengthScore.toFixed(2);

  const lines: string[] = [];
  lines.push('Weakest-Link Analysis');
  lines.push('\u2550'.repeat(21));
  lines.push(`Argument Strength: ${strengthIcon} ${strengthLabel}  (resilience score: ${scoreFormatted}/1.00)`);
  lines.push('');

  const claimsToShow = analysis.rankedClaims.slice(0, topN);
  const count = claimsToShow.length;
  lines.push(`Top ${count} fragile claims:`);
  lines.push('');

  for (let i = 0; i < claimsToShow.length; i++) {
    lines.push(formatClaimEntry(claimsToShow[i], i + 1, i === 0));
    if (i < claimsToShow.length - 1) {
      lines.push('');
    }
  }

  lines.push('');
  lines.push(`Summary: ${analysis.summary}`);

  return lines.join('\n');
}
