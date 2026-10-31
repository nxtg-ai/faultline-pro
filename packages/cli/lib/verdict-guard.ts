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
import type { ClaimStatus, ProviderVote, VerificationResult } from '../types.js';

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

/** The verdicts that can be billed. `unverified` never is: it says the claim could not be settled. */
const BILLABLE_STATUSES: ReadonlySet<string> = new Set(['supported', 'contradicted', 'mixed']);

/**
 * A claim that can be billed: its sources were retrieved by the engine. All of
 * these must hold:
 * 1. the verdict is supported, contradicted or mixed;
 * 2. `sources` is an array with at least one entry;
 * 3. `provenance.retriever` is a non-empty string;
 * 4. it is not an API error (`apiError !== true`).
 * The engine alone sets `provenance.retriever`: the verify runner binds it from
 * its own table of retrievers by the provider id it resolved, and the consensus
 * engine names its own retriever. A provider's self-set provenance never
 * reaches this check through the engine, so a provider cannot make its own
 * citations billable. `unverified`, a verdict with zero sources, a verdict with
 * no engine retriever (the mock provider, for one), a provider error, a
 * malformed verdict (flagged `apiError`) and a UI state (`loading`, `skipped`)
 * are never billable. This is the one rule every billed count uses: the cost
 * log's `verified_count`, the spend ledger's `verifiedCount`, full-scan
 * served units and the API's monthly scan quota (a scan counts only when it
 * delivered at least one).
 */
export function isBillableVerdict(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as { status?: unknown; sources?: unknown; provenance?: unknown; apiError?: unknown };
  const retriever = v.provenance && typeof v.provenance === 'object'
    ? (v.provenance as { retriever?: unknown }).retriever
    : undefined;
  return typeof v.status === 'string' && BILLABLE_STATUSES.has(v.status)
    && Array.isArray(v.sources) && v.sources.length > 0
    && typeof retriever === 'string' && retriever.length > 0
    && v.apiError !== true;
}

/** How many entries of a scan's `verifications` (object or array) are billable verdicts. */
export function billableVerdictCount(verifications: unknown): number {
  if (!verifications || typeof verifications !== 'object') return 0;
  const list = Array.isArray(verifications) ? verifications : Object.values(verifications);
  return list.filter(isBillableVerdict).length;
}

/** The explanation every claim downgraded by abstainWithoutSource carries. */
export const NO_SOURCE_EXPLANATION =
  'The search returned no source this claim can be checked against, so it is not marked supported, contradicted or mixed.';

/**
 * True when `source` is one a reader can open: its `uri` is a string that
 * parses as an absolute URL (`new URL` succeeds) with protocol `http:` or
 * `https:`. An empty or blank uri, a relative path, `javascript:`, `ftp:` and
 * a missing uri all fail.
 */
