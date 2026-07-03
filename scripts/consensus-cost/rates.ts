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
export const LIVE_RATES_PINNED_ON: string | null = '2026-07-03';

export const LIVE_RATES: Record<string, Rate | null> = {
  // key = the engine default model above. Pinned 2026-07-03 from official pricing pages.
  // gemini-2.5-flash: text input $0.30/M, output $2.50/M; grounding $35 / 1,000 grounded
  //   prompts after the free tier ⇒ $0.035/call.
  //   Source: https://ai.google.dev/gemini-api/docs/pricing (Gemini 2.5 Flash, Standard/Paid tier)
  'gemini-2.5-flash': { inputPerM: 0.30, outputPerM: 2.50, groundingPerCall: 0.035 },
  // gpt-4o-mini: $0.15/M input, $0.60/M output. PROVENANCE: gpt-4o / gpt-4o-mini are NOT
  //   listed verbatim on the current official OpenAI pricing page (confirmed by direct fetch
  //   2026-07-03 — GPT-4.1/5.x families replaced the 4o listing). These are the grandfathered
  //   legacy GPT-4o rates still billed for existing 4o access, confirmed via web search of
  //   pricing aggregators (pricepertoken.com, valueaddvc.com). Re-verify if a paid run depends
  //   on exactness. NOT taken from a live official page.
  'gpt-4o-mini':      { inputPerM: 0.15, outputPerM: 0.60, groundingPerCall: 0 },
  // claude-opus-4-8: $5.00/M input, $25.00/M output. Confirmed verbatim on the LIVE Anthropic
  //   models page (fetched 2026-07-03): "claude-opus-4-8 ... $5 / input MTok  $25 / output MTok".
  //   Source: https://platform.claude.com/docs/en/about-claude/models/overview
  //   (operator may still independently re-confirm before spend, as requested).
  'claude-opus-4-8':  { inputPerM: 5.00, outputPerM: 25.00, groundingPerCall: 0 },
  // gpt-4o: $2.50/M input, $10.00/M output (legacy grandfathered — same NOT-on-page provenance
  //   as gpt-4o-mini above). web_search built-in tool = $10.00 / 1,000 calls ⇒ $0.010/call, per
  //   the CURRENT OpenAI pricing page ("$10.00 / 1k calls", fetched 2026-07-03). CAVEATS: (1) that
  //   $10/1k line is on the current GPT-5.x page — not confirmed to apply to legacy gpt-4o's tool
  //   (historically $25-35/1k); (2) the tool also bills search-content tokens at model rate on top,
  //   which this single per-call field does NOT model. Source (tool fee):
  //   https://developers.openai.com/api/docs/pricing
  'gpt-4o':           { inputPerM: 2.50, outputPerM: 10.00, groundingPerCall: 0.010 },
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
