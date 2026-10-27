/**
 * An empty provider account keeps its reason past claim extraction: through
 * single-provider verification and through multi-model consensus.
 *
 * Before this, a verification adapter that caught "credit balance is too low"
 * returned `apiError: true` with no reason, and a consensus vote built from a
 * thrown error dropped it too. The CLI then told the user to re-run when the
 * provider was healthy, which cannot succeed until the account has credits.
 * The adapter cases use the real adapters with a mocked fetch Response.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Claim, ProviderVote, Source } from '../types.js';
import type { Retriever } from '../providers/base_provider.js';

const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

import { createClaudeProvider } from '../providers/claude_provider.js';
import { createOpenAIProvider } from '../providers/openai_provider.js';
import { createPerplexityProvider } from '../providers/perplexity_provider.js';
import { verifyClaim as geminiVerifyClaim, verifyClaimGrounded as geminiVerifyClaimGrounded } from '../services/geminiService.js';
import { consensusVerify, type NamedProvider } from '../consensus/consensus_engine.js';
import { OUT_OF_CREDITS_VERIFY_MESSAGE } from '../services/verify-error.js';

const claim: Claim = { id: 'c1', text: 'Water boils at 100 C at sea level.', type: 'fact', importance: 3 };
// One shared source, so the voters are asked: a search with no source asks no provider.
const oneSourceRetriever: Retriever = {
  name: 'test-retriever',
  retrieve: async () => [{ title: 'Boiling point', uri: 'https://example.com/boiling' }] as Source[],
};

const ANTHROPIC_CREDIT_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
});
const OPENAI_INSUFFICIENT_QUOTA_BODY = JSON.stringify({
  error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
});
const OPENAI_RATE_LIMIT_BODY = JSON.stringify({ error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } });

function failWith(status: number, statusText: string, body: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, statusText })));
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mockGenerateContent.mockReset();
});

describe('single-provider verification keeps the out-of-credits reason', () => {
  it('Anthropic 400 credit balance too low at verify -> apiErrorReason provider_out_of_credits', async () => {
    failWith(400, 'Bad Request', ANTHROPIC_CREDIT_BODY);
    const result = await createClaudeProvider('k').verifyClaim(claim);
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBe('provider_out_of_credits');
    expect(result.explanation).toBe(OUT_OF_CREDITS_VERIFY_MESSAGE);
    expect(result.explanation).not.toContain('credit balance is too low');
  });

  it('Anthropic 500 at verify stays a plain provider error with no reason', async () => {
    failWith(500, 'Internal Server Error', '{"type":"error","error":{"type":"api_error"}}');
    const result = await createClaudeProvider('k').verifyClaim(claim);
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBeUndefined();
  });

  it('OpenAI 400 billing_hard_limit_reached at verify -> apiErrorReason provider_out_of_credits', async () => {
    failWith(400, 'Bad Request', '{"error":{"code":"billing_hard_limit_reached","message":"Billing hard limit has been reached"}}');
    const result = await createOpenAIProvider('k').verifyClaim(claim);
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBe('provider_out_of_credits');
  });

  it('Perplexity 402 billing at verify -> apiErrorReason provider_out_of_credits', async () => {
    failWith(402, 'Payment Required', '{"error":{"message":"billing: no active payment method"}}');
    const result = await createPerplexityProvider('k').verifyClaim(claim);
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBe('provider_out_of_credits');
  });

  it('Gemini verify whose error reads as out of credits -> apiErrorReason provider_out_of_credits', async () => {
    mockGenerateContent.mockRejectedValue(new Error('402 Payment Required: billing account is not active'));
    const result = await geminiVerifyClaim(claim, 'k');
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBe('provider_out_of_credits');
  });

  it('Gemini grounded verify whose error reads as out of credits -> apiErrorReason provider_out_of_credits', async () => {
    mockGenerateContent.mockRejectedValue(new Error('402 Payment Required: billing account is not active'));
    const result = await geminiVerifyClaimGrounded(claim, [], 'k');
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBe('provider_out_of_credits');
  });

  it('Gemini per-minute RESOURCE_EXHAUSTED at verify is not read as out of credits', async () => {
    mockGenerateContent.mockRejectedValue(new Error(
      '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
    ));
    const result = await geminiVerifyClaim(claim, 'k');
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).not.toBe('provider_out_of_credits');
  });
});

describe('consensus keeps the out-of-credits reason on the vote and the fused result', () => {
  const openaiVoter = (): NamedProvider => ({ name: 'openai', provider: createOpenAIProvider('k') });

  it('OpenAI 429 insufficient_quota voter -> the vote reads provider_out_of_credits', async () => {
    failWith(429, 'Too Many Requests', OPENAI_INSUFFICIENT_QUOTA_BODY);
    const result = await consensusVerify(claim, oneSourceRetriever, [openaiVoter()]);
    const vote = result.providerVotes?.[0] as ProviderVote;
    expect(vote).toBeDefined();
    expect(vote.apiError).toBe(true);
    expect(vote.apiErrorReason).toBe('provider_out_of_credits');
    expect(vote.explanation).toBe(OUT_OF_CREDITS_VERIFY_MESSAGE);
    expect(vote.explanation).not.toContain('billing details');
  });

  it('every voter out of credits -> the fused result reads provider_out_of_credits', async () => {
    failWith(429, 'Too Many Requests', OPENAI_INSUFFICIENT_QUOTA_BODY);
    const result = await consensusVerify(claim, oneSourceRetriever, [openaiVoter(), openaiVoter()]);
    expect(result.providerVotes).toHaveLength(2);
    expect(result.status).toBe('unverified');
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBe('provider_out_of_credits');
    expect(result.consensus?.providerCount).toBe(0);
  });

  it('control: a genuine 429 rate-limit voter reads rate_limited, and the fused result is not out of credits', async () => {
    failWith(429, 'Too Many Requests', OPENAI_RATE_LIMIT_BODY);
    const result = await consensusVerify(claim, oneSourceRetriever, [openaiVoter()]);
    const vote = result.providerVotes?.[0] as ProviderVote;
    expect(vote).toBeDefined();
    expect(vote.apiErrorReason).toBe('rate_limited');
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).not.toBe('provider_out_of_credits');
  });

  it('a mix of out-of-credits and rate-limited voters does not claim out of credits', async () => {
    const outOfCredits: NamedProvider = {
      name: 'openai',
      provider: { verifyClaimGrounded: async () => { throw new Error('OpenAI API error: 429 Too Many Requests (out_of_credits)'); } } as never,
    };
    const rateLimited: NamedProvider = {
      name: 'claude',
      provider: { verifyClaimGrounded: async () => { throw new Error('Anthropic API error: 429 Too Many Requests'); } } as never,
    };
    const result = await consensusVerify(claim, oneSourceRetriever, [outOfCredits, rateLimited]);
    expect(result.providerVotes?.map((v) => v.apiErrorReason)).toEqual(['provider_out_of_credits', 'rate_limited']);
    expect(result.apiError).toBe(true);
    expect(result.apiErrorReason).toBeUndefined();
  });

  it('one voter out of credits and one real verdict -> a checked claim with no failure reason', async () => {
    const outOfCredits: NamedProvider = {
      name: 'openai',
      provider: { verifyClaimGrounded: async () => { throw new Error('429 insufficient_quota'); } } as never,
    };
    const healthy: NamedProvider = {
      name: 'claude',
      provider: { verifyClaimGrounded: async () => ({ claimId: claim.id, status: 'supported' as const, explanation: 'Holds up.', sources: [] }) } as never,
    };
    const result = await consensusVerify(claim, oneSourceRetriever, [outOfCredits, healthy]);
    expect(result.status).toBe('supported');
    expect(result.apiError).toBeUndefined();
    expect(result.apiErrorReason).toBeUndefined();
  });
});