export function isOpenableSource(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  const uri = (source as { uri?: unknown }).uri;
  if (typeof uri !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * A definite verdict (supported, contradicted or mixed) needs at least one
 * source the reader can open (isOpenableSource). When `result` has one of
 * those statuses, sources that cannot be opened are dropped from it; when none
 * remain, it is returned as `unverified` with `noSourceAbstain: true` and
 * NO_SOURCE_EXPLANATION; every other field (provenance, webSearchQueries,
 * searchEntryPoint) is kept. Anything else is returned unchanged. Where a
 * verdict is produced (the verify runner, the full-scan job store) it runs
 * after guardVerdict, never before: a source entry with no string uri is a
 * malformed verdict (a provider error), not an unopenable source. Every place
 * a single-provider verdict leaves the engine passes through this once: the
 * Gemini service, the verify runner (scan, stream, deep, full scan, batch,
 * report, MCP), the full-scan job store and the admin verify route. Every
 * API store that serves scan results applies it again on read
 * (abstainScanWithoutSource), so a result stored before this rule is served
 * under it. It runs before any billed count: isBillableVerdict counts
 * sources by length and sees the cleaned list, and a downgraded claim is
 * `unverified`, so it is never billed and no verified count includes it.
 *
 * A consensus result also lists each provider's vote (`providerVotes`), and
 * a reader sees every vote. The same rule applies to each vote: a supported,
 * contradicted or mixed vote keeps only its openable sources, and with none
 * left it reads `unverified` with `sources: []`, NO_SOURCE_EXPLANATION and
 * `noSourceAbstain: true` (its other fields kept). A vote with any other
 * status is unchanged. Votes are checked even when the fused verdict is
 * already not definite. This is a rewrite for the reader after fusion: the
 * voting, the fused status and the billed count are decided before it and
 * are not changed by it. Because abstainScanWithoutSource calls this for each
 * verification, stored results are guarded on read the same way, votes
 * included. The same object is returned when nothing changed.
 */
export function abstainWithoutSource<T extends VerificationResult>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const votes = abstainVotesWithoutSource(result.providerVotes);
  const withVotes: T = votes === result.providerVotes ? result : { ...result, providerVotes: votes };
  if (!BILLABLE_STATUSES.has(withVotes.status as string)) return withVotes;
  const sources: unknown[] = Array.isArray(withVotes.sources) ? withVotes.sources : [];
  const openable = sources.filter(isOpenableSource);
  if (openable.length > 0) {
    return openable.length === sources.length ? withVotes : { ...withVotes, sources: openable as T['sources'] };
  }
  return { ...withVotes, status: 'unverified', explanation: NO_SOURCE_EXPLANATION, sources: [], noSourceAbstain: true };
}

/** One vote under the rule above; the same object when nothing changed. */
function abstainVoteWithoutSource(vote: ProviderVote): ProviderVote {
  if (!vote || typeof vote !== 'object') return vote;
  if (!BILLABLE_STATUSES.has(vote.status as string)) return vote;
  const sources: unknown[] = Array.isArray(vote.sources) ? vote.sources : [];
  const openable = sources.filter(isOpenableSource);
  if (openable.length > 0) {
    return openable.length === sources.length ? vote : { ...vote, sources: openable as ProviderVote['sources'] };
  }
  return { ...vote, status: 'unverified', explanation: NO_SOURCE_EXPLANATION, sources: [], noSourceAbstain: true };
}

/** `votes` with every vote guarded; the same array when no vote changed, and anything not an array as given. */
function abstainVotesWithoutSource(votes: ProviderVote[] | undefined): ProviderVote[] | undefined {
  if (!Array.isArray(votes)) return votes;
  let changed = false;
  const next = votes.map((v) => {
    const g = abstainVoteWithoutSource(v);
    if (g !== v) changed = true;
    return g;
  });
  return changed ? next : votes;
}

/**
 * `result` with abstainWithoutSource applied to every entry of its
 * `verifications` (an object keyed by claim id, or an array). Returns a new
 * object when anything changed and never modifies `result`, so stored data is
 * left as written and guarded on read. Anything without verifications is
 * returned unchanged. Every API store that returns a scan result calls this
 * on read: the scan cache (scan and deep scan), the stored-scan store, the
 * scan queue and the full-scan job store.
 */
export function abstainScanWithoutSource<T>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const verifications = (result as { verifications?: unknown }).verifications;
  if (!verifications || typeof verifications !== 'object') return result;
  const guard = (v: unknown): unknown =>
    v && typeof v === 'object' ? abstainWithoutSource(v as VerificationResult) : v;
  let changed = false;
  let next: unknown;
  if (Array.isArray(verifications)) {
    next = verifications.map((v) => {
      const g = guard(v);
      if (g !== v) changed = true;
      return g;
    });
  } else {
    const out: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(verifications)) {
      const g = guard(v);
      if (g !== v) changed = true;
      out[id] = g;
    }
    next = out;
  }
  return changed ? { ...result, verifications: next } : result;
}
