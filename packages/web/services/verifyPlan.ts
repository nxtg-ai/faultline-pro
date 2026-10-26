import { DOCUMENT_SCOPE_EXPLANATION, isDocumentRelative } from '@nxtg/faultline/lib/claim-scope.js';
import type { AnalysisState, Claim, VerificationResult } from '../types';

/** How many claims one analysis sends to the verifier (rate limits and cost). */
export const WEB_VERIFY_CAP = 8;

export interface VerifyPlan {
  /** The claims marked with `scope: 'document'` where they are about the document itself. */
  claims: Claim[];
  /** Claims to send to the verifier, most important first. */
  claimsToVerify: Claim[];
  /** A starting verification for every claim: 'loading' if queued, 'skipped' otherwise. */
  initialVerifications: Record<string, VerificationResult>;
}

/**
 * Decide which claims get web-checked. A fact about the document's own scope
 * or structure ("This report covers three models") is never sent to a provider:
 * it is marked `scope: 'document'` and shown as skipped, so it has no verdict and
 * adds nothing to risk or to the contradiction count. Uses the same check as the
 * CLI and API.
 */
export function planVerification(extracted: Claim[]): VerifyPlan {
  const claims = extracted.map((c) =>
    c.type === 'fact' && isDocumentRelative(c.text) ? { ...c, scope: 'document' as const } : c,
  );
  const claimsToVerify = claims
    .filter((c) => c.type === 'fact' && c.importance >= 3 && c.scope !== 'document')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, WEB_VERIFY_CAP);
  const queued = new Set(claimsToVerify.map((c) => c.id));

  const initialVerifications: Record<string, VerificationResult> = {};
  for (const c of claims) {
    if (queued.has(c.id)) {
      initialVerifications[c.id] = { claimId: c.id, status: 'loading', explanation: 'Queued for stress-testing...', sources: [] };
      continue;
    }
    let reason = 'Low load-bearing impact.';
    if (c.type === 'opinion') reason = 'Subjective opinion (not testable).';
    if (c.type === 'interpretation') reason = 'Interpretation (context dependent).';
    if (c.scope === 'document') reason = DOCUMENT_SCOPE_EXPLANATION;
    initialVerifications[c.id] = { claimId: c.id, status: 'skipped', explanation: reason, sources: [] };
  }
  return { claims, claimsToVerify, initialVerifications };
}

/** Overall risk from the verdicts. Skipped claims, including document-scope ones, add nothing. */
export function calculateRisk(verifications: Record<string, VerificationResult>): AnalysisState['overallRisk'] {
  const values = Object.values(verifications);
  const contradicted = values.filter((v) => v.status === 'contradicted').length;
  const mixed = values.filter((v) => v.status === 'mixed').length;

  if (contradicted > 2) return 'critical';
  if (contradicted > 0 || mixed > 2) return 'high';
  if (mixed > 0) return 'medium';
  return 'low';
}
