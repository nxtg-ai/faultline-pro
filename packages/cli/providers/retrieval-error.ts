import type { ApiErrorReason } from '../types';
import { classifyApiError } from './extraction-error';
import { isOutputTruncatedError } from './output-truncation';

/** The reasons a source search can fail for. A search has no verdict to be unreadable. */
export type RetrievalErrorReason = Exclude<ApiErrorReason, 'provider_unparseable'>;

/**
 * Customer-safe text per reason. It goes into a claim's explanation as is, so
 * it must never carry the raw provider payload; that stays on `cause`.
 */
const SAFE_MESSAGES: Record<RetrievalErrorReason, string> = {
  rate_limited: 'The source search is rate-limited right now, so this claim was not checked. Re-run the scan shortly.',
  provider_out_of_credits: 'The source search provider account is out of credits, so this claim was not checked. Re-running will not help until the account has credits again.',
  provider_unavailable: 'The source search is unavailable right now, so this claim was not checked. Re-run the scan shortly.',
  timeout: 'The source search timed out, so this claim was not checked. Re-run the scan shortly.',
  output_truncated: 'The source search reply was cut off at its output limit, so this claim was not checked.',
  provider_error: 'The source search failed, so this claim was not checked.',
};

/**
 * Thrown by a Retriever when the search itself failed.
 *
 * A failed search is not "searched and found nothing": a Retriever resolves []
 * only when the search ran and returned no source. The consensus engine reads
 * this error as "not checked" and casts no votes.
 */
export class RetrievalError extends Error {
  readonly reason: RetrievalErrorReason;

  constructor(reason: RetrievalErrorReason, cause?: unknown) {
    super(SAFE_MESSAGES[reason], { cause });
    this.name = 'RetrievalError';
    this.reason = reason;
  }

  /** Wrap any search failure, classifying it like the verify stage does. */
  static fromError(err: unknown): RetrievalError {
    if (isRetrievalError(err)) return err;
    if (isOutputTruncatedError(err)) return new RetrievalError('output_truncated', err);
    return new RetrievalError(classifyApiError(err), err);
  }
}

/**
 * True for a RetrievalError, including one from a second copy of this module
 * (an API process can load the engine twice), so it checks shape, not identity.
 */
export function isRetrievalError(err: unknown): err is RetrievalError {
  return err instanceof RetrievalError
    || (err instanceof Error && err.name === 'RetrievalError' && typeof (err as { reason?: unknown }).reason === 'string');
}
