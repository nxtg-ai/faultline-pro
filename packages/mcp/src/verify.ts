/**
 * verify_claims — the wrapper around the existing Faultline scan pipeline.
 *
 * No engine code lives here. This module calls `scan()` from @nxtg/faultline
 * exactly as the CLI does, then shapes the result for MCP consumers while
 * preserving the two distinctions the engine is explicit about: `apiError`
 * (never checked) vs a real verdict, and `degraded` (the scan as a whole is
 * not trustworthy).
 */

import type { scan, ScanResult } from '@nxtg/faultline/cli/scan.js';
import type { Claim } from '@nxtg/faultline/types.js';
import {
  resolveTransport,
  runScan,
  isGrounded,
  type Transport,
} from '@nxtg/faultline/cli/transport.js';
import { toClaimVerdict, toRiskScore, isRealVerdict, type ClaimVerdict } from './verdict.js';
import { writeAuditRecord } from './audit.js';

export { isGrounded, resolveTransport };

/**
 * Provider auto-detection.
 *
 * Mirrors `autoDetectProvider()` in packages/cli/cli/index.ts:64-70 — same
 * precedence, same 'mock' fallback — because the MCP surface must behave
 * identically to the CLI a user may already be running. It is duplicated
 * rather than imported because the CLI does not export it, and exporting it
 * would be an engine change.
 */
export function autoDetectProvider(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FAULTLINE_PROVIDER) return env.FAULTLINE_PROVIDER;
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.PERPLEXITY_API_KEY) return 'perplexity';
  return 'mock';
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

function buildSummary(o: Omit<VerifyClaimsOutput, 'summary'>): string {
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
  if (!o.grounded) {
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
}

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

  const audit = writeAuditRecord(text, result.provider ?? provider, result);

  // A risk band computed over zero real verdicts is not a risk reading. The
  // engine defaults such a scan to "low" because nothing was contradicted —
  // reporting that number would say "safe" on the basis of nothing checked.
  const realVerdictCount = allClaims.filter((c) => {
    const v = result.verifications?.[c.id];
    return v && v.apiError !== true && v.status !== 'skipped' && v.status !== 'loading';
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
    ...(audit.ref ? { audit_ref: audit.ref, audit_path: audit.path } : {}),
    ...(audit.skipped ? { audit_skipped: audit.skipped } : {}),
  };

  return { ...partial, summary: buildSummary(partial) };
}

/** Re-exported so the guard subcommand and tests share one definition. */
export { isRealVerdict };
