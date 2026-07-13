import { describe, it, expect } from 'vitest';
import { sanitizeVerifyError, hasUncheckedClaim } from './verify-error';

// The EXACT raw blob that leaked into a paying customer's report on 2026-07-13.
const PROD_429_LEAK =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. ' +
  '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, ' +
  'model: gemini-2.5-flash","status":"RESOURCE_EXHAUSTED"}}';

// Strings that must NEVER reach a customer-facing explanation.
const LEAK_MARKERS = [
  'RESOURCE_EXHAUSTED', 'generativelanguage', 'generate_content_free_tier',
  'billing details', 'gemini-2.5-flash', 'limit: 5', '"code":429', '{',
];

describe('sanitizeVerifyError', () => {
  it('never echoes the raw prod 429 quota blob', () => {
    const out = sanitizeVerifyError(new Error(PROD_429_LEAK));
    expect(out.length).toBeGreaterThan(0);
    for (const marker of LEAK_MARKERS) {
      expect(out).not.toContain(marker);
    }
  });

  it('classifies quota/429 as a rate-limit message', () => {
    expect(sanitizeVerifyError(new Error(PROD_429_LEAK)).toLowerCase()).toContain('rate-limited');
    expect(sanitizeVerifyError(new Error('429 Too Many Requests')).toLowerCase()).toContain('rate-limited');
    expect(sanitizeVerifyError(new Error('RESOURCE_EXHAUSTED')).toLowerCase()).toContain('rate-limited');
  });

  it('classifies auth failures without leaking the key', () => {
    const out = sanitizeVerifyError(new Error('401 invalid api key sk-abc123SECRET'));
    expect(out.toLowerCase()).toContain('configuration');
    expect(out).not.toContain('sk-abc123SECRET');
  });

  it('classifies 5xx/timeout/network as transient', () => {
    for (const m of ['503 Service Unavailable', 'request timed out', 'ECONNRESET', 'fetch failed']) {
      expect(sanitizeVerifyError(new Error(m)).toLowerCase()).toContain('temporarily unavailable');
    }
  });

  it('falls back safely for unknown errors and non-Error inputs', () => {
    const out = sanitizeVerifyError('some weird raw string with internals /home/axw/key.pem');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('/home/axw/key.pem');
    expect(sanitizeVerifyError(undefined).length).toBeGreaterThan(0);
    expect(sanitizeVerifyError(null).length).toBeGreaterThan(0);
  });

  it('every branch states the claim was not checked (never implies "unsupported")', () => {
    const samples = [PROD_429_LEAK, '401 bad key', '503 down', 'totally unknown'];
    for (const s of samples) {
      expect(sanitizeVerifyError(new Error(s)).toLowerCase()).toContain('not checked');
    }
  });
});

describe('hasUncheckedClaim', () => {
  it('detects apiError in the verifications map', () => {
    expect(hasUncheckedClaim({ verifications: { c1: { status: 'unverified', apiError: true } } })).toBe(true);
  });

  it('detects apiError inline on claims', () => {
    expect(hasUncheckedClaim({ claims: [{ id: 'c1', apiError: true }] })).toBe(true);
  });

  it('is false for a fully clean result', () => {
    expect(hasUncheckedClaim({
      verifications: { c1: { status: 'supported' }, c2: { status: 'mixed' } },
      claims: [{ id: 'c1' }, { id: 'c2' }],
    })).toBe(false);
  });

  it('is false/safe for empty or malformed input', () => {
    expect(hasUncheckedClaim(null)).toBe(false);
    expect(hasUncheckedClaim(undefined)).toBe(false);
    expect(hasUncheckedClaim({})).toBe(false);
    expect(hasUncheckedClaim('nope')).toBe(false);
  });
});
