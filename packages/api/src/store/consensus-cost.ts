/**
 * consensus-cost.ts — measured, model-keyed cost composition for the v0.9.0
 * multi-model consensus fan-out.
 *
 * BLG-CLX9-20260703-005 — fixes the 3 defects in the legacy single-provider
 * telemetry (see costs.ts `computeScanCost` / `MANAGED_PROVIDER_RATES`):
 *
 *   1. text-length token ESTIMATE           → real provider-reported usage
 *      (per-leg `inputTokens`/`outputTokens`; the ALS usage sink feeds these
 *       from the adapters — see the Retriever/provider plumbing).
 *   2. one `effectiveProvider` per scan      → SUM across the 1 + K·(1+N)
 *      fan-out (extraction + K claims × (1 retrieval + N grounded voters)).
 *   3. claude leg priced at HAIKU            → priced at the REAL model the
 *      engine calls (claude-opus-4-8 = $5/$25, i.e. 6.25× the haiku output
 *      rate the old table assumed).
 *
 * SINGLE SOURCE OF RATES. This model-keyed table is the production sibling of
 * the measurement harness `scripts/consensus-cost/rates.ts` `LIVE_RATES`
 * (pinned 2026-07-03 from official pricing pages). The replay test
 * (`consensus-cost-replay.test.ts`) asserts this table agrees with that pinned
 * source for every shared model, so the two cannot silently re-diverge — the
 * exact "third parallel table" trap that produced defect 3.
 */

/** USD pricing for one model. Per-1M-token in/out; per-call for the web_search tool. */
export interface Rate {
  inputPerM: number;
  outputPerM: number;
  groundingPerCall: number;
}

/**
 * Model-keyed rates. Keys are the REAL model IDs the v0.9.0 consensus engine
 * calls (NOT provider families — that conflation is what let defect 3 hide).
 * Values pinned 2026-07-03 (see rates.ts provenance citations, mirrored here):
 *   gemini-2.5-flash  $0.30/$2.50  + $0.035/grounded-prompt
 *   gpt-4o-mini       $0.15/$0.60  (legacy grandfathered 4o-mini)
 *   claude-opus-4-8   $5.00/$25.00 (LIVE Anthropic models page)
 *   gpt-4o            $2.50/$10.00 + $0.010/web_search call (legacy 4o)
 */
export const CONSENSUS_MODEL_RATES: Record<string, Rate> = {
  'gemini-2.5-flash': { inputPerM: 0.30, outputPerM: 2.50, groundingPerCall: 0.035 },
  'gpt-4o-mini':      { inputPerM: 0.15, outputPerM: 0.60, groundingPerCall: 0 },
  'claude-opus-4-8':  { inputPerM: 5.00, outputPerM: 25.00, groundingPerCall: 0 },
  'gpt-4o':           { inputPerM: 2.50, outputPerM: 10.00, groundingPerCall: 0.010 },
};

/**
 * Fallback model per call type, for legs whose real model could not be captured
 * off the wire (e.g. gemini carries the model in the URL path, not the body, so
 * a measured leg can arrive with model '?'). Mirrors the engine defaults in
 * rates.ts `ENGINE_DEFAULT_MODELS`. Resolving via call type is honest recovery
 * of a KNOWN engine default — never a silent guess that drops the leg's cost.
 */
export const CALLTYPE_DEFAULT_MODEL: Record<string, string> = {
  'extraction':             'gemini-2.5-flash',
  'grounded-verify:openai': 'gpt-4o-mini',
  'grounded-verify:claude': 'claude-opus-4-8',
  'grounded-verify:gemini': 'gemini-2.5-flash',
  'web_search':             'gpt-4o',
};

/** One LLM/retrieval call in a scan's fan-out, with real provider-reported usage. */
export interface UsageLeg {
  /** Real model ID from the response, when known. */
  model?: string;
  /** Call type (extraction · grounded-verify:<provider> · web_search). */
  callType?: string;
  /** Provider family (openai · gemini · anthropic) — diagnostic only. */
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  /** True for the web_search / grounded-retrieval tool call (bills per call). */
  isGrounding: boolean;
}

export interface ModelCostBreakdown {
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ScanCostComposition {
  /** Total measured USD for the scan = sum over every fan-out leg. */
  costUsd: number;
  /** Number of priced legs (the 1 + K·(1+N) fan-out size). */
  callCount: number;
  /** Legs whose model resolved to no known rate (priced 0, surfaced not hidden). */
  unratedCalls: number;
  /** Per-real-model cost/usage breakdown. */
  byModel: Record<string, ModelCostBreakdown>;
}

/**
 * Resolve a leg's real model: the captured model if it has a rate, else the
 * known engine default for its call type. Returns null only when neither
 * resolves (genuinely unknown — surfaced as `unratedCalls`, never zeroed away).
 */
export function resolveLegModel(leg: UsageLeg): string | null {
  if (leg.model && CONSENSUS_MODEL_RATES[leg.model]) return leg.model;
  if (leg.callType) {
    const byType = CALLTYPE_DEFAULT_MODEL[leg.callType];
    if (byType && CONSENSUS_MODEL_RATES[byType]) return byType;
  }
  if (leg.model && CALLTYPE_DEFAULT_MODEL[leg.model]) return CALLTYPE_DEFAULT_MODEL[leg.model];
  return null;
}

/** Price one leg at its real model's rate. Unknown model → 0 (caller counts it). */
export function priceLeg(leg: UsageLeg): number {
  const model = resolveLegModel(leg);
  if (!model) return 0;
  const rate = CONSENSUS_MODEL_RATES[model];
  return (
    (leg.inputTokens / 1_000_000) * rate.inputPerM +
    (leg.outputTokens / 1_000_000) * rate.outputPerM +
    (leg.isGrounding ? rate.groundingPerCall : 0)
  );
}

/**
 * Compose the measured cost of ONE scan from its fan-out legs.
 * Defect-2 fix: this SUMS every leg (extraction + retrievals + all N voters),
 * where the legacy path priced a single `effectiveProvider`.
 * Defect-3 fix: each leg prices at its real model via `CONSENSUS_MODEL_RATES`.
 */
export function composeConsensusCost(legs: UsageLeg[]): ScanCostComposition {
  const byModel: Record<string, ModelCostBreakdown> = {};
  let costUsd = 0;
  let unratedCalls = 0;

  for (const leg of legs) {
    const model = resolveLegModel(leg);
    const legCost = priceLeg(leg);
    costUsd += legCost;
    if (!model) {
      unratedCalls += 1;
      continue;
    }
    const b = byModel[model] ?? { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    b.costUsd += legCost;
    b.calls += 1;
    b.inputTokens += leg.inputTokens;
    b.outputTokens += leg.outputTokens;
    byModel[model] = b;
  }

  return { costUsd, callCount: legs.length, unratedCalls, byModel };
}
