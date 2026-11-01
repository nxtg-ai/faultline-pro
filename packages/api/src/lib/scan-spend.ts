import { captureUsage, type UsageLeg } from '@nxtg/faultline/lib/usage-sink.js';
import { billableVerdictCount } from '@nxtg/faultline/lib/verdict-guard.js';
import { resolveStageProviders, type PipelineConfig } from '@nxtg/faultline/cli/verify-runner.js';
import { getCostStore, emitScanCostEvent, appendScanCostLog, resolveTier, buildManagedCostEvent, type ManagedScanCostEvent } from '../store/costs.js';
import { recordProviderSpend } from '../store/provider-spend.js';
import { classifyKeyId } from '../plugins/auth.js';

/**
 * Every engine call the API makes spends Faultline's own provider keys, so every
 * one of them must land in the provider-spend ledger, or the fleet spend cap
 * cannot see it. This module is the one place a scan's spend is recorded.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Run `fn` inside a usage scope and keep the legs even when it throws (a failed call can still have spent). */
export async function captureOutcome<T>(fn: () => Promise<T>): Promise<{ outcome: Outcome<T>; legs: UsageLeg[] }> {
  const { result, legs } = await captureUsage(async (): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error };
    }
  });
  return { outcome: result, legs };
}

export interface ScanSpendContext {
  /** The scanned text. Used only to size the fallback estimate; never logged. */
  text: string;
  /** The provider asked for, or the engine's default when none was. Stages without an override run on it. */
  provider?: string;
  /**
   * The per-stage overrides the scan ran with. The row is labelled and its fallback
   * estimate priced by the providers each stage actually used, never by `provider`
   * alone (a caller can say provider 'mock' and run every stage on Perplexity).
   */
  pipelineConfig?: PipelineConfig;
  /** The key that asked. Sets the tier label (same source as POST /scan), the cost-store owner and the spend row's key class. */
  keyId: string;
  /** The tier label, when the route takes it from somewhere other than the key (the stream routes read the forwarded plan). */
  tier?: ManagedScanCostEvent['tier'];
  /** When the work started, if earlier than this call (for example before a failover loop). */
  startTime?: number;
}

interface ScanLike {
  claims?: unknown;
  verifications?: unknown;
}

/**
 * Run one engine call and record what it spent: the managed cost store, the
 * scan-cost telemetry and log, and the provider-spend ledger, exactly as
 * POST /scan records a scan.
 *
 * A call that throws after reaching a provider is recorded too, with no claims
 * delivered, and the error is rethrown unchanged. A call that throws before any
 * provider reported usage (a missing provider key, say) is not recorded: with no
 * usage the cost would be a text-length estimate of money never spent.
 */
export async function scanWithSpend<T extends ScanLike>(ctx: ScanSpendContext, run: () => Promise<T>): Promise<T> {
  const startTime = ctx.startTime ?? Date.now();
  const { outcome, legs } = await captureOutcome(run);

  if (outcome.ok === false) {
    if (legs.length > 0) {
      ledgerScanSpend(legs, ctx, startTime, { groundingCalls: 0, extracted: 0, verified: 0 });
    }
    throw outcome.error;
  }

  const result = outcome.value;
  const verifications = typeof result.verifications === 'object' && result.verifications !== null
    ? result.verifications as Record<string, unknown> : {};
  ledgerScanSpend(legs, ctx, startTime, {
    groundingCalls: Object.keys(verifications).length,
    extracted: Array.isArray(result.claims) ? result.claims.length : 0,
    verified: billableVerdictCount(result.verifications),
  });
  return result;
}

function ledgerScanSpend(
  legs: UsageLeg[],
  ctx: ScanSpendContext,
  startTime: number,
  counts: { groundingCalls: number; extracted: number; verified: number },
): void {
  const stages = resolveStageProviders(ctx.provider || undefined, ctx.pipelineConfig);
  const verification = stages.consensusVoters ?? [stages.verification];
  const costEvent = buildManagedCostEvent(legs, {
    text: ctx.text,
    provider: [...new Set([stages.extraction, ...verification])].join('+'),
    stageProviders: { extraction: stages.extraction, verification },
    claimCount: counts.groundingCalls,
    tier: ctx.tier ?? resolveTier(ctx.keyId),
    latencyMs: Date.now() - startTime,
    claims: { extracted: counts.extracted, verified: counts.verified },
  });
  getCostStore().recordManaged(costEvent, ctx.keyId);
  emitScanCostEvent(costEvent);
  appendScanCostLog(costEvent);
  recordProviderSpend(costEvent, classifyKeyId(ctx.keyId));
}
