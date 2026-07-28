/**
 * `faultline guard` — pipe agent output in, get a verdict out.
 *
 *   claude -p "..." | npx @nxtg/faultline guard --fail-on refuted
 *
 * Mount 2 of the Agent-Outputs Guard. Same pipeline as `scan`, shaped for the
 * place agent output actually flows through: a pipe, a CI step, a Stop hook.
 *
 * GATE POLICY — the two halves matter and pull in opposite directions:
 *
 *   Without --fail-on, guard is ADVISORY and always exits 0. A checker that
 *   blocks by default gets uninstalled the first time it is wrong, and then it
 *   protects nothing.
 *
 *   With --fail-on, the gate FAILS CLOSED on a degraded scan. This mirrors
 *   `degradedGateFailure()` in index.ts: if transient provider errors left
 *   claims unchecked, exiting 0 would pass a possibly-fabricated claim off as
 *   clean — the exact failure this tool exists to prevent. Opting in to a gate
 *   means opting in to "unchecked is not the same as fine".
 */

import type { ScanResult } from './scan.js';
import { toClaimVerdict, isRealVerdict, type Verdict, type ClaimVerdict } from './verdict.js';

/** What a `--fail-on` value gates against. */
export type FailOn = 'refuted' | 'unsupported';

export const FAIL_ON_VALUES: readonly FailOn[] = ['refuted', 'unsupported'];

/**
 * Which verdicts each gate level trips on.
 *
 * `unsupported` is the STRICTER setting: it trips on REFUTED *and* on claims
 * that were checked without finding support (including MIXED, where part of
 * the evidence contradicts). It is a superset of `refuted`, not an alternative
 * to it — a caller asking to fail on unsupported certainly wants to fail on
 * outright contradiction too.
 */
const GATE_VERDICTS: Record<FailOn, readonly Verdict[]> = {
  refuted: ['REFUTED'],
  unsupported: ['REFUTED', 'UNSUPPORTED', 'MIXED'],
};

export function isFailOn(value: string): value is FailOn {
  return (FAIL_ON_VALUES as readonly string[]).includes(value);
}

export interface GuardClaim extends ClaimVerdict {
  importance: number;
}

export interface GuardReport {
  provider: string;
  overallRisk: string;
  claims: GuardClaim[];
  claimsTotal: number;
  /** Claims whose verification did not run. */
  uncheckedCount: number;
  /** True when any claim went unchecked — the scan is not a clean bill of health. */
  degraded: boolean;
  /** Verdicts that tripped the configured gate. Empty when no gate is set. */
  tripped: GuardClaim[];
  /** Why the gate failed, when it did. */
  failureReason?: 'degraded' | 'verdict';
  exitCode: number;
}

/** Build the guard's view of a scan, and decide the exit code. */
export function evaluateGuard(result: ScanResult, failOn?: FailOn): GuardReport {
  const claims: GuardClaim[] = (result.claims ?? []).map((c) => ({
    ...toClaimVerdict(c.text, result.verifications?.[c.id]),
    importance: c.importance ?? 0,
  }));

  const uncheckedCount = claims.filter((c) => c.verdict === 'UNCHECKED').length;
  // Trust the engine's own flag first; fall back to our count so a missing
  // verification record still registers as degradation.
  const degraded = result.degraded === true || claims.some((c) => c.unchecked_reason === 'provider_error');

  const gate = failOn ? GATE_VERDICTS[failOn] : [];
  const tripped = claims.filter((c) => gate.includes(c.verdict));

  let exitCode = 0;
  let failureReason: GuardReport['failureReason'];

  if (failOn) {
    if (degraded) {
      exitCode = 1;
      failureReason = 'degraded';
    } else if (tripped.length > 0) {
      exitCode = 1;
      failureReason = 'verdict';
    }
  }

  return {
    provider: result.provider,
    overallRisk: result.overallRisk,
    claims,
    claimsTotal: claims.length,
    uncheckedCount,
    degraded,
    tripped,
    failureReason,
    exitCode,
  };
}

const MARK: Record<Verdict, string> = {
  VERIFIED: '[OK]',
  REFUTED: '[!!]',
  UNSUPPORTED: '[??]',
  MIXED: '[~~]',
  UNCHECKED: '[--]',
};

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/** Render the human-readable verdict table. */
export function formatGuardReport(report: GuardReport, failOn?: FailOn): string {
  const lines: string[] = [];
  lines.push('=== FAULTLINE GUARD ===');
  lines.push(`Provider:     ${report.provider}`);
  lines.push(`Overall Risk: ${report.overallRisk.toUpperCase()}`);
  lines.push(`Claims:       ${report.claimsTotal}`);
  lines.push('');

  if (report.claims.length === 0) {
    lines.push('  No verifiable factual claims were found in this text.');
    lines.push('');
  } else {
    for (const c of report.claims) {
      lines.push(`  ${MARK[c.verdict]} ${c.verdict.padEnd(11)} ${truncate(c.claim, 88)}`);
      if (c.note) lines.push(`       ${truncate(c.note, 96)}`);
      if (c.evidence_url) lines.push(`       source: ${c.evidence_url}`);
      if (c.verdict === 'UNCHECKED' && c.unchecked_reason === 'provider_error') {
        lines.push('       NOT CHECKED — the provider errored. This is not a verdict.');
      }
    }
    lines.push('');
  }

  if (report.degraded) {
    lines.push(
      `! DEGRADED — ${report.uncheckedCount} claim(s) could not be checked. ` +
        'Unchecked is not the same as clean; this text was not fully verified.',
    );
  }

  if (!failOn) {
    lines.push('Advisory mode — exit 0 regardless of verdicts. Use --fail-on to gate.');
  } else if (report.exitCode === 0) {
    lines.push(`✓ Gate PASSED (--fail-on ${failOn}).`);
  } else if (report.failureReason === 'degraded') {
    lines.push(
      `✗ Gate FAILED (--fail-on ${failOn}) — verification was degraded, so the result ` +
        'cannot be trusted. The gate fails closed rather than passing unchecked claims.',
    );
  } else {
    const names = report.tripped.map((t) => t.verdict);
    const counts = [...new Set(names)].map((v) => `${names.filter((n) => n === v).length} ${v}`);
    lines.push(`✗ Gate FAILED (--fail-on ${failOn}) — ${counts.join(', ')}.`);
  }

  return lines.join('\n');
}

/** Machine-readable form, for CI steps and hooks that parse rather than read. */
export function formatGuardJson(report: GuardReport, failOn?: FailOn): string {
  return JSON.stringify(
    {
      provider: report.provider,
      overall_risk: report.overallRisk,
      claims_total: report.claimsTotal,
      degraded: report.degraded,
      unchecked_count: report.uncheckedCount,
      fail_on: failOn ?? null,
      gate_passed: report.exitCode === 0,
      failure_reason: report.failureReason ?? null,
      claims: report.claims.map((c) => ({
        claim: c.claim,
        verdict: c.verdict,
        real_verdict: isRealVerdict(c.verdict),
        evidence_url: c.evidence_url ?? null,
        evidence_urls: c.evidence_urls,
        note: c.note,
        unchecked_reason: c.unchecked_reason ?? null,
      })),
    },
    null,
    2,
  );
}

/**
 * Read piped stdin.
 *
 * Resolves to '' when stdin is a TTY — that means nothing was piped, and the
 * caller should say so rather than hang waiting for input that will not come.
 */
export function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}
