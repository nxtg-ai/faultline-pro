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
import { consensusVerify } from '../consensus/consensus_engine';
import type { Retriever } from '../providers/base_provider';

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
    const src = [{ title: 'S', uri: 'https://example.org/s' }];
    expect(billableVerdictCount({ c1: r, c2: { claimId: 'c2', status: 'mixed', explanation: '', sources: src, provenance: { provider: 'gemini', model: 'm', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-01T00:00:00.000Z' } } })).toBe(1);
    expect(billableVerdictCount({ c1: r, c2: { claimId: 'c2', status: 'mixed', explanation: '', sources: [] } })).toBe(0);
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
    // A raw provider verdict carries no engine retriever, so it is not billable
    // as returned, whatever it cites. With a source and the provenance the
    // engine binds for a provider that retrieves (gemini), it would be.
    expect(r.provenance?.retriever).toBeUndefined();
    expect(isBillableVerdict(r)).toBe(false);
    expect(isBillableVerdict({ ...r, sources: [{ title: 'S', uri: 'https://example.org/s' }], provenance: { provider: 'gemini', model: 'm', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-01T00:00:00.000Z' } })).toBe(true);
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

// Codex seat HOLD on 3a07b32: consensus dropped the reason between vote and fused result.
describe('consensus carries provider_unparseable end to end', () => {
  const retriever: Retriever = { name: 'test-retriever', retrieve: async () => [{ title: 's', uri: 'https://example.org/a' }] };
  const named = () => [
    { name: 'openai', provider: createOpenAIProvider('k') },
    { name: 'claude', provider: createClaudeProvider('k') },
  ];

  it('every vote unreadable: the fused claim is unchecked with reason provider_unparseable, MCP says so', async () => {
    mockFetch.mockImplementation(async (url: string) => ok(String(url).includes('anthropic') ? REPLY.claude('prose') : REPLY.openai('prose')));
    const fused = await consensusVerify(CLAIM, retriever, named());
    expect(fused).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_unparseable' });
    expect(fused.providerVotes?.map((v) => v.apiErrorReason)).toEqual(['provider_unparseable', 'provider_unparseable']);
    expect(toClaimVerdict(CLAIM.text, fused).unchecked_reason).toBe('provider_unparseable');
    expect(isBillableVerdict(fused)).toBe(false);
  });

  it('one unreadable vote and one thrown error: unchecked, but not labelled unparseable', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('anthropic')) throw new Error('503 overloaded');
      return ok(REPLY.openai('prose'));
    });
    const fused = await consensusVerify(CLAIM, retriever, named());
    expect(fused.apiError).toBe(true);
    expect(fused.apiErrorReason).toBeUndefined();
    expect(toClaimVerdict(CLAIM.text, fused).unchecked_reason).toBe('provider_error');
  });

  it('one readable vote and one unreadable: the readable verdict stands, the failed vote keeps its reason', async () => {
    mockFetch.mockImplementation(async (url: string) => ok(String(url).includes('anthropic')
      ? REPLY.claude('{"status":"supported","explanation":"Holds."}') : REPLY.openai('prose')));
    const fused = await consensusVerify(CLAIM, retriever, named());
    expect(fused.status).toBe('supported');
    expect(fused.apiError).toBeUndefined();
    expect(fused.providerVotes?.find((v) => v.provider === 'openai')?.apiErrorReason).toBe('provider_unparseable');
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
