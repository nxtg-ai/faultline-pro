// Validates: billing rule, a claim is billable only on the retrieval of a built-in provider instance
/**
 * A built-in provider cannot be replaced, and its retrieval belongs to the
 * built-in instance, not to its id. A plugin or caller that registers a
 * provider under a built-in id is refused, and a provider that is not the
 * built-in one never gets an engine retriever, so it is never billable.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: mockGenerateContent }; },
}));

import { getProvider, registerProvider, listProviders, isBuiltInProviderName, builtInProviderIdOf } from '../providers/registry.js';
import { loadPlugin, loadPluginsFromConfig, resetPluginRegistry } from '../plugins/loader.js';
import { runVerification, bindEngineProvenance } from '../cli/verify-runner.js';
import { scan } from '../cli/scan.js';
import { isBillableVerdict, billableVerdictCount } from '../lib/verdict-guard.js';
import type { Claim, VerificationResult } from '../types.js';

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 };
const SOURCE = { title: 'Publisher', uri: 'https://publisher.example/eiffel' };
const BUILT_IN = ['gemini', 'claude', 'openai', 'perplexity', 'mock'];

/** A provider that retrieves nothing and claims a supported verdict with a citation. */
function spoofFactory() {
  return () => ({
    name: 'Spoof',
    modelId: 'spoof-v1',
    extractClaims: async () => [CLAIM],
    verifyClaim: async (c: Claim): Promise<VerificationResult> => ({
      claimId: c.id, status: 'supported', explanation: 'ok', sources: [SOURCE],
      provenance: { provider: 'gemini', model: 'm', verifiedAt: '2020-01-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2020-01-01T00:00:00.000Z' },
    }),
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }) as never;
}

describe('registerProvider refuses a built-in id', () => {
  it.each([
    'gemini', 'Gemini ', 'GEMINI', ' gemini', '\tGeMiNi\n',
    'claude', 'OpenAI', ' perplexity ', 'MOCK',
  ])('refuses %j with an error naming it built-in', (name) => {
    expect(() => registerProvider(name, spoofFactory())).toThrow(/built-in provider and cannot be replaced/);
  });

  it('leaves every built-in factory in place after a refused registration', () => {
    for (const name of BUILT_IN) expect(() => registerProvider(name, spoofFactory())).toThrow();
    const g = getProvider('k', 'gemini');
    expect(g.name).toBe('Google Gemini');
    expect(builtInProviderIdOf(g)).toBe('gemini');
    // No look-alike id was added either.
    expect(listProviders().filter((n) => n.trim().toLowerCase() === 'gemini')).toEqual(['gemini']);
  });

  it('still registers a custom provider under its own name', () => {
    registerProvider('guard-custom', spoofFactory());
    expect(getProvider('k', 'guard-custom').name).toBe('Spoof');
    expect(isBuiltInProviderName('guard-custom')).toBe(false);
  });

  it('a custom provider stays replaceable by its own registrant', () => {
    registerProvider('guard-replaceable', spoofFactory());
    expect(() => registerProvider('guard-replaceable', spoofFactory())).not.toThrow();
  });

  it('isBuiltInProviderName trims and ignores case', () => {
    for (const name of BUILT_IN) {
      expect(isBuiltInProviderName(name)).toBe(true);
      expect(isBuiltInProviderName(` ${name.toUpperCase()} `)).toBe(true);
    }
    expect(isBuiltInProviderName('gemini-pro')).toBe(false);
    expect(isBuiltInProviderName('')).toBe(false);
  });
});

describe('a plugin cannot replace a built-in provider', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(__dirname, '.plugin-guard-')); resetPluginRegistry(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetPluginRegistry(); });

  function writePlugin(file: string, providerName: string): string {
    const path = join(dir, file);
    writeFileSync(path, `export default {
  name: 'spoof-plugin',
  register(ctx) {
    ctx.registerProvider(${JSON.stringify(providerName)}, () => ({
      name: 'Plugin spoof', modelId: 'spoof-v1',
      extractClaims: async () => [],
      verifyClaim: async (c) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [{ title: 't', uri: 'https://x.example' }] }),
      generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
    }));
  },
};
`);
    return path;
  }

  it.each(['gemini', 'Gemini ', 'GEMINI'])('loading a plugin that registers %j fails with the refusal', async (name) => {
    const path = writePlugin('spoof-builtin.mjs', name);
    await expect(loadPlugin(path)).rejects.toThrow(/threw an error during register\(\).*built-in provider and cannot be replaced/s);
    const g = getProvider('k', 'gemini');
    expect(g.name).toBe('Google Gemini');
    expect(builtInProviderIdOf(g)).toBe('gemini');
  });

  it('a config that lists such a plugin reports it as failed and keeps the built-in', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const path = writePlugin('spoof-config.mjs', 'gemini');
    const results = await loadPluginsFromConfig([path]);
    stderr.mockRestore();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/built-in provider and cannot be replaced/);
    expect(getProvider('k', 'gemini').name).toBe('Google Gemini');
  });

  it('a plugin may still register a provider under its own name', async () => {
    const path = writePlugin('own-name.mjs', 'guard-plugin-own');
    await loadPlugin(path);
    const p = getProvider('k', 'guard-plugin-own');
    expect(p.name).toBe('Plugin spoof');
    expect(builtInProviderIdOf(p)).toBeUndefined();
  });
});

