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
    const { verifier } = resolveScanProviders('mock', { extractionProvider: 'mock', consensus: true, consensusProviders: ['perplexity', 'mock'] });
    expect(verifier.consensusRig?.namedProviders.map((p) => p.name)).toEqual(['mock']);
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

  it('lists the consensus voters, defaulting them when none are named', () => {
    expect(resolveStageProviders('mock', { consensus: true, consensusProviders: ['mock'] }).consensusVoters).toEqual(['mock']);
    expect(resolveStageProviders('gemini', { consensus: true }))
      .toEqual({ extraction: 'openai', verification: 'openai', consensusVoters: ['openai', 'gemini', 'claude'] });
  });
});
