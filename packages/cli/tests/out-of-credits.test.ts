/**
 * A provider account with no credits is reported as out of credits, never as a
 * rate limit.
 *
 * OpenAI answers an empty account with HTTP 429 and code `insufficient_quota`,
 * so a classifier that maps every 429 to rate_limited told customers to "retry
 * shortly" when no retry could succeed. These tables pin both sides: each
 * out-of-credits pattern, and the rate-limit messages that must stay rate_limited.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyApiError, ExtractionError } from '../providers/extraction-error.js';
import { isOutOfCreditsError, isOutOfCreditsText, outOfCreditsTag } from '../providers/out-of-credits.js';
import { OUT_OF_CREDITS_VERIFY_MESSAGE, sanitizeVerifyError } from '../services/verify-error.js';
import { createOpenAIProvider } from '../providers/openai_provider.js';
import { createClaudeProvider } from '../providers/claude_provider.js';
import { createPerplexityProvider } from '../providers/perplexity_provider.js';
import type { Claim } from '../types.js';

/** Error messages as an adapter or SDK raises them for an empty account. */
const OUT_OF_CREDITS_CASES: Array<[string, string]> = [
  ['OpenAI code', 'OpenAI API error: 429 Too Many Requests insufficient_quota'],
  ['OpenAI quota text', '429 You exceeded your current quota, please check your plan and billing details.'],
  ['OpenAI no-credits text', '429 You have no credits remaining.'],
  ['Anthropic credit balance', '400 Your credit balance is too low to access the Anthropic API.'],
  ['OpenAI hard billing limit', '400 billing_hard_limit_reached'],
  ['adapter tag', 'OpenAI API error: 429 Too Many Requests (out_of_credits)'],
];

/**
 * A genuine rate limit whose body mentions a count of 402 and links to the
 * billing page. A 402 is read from the HTTP status only, so this stays a rate limit.
 */
const RATE_LIMIT_MENTIONING_402 =
  '429 Too Many Requests: Rate limit reached: 402 requests in the last minute. See https://platform.example.com/account/billing for your limits.';

/** Rate limits a retry does fix: these must stay rate_limited. */
const RATE_LIMITED_CASES: Array<[string, string]> = [
  ['a rate limit that mentions 402 and the billing page', RATE_LIMIT_MENTIONING_402],
  ['plain 429', '429 Too Many Requests'],
  ['adapter 429 without a credits body', 'OpenAI API error: 429 Too Many Requests'],
  ['RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED'],
  ['too many requests', 'too many requests, slow down'],
  ['rate limit text', 'Rate limit exceeded for requests per minute'],
  [
    'Gemini per-minute quota (says "exceeded your current quota" but is RESOURCE_EXHAUSTED)',
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
  ],
];

describe('classifyApiError: out of credits before the 429 class', () => {
  for (const [name, message] of OUT_OF_CREDITS_CASES) {
    it(`${name} -> provider_out_of_credits`, () => {
      expect(classifyApiError(new Error(message))).toBe('provider_out_of_credits');
    });
  }
  for (const [name, message] of RATE_LIMITED_CASES) {
    it(`${name} -> rate_limited`, () => {
      expect(classifyApiError(new Error(message))).toBe('rate_limited');
    });
  }

  it('402 without a billing word is not out of credits', () => {
    expect(isOutOfCreditsText('402 Payment Required')).toBe(false);
  });

  it('a 402 in the text alone is not out of credits, even beside the word billing', () => {
    expect(isOutOfCreditsText('402 Payment Required: billing account inactive')).toBe(false);
    expect(classifyApiError(new Error('402 Payment Required: billing account inactive'))).toBe('provider_error');
  });

  it('an SDK error whose HTTP status is 402 is out of credits, whatever its text', () => {
    const err = Object.assign(new Error('Payment Required'), { status: 402 });
    expect(isOutOfCreditsError(err)).toBe(true);
    expect(classifyApiError(err)).toBe('provider_out_of_credits');
    expect(sanitizeVerifyError(err)).toBe(OUT_OF_CREDITS_VERIFY_MESSAGE);
  });

  it('an SDK error with status 429 and a rate-limit text stays rate_limited', () => {
    const err = Object.assign(new Error(RATE_LIMIT_MENTIONING_402), { status: 429 });
    expect(isOutOfCreditsError(err)).toBe(false);
    expect(classifyApiError(err)).toBe('rate_limited');
  });

  it('a thrown string is classified too', () => {
    expect(classifyApiError('insufficient_quota')).toBe('provider_out_of_credits');
  });
});

