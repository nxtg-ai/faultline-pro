/**
 * Recognise a provider error that means the provider account has run out of
 * credits, as opposed to a rate limit.
 *
 * Both often arrive as HTTP 429, but they need opposite advice: a rate limit
 * clears on its own, while an empty account fails on every retry until someone
 * adds credits. OpenAI reports it as 429 with code `insufficient_quota` ("You
 * exceeded your current quota" / "You have no credits remaining"); Anthropic as
 * "Your credit balance is too low"; some providers as HTTP 402 Payment Required.
 *
 * A 402 is read from the HTTP status, never from the text: a rate-limit body
 * can mention a count of 402 and link to the billing page and still be a rate
 * limit.
 *
 * Gemini's per-minute quota error is RESOURCE_EXHAUSTED and its text also says
 * "You exceeded your current quota", yet it is a rate limit that a retry fixes,
 * so a RESOURCE_EXHAUSTED message is never read as out of credits.
 *
 * Every pattern is a plain literal or a literal alternation, so matching is
 * linear in the input (no nested quantifiers).
 */
const OUT_OF_CREDITS = /insufficient_quota|exceeded your current quota|no credits|credit balance is too low|billing_hard_limit|out_of_credits/;

/** True when an error message or response body says the account has no credits. */
export function isOutOfCreditsText(text: string): boolean {
  const raw = text.toLowerCase();
  if (raw.includes('resource_exhausted')) return false;
  return OUT_OF_CREDITS.test(raw);
}

/** Error bodies longer than this are cut before matching; the signal sits near the start. */
const MAX_BODY_CHARS = 8_192;

/** True when a failed HTTP response says the account has no credits: a 402, or a body with the quota texts. */
export function isOutOfCreditsResponse(status: number, body: string): boolean {
  return status === 402 || isOutOfCreditsText(body.slice(0, MAX_BODY_CHARS));
}

/**
 * True when a thrown provider error says the account has no credits: an SDK
 * error whose numeric HTTP `status` is 402, or a message with the quota texts.
 */
export function isOutOfCreditsError(err: unknown): boolean {
  const status = err !== null && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  if (status === 402) return true;
  return isOutOfCreditsText(err instanceof Error ? err.message : String(err));
}

/**
 * Suffix for a provider adapter's thrown error when its non-OK response says the
 * account is out of credits. The adapters throw only the status line, which
 * cannot tell an empty account from a rate limit, so they add this fixed tag.
 * It never carries the provider's own text.
 */
export function outOfCreditsTag(status: number, body: string): string {
  return isOutOfCreditsResponse(status, body) ? ' (out_of_credits)' : '';
}

/** Read a failed response's body for outOfCreditsTag; an unreadable body reads as empty. */
export async function readErrorBody(response: { text?: () => Promise<string> }): Promise<string> {
  try {
    return typeof response.text === 'function' ? await response.text() : '';
  } catch {
    return '';
  }
}
