/**
 * scan() for a local run (the CLI commands, a local MCP server): the grounding
 * mode comes from the user's own FAULTLINE_GROUNDING (cli/grounding.ts), and a
 * source policy from FAULTLINE_SOURCE_POLICY (cli/source-policy.ts).
 *
 * With both unset, the call is exactly scan() with the same arguments, so
 * local behaviour is unchanged. An explicit options.grounding or
 * options.sourcePolicy wins over the env. The hosted API never calls this:
 * it decides both per request (packages/api/src/lib/grounding.ts).
 */
import { scan } from './scan.js';
import { localGroundingAdditions } from './source-policy.js';

export function scanLocal(...args: Parameters<typeof scan>): ReturnType<typeof scan> {
  const [text, providerName, minConfidence, ruleNames, onProgress, onClaimVerified, pipelineConfig, options] = args;
  const extra = localGroundingAdditions(options);
  if (!extra) return scan(...args);
  return scan(text, providerName, minConfidence, ruleNames, onProgress, onClaimVerified, pipelineConfig, { ...options, ...extra });
}
