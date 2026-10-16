/**
 * A provider reply we cannot read is our failure, not a verdict (emma-soul ruling
 * al:5b18840b0116047a, item c). Every provider reports it as unchecked with
 * reason 'provider_unparseable': never 'mixed', never a plain 'unverified', never
 * billed, and the MCP/guard surfaces say UNCHECKED with that reason.
 *
 * Red before 2026-10-16: Gemini returned 'mixed' for prose, and every provider
 * returned a billable 'unverified' for JSON without a status.
 */
// Validates: N-234 (billable unit, GoPMO 1.18.11.7.13)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Claim, VerificationResult } from '../types';
import { readVerdictReply, unparseableVerdict } from '../providers/verdict-reply';
import { createOpenAIProvider } from '../providers/openai_provider';
import { createClaudeProvider } from '../providers/claude_provider';
import { createPerplexityProvider } from '../providers/perplexity_provider';
import { toClaimVerdict, isProviderUnchecked } from '../cli/verdict';
import { evaluateGuard } from '../cli/guard';
import { isBillableVerdict, billableVerdictCount } from '../lib/verdict-guard';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 };
const UNREADABLE = ['I think it is probably true, sources disagree.', '{"explanation":"no status here"}', '{"status":"likely"}', '[]'];

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
}
const REPLY: Record<string, (t: string) => unknown> = {
  openai: (t) => ({ choices: [{ message: { content: t } }] }),
  claude: (t) => ({ content: [{ type: 'text', text: t }], usage: {} }),
  perplexity: (t) => ({ choices: [{ message: { content: t } }], citations: [] }),
};
const FACTORY = { openai: createOpenAIProvider, claude: createClaudeProvider, perplexity: createPerplexityProvider };

function expectUnparseable(r: VerificationResult) {
  expect(r.status).toBe('unverified');
  expect(r.status).not.toBe('mixed');
  expect(r.apiError).toBe(true);
  expect(r.apiErrorReason).toBe('provider_unparseable');
  expect(r.parseFallback).toBe(true);
  expect(r.sources).toEqual([]);
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('readVerdictReply', () => {
  it('reads a verdict with a prompt status, and nothing else', () => {
    expect(readVerdictReply('{"status":"mixed","explanation":"both ways"}')).toEqual({ status: 'mixed', explanation: 'both ways' });
    expect(readVerdictReply('{"status":"unverified"}')).toEqual({ status: 'unverified', explanation: 'No structural analysis provided.' });
    for (const t of [...UNREADABLE, '', '   ', 'null', '"supported"', '{"status":"skipped"}', '{"status":7}']) {
      expect(readVerdictReply(t)).toBeNull();
    }
    expect(readVerdictReply(undefined)).toBeNull();
  });

  it('the unchecked result is not billable', () => {
    const r = unparseableVerdict('c1');
    expectUnparseable(r);
    expect(isBillableVerdict(r)).toBe(false);
    expect(billableVerdictCount({ c1: r, c2: { claimId: 'c2', status: 'mixed', explanation: '', sources: [] } })).toBe(1);
  });
});

describe.each(['openai', 'claude', 'perplexity'] as const)('%s verifyClaim', (name) => {
  it('an unreadable reply is unchecked with reason provider_unparseable', async () => {
    for (const text of UNREADABLE) {
      mockFetch.mockResolvedValueOnce(ok(REPLY[name](text)));
      expectUnparseable(await FACTORY[name]('k').verifyClaim(CLAIM));
    }
  });

  it('a readable reply is still a verdict, including mixed', async () => {
    mockFetch.mockResolvedValueOnce(ok(REPLY[name]('{"status":"mixed","explanation":"Evidence both ways."}')));
    const r = await FACTORY[name]('k').verifyClaim(CLAIM);
    expect(r.status).toBe('mixed');
    expect(r.apiError).toBeUndefined();
    expect(isBillableVerdict(r)).toBe(true);
  });
});

describe.each(['openai', 'claude'] as const)('%s verifyClaimGrounded (consensus vote)', (name) => {
  it('an unreadable reply is a failed vote, not an unverified one', async () => {
    const sources = [{ title: 's', uri: 'https://example.org/a' }];
    mockFetch.mockResolvedValueOnce(ok(REPLY[name]('{"explanation":"no status"}')));
    const r = await FACTORY[name]('k').verifyClaimGrounded!(CLAIM, sources);
    expect(r.apiError).toBe(true);
    expect(r.apiErrorReason).toBe('provider_unparseable');
  });
});

describe('MCP verdict and guard', () => {
  it('UNCHECKED with unchecked_reason provider_unparseable, and the guard reports degraded', () => {
    const v = toClaimVerdict(CLAIM.text, unparseableVerdict('c1'));
    expect(v.verdict).toBe('UNCHECKED');
    expect(v.unchecked_reason).toBe('provider_unparseable');
    expect(isProviderUnchecked(v.unchecked_reason)).toBe(true);
    expect(toClaimVerdict(CLAIM.text, { claimId: 'c1', status: 'unverified', explanation: '', sources: [], apiError: true }).unchecked_reason).toBe('provider_error');

    const report = evaluateGuard({
      claims: [CLAIM], verifications: { c1: unparseableVerdict('c1') },
    } as never);
    expect(report.degraded).toBe(true);
    expect(report.claims[0].verdict).toBe('UNCHECKED');
  });
});
