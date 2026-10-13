import type { ApiErrorReason, Claim } from '../types';

/**
 * Why a claim extraction did not produce claims.
 *
 * The provider-call reasons are the verify stage's ApiErrorReason; extraction
 * adds `invalid_output` for a model reply that is not a claims array (most
 * often JSON cut off mid-output on a long document).
 */
export type ExtractionErrorReason = ApiErrorReason | 'invalid_output';

/**
 * Classify a provider-call error. Patterns follow services/verify-error.ts so
 * the reason and the customer text agree on what a 429, a 503 or a timeout is;
 * a timeout is tested before the 5xx/unavailable class because "upstream timed
 * out (503)" is still a timeout to the caller.
 */
export function classifyApiError(err: unknown): ApiErrorReason {
  const name = err instanceof Error ? err.name : '';
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b|resource_exhausted|quota|rate[ _-]?limit|too many requests/.test(raw)) return 'rate_limited';
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|etimedout/.test(raw)) return 'timeout';
  if (/\b503\b|overloaded|unavailable/.test(raw)) return 'provider_unavailable';
  return 'provider_error';
}

/**
 * Customer-safe text per reason. Callers forward `message` verbatim (API 500
 * bodies, MCP tool errors, CLI output), so it must never carry the raw provider
 * payload; that stays on `cause` for ops logs.
 */
const SAFE_MESSAGES: Record<ExtractionErrorReason, string> = {
  rate_limited: 'Claim extraction failed: the extraction provider is rate-limited. Nothing was verified; retry shortly.',
  provider_unavailable: 'Claim extraction failed: the extraction provider is unavailable. Nothing was verified; retry shortly.',
  timeout: 'Claim extraction failed: the extraction provider timed out. Nothing was verified; retry shortly.',
  invalid_output: 'Claim extraction failed: the extraction provider returned an unreadable claim list. Nothing was verified.',
  provider_error: 'Claim extraction failed: the extraction provider returned an error. Nothing was verified.',
};

/**
 * Thrown by a provider's extractClaims when no claim list was obtained.
 *
 * A failed extraction is not "the text has no claims": a scan that went on
 * would fill one synthetic claim per sentence (guaranteeClaimPerSentence) and
 * price or verify those as if the model had found them. A valid empty array
 * from the model is not an error and is still returned as [].
 */
export class ExtractionError extends Error {
  readonly reason: ExtractionErrorReason;

  constructor(reason: ExtractionErrorReason, cause?: unknown) {
    super(SAFE_MESSAGES[reason], { cause });
    this.name = 'ExtractionError';
    this.reason = reason;
  }

  /** Wrap a provider-call failure, classifying it like the verify stage does. */
  static fromProviderError(err: unknown): ExtractionError {
    return err instanceof ExtractionError ? err : new ExtractionError(classifyApiError(err), err);
  }
}

/**
 * True for an ExtractionError, including one from a second copy of this module
 * (an API process can load the engine twice), so it checks shape, not identity.
 */
export function isExtractionError(err: unknown): err is ExtractionError {
  return err instanceof ExtractionError
    || (err instanceof Error && err.name === 'ExtractionError' && typeof (err as { reason?: unknown }).reason === 'string');
}

/**
 * Parse a model's claim-list reply. Throws ExtractionError('invalid_output')
 * when the reply is not JSON or holds no array; `[]` is a valid answer.
 *
 * @param raw     The model's JSON text.
 * @param unwrap  Read the array from a `{ "claims": [...] }` envelope when present.
 */
export function parseExtractedClaims(raw: string, unwrap = false): Claim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExtractionError('invalid_output', error);
  }
  const claims = unwrap && parsed && typeof parsed === 'object' && 'claims' in parsed
    ? (parsed as { claims: unknown }).claims
    : parsed;
  if (!Array.isArray(claims)) {
    throw new ExtractionError('invalid_output', new Error(`expected a claims array, got ${claims === null ? 'null' : typeof claims}`));
  }
  return claims.map((item, index) => validateClaim(item, index));
}

const CLAIM_TYPES: ReadonlySet<string> = new Set(['fact', 'opinion', 'interpretation']);

/**
 * One extracted claim, checked field by field. Any malformed item fails the whole
 * extraction (invalid_output): the model did not follow the format, so nothing it
 * returned can be trusted as the claim list, and a half-valid list would let the
 * per-sentence guarantee fill synthetic claims around it (codex E1). A numeric id
 * is the only coercion. The cause names the item index and field, never claim text.
 */
function validateClaim(item: unknown, index: number): Claim {
  const fail = (field: string): never => {
    throw new ExtractionError('invalid_output', new Error(`claim ${index}: invalid or missing ${field}`));
  };
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return fail('object');
  const { id, text, type, importance } = item as Record<string, unknown>;
  const claimId = typeof id === 'number' && Number.isFinite(id) ? String(id) : id;
  if (typeof claimId !== 'string' || claimId.trim() === '') return fail('id');
  if (typeof text !== 'string' || text.trim() === '') return fail('text');
  if (typeof type !== 'string' || !CLAIM_TYPES.has(type)) return fail('type');
  if (typeof importance !== 'number' || !Number.isInteger(importance) || importance < 1 || importance > 5) {
    return fail('importance');
  }
  return { ...(item as object), id: claimId, text, type: type as Claim['type'], importance } as Claim;
}