describe('the engine retriever belongs to the built-in instance, not the id', () => {
  it('a non-built-in provider resolved as gemini gets no retriever and is not billable', async () => {
    const provider = spoofFactory()();
    const r = await runVerification([CLAIM], { provider, consensusRig: null, providerName: 'gemini' });
    const v = r.verifications.c1;
    expect(v.status).toBe('supported');
    expect(v.sources).toEqual([SOURCE]);
    expect(v.provenance?.provider).toBe('gemini');
    expect(v.provenance?.retriever).toBeUndefined();
    expect(v.provenance?.retrievedAt).toBeUndefined();
    expect(isBillableVerdict(v)).toBe(false);
    expect(billableVerdictCount(r.verifications)).toBe(0);
  });

  it('a registered custom provider never gets an engine retriever under its own id', async () => {
    registerProvider('guard-spoof', spoofFactory());
    const provider = getProvider('k', 'guard-spoof');
    const r = await runVerification([CLAIM], { provider, consensusRig: null, providerName: 'guard-spoof' });
    expect(r.verifications.c1.provenance?.retriever).toBeUndefined();
    expect(billableVerdictCount(r.verifications)).toBe(0);
  });

  it('a wrapper around the built-in gemini instance is not the built-in', () => {
    const g = getProvider('k', 'gemini');
    const wrapper = { ...g, modelId: g.modelId, verifyClaim: (c: Claim) => g.verifyClaim(c) };
    const result: VerificationResult = { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [SOURCE] };
    const v = bindEngineProvenance(result, 'gemini', wrapper as never, '2026-10-01T00:00:00.000Z');
    expect(v.provenance?.retriever).toBeUndefined();
    expect(isBillableVerdict(v)).toBe(false);
  });

  it('a built-in instance bound under a different id gets no retriever', () => {
    const g = getProvider('k', 'gemini');
    const result: VerificationResult = { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [SOURCE] };
    expect(bindEngineProvenance(result, 'gemini', g, '2026-10-01T00:00:00.000Z').provenance?.retriever).toBe('gemini-grounding');
    expect(bindEngineProvenance(result, 'guard-elsewhere', g, '2026-10-01T00:00:00.000Z').provenance?.retriever).toBeUndefined();
  });

  it('other built-in instances get no retriever', () => {
    const m = getProvider('k', 'mock');
    expect(builtInProviderIdOf(m)).toBe('mock');
    const result: VerificationResult = { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [SOURCE] };
    expect(bindEngineProvenance(result, 'mock', m, '2026-10-01T00:00:00.000Z').provenance?.retriever).toBeUndefined();
  });
});

describe('the real built-in gemini path is unchanged and billable', () => {
  let savedEnv: Record<string, string | undefined>;
  const KEYS = ['GEMINI_API_KEY', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_CONSENSUS', 'FAULTLINE_PROVIDER'];
  beforeAll(() => {
    savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.GEMINI_API_KEY = 'fixture-unused';
    process.env.FAULTLINE_EVIDENCE_FETCH = 'off';
    delete process.env.FAULTLINE_CONSENSUS;
    delete process.env.FAULTLINE_PROVIDER;
  });
  afterAll(() => {
    for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  });
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGenerateContent.mockImplementation(async (req: { config?: { tools?: unknown[] } }) => {
      const grounded = Array.isArray(req.config?.tools) && req.config!.tools!.length > 0;
      if (!grounded) return { text: JSON.stringify([CLAIM]), candidates: [] };
      return {
        text: '{"status":"supported","explanation":"Completed in 1889."}',
        modelVersion: 'gemini-2.5-flash-001',
        candidates: [{ groundingMetadata: { groundingChunks: [{ web: SOURCE }] } }],
      };
    });
  });

  it('scan(text, "gemini") binds gemini-grounding at the call site and bills the claim', async () => {
    const before = Date.now();
    const r = await scan(CLAIM.text, 'gemini');
    const v = r.verifications.c1;
    expect(v).toBeDefined();
    expect(v.status).toBe('supported');
    expect(v.sources).toEqual([SOURCE]);
    expect(v.provenance?.provider).toBe('gemini');
    expect(v.provenance?.model).toBe('gemini-2.5-flash-001');
    expect(v.provenance?.retriever).toBe('gemini-grounding');
    expect(Date.parse(v.provenance!.retrievedAt!)).toBeGreaterThanOrEqual(before);
    expect(v.provenance?.retrievedAt).toBe(v.provenance?.verifiedAt);
    expect(isBillableVerdict(v)).toBe(true);
    expect(billableVerdictCount(r.verifications)).toBe(1);
  });

  it('the built-in instance from getProvider gets gemini-grounding through the runner', async () => {
    const provider = getProvider('k', 'gemini');
    const r = await runVerification([CLAIM], { provider, consensusRig: null, providerName: 'gemini' });
    expect(r.verifications.c1.provenance?.retriever).toBe('gemini-grounding');
    expect(isBillableVerdict(r.verifications.c1)).toBe(true);
  });
});
