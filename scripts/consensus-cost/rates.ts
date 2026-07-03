/**
 * rates.ts — G2 rate module.
 *
 * SOURCE OF TRUTH = LIVE PUBLISHED PRICING on the run date. The operator MUST
 * fill `LIVE_RATES` with values re-pinned from each provider's pricing page on
 * the day the paid matrix runs (see the TODO block). Do NOT ship a measured
 * $/scan sourced from the mirror below — that is the stale-constant estimate
 * trap Wolf's G2 exists to prevent.
 *
 * `MANAGED_RATES_MIRROR` is a LABELED CROSS-CHECK only. The engine's
 * `MANAGED_PROVIDER_RATES` (packages/api/src/store/costs.ts:40-50) is NOT
 * exported, so it cannot be imported — these values are mirrored verbatim with a
 * citation. Its purpose is to quantify how far the deployed telemetry estimate
 * diverges from live-measured cost, NOT to price the scan.
 */

export interface Rate {
  /** USD per 1,000,000 input/prompt tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output/completion tokens. */
  outputPerM: number;
  /** USD per grounding / web_search call. */
  groundingPerCall: number;
}

/**
 * The engine default model per provider family AT THE CONSENSUS CLI PATH
 * (packages/cli — the path the matrix actually exercises). NOTE these diverge
 * from what costs.ts assumes; the divergence is a G2 finding (see below).
 */
export const ENGINE_DEFAULT_MODELS = {
  extraction: 'gemini-2.5-flash',            // geminiService.ts:5 DEFAULT_GEMINI_MODEL
  'grounded-verify:openai': 'gpt-4o-mini',   // openai_provider.ts:12 DEFAULT_MODEL
  'grounded-verify:claude': 'claude-opus-4-8', // claude_provider.ts:20 DEFAULT_MODEL  ← NOT haiku
  'grounded-verify:gemini': 'gemini-2.5-flash',
  web_search: 'gpt-4o',                      // openai_web_search_retriever.ts:19 DEFAULT_MODEL
} as const;

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ G2 — OPERATOR ACTION REQUIRED before the paid matrix run.                │
 * │ Re-pin every value below from the provider's LIVE pricing page on the    │
 * │ run date, then set `LIVE_RATES_PINNED_ON` to that date. The harness      │
 * │ REFUSES to compute a measured $/scan while any value is `null`.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
export const LIVE_RATES_PINNED_ON: string | null = null; // e.g. '2026-07-03'

export const LIVE_RATES: Record<string, Rate | null> = {
  // key = the engine default model above. Fill each on the run date.
  'gemini-2.5-flash': null,   // TODO(operator): gemini flash input/output per-M on run date
  'gpt-4o-mini':      null,   // TODO(operator): gpt-4o-mini input/output per-M on run date
  'claude-opus-4-8':  null,   // TODO(operator): Opus-tier input/output per-M on run date (expensive — verify!)
  'gpt-4o':           null,   // TODO(operator): gpt-4o + web_search tool call price on run date
};

/**
 * MIRROR of packages/api/src/store/costs.ts:40-50 MANAGED_PROVIDER_RATES
 * (verbatim, 2026-07-03). NOT exported by the product → mirrored, not imported.
 * Cross-check ONLY. Keyed by provider family, assumes the models in costs.ts:33-38
 * (gemini-flash, claude-HAIKU, gpt-4o-mini) — note claude assumption differs from
 * the CLI default (opus-4-8), which is exactly the divergence to report.
 */
export const MANAGED_RATES_MIRROR: Record<string, Rate> = {
  gemini:     { inputPerM: 0.15, outputPerM: 0.60, groundingPerCall: 0.035 },
  claude:     { inputPerM: 0.80, outputPerM: 4.00, groundingPerCall: 0 },
  openai:     { inputPerM: 0.15, outputPerM: 0.60, groundingPerCall: 0 },
  perplexity: { inputPerM: 1.00, outputPerM: 1.00, groundingPerCall: 0 },
  mock:       { inputPerM: 0,    outputPerM: 0,    groundingPerCall: 0 },
};

/** True only when every live rate the matrix needs has been pinned. */
export function liveRatesReady(models: string[]): { ready: boolean; missing: string[] } {
  const missing = models.filter((m) => !LIVE_RATES[m]);
  return { ready: LIVE_RATES_PINNED_ON !== null && missing.length === 0, missing };
}
