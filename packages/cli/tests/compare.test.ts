import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

vi.stubGlobal('fetch', vi.fn());

import { compareScanResults, renderCompare, type CompareResult } from '../cli/compare.js';
import { main } from '../cli/index.js';
import type { ScanResult } from '../cli/scan.js';
import type { Claim, VerificationResult } from '../types.js';

// ------------------------------------------------------------------ fixtures

function makeClaim(id: string, text: string, type: Claim['type'] = 'fact', importance = 4): Claim {
  return { id, text, type, importance };
}

function makeVerification(claimId: string, status: VerificationResult['status']): VerificationResult {
  return { claimId, status, explanation: 'test', sources: [] };
}

function makeScanResult(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
  risk: ScanResult['overallRisk'],
): ScanResult {
  return {
    input: 'test',
    provider: 'Mock Provider',
    claims,
    verifications,
    overallRisk: risk,
    complianceReport: {
      generatedAt: '',
      overallRiskLevel: risk,
      euRiskSummary: {
        unacceptable: 0,
        high: 0,
        limited: 0,
        minimal: 0,
        totalClaims: 0,
        highestTier: 'minimal',
      },
      claimMappings: [],
      triggeredArticles: [],
      mitigations: [],
      confidenceDistribution: { high: 0, medium: 0, low: 0 },
    },
    ruleFindings: [],
  };
}

// ------------------------------------------------------------------ unit: compareScanResults

