/**
 * Which providers can vote in consensus, and what happens when a consensus scan
 * has no voter it can run: it fails before any provider call instead of fusing
 * zero votes into a verdict that reads as checked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CONSENSUS_VOTER_PROVIDERS,
  canVoteInConsensus,
  resolveScanProviders,
  resolveStageProviders,
  isConsensusUnavailableError,
  isInvalidConsensusVotersError,
  consensusVoterRefusal,
  type InvalidConsensusVotersError,
} from '../cli/verify-runner';
import { getProvider } from '../providers/registry';

const ALL_PROVIDERS = ['gemini', 'openai', 'claude', 'perplexity', 'mock'];
const KEY_ENV = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY'];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEY_ENV.map((k) => [k, process.env[k]]));
  for (const k of KEY_ENV) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('consensus voters', () => {
  it('the voter list is exactly the providers whose adapter can judge against shared sources', () => {
    const grounded = ALL_PROVIDERS.filter((name) => typeof getProvider('test-key', name).verifyClaimGrounded === 'function');
    expect(grounded.length).toBeGreaterThan(0);
    expect([...CONSENSUS_VOTER_PROVIDERS].sort()).toEqual(grounded.sort());
  });

  it('perplexity and unknown names cannot vote', () => {
    expect(canVoteInConsensus('perplexity')).toBe(false);
    expect(canVoteInConsensus('not-a-provider')).toBe(false);
    expect(canVoteInConsensus('mock')).toBe(true);
  });

  it('a consensus scan whose voters all lack keys fails before any provider call', () => {
    let thrown: unknown;
    try {
      resolveScanProviders('mock', { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai', 'claude'] });
    } catch (err) {
      thrown = err;
    }
    expect(isConsensusUnavailableError(thrown)).toBe(true);
  });

  it('a voter list of only providers that cannot vote fails the same way', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    expect(() => resolveScanProviders('mock', { extractionProvider: 'mock', consensus: true, consensusProviders: ['perplexity'] }))
      .toThrow(/No consensus voter is available/);
  });

  it('a voter with a key is kept and one that cannot vote is left out', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key';
    const { verifier } = resolveScanProviders('openai', { consensus: true, consensusProviders: ['perplexity', 'openai'] });
    expect(verifier.consensusRig?.namedProviders.map((p) => p.name)).toEqual(['openai']);
  });
});

describe('only real, distinct providers vote, unless the whole run is offline', () => {
  function refusalOf(provider: string, config: Parameters<typeof resolveScanProviders>[1]): unknown {
    try {
      resolveScanProviders(provider, config);
    } catch (err) {
      return err;
    }
    return undefined;
  }

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  const refusedMock: Array<[string, string, Parameters<typeof resolveScanProviders>[1]]> = [
    ['mock beside a real voter', 'mock', { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai', 'mock'] }],
    ['mock alone on a paid extraction', 'openai', { consensus: true, consensusProviders: ['mock'] }],
    ['mock alone with a paid verification stage', 'mock', { verificationProvider: 'openai', consensus: true, consensusProviders: ['mock'] }],
    ['mock alone where consensus defaults the stages to openai', 'gemini', { consensus: true, consensusProviders: ['mock'] }],
  ];
  for (const [name, provider, config] of refusedMock) {
    it(`refuses ${name} before any provider is built`, () => {
      const err = refusalOf(provider, config);
      expect(isInvalidConsensusVotersError(err)).toBe(true);
      expect((err as InvalidConsensusVotersError).refusal.error).toBe('consensus_mock_voter_not_offline');
      expect(consensusVoterRefusal(provider, config)?.error).toBe('consensus_mock_voter_not_offline');
    });
  }

  for (const voters of [['openai', 'openai', 'openai'], ['openai', 'gemini', 'openai'], ['mock', 'mock']] as const) {
    it(`refuses the duplicate voter list ${voters.join(', ')}`, () => {
      const provider = voters[0] === 'mock' ? 'mock' : 'openai';
      const config = { consensus: true, consensusProviders: [...voters] };
      const err = refusalOf(provider, config);
      expect(isInvalidConsensusVotersError(err)).toBe(true);
      expect((err as InvalidConsensusVotersError).refusal).toMatchObject({ error: 'consensus_provider_duplicate', providers: [voters[0]] });
      expect(consensusVoterRefusal(provider, config)?.error).toBe('consensus_provider_duplicate');
    });
  }

  it('a fully offline run (every stage and voter mock) builds a rig whose retriever makes no call', async () => {
    const config = { consensus: true, consensusProviders: ['mock' as const] };
    expect(consensusVoterRefusal('mock', config)).toBeNull();
    const { verifier } = resolveScanProviders('mock', config);
    expect(verifier.consensusRig?.namedProviders.map((p) => p.name)).toEqual(['mock']);
    // OPENAI_API_KEY is set, so any other run would retrieve through paid OpenAI web search.
    expect(verifier.consensusRig?.retriever.name).toBe('offline');
    await expect(verifier.consensusRig?.retriever.retrieve('Paris is in France')).resolves.toEqual([]);
  });

  it('distinct real voters pass and retrieve through the funded web search', () => {
    const config = { consensus: true, consensusProviders: ['openai' as const, 'gemini' as const, 'claude' as const] };
    expect(consensusVoterRefusal('openai', config)).toBeNull();
    const { verifier } = resolveScanProviders('openai', config);
    expect(verifier.consensusRig?.namedProviders.map((p) => p.name)).toEqual(['openai', 'gemini', 'claude']);
    expect(verifier.consensusRig?.retriever.name).not.toBe('offline');
  });

  it('a scan with consensus off is never refused', () => {
    expect(consensusVoterRefusal('openai', { consensus: false, consensusProviders: ['mock', 'mock'] })).toBeNull();
  });
});

describe('resolveStageProviders', () => {
  it('names the providers each stage runs on, not the outer label', () => {
    expect(resolveStageProviders('mock', { extractionProvider: 'perplexity', verificationProvider: 'perplexity' }))
      .toEqual({ extraction: 'perplexity', verification: 'perplexity', consensusVoters: null });
  });

  it('falls back to the outer provider for a stage with no override', () => {
    expect(resolveStageProviders('openai', { extractionProvider: 'claude' }))
      .toEqual({ extraction: 'claude', verification: 'openai', consensusVoters: null });
    expect(resolveStageProviders(undefined, undefined))
      .toEqual({ extraction: 'gemini', verification: 'gemini', consensusVoters: null });
  });

  it('lists the consensus voters that run, defaulting them when none are named', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(resolveStageProviders('mock', { consensus: true, consensusProviders: ['mock'] }).consensusVoters).toEqual(['mock']);
    // gemini has no key here, so the rig drops it and it is not listed.
    expect(resolveStageProviders('gemini', { consensus: true }))
      .toEqual({ extraction: 'openai', verification: 'openai', consensusVoters: ['openai', 'claude'] });
  });

  it('leaves out a named voter with no key or one that cannot vote', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.PERPLEXITY_API_KEY = 'test-key';
    expect(resolveStageProviders('openai', { consensus: true, consensusProviders: ['openai', 'gemini', 'perplexity'] }).consensusVoters)
      .toEqual(['openai']);
  });
});
