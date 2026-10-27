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
import { isOutOfCreditsText, outOfCreditsTag } from '../providers/out-of-credits.js';
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
  ['402 with billing', '402 Payment Required: billing account inactive'],
  ['adapter tag', 'OpenAI API error: 429 Too Many Requests (out_of_credits)'],
];

/** Rate limits a retry does fix: these must stay rate_limited. */
const RATE_LIMITED_CASES: Array<[string, string]> = [
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
