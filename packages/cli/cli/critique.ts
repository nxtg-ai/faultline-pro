/**
 * Critique Analysis formatter -- pure ASCII output, no I/O, no side effects.
 *
 * Formats a CritiqueAnalysis into a human-readable report suitable for
 * terminal display. Follows the same conventions as cli/weakest.ts.
 */

import type { CritiqueAnalysis } from '../analysis/critique.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TITLE = 'Critique Analysis';
const SEPARATOR = '\u2550'.repeat(TITLE.length);
const MAX_CLAIM_TEXT_LENGTH = 80;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}

/**
 * Format a single failed claim as a bullet-point line.
 *
 * Output: `  - [type] imp:N -- "claim text"`
 */
function formatClaimLine(claim: { text: string; type: string; importance: number }): string {
  const truncated = truncateText(claim.text, MAX_CLAIM_TEXT_LENGTH);
  return `  - [${claim.type}] imp:${claim.importance} \u2014 "${truncated}"`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a CritiqueAnalysis into a human-readable ASCII report.
 *
 * When there are failed claims, the output includes a listing of each
 * failed claim, the provider's critique, and the improved prompt.
 * When there are no failed claims, a brief success message is shown.
 *
 * @param analysis - The critique analysis to format
 * @param providerName - Name of the LLM provider used for display
 * @returns Formatted string suitable for terminal output
 */
export function formatCritique(analysis: CritiqueAnalysis, providerName: string): string {
  const lines: string[] = [];

  lines.push(TITLE);
  lines.push(SEPARATOR);
  lines.push(
    `Provider: ${providerName} | Claims: ${analysis.totalClaims} | ` +
    `Verified: ${analysis.totalVerified} | Failed: ${analysis.failedCount}`,
  );

  if (analysis.failedCount === 0) {
    lines.push('');
    lines.push('No failed claims \u2014 all verified claims are supported.');
    lines.push('No critique generated.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Failed claims (${analysis.failedCount}):`);
  for (const claim of analysis.failedClaims) {
    lines.push(formatClaimLine(claim));
  }

  if (analysis.hasCritique) {
    lines.push('');
    lines.push('CRITIQUE:');
    lines.push(analysis.critique);
    lines.push('');
    lines.push('IMPROVED PROMPT:');
    lines.push(analysis.improvedPrompt);
  }

  lines.push('');
  lines.push(
    `Summary: ${analysis.failedCount} failed claim(s). ` +
    'Use the improved prompt above to elicit a more rigorous AI response.',
  );

  return lines.join('\n');
}
