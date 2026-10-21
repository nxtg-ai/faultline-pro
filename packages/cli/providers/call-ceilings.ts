/**
 * Output-token ceilings for every model call, in one table (GoPMO 1.18.11.7.18).
 *
 * Every provider request carries a ceiling looked up here by provider and call
 * purpose, and every Gemini request also carries a thinking budget. A reply cut
 * off at its ceiling is not a verdict: the call sites turn it into an unchecked,
 * unbilled result with reason 'output_truncated' (providers/output-truncation.ts).
 *
 * The numbers come from a measured sample run on 2026-10-21; each row's `basis`
 * says what was measured. docs/cost-ceilings.md carries the same table.
 * Prompts, model ids and temperatures are not set here and are not changed by it.
 */

/** What a model call is for. One shared helper can serve several purposes. */
export type CallPurpose = 'extract' | 'verify' | 'verifyGrounded' | 'retrieve' | 'critique';

/** A ceiling on one call's output tokens, with the measurement it rests on. */
export interface OutputCeiling {
  /** Maximum output tokens the request may produce (wire field named per provider). */
  readonly maxOutputTokens: number;
  /** One line: what this number was sized from. */
  readonly basis: string;
}

/** A Gemini ceiling: `maxOutputTokens` counts thinking tokens too, so it is the budget plus the visible allowance. */
export interface GeminiCeiling extends OutputCeiling {
  /** config.thinkingConfig.thinkingBudget */
  readonly thinkingBudget: number;
}

const GEMINI_GROUNDED_VERIFY: GeminiCeiling = {
  thinkingBudget: 4096,
  maxOutputTokens: 5120,
  basis: 'sample n=40 grounded verifies 2026-10-21: thoughts p50 701 max 3423, visible p50 104 max 250, all finishReason STOP',
};

/** Retrieval and the shared-source judge reuse the grounded-verify row: same reply shape, not separately measured. */
const GEMINI_REUSES_VERIFY = (use: string): GeminiCeiling => ({
  ...GEMINI_GROUNDED_VERIFY,
  basis: `${use} reuses the grounded-verify row; ${GEMINI_GROUNDED_VERIFY.basis}`,
});

const OPENAI_VERIFY_BASIS = 'sample n=10: max 85';
const CLAUDE_VERIFY_BASIS = 'sample n=10: max 184';
const CHAT_CRITIQUE_BASIS = 'not sampled for this provider; the Gemini critique sample (n=1 2026-10-21) was 107 visible tokens';
const PERPLEXITY_BASIS = 'not measured (no key on the build host); same values as the OpenAI chat rows for the same prompts';

/** The table. Keyed by the provider's wire, then by call purpose. */
export const CALL_CEILINGS = deepFreeze({
  /** services/geminiService.ts; fields config.maxOutputTokens and config.thinkingConfig.thinkingBudget. */
  gemini: {
    extract: {
      thinkingBudget: 2048,
      maxOutputTokens: 34816, // 2048 thinking + 32768 visible
      basis: 'sample n=8 2026-10-21: thoughts max 899, visible max 221 for 4 claims; visible sized for the 50,000-char scan input cap',
    },
    verify: GEMINI_GROUNDED_VERIFY,
    retrieve: GEMINI_REUSES_VERIFY('grounded retrieve'),
    verifyGrounded: GEMINI_REUSES_VERIFY('shared-source judge'),
    critique: {
      thinkingBudget: 4096,
      maxOutputTokens: 6144,
      basis: 'sample n=1 2026-10-21: thoughts 1864, visible 107',
    },
  },
  /** providers/openai_provider.ts, Chat Completions (gpt-4o-mini); field max_completion_tokens. */
  openai: {
    extract: { maxOutputTokens: 16384, basis: "sample n=1: 273 for 6 claims; 16384 is gpt-4o-mini's maximum" },
    verify: { maxOutputTokens: 1024, basis: OPENAI_VERIFY_BASIS },
    verifyGrounded: { maxOutputTokens: 1024, basis: OPENAI_VERIFY_BASIS },
    critique: { maxOutputTokens: 2048, basis: CHAT_CRITIQUE_BASIS },
  },
  /** providers/openai_web_search_retriever.ts, Responses API web_search; field max_output_tokens. */
  openaiResponses: {
    retrieve: { maxOutputTokens: 2048, basis: 'sample n=5: max 811' },
  },
  /** providers/claude_provider.ts, Messages API; field max_tokens (was 4096 for every call). */
  claude: {
    extract: { maxOutputTokens: 16384, basis: 'sample n=1: 369 for 6 claims; was 4096 for every call, which could cut a long extraction' },
    verify: { maxOutputTokens: 1024, basis: CLAUDE_VERIFY_BASIS },
    verifyGrounded: { maxOutputTokens: 1024, basis: CLAUDE_VERIFY_BASIS },
    critique: { maxOutputTokens: 2048, basis: CHAT_CRITIQUE_BASIS },
  },
  /** providers/perplexity_provider.ts, Chat Completions (sonar-pro); field max_tokens. */
  perplexity: {
    extract: { maxOutputTokens: 8192, basis: `${PERPLEXITY_BASIS}; extract held at 8192 because sonar-pro's documented output maximum is 8k (https://docs.perplexity.ai/getting-started/models/models/sonar-pro), and a request above a model's maximum may be refused rather than clamped` },
    verify: { maxOutputTokens: 1024, basis: PERPLEXITY_BASIS },
    critique: { maxOutputTokens: 2048, basis: PERPLEXITY_BASIS },
  },
} as const);

export type GeminiPurpose = keyof typeof CALL_CEILINGS.gemini;
export type OpenAIChatPurpose = keyof typeof CALL_CEILINGS.openai;
export type ClaudePurpose = keyof typeof CALL_CEILINGS.claude;
export type PerplexityPurpose = keyof typeof CALL_CEILINGS.perplexity;

/** The Gemini request config fields for one purpose, ready to spread into `config`. */
export function geminiCeilingConfig(purpose: GeminiPurpose): {
  maxOutputTokens: number;
  thinkingConfig: { thinkingBudget: number };
} {
  const row = CALL_CEILINGS.gemini[purpose];
  return { maxOutputTokens: row.maxOutputTokens, thinkingConfig: { thinkingBudget: row.thinkingBudget } };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
