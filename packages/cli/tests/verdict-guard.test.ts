// Validates: N-234 (verdict states enforced at runtime, GoPMO 1.18.11.3 P2; EP4 recert 02-codex-evidence.md row 1)
/**
 * A verdict status is checked at runtime, not only typed. The examiner's probe
 * (P1) registered a provider that returned the status ROYALLY_CERTIFIED and saw
 * it survive scan() and disk history. These tests replay that probe through
 * the real engine path and through the CLI history writer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VERDICT_STATUSES,
  isVerdictStatus,
  verdictProblem,
  guardVerdict,
  assertValidScanResult,
  storedVerdictProblem,
  STORED_STATUSES,
  isInvalidVerdictError,
} from '../lib/verdict-guard.js';
import { scan } from '../cli/scan.js';
import { registerProvider } from '../providers/registry.js';
import { saveHistoryEntry } from '../history/store.js';
import type { Claim, VerificationResult } from '../types.js';

const PROBE = 'ROYALLY_CERTIFIED';
const valid = (claimId = 'c1'): VerificationResult => ({ claimId, status: 'supported', explanation: 'ok', sources: [{ title: 't', uri: 'https://example.org' }] });

function registerFixture(name: string, verify: (c: Claim) => unknown): void {
  registerProvider(name, () => ({
    name: 'Examiner fixture',
    modelId: 'fixture-v1',
    extractClaims: async () => [{ id: 'c1', text: 'The examiner fixture contains a factual claim.', type: 'fact', importance: 5 }],
    verifyClaim: async (c: Claim) => verify(c) as VerificationResult,
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }) as never);
}

describe('allowlist', () => {
  it('is exactly the four verdict statuses', () => {
    expect([...VERDICT_STATUSES]).toEqual(['supported', 'contradicted', 'mixed', 'unverified']);
    for (const s of VERDICT_STATUSES) expect(isVerdictStatus(s)).toBe(true);
    for (const s of [PROBE, 'loading', 'skipped', 'Supported', ' supported', '', null, undefined, 1, {}]) {
      expect(isVerdictStatus(s)).toBe(false);
    }
  });

  it('names each shape problem without echoing the value', () => {
    expect(verdictProblem(valid())).toBeNull();
    expect(verdictProblem(null)).toBe('not an object');
    expect(verdictProblem([])).toBe('not an object');
    expect(verdictProblem({ ...valid(), status: PROBE })).toBe('status is not an allowed verdict');
    expect(verdictProblem({ ...valid(), explanation: 5 })).toBe('explanation is not a string');
    expect(verdictProblem({ ...valid(), sources: 'x' })).toBe('sources is not an array');
    expect(verdictProblem({ ...valid(), sources: [{ title: 't' }] })).toBe('a source has no string uri');
  });

  it('stores accept the verdicts plus skipped, never loading or an unknown value, and check source shape', () => {
    expect([...STORED_STATUSES]).toEqual(['supported', 'contradicted', 'mixed', 'unverified', 'skipped']);
    expect(storedVerdictProblem({ status: 'skipped', explanation: 'opinion' })).toBeNull();
    expect(storedVerdictProblem({ status: 'supported' })).toBeNull();
    expect(storedVerdictProblem({ status: 'loading' })).toBe('status is not an allowed verdict');
    expect(storedVerdictProblem({ status: PROBE })).toBe('status is not an allowed verdict');
    expect(storedVerdictProblem({ status: 'mixed', sources: [{ title: 'no uri' }] })).toBe('a source has no string uri');
    expect(() => assertValidScanResult({ verifications: { c1: { status: 'skipped' } } })).not.toThrow();
  });

  it('guardVerdict returns a valid verdict unchanged and replaces an invalid one', () => {
    const v = valid();
    expect(guardVerdict(v, 'c1')).toBe(v);
    const g = guardVerdict({ ...v, status: PROBE }, 'c1');
    expect(g).toEqual({
      claimId: 'c1',
      status: 'unverified',
      explanation: 'The verifier returned a malformed verdict, so this claim was not checked.',
      sources: [],
      apiError: true,
      apiErrorReason: 'provider_error',
    });
    expect(JSON.stringify(g)).not.toContain(PROBE);
  });

  it('assertValidScanResult refuses a bad status and a bad overallRisk, and passes a good result', () => {
    expect(() => assertValidScanResult({ verifications: { c1: valid() }, overallRisk: 'low' })).not.toThrow();
    let caught: unknown;
    try { assertValidScanResult({ verifications: { c1: { ...valid(), status: PROBE } } }); } catch (e) { caught = e; }
    expect(isInvalidVerdictError(caught)).toBe(true);
    expect((caught as { statusCode: number }).statusCode).toBe(502);
    expect(String((caught as Error).message)).not.toContain(PROBE);
    expect(() => assertValidScanResult({ verifications: {}, overallRisk: 'edited' })).toThrow(/overallRisk/);
  });
});

describe('engine path: the examiner probe through scan()', () => {
  // A registered custom provider resolves its key from GEMINI_API_KEY; the fixture never uses it.
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'fixture-unused'; });
  afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

  it('a provider status outside the allowlist never leaves scan()', async () => {
    registerFixture('examiner-p1', (c) => ({ claimId: c.id, status: PROBE, explanation: 'fixture', sources: [] }));
    const result = await scan('The examiner fixture contains a factual claim.', 'examiner-p1');
    const v = result.verifications.c1;
    expect(v).toBeDefined();
    expect(v.status).toBe('unverified');
    expect(v.apiError).toBe(true);
    expect(v.apiErrorReason).toBe('provider_error');
    expect(JSON.stringify(result)).not.toContain(PROBE);
  });

  it('a malformed verdict shape is replaced the same way', async () => {
    registerFixture('examiner-shape', (c) => ({ claimId: c.id, status: 'supported', explanation: 'x', sources: [{ title: 'no uri' }] }));
    const result = await scan('The examiner fixture contains a factual claim.', 'examiner-shape');
    expect(result.verifications.c1.status).toBe('unverified');
    expect(result.verifications.c1.apiError).toBe(true);
  });

  it('a valid verdict passes through unchanged', async () => {
    registerFixture('examiner-ok', (c) => ({ claimId: c.id, status: 'contradicted', explanation: 'refuted', sources: [] }));
    const result = await scan('The examiner fixture contains a factual claim.', 'examiner-ok');
    expect(result.verifications.c1).toMatchObject({ status: 'contradicted', explanation: 'refuted' });
    expect(result.verifications.c1.apiError).toBeUndefined();
  });
});

describe('CLI disk history', () => {
  it('refuses to write a scan carrying an invalid verdict, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-verdict-history-'));
    try {
      const bad = { claims: [], verifications: { c1: { ...valid(), status: PROBE } }, overallRisk: 'low', provider: 'mock', ruleFindings: [] } as never;
      expect(() => saveHistoryEntry(bad, 'doc.txt', dir)).toThrow(/invalid verdict/);
      expect(readdirSync(dir)).toHaveLength(0);
      const good = { claims: [], verifications: { c1: valid() }, overallRisk: 'low', provider: 'mock', ruleFindings: [] } as never;
      saveHistoryEntry(good, 'doc.txt', dir);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('billable verdicts (cost log verified_count, GoPMO 1.18.11.7.3)', () => {
  it('counts sourced definite verdicts only; not unverified, zero-source verdicts, provider errors, UI states or junk', async () => {
    const { isBillableVerdict, billableVerdictCount } = await import('../lib/verdict-guard.js');
    const src = [{ title: 'S', uri: 'https://example.org/s' }];
    expect(isBillableVerdict({ status: 'supported', sources: src })).toBe(true);
    expect(isBillableVerdict({ status: 'supported' })).toBe(false);
    expect(isBillableVerdict({ status: 'unverified', sources: src })).toBe(false);
    expect(isBillableVerdict({ status: 'unverified', apiError: true })).toBe(false);
    expect(isBillableVerdict({ status: 'skipped', sources: src })).toBe(false);
    expect(isBillableVerdict({ status: 'loading', sources: src })).toBe(false);
    expect(isBillableVerdict({ status: 'ROYALLY_CERTIFIED', sources: src })).toBe(false);
    expect(isBillableVerdict(null)).toBe(false);
    const v = {
      a: { status: 'supported', sources: src }, b: { status: 'unverified', sources: src },
      c: { status: 'unverified', apiError: true }, d: { status: 'skipped' }, e: { status: 'contradicted', sources: src },
    };
    expect(billableVerdictCount(v)).toBe(2);
    expect(billableVerdictCount(Object.values(v))).toBe(2);
    expect(billableVerdictCount([undefined, { status: 'mixed', sources: src }, { status: 'mixed', sources: [] }])).toBe(1);
    expect(billableVerdictCount(undefined)).toBe(0);
  });
});
