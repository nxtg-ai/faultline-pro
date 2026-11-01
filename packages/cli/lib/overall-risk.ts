import type { AnalysisState, VerificationResult } from '../types.js';

export type OverallRisk = AnalysisState['overallRisk'];

const RANK: Record<OverallRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function atLeast(band: OverallRisk, floor: OverallRisk): OverallRisk {
  return RANK[floor] > RANK[band] ? floor : band;
}

/**
 * The overall risk band of a scan, from its verdicts. Every scan path (quick,
 * full, stream, deep, consensus) uses this one function.
 *
 * Contradicted and mixed verdicts set the band first:
 *   more than 2 contradicted                  -> critical
 *   any contradicted, or more than 2 mixed    -> high
 *   any mixed                                 -> medium
 *   otherwise                                 -> low
 *
 * An unverified claim means its risk was not checked, so it is never evidence
 * of low risk. It can only raise the band, never lower it:
 *   unverified claims are at least half of the verdicts -> at least high
 *   at least one unverified claim                       -> at least medium
 *
 * A scan with no verdicts reads low, as before.
 */
export function calculateRisk(verifications: Record<string, VerificationResult>): OverallRisk {
  const values = Object.values(verifications);
  const total = values.length;
  const contradicted = values.filter((v) => v.status === 'contradicted').length;
  const mixed = values.filter((v) => v.status === 'mixed').length;
  const unverified = values.filter((v) => v.status === 'unverified').length;

  let band: OverallRisk = 'low';
  if (contradicted > 2) band = 'critical';
  else if (contradicted > 0 || mixed > 2) band = 'high';
  else if (mixed > 0) band = 'medium';

  if (total > 0 && unverified * 2 >= total) band = atLeast(band, 'high');
  if (unverified > 0) band = atLeast(band, 'medium');

  return band;
}