describe('compareScanResults()', () => {
  it('identical scans → all arrays empty, delta=0, summary=No change', () => {
    const claim = makeClaim('c1', 'Water boils at 100 degrees Celsius.');
    const ver = makeVerification('c1', 'supported');
    const sr = makeScanResult([claim], { c1: ver }, 'low');

    const result = compareScanResults(sr, sr);

    expect(result.newClaims).toHaveLength(0);
    expect(result.removedClaims).toHaveLength(0);
    expect(result.changedVerdicts).toHaveLength(0);
    expect(result.trustScoreDelta).toBe(0);
    expect(result.summary).toBe('No change');
  });

  it('new claim in after → newClaims has 1 entry (Gate 2)', () => {
    const claimA = makeClaim('c1', 'The sky is blue.');
    const claimB = makeClaim('c2', 'Grass is green.');
    const before = makeScanResult([claimA], {}, 'low');
    const after  = makeScanResult([claimA, claimB], {}, 'low');

    const result = compareScanResults(before, after);

    expect(result.newClaims).toHaveLength(1);
    expect(result.newClaims[0].id).toBe('c2');
    expect(result.removedClaims).toHaveLength(0);
  });

  it('removed claim → removedClaims has 1 entry (Gate 2)', () => {
    const claimA = makeClaim('c1', 'The sky is blue.');
    const claimB = makeClaim('c2', 'Grass is green.');
    const before = makeScanResult([claimA, claimB], {}, 'low');
    const after  = makeScanResult([claimA], {}, 'low');

    const result = compareScanResults(before, after);

    expect(result.removedClaims).toHaveLength(1);
    expect(result.removedClaims[0].id).toBe('c2');
    expect(result.newClaims).toHaveLength(0);
  });

  it('verdict change → changedVerdicts has 1 entry with correct before/after (Gate 2)', () => {
    const claim = makeClaim('c1', 'AI is deterministic.');
    const before = makeScanResult([claim], { c1: makeVerification('c1', 'supported') }, 'low');
    const after  = makeScanResult([claim], { c1: makeVerification('c1', 'contradicted') }, 'high');

    const result = compareScanResults(before, after);

    expect(result.changedVerdicts).toHaveLength(1);
    expect(result.changedVerdicts[0].before).toBe('supported');
    expect(result.changedVerdicts[0].after).toBe('contradicted');
    expect(result.changedVerdicts[0].claim.id).toBe('c1');
  });

  it('risk improved (high → low) → trustScoreDelta=-2, summary=Risk improved', () => {
    const claim = makeClaim('c1', 'Some claim.');
    const before = makeScanResult([claim], {}, 'high');
    const after  = makeScanResult([claim], {}, 'low');

    const result = compareScanResults(before, after);

    expect(result.trustScoreDelta).toBe(-2);
    expect(result.summary).toBe('Risk improved');
  });

  it('risk worsened (low → high) → trustScoreDelta=+2, summary=Risk worsened', () => {
    const claim = makeClaim('c1', 'Some claim.');
    const before = makeScanResult([claim], {}, 'low');
    const after  = makeScanResult([claim], {}, 'high');

    const result = compareScanResults(before, after);

    expect(result.trustScoreDelta).toBe(2);
    expect(result.summary).toBe('Risk worsened');
  });

  it('case-insensitive claim matching — same text different case produces no new/removed claims', () => {
    const claimBefore = makeClaim('c1', 'Water boils at 100 degrees Celsius.');
    const claimAfter  = makeClaim('c2', 'WATER BOILS AT 100 DEGREES CELSIUS.');
    const before = makeScanResult([claimBefore], {}, 'low');
    const after  = makeScanResult([claimAfter],  {}, 'low');

    const result = compareScanResults(before, after);

    expect(result.newClaims).toHaveLength(0);
    expect(result.removedClaims).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ unit: renderCompare

describe('renderCompare()', () => {
  const noChanges: CompareResult = {
    newClaims: [],
    removedClaims: [],
    changedVerdicts: [],
    trustScoreDelta: 0,
    summary: 'No change',
  };

  it('JSON format → valid JSON, parseable', () => {
    const output = renderCompare(noChanges, 'json');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('newClaims');
    expect(parsed).toHaveProperty('trustScoreDelta');
  });

  it('text format → contains FAULTLINE COMPARE REPORT header', () => {
    const output = renderCompare(noChanges, 'text');
    expect(output).toContain('FAULTLINE COMPARE REPORT');
  });

  it('text format with new claim → output contains the claim text (Gate 2)', () => {
    const result: CompareResult = {
      newClaims: [makeClaim('c1', 'A brand new claim about something.')],
      removedClaims: [],
      changedVerdicts: [],
      trustScoreDelta: 0,
      summary: 'No change',
    };
    const output = renderCompare(result, 'text');
    expect(output).toContain('A brand new claim about something.');
    expect(output).toContain('New claims (1)');
  });

  it('text format with no changes → output contains "No differences detected"', () => {
    const output = renderCompare(noChanges, 'text');
    expect(output).toContain('No differences detected.');
  });
});

// ------------------------------------------------------------------ integration: main() compare command

describe('CLI compare command', () => {
  it('faultline compare without flags → exitCode 1 with Usage hint', async () => {
    const { exitCode, output } = await main(['compare']);
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage:');
  });

  it('faultline compare missing --after → exitCode 1 with Usage hint', async () => {
    const { exitCode, output } = await main(['compare', '--before', 'some text']);
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage:');
  });

  it('faultline compare with identical text --provider mock → exitCode 0', async () => {
    const text = 'Water boils at 100 degrees Celsius. The sky is blue during the day.';
    const { exitCode } = await main(['compare', '--before', text, '--after', text, '--provider', 'mock']);
    expect(exitCode).toBe(0);
  });

  it('compare output contains FAULTLINE COMPARE REPORT header (Gate 2)', async () => {
    const text = 'Water boils at 100 degrees Celsius.';
    const { exitCode, output } = await main(['compare', '--before', text, '--after', text, '--provider', 'mock']);
    expect(exitCode).toBe(0);
    expect(output).toContain('FAULTLINE COMPARE REPORT');
  });

  it('--output-format json → output is valid JSON with newClaims field', async () => {
    const text = 'Water boils at 100 degrees Celsius.';
    const { exitCode, output } = await main([
      'compare',
      '--before', text,
      '--after', text,
      '--provider', 'mock',
      '--output-format', 'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('newClaims');
    expect(Array.isArray(parsed.newClaims)).toBe(true);
  });
});
