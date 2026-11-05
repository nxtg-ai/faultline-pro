/**
 * verify_claims — the wrapper around the existing Faultline scan pipeline.
 *
 * No engine code lives here. This module calls `scan()` exactly as the CLI does, then shapes the result for MCP consumers while
 * preserving the two distinctions the engine is explicit about: `apiError`
 * (never checked) vs a real verdict, and `degraded` (the scan as a whole is
 * not trustworthy).
 */

import type { scan, ScanResult } from '../scan.js';
import type { Claim } from '../../types.js';
import {
  resolveTransport,
  runScan,
  isGrounded,
  type Transport,
} from '../transport.js';
import { toClaimVerdict, toRiskScore, isRealVerdict, type ClaimVerdict } from '../verdict.js';
import { isNotCheckable } from '../../lib/verdict-guard.js';
import { writeAuditRecord, type AuditWriteResult } from './audit.js';

export { isGrounded, resolveTransport };

/**
 * Provider auto-detection.
 *
 * Same precedence as `autoDetectProvider()` in cli/index.ts, with an explicit
 * FAULTLINE_PROVIDER taking priority (kept from packages/mcp so behaviour does
 * not change). With no key at all it falls back to 'mock', and the server says
 * on stderr at startup that mock verifies nothing.
 */
export function autoDetectProvider(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FAULTLINE_PROVIDER) return env.FAULTLINE_PROVIDER;
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.PERPLEXITY_API_KEY) return 'perplexity';
  return 'mock';
}

/**
 * What a local call gets when neither FAULTLINE_API_KEY nor a provider key is
 * set and the caller names no provider. The fallback would be 'mock', which
 * checks nothing, so the call is refused rather than answered with made-up
 * verdicts. The server turns it into an isError tool result.
 */
export const NO_KEY_MESSAGE =
  'no key: nothing was verified. Set FAULTLINE_API_KEY to a Faultline API key ' +
  '(https://faultline.nxtg.ai/account/api-key) to verify on the hosted API, or a provider key ' +
  'such as GEMINI_API_KEY to verify locally. For a SYNTHETIC demo that checks nothing, name ' +
  'provider "mock" or set FAULTLINE_PROVIDER=mock.';

/** True when no key is set and no provider is configured, so auto-detection would pick 'mock'. */
export function hasNoKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.FAULTLINE_PROVIDER && autoDetectProvider(env) === 'mock';
}

export interface VerifyClaimsInput {
  text: string;
  max_claims?: number;
  provider?: string;
}

export interface VerifyClaimsOutput {
  /**
   * 0-100, higher is riskier. NULL when not a single claim received a real
   * verdict — a scan that checked nothing has no risk reading, and emitting the
   * engine's default "low" there would tell a caller the text is safe on the
   * strength of zero evidence.
   */
  risk_score: number | null;
  overall_risk: string;
  provider: string;
  /**
   * True when the provider retrieved live sources during verification. When
   * false, verdicts reflect the model's own knowledge with no receipts behind
   * them — usable as a signal, not as evidence.
   */
  grounded: boolean;
  /** Whether the scan ran on the hosted API or the local engine. */
  mode: 'hosted' | 'local';
  /** Claims that got a real verdict but carry no supporting source URL. */
  unsourced_count: number;
  claims: ClaimVerdict[];
  /** Total claims extracted, before any max_claims truncation. */
  claims_total: number;
  /** True when `claims` was truncated by max_claims. */
  truncated: boolean;
  /**
   * True when one or more claims could not be verified due to provider errors.
   * A degraded result is NOT a clean bill of health — unchecked claims may be
   * false. Callers must surface this, not just the risk score.
   */
  degraded: boolean;
  /** Count of claims whose verification failed to run. */
  unchecked_count: number;
  /**
   * How many claims were billed and why each unbilled one was not. Present when
   * the scan ran on the hosted API, which reports it on every result; absent on
   * a local scan, which bills nothing.
   */
  billing?: unknown;
  /** Pointer to the persisted audit record. Absent when none was written. */
  audit_ref?: string;
  audit_path?: string;
  /** Present when no audit record exists, explaining why. */
  audit_skipped?: string;
  /** Human-readable one-line summary. */
  summary: string;
}

/** Order claims most-important-first so max_claims truncation keeps the ones that matter. */
function byImportanceDesc(a: Claim, b: Claim): number {
  return (b.importance ?? 0) - (a.importance ?? 0);
}

