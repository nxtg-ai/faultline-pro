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
import { parseSourcePolicy, type SourcePolicy } from '@nxtg/faultline/cli/source-policy.js';
import { getKeyStore } from '../store/keys.js';

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
 * The source policy stored on `keyId`, or null. The server key (`admin`), a
 * missing key and a key with no policy are null, so a scan options object
 * that spreads `sourcePolicyOption` gains no field. A stored value that can
 * no longer be read is the invalid sentinel: the retriever then searches
 * nothing rather than the open web.
 */
export function sourcePolicyForKey(keyId: string | undefined): SourcePolicy | null {
  if (!keyId || keyId === 'admin' || keyId === 'unknown' || keyId === 'measurement' || keyId === 'public') return null;
  const stored = getKeyStore().validateById(keyId)?.sourcePolicy;
  if (stored === undefined) return null;
  return parseSourcePolicy(stored);
}

/** `{ sourcePolicy }` when this key has one, `{}` when it does not. */
export function sourcePolicyOption(keyId?: string): Pick<ScanOptions, 'sourcePolicy'> {
  const sourcePolicy = sourcePolicyForKey(keyId);
  return sourcePolicy ? { sourcePolicy } : {};
}

/**
 * `scan(text, provider)` for a route that passes no other option, in the
 * request's grounding mode. In the google mode with no key policy the call is
 * exactly `scan(text, provider)`, as before. A key policy is passed either
 * way: Parallel applies it, and any other mode refuses the scan instead of
 * searching the open web (docs/grounding-providers.md).
 */
export function scanInRequestMode(
  text: string,
  provider?: Parameters<typeof scan>[1],
  mode: GroundingMode = requestGrounding(),
  keyId?: string,
): ReturnType<typeof scan> {
  const policy = sourcePolicyOption(keyId);
  if (mode !== 'parallel') {
    if (!policy.sourcePolicy) return scan(text, provider);
    return scan(text, provider, undefined, undefined, undefined, undefined, undefined, policy);
  }
  return scan(text, provider, undefined, undefined, undefined, undefined, undefined, { grounding: 'parallel', ...policy });
}
