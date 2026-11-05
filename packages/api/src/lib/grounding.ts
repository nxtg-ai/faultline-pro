/**
 * The grounding mode of a hosted request (docs/grounding-providers.md).
 *
 * FAULTLINE_GROUNDING=parallel moves every hosted path to retrieve-then-judge:
 * Parallel's Search API finds the sources, then Gemini judges the claim
 * against them with no googleSearch tool. That covers every key, the server
 * key faultline-web uses included, every scan route, full-scan jobs and both
 * MCP surfaces (the hosted /mcp route and the stdio server on the hosted
 * transport both reach POST /scan). Unset, or any other value, keeps Google
 * grounding everywhere.
 *
 * The env var is read once per request and the mode is passed to the engine as
 * an argument (ScanOptions.grounding, VerifyFullScanOptions.grounding). Nothing
 * here or in the engine writes process.env, so a flip of the secret takes
 * effect on the next request and two requests in flight never share a mode by
 * accident of timing.
 */
import { scan, type ScanOptions } from '@nxtg/faultline/cli/scan.js';
import { groundingFromEnv, type GroundingMode } from '@nxtg/faultline/cli/grounding.js';

export type { GroundingMode };

/** The mode for one hosted request, read now from `env`. */
export function requestGrounding(env: NodeJS.ProcessEnv = process.env): GroundingMode {
  return groundingFromEnv(env);
}

/**
 * The grounding field to spread into a scan's options: `{ grounding: 'parallel' }`
 * in the parallel mode, `{}` otherwise (the engine's own default is google, so
 * the google path passes exactly what it passed before this mode existed).
 */
export function groundingOption(mode: GroundingMode = requestGrounding()): Pick<ScanOptions, 'grounding'> {
  return mode === 'parallel' ? { grounding: 'parallel' } : {};
}

/**
 * `scan(text, provider)` for a route that passes no other option, in the
 * request's grounding mode. In the google mode the call is exactly
 * `scan(text, provider)`, as before.
 */
export function scanInRequestMode(
  text: string,
  provider?: Parameters<typeof scan>[1],
  mode: GroundingMode = requestGrounding(),
): ReturnType<typeof scan> {
  if (mode !== 'parallel') return scan(text, provider);
  return scan(text, provider, undefined, undefined, undefined, undefined, undefined, { grounding: 'parallel' });
}