describe('sanitizeVerifyError: out of credits before the rate-limit text', () => {
  for (const [name, message] of OUT_OF_CREDITS_CASES) {
    it(`${name} -> out-of-credits text`, () => {
      expect(sanitizeVerifyError(new Error(message))).toBe(OUT_OF_CREDITS_VERIFY_MESSAGE);
    });
  }
  for (const [name, message] of RATE_LIMITED_CASES) {
    it(`${name} -> rate-limited text`, () => {
      expect(sanitizeVerifyError(new Error(message))).toContain('rate-limited');
    });
  }

  it('the out-of-credits text says nothing was checked and a retry will not help', () => {
    expect(OUT_OF_CREDITS_VERIFY_MESSAGE).toContain('out of credits');
    expect(OUT_OF_CREDITS_VERIFY_MESSAGE).toContain('not checked');
    expect(OUT_OF_CREDITS_VERIFY_MESSAGE).toContain('will not help');
    expect(OUT_OF_CREDITS_VERIFY_MESSAGE).not.toMatch(/shortly|rate-limited/i);
  });
});

describe('ExtractionError for an empty provider account', () => {
  it('carries the reason and customer text that never asks for a retry', () => {
    const err = ExtractionError.fromProviderError(new Error('429 insufficient_quota'));
    expect(err.reason).toBe('provider_out_of_credits');
    expect(err.message).toContain('out of credits');
    expect(err.message).toContain('Nothing was verified');
    expect(err.message).toContain('will not help');
    expect(err.message).not.toMatch(/retry shortly|rate-limited/i);
    expect(err.message).not.toContain('insufficient_quota');
  });
});

describe('outOfCreditsTag: the adapters keep only a fixed tag from the error body', () => {
  it('tags an OpenAI insufficient_quota body', () => {
    const body = '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}}';
    expect(outOfCreditsTag(429, body)).toBe(' (out_of_credits)');
  });

  it('tags a 402 billing body by its status', () => {
    expect(outOfCreditsTag(402, '{"error":"billing account suspended"}')).toBe(' (out_of_credits)');
  });

  it('tags a 402 by its status even when the body says nothing about billing', () => {
    expect(outOfCreditsTag(402, '')).toBe(' (out_of_credits)');
  });

  it('leaves a 429 rate-limit body that mentions 402 and the billing page untagged', () => {
    const body = '{"error":{"message":"Rate limit reached: 402 requests in the last minute. See https://platform.example.com/account/billing","code":"rate_limit_exceeded"}}';
    expect(outOfCreditsTag(429, body)).toBe('');
  });

  it('leaves a plain rate-limit body untagged', () => {
    expect(outOfCreditsTag(429, '{"error":{"message":"Rate limit reached for requests","code":"rate_limit_exceeded"}}')).toBe('');
    expect(outOfCreditsTag(429, '')).toBe('');
  });
});

describe('provider adapters classify a real empty-account response', () => {
  const claim: Claim = { id: 'c1', text: 'Water boils at 100 C at sea level.', type: 'fact', importance: 3 };
  afterEach(() => vi.unstubAllGlobals());

  function failWith(status: number, statusText: string, body: string): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(body, { status, statusText }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('OpenAI 429 insufficient_quota at extraction -> provider_out_of_credits, no provider text', async () => {
    failWith(429, 'Too Many Requests', JSON.stringify({
      error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
    }));
    const err = await createOpenAIProvider('k').extractClaims('Water boils at 100 C.').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).reason).toBe('provider_out_of_credits');
    expect((err as ExtractionError).message).not.toContain('billing details');
  });

  it('OpenAI 429 rate_limit_exceeded at extraction stays rate_limited', async () => {
    failWith(429, 'Too Many Requests', JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }));
    const err = await createOpenAIProvider('k').extractClaims('Water boils at 100 C.').catch((e: unknown) => e);
    expect((err as ExtractionError).reason).toBe('rate_limited');
  });

  it('Anthropic credit balance too low at extraction -> provider_out_of_credits', async () => {
    failWith(400, 'Bad Request', JSON.stringify({
      type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
    }));
    const err = await createClaudeProvider('k').extractClaims('Water boils at 100 C.').catch((e: unknown) => e);
    expect((err as ExtractionError).reason).toBe('provider_out_of_credits');
  });

  it('Perplexity 402 billing at verify -> the thrown error is classified out of credits', async () => {
    failWith(402, 'Payment Required', '{"error":{"message":"billing: no active payment method"}}');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createPerplexityProvider('k').verifyClaim(claim);
    expect(result.apiError).toBe(true);
    expect(result.explanation).toBe(OUT_OF_CREDITS_VERIFY_MESSAGE);
  });
});
