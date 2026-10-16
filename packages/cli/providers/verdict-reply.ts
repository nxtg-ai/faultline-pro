/**
 * Reading a provider's verify reply.
 *
 * A reply we cannot read is OUR failure, not a verdict (emma-soul ruling
 * al:5b18840b0116047a, item c). Before 2026-10-16 Gemini turned non-JSON text
 * into status 'mixed', and every provider turned JSON without a status into
 * 'unverified': both showed the user a verdict no provider gave, and both were
 * billed. Now such a claim is unchecked: `apiError: true` with reason
 * 'provider_unparseable', so it is degraded, never cached, refunded on a full
 * scan, and free on every meter that skips `apiError`.
 */
import type { ClaimStatus, VerificationResult } from '../types';

/** The statuses the verify prompts allow a provider to return. */
const REPLY_STATUSES: ReadonlySet<string> = new Set(['supported', 'contradicted', 'mixed', 'unverified']);

/** A verdict read from a reply. */
export interface ReplyVerdict {
  status: ClaimStatus;
  explanation: string;
}

/**
 * The verdict in `text`, or null when there is none: the text is not JSON, is
 * not an object, or carries no status from the prompt's list.
 */
export function readVerdictReply(text: string | undefined | null): ReplyVerdict | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { status, explanation } = parsed as { status?: unknown; explanation?: unknown };
  if (typeof status !== 'string' || !REPLY_STATUSES.has(status)) return null;
  return {
    status: status as ClaimStatus,
    explanation: typeof explanation === 'string' && explanation.length > 0 ? explanation : 'No structural analysis provided.',
  };
}

/** The unchecked result for a claim whose provider reply could not be read. */
export function unparseableVerdict(claimId: string): VerificationResult {
  return {
    claimId,
    status: 'unverified',
    explanation: "The provider's reply could not be read, so this claim was not checked.",
    sources: [],
    apiError: true,
    apiErrorReason: 'provider_unparseable',
    parseFallback: true,
  };
}