function buildSummary(o: Omit<VerifyClaimsOutput, 'summary'>, synthetic = false): string {
  const counts = o.claims.reduce<Record<string, number>>((acc, c) => {
    acc[c.verdict] = (acc[c.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  const risk = o.risk_score === null ? 'risk UNKNOWN' : `risk ${o.overall_risk.toUpperCase()}`;
  let out = `${o.claims_total} claim${o.claims_total === 1 ? '' : 's'} — ${parts.join(', ') || 'none'} · ${risk}`;

  if (o.degraded) {
    out +=
      ` · DEGRADED: ${o.unchecked_count} claim(s) could not be checked (provider error)` +
      ' — this result is not a clean bill of health.';
  }
  if (synthetic) {
    out =
      'SYNTHETIC: the "mock" provider checked nothing, so these verdicts are made up for testing. ' +
      out;
  } else if (!o.grounded) {
    out +=
      ` · NOT GROUNDED: provider "${o.provider}" judged from model knowledge without retrieving` +
      ' sources, so these verdicts carry no evidence. Set GEMINI_API_KEY for source-backed verification.';
  } else if (o.unsourced_count > 0) {
    out += ` · ${o.unsourced_count} verdict(s) carry no supporting source URL.`;
  }
  return out;
}

/**
 * Run the pipeline and shape the response.
 *
 * `scanFn` is injectable so tests exercise the mapping without burning provider
 * quota; production always uses the real engine `scan`.
 */
export interface VerifyDeps {
  /** Local engine override. Production uses the real `scan`. */
  scanFn?: typeof scan;
  /** Hosted-path fetch override. Production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Transport override. Production resolves from the environment. */
  transport?: Transport;
  /**
   * Write the local audit record (default true). The hosted endpoint sets this
   * to false: a server must not write each caller's text to its own disk, and
   * the API keeps its own scan history for every POST /scan.
   */
  audit?: boolean;
}

/** Why no audit record exists when the caller switched audit writing off. */
export const AUDIT_OFF_REASON =
  'audit records are not written by this server; the hosted API keeps its own scan history';

export async function verifyClaims(
  input: VerifyClaimsInput,
  deps: VerifyDeps = {},
): Promise<VerifyClaimsOutput> {
  // `deps` used to be a bare scanFn. Passing a function here now would be
  // silently ignored and the call would run a REAL scan against a real
  // provider — billing tokens and, in tests, quietly asserting against the
  // wrong data. Fail loudly instead of doing something expensive and wrong.
  if (typeof deps === 'function') {
    throw new TypeError(
      'verifyClaims(input, deps) takes a deps object, not a function. ' +
        'Pass { scanFn } instead of a bare scan function.',
    );
  }

  const text = (input.text ?? '').trim();
  if (!text) {
    throw new Error('verify_claims requires non-empty `text`.');
  }

  const transport = deps.transport ?? resolveTransport();

  // Hosted scans run on server-side provider keys, so no local key is needed
  // and the provider stays unset unless the caller names one — letting the
  // server apply its own (grounded) default. Locally we must resolve one.
  const provider =
    transport.mode === 'hosted' ? input.provider : input.provider || autoDetectProvider();

  if (transport.mode === 'local' && !input.provider && hasNoKey()) {
    throw new Error(NO_KEY_MESSAGE);
  }

  const result: ScanResult = await runScan(text, provider, transport, {
    scanFn: deps.scanFn,
    fetchImpl: deps.fetchImpl,
  });

  const allClaims = [...(result.claims ?? [])].sort(byImportanceDesc);
  const limit =
    typeof input.max_claims === 'number' && input.max_claims > 0
      ? Math.floor(input.max_claims)
      : allClaims.length;

  const selected = allClaims.slice(0, limit);
  const claims = selected.map((c) => toClaimVerdict(c.text, result.verifications?.[c.id]));

  // Count unchecked across EVERY extracted claim, not just the returned page —
  // truncating the view must not shrink the degradation signal.
  const uncheckedAll = allClaims.filter((c) => {
    const v = result.verifications?.[c.id];
    return !v || v.apiError === true;
  }).length;

  const audit: AuditWriteResult =
    deps.audit === false
      ? { skipped: AUDIT_OFF_REASON }
      : writeAuditRecord(text, result.provider ?? provider, result);
  const billing = (result as { billing?: unknown }).billing;

  // A risk band computed over zero real verdicts is not a risk reading, so no
  // score is given for it. (The engine's band for such a scan is never "low":
  // an unverified claim raises it to at least medium, half or more to high.)
  // A not-checkable claim is no verdict either: the engine leaves it out of the
  // band, so a scan of only such claims reads "low" with nothing behind it
  // (GoPMO 1.18.11.7.19).
  const realVerdictCount = allClaims.filter((c) => {
    const v = result.verifications?.[c.id];
    return v && v.apiError !== true && v.status !== 'skipped' && v.status !== 'loading' && !isNotCheckable(v);
  }).length;

  const unsourcedCount = claims.filter(
    (c) => isRealVerdict(c.verdict) && c.evidence_urls.length === 0,
  ).length;

  const partial: Omit<VerifyClaimsOutput, 'summary'> = {
    risk_score: realVerdictCount === 0 ? null : toRiskScore(result.overallRisk),
    overall_risk: result.overallRisk,
    provider: result.provider ?? provider ?? 'default',
    grounded: isGrounded(provider),
    mode: transport.mode,
    unsourced_count: unsourcedCount,
    claims,
    claims_total: allClaims.length,
    truncated: selected.length < allClaims.length,
    degraded: result.degraded === true || uncheckedAll > 0,
    unchecked_count: uncheckedAll,
    ...(billing !== undefined ? { billing } : {}),
    ...(audit.ref ? { audit_ref: audit.ref, audit_path: audit.path } : {}),
    ...(audit.skipped ? { audit_skipped: audit.skipped } : {}),
  };

  return { ...partial, summary: buildSummary(partial, provider === 'mock') };
}

/** Re-exported so the guard subcommand and tests share one definition. */
export { isRealVerdict };
