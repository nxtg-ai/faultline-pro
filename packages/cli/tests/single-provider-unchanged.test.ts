/**
 * The single-provider (non-consensus) verify path is untouched by the consensus
 * retrieval rules. These expected verdicts were recorded from the code before
 * consensus stopped voting without a retrieved source. One rule applies to both
 * paths: a definite verdict (supported, contradicted or mixed) with no source is
 * reported as unverified, flagged noSourceAbstain (abstainWithoutSource).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scan } from '../cli/scan.js';
import { registerProvider } from '../providers/registry.js';
import { NO_SOURCE_EXPLANATION } from '../lib/verdict-guard.js';
import type { Claim, VerificationResult } from '../types.js';

const TEXT = 'The Eiffel Tower is in Paris. Water boils at 100 degrees Celsius at sea level. The moon orbits the earth.';

const CLAIMS: Claim[] = [
  { id: 'c1', text: 'The Eiffel Tower is in Paris', type: 'fact', importance: 3 },
  { id: 'c2', text: 'Water boils at 100 degrees Celsius at sea level', type: 'fact', importance: 3 },
  { id: 'c3', text: 'The moon orbits the earth', type: 'fact', importance: 4 },
];

/** One fixed verdict per claim: supported with a source, contradicted with none, inconclusive. */
const FIXED: Record<string, Omit<VerificationResult, 'claimId'>> = {
  c1: { status: 'supported', explanation: 'Fixture: supported.', sources: [{ title: 'S', uri: 'https://example.org/s' }] },
  c2: { status: 'contradicted', explanation: 'Fixture: contradicted.', sources: [] },
  c3: { status: 'unverified', explanation: 'Fixture: inconclusive.', sources: [] },
};

registerProvider('single-path-fixture', () => ({
  name: 'Single path fixture',
  modelId: 'fixture-v1',
  extractClaims: async () => CLAIMS,
  verifyClaim: async (c: Claim) => ({ claimId: c.id, ...FIXED[c.id] }),
  generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
}) as never);

/** Drop the call time, which differs per run; everything else is compared exactly. */
function stable(v: VerificationResult): unknown {
  return { ...v, provenance: v.provenance && { ...v.provenance, verifiedAt: 'T' } };
}

describe('single-provider path, unchanged', () => {
  // A registered provider still resolves its key from the env; this one never uses it.
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'fixture-unused'; });
  afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

  it('the mock provider cites no source, so each of its supported verdicts is reported as unverified', async () => {
    const r = await scan(TEXT, 'mock');
    expect(r.claims).toEqual(CLAIMS);
    const got = Object.fromEntries(Object.entries(r.verifications).map(([k, v]) => [k, stable(v)]));
    const abstained = (id: string) => ({
      claimId: id, status: 'unverified', explanation: NO_SOURCE_EXPLANATION, sources: [], noSourceAbstain: true,
      provenance: { provider: 'mock', model: 'mock-v1', verifiedAt: 'T' },
    });
    expect(Object.keys(got).length).toBe(3);
    expect(got).toEqual({ c1: abstained('c1'), c2: abstained('c2'), c3: abstained('c3') });
  });

  it('a fixed provider keeps every sourced verdict as returned; a no-source contradicted becomes unverified', async () => {
    const r = await scan(TEXT, 'single-path-fixture');
    const got = Object.fromEntries(Object.entries(r.verifications).map(([k, v]) => [k, stable(v)]));
    const prov = { provider: 'single-path-fixture', model: 'fixture-v1', verifiedAt: 'T' };
    expect(Object.keys(got).length).toBe(3);
    expect(got).toEqual({
      c1: { claimId: 'c1', ...FIXED.c1, provenance: prov },
      c2: { claimId: 'c2', status: 'unverified', explanation: NO_SOURCE_EXPLANATION, sources: [], noSourceAbstain: true, provenance: prov },
      c3: { claimId: 'c3', ...FIXED.c3, provenance: prov },
    });
  });
});
