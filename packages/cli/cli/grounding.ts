/**
 * Which search grounds the default (non-consensus) Gemini verify.
 *
 *   google    Gemini with the googleSearch tool: one call searches and judges
 *             (services/geminiService.ts verifyClaim). The default.
 *   parallel  retrieve, then judge: Parallel's Search API finds the sources
 *             (providers/parallel_search_retriever.ts), then Gemini judges the
 *             claim against them with no search tool (verifyClaimGrounded).
 *
 * The engine never reads the environment for this. A caller passes the mode as
 * an argument (ScanOptions.grounding), decided per request: the API from the
 * calling key, the local CLI and the local MCP from the user's own env through
 * groundingFromEnv. With no mode passed the engine runs google, as before.
 */
export type GroundingMode = 'google' | 'parallel';

/** The env var a local run and the hosted API read. Unset or any other value means google. */
export const GROUNDING_ENV = 'FAULTLINE_GROUNDING';

/** 'parallel' only for that exact value (case and surrounding space ignored); anything else is google. */
export function parseGroundingMode(value: unknown): GroundingMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'parallel' ? 'parallel' : 'google';
}

/** The mode FAULTLINE_GROUNDING asks for in `env`. Read once per call, never written. */
export function groundingFromEnv(env: NodeJS.ProcessEnv = process.env): GroundingMode {
  return parseGroundingMode(env[GROUNDING_ENV]);
}
