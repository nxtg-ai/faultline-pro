// Positioning canon: questionnaire-unblock (NOT the EU AI Act deadline). Locked by Asif 2026-05-31.
export const NUDGE_COPY = 'Closing a deal? Your buyer will ask how this AI is governed. Generate an audit-ready report to answer their questionnaire:';
export const NUDGE_URL = 'https://faultline.nxtg.ai/pricing?src=cli-nudge';

const HIGH_RISK_LEVELS = new Set(['critical', 'high']);

/**
 * Print a one-line point-of-pain conversion nudge to stderr.
 * Fires only on critical or high overall risk.
 * Suppressed by: suppress=true (--no-nudge flag), FAULTLINE_NO_NUDGE=1 env.
 */
export function printConversionNudge(overallRisk: string, suppress: boolean): void {
  if (suppress) return;
  if (process.env.FAULTLINE_NO_NUDGE === '1') return;
  if (!HIGH_RISK_LEVELS.has(overallRisk)) return;
  process.stderr.write(`→ ${NUDGE_COPY} ${NUDGE_URL}\n`);
}
