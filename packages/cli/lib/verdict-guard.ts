/**
 * Runtime check of a verdict's shape and status.
 *
 * `ClaimStatus` is a TypeScript type, and a type validates nothing at runtime:
 * an independent examiner pushed the status `ROYALLY_CERTIFIED` from a provider
 * through scan(), the API stores, the HTTP response and a share (EP4 recert,
 * ASIF bca5a7f7ec, 02-codex-evidence.md row 1). This module is the allowlist
 * every write path checks against (emma-soul al:ea03474ab4809de5, P2, GoPMO
 * 1.18.11.3).
 */
import type { ClaimStatus, VerificationResult } from '../types.js';

/** The only statuses a completed verdict may carry. `loading` and `skipped` are UI states, never verdicts. */
export const VERDICT_STATUSES = ['supported', 'contradicted', 'mixed', 'unverified'] as const;

export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

const ALLOWED: ReadonlySet<string> = new Set(VERDICT_STATUSES);

export const isVerdictStatus = (value: unknown): value is VerdictStatus =>
  typeof value === 'string' && ALLOWED.has(value);

/**
 * Why `value` is not a valid verdict, or null when it is. The reason names the
 * field only: it never echoes the offending value, which can be arbitrary
 * provider output.
 */
export function verdictProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const v = value as Record<string, unknown>;
  if (!isVerdictStatus(v.status)) return 'status is not an allowed verdict';
  if (typeof v.explanation !== 'string') return 'explanation is not a string';
  if (!Array.isArray(v.sources)) return 'sources is not an array';
  for (const s of v.sources) {
    if (!s || typeof s !== 'object' || typeof (s as { uri?: unknown }).uri !== 'string') {
      return 'a source has no string uri';
    }
  }
  return null;
}

/**
 * The statuses a STORED result may carry: the verdicts plus `skipped`, which
 * reports render for a claim that was not sent to verification. `loading` is
 * never stored.
 */
export const STORED_STATUSES = [...VERDICT_STATUSES, 'skipped'] as const;

const STORED: ReadonlySet<string> = new Set(STORED_STATUSES);

/**
 * Why `value` may not be stored, or null when it may. Stores check the state
 * vocabulary and the source shape; the full verdict shape is checked where a
 * verdict is produced (guardVerdict), because stores legitimately receive
 * partial verdicts (the claim index takes status and sources only).
 */
export function storedVerdictProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const v = value as Record<string, unknown>;
  if (typeof v.status !== 'string' || !STORED.has(v.status)) return 'status is not an allowed verdict';
  if (v.sources !== undefined) {
    if (!Array.isArray(v.sources)) return 'sources is not an array';
    for (const s of v.sources) {
      if (!s || typeof s !== 'object' || typeof (s as { uri?: unknown }).uri !== 'string') {
        return 'a source has no string uri';
      }
    }
  }
  return null;
}

/**
 * The verdict as given when it is valid; otherwise an `unverified` result
 * flagged `apiError` with reason `provider_error`, so the claim reads as
 * "never checked" (and a full scan refunds it) rather than carrying a value
 * no reader can trust.
 */
export function guardVerdict(value: unknown, claimId: string): VerificationResult {
  if (verdictProblem(value) === null) return value as VerificationResult;
  return {
    claimId,
    status: 'unverified' satisfies ClaimStatus,
    explanation: 'The verifier returned a malformed verdict, so this claim was not checked.',
    sources: [],
    apiError: true,
    apiErrorReason: 'provider_error',
  };
}

/**
 * Throw unless every verification in `result` is a valid verdict. Stores call
 * this before writing, so a value that bypassed the engine (a mocked engine, a
 * caller-built object) is refused at the store too.
 */
export function assertValidVerifications(result: unknown): void {
  const verifications = (result as { verifications?: unknown } | null)?.verifications;
  if (verifications === undefined) return;
  if (!verifications || typeof verifications !== 'object' || Array.isArray(verifications)) {
    throw new InvalidVerdictError('verifications is not an object');
  }
  for (const [claimId, v] of Object.entries(verifications)) {
    const problem = storedVerdictProblem(v);
    if (problem !== null) throw new InvalidVerdictError(`claim ${claimId}: ${problem}`);
  }
}

/** The only values a scan's `overallRisk` may carry. */
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Throw unless `result` is safe to store: every verification valid and, when
 * present, `overallRisk` one of RISK_LEVELS.
 */
export function assertValidScanResult(result: unknown): void {
  assertValidVerifications(result);
  const risk = (result as { overallRisk?: unknown } | null)?.overallRisk;
  if (risk !== undefined && !(RISK_LEVELS as readonly unknown[]).includes(risk)) {
    throw new InvalidVerdictError('overallRisk is not an allowed level');
  }
}

/**
 * A refused write. `statusCode` and `code` make the API's error handler answer
 * 502 `invalid_verdict` without internal detail.
 */
export class InvalidVerdictError extends Error {
  readonly code = 'invalid_verdict';
  readonly statusCode = 502;
  constructor(detail: string) {
    super(`invalid verdict: ${detail}`);
    this.name = 'InvalidVerdictError';
  }
}

export const isInvalidVerdictError = (err: unknown): err is InvalidVerdictError =>
  err instanceof Error && (err as { code?: unknown }).code === 'invalid_verdict';
