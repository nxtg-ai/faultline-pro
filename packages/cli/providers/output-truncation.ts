/**
 * A reply cut off at its output ceiling (providers/call-ceilings.ts) is not a
 * verdict, not a claim list and not a retrieval (GoPMO 1.18.11.7.18). Each wire
 * reports the cut-off its own way; these readers name it once per wire, and the
 * shared call helpers throw OutputTruncatedError so every caller handles it in
 * the catch it already has.
 */
import type { CallPurpose } from './call-ceilings';

/** Thrown by a provider call helper when the reply stopped at its output ceiling. */
export class OutputTruncatedError extends Error {
  readonly provider: string;
  readonly purpose: CallPurpose;

  constructor(provider: string, purpose: CallPurpose) {
    super(`${provider} ${purpose} reply was cut off at its output-token ceiling`);
    this.name = 'OutputTruncatedError';
    this.provider = provider;
    this.purpose = purpose;
  }
}

/** True for an OutputTruncatedError, including one from a second copy of this module (shape, not identity). */
export function isOutputTruncatedError(err: unknown): err is OutputTruncatedError {
  return err instanceof OutputTruncatedError || (err instanceof Error && err.name === 'OutputTruncatedError');
}

/** Gemini generateContent: `candidates[0].finishReason === 'MAX_TOKENS'`. */
export function isGeminiTruncated(response: unknown): boolean {
  const candidates = (response as { candidates?: Array<{ finishReason?: unknown }> } | null)?.candidates;
  return Array.isArray(candidates) && candidates[0]?.finishReason === 'MAX_TOKENS';
}

/** OpenAI and Perplexity Chat Completions: `choices[0].finish_reason === 'length'`. */
export function isChatCompletionTruncated(data: unknown): boolean {
  const choices = (data as { choices?: Array<{ finish_reason?: unknown }> } | null)?.choices;
  return Array.isArray(choices) && choices[0]?.finish_reason === 'length';
}

/** OpenAI Responses: `status === 'incomplete'` with `incomplete_details.reason === 'max_output_tokens'`. */
export function isResponsesTruncated(payload: unknown): boolean {
  const p = payload as { status?: unknown; incomplete_details?: { reason?: unknown } | null } | null;
  return p?.status === 'incomplete' && p.incomplete_details?.reason === 'max_output_tokens';
}

/** Anthropic Messages: `stop_reason === 'max_tokens'`. */
export function isClaudeTruncated(data: unknown): boolean {
  return (data as { stop_reason?: unknown } | null)?.stop_reason === 'max_tokens';
}
