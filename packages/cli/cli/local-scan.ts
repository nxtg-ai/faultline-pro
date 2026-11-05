/**
 * scan() for a local run (the CLI commands, a local MCP server): the grounding
 * mode comes from the user's own FAULTLINE_GROUNDING (cli/grounding.ts).
 *
 * With it unset, or set to anything but parallel, the call is exactly scan()
 * with the same arguments, so local behaviour is unchanged. With parallel it
 * adds `grounding: 'parallel'` to the options; an explicit options.grounding
 * wins. The hosted API never calls this: it decides the mode per request
 * (packages/api/src/lib/grounding.ts).
 */
import { scan } from './scan.js';
import { groundingFromEnv } from './grounding.js';

export function scanLocal(...args: Parameters<typeof scan>): ReturnType<typeof scan> {
  const [text, providerName, minConfidence, ruleNames, onProgress, onClaimVerified, pipelineConfig, options] = args;
  if (options?.grounding !== undefined || groundingFromEnv() !== 'parallel') return scan(...args);
  return scan(text, providerName, minConfidence, ruleNames, onProgress, onClaimVerified, pipelineConfig, { ...options, grounding: 'parallel' });
}
