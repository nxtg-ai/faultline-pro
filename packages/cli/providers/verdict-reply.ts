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

/**
 * The judge's answer to "do the sources address this claim?" (GoPMO 1.18.11.7.19).
 * One sentence and one JSON key, the same text in the Google grounded prompt
 * and the parallel judge prompt. A claim about the scanned text itself ("This
 * report covers three models.") gets sources about other things, and without
 * this key the judge called it contradicted. Grammar cannot tell the scanned
 * text from an external work it names, so the judge, who has read the sources,
 * decides.
 */
export const SOURCES_ADDRESS_KEY = 'sourcesAddressClaim';

export const SOURCES_ADDRESS_RULE =
  `SOURCES RULE: Set "${SOURCES_ADDRESS_KEY}" to false when no source says anything about the subject of the claim (for example, the claim describes the text it comes from and the sources are about other things). Otherwise set it to true.`;

/** A verdict read from a reply. */
export interface ReplyVerdict {
  status: ClaimStatus;
  explanation: string;
  /**
   * The reply's `sourcesAddressClaim`, only when it is a JSON boolean. Absent
   * when the key is missing or holds anything else, which reads as today's
   * behaviour: the status stands.
   */
  sourcesAddressClaim?: boolean;
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
  const addressed = (parsed as Record<string, unknown>)[SOURCES_ADDRESS_KEY];
  return {
    status: status as ClaimStatus,
    explanation: typeof explanation === 'string' && explanation.length > 0 ? explanation : 'No structural analysis provided.',
    ...(typeof addressed === 'boolean' ? { sourcesAddressClaim: addressed } : {}),
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

/**
 * The unchecked result for a claim whose verify reply stopped at its output-token
 * ceiling (providers/call-ceilings.ts, GoPMO 1.18.11.7.18). Same unchecked shape as
 * an unreadable reply, reason 'output_truncated': a cut-off reply is never a verdict,
 * even when the part that arrived happens to parse. No `parseFallback`: that flag
 * counts unreadable replies for the accuracy run, and this reply was cut, not unreadable.
 */
export function truncatedVerdict(claimId: string): VerificationResult {
  return {
    claimId,
    status: 'unverified',
    explanation: "The provider's reply was cut off at its output limit, so this claim was not checked.",
    sources: [],
    apiError: true,
    apiErrorReason: 'output_truncated',
  };
}
