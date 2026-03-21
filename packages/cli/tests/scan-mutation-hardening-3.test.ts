/**
 * N-138 — cli/scan.ts mutation hardening round 3 (HN1–HN15)
 *
 * Targets surviving mutants from stryker-cli.config.mjs baseline (75.41%):
 *
 * guaranteeClaimPerSentence idx (HN1–HN2):
 *   HN1: first synthetic ID equals result.length + 1 (not result.length - 1)
 *        kills: line 64 ArithmeticOperator (`result.length + 1` → `result.length - 1`)
 *   HN2: synthetic IDs are consecutive and ascending
 *        kills: line 78 UpdateOperator (`idx++` → `idx--`)
 *
 * aggregateResults arithmetic (HN3–HN9):
 *   HN3: euTierCounts.high accumulates across two files
 *        kills: line 279 ArithmeticOperator (`+=` → `-=`)
 *   HN4: euTierCounts.unacceptable accumulates across two files
 *        kills: line 278 ArithmeticOperator (`+=` → `-=`)
 *   HN5: euTierCounts.limited accumulates across two files
 *        kills: line 280 ArithmeticOperator (`+=` → `-=`)
 *   HN6: euTierCounts.minimal accumulates across two files
 *        kills: line 281 ArithmeticOperator (`+=` → `-=`)
 *   HN7: all euTierCounts fields are defined numbers (not from empty {})
 *        kills: line 268 ObjectLiteral (`{ unacceptable:0, ... }` → `{}`)
 *   HN8: totalClaims accumulates across two files
 *        kills: line 273 ArithmeticOperator (`+=` → `-=`)
 *   HN9: totalVerifications accumulates across two files
 *        kills: line 274 ArithmeticOperator (`+=` → `-=`)
 *
 * batchScan glob field (HN10–HN11):
 *   HN10: r.glob equals the provided pattern string (not false/true/null)
 *         kills: line 252 BooleanLiteral false/true + LogicalOperator `||` → `&&`
 *   HN11: r.glob is null when no pattern is provided (not false/true/undefined)
 *         kills: line 252 BooleanLiteral false/true + LogicalOperator `||` → `&&`
 *
 * collectFiles ArrayDeclaration (HN12):
 *   HN12: filesSkipped is 0 for a clean valid-file scan
 *         kills: line 183 ArrayDeclaration (`[] ` → `["Stryker was here!"]`)
 *
 * normalizeSentence mutations (HN13):
 *   HN13: triple-space sentence covered by single-space claim (no synthetic added)
 *         kills: line 45 StringLiteral (`' '` → `"Stryker was here!"`)
 *                line 45 Regex (`/\s+/g` → `/\s/g`)
 *
 * riskOrder StringLiteral mutations (HN14–HN15):
 *   HN14: highestRisk 'critical' when 3+ claims are contradicted
 *         kills: line 284 StringLiteral `'critical'` → `''`
 *   HN15: highestRisk 'high' when exactly 1 claim is contradicted
 *         kills: line 284 StringLiteral `'high'` → `''`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VerificationResult } from '../types.js';

// ── Mock setup ────────────────────────────────────────────────────────────────

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim:   vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name:    'hardening3-provider',
    modelId: 'hardening3-v1',
    extractClaims:             mockExtractClaims,
    verifyClaim:               mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { batchScan, guaranteeClaimPerSentence } from '../cli/scan.js';

function vr(status: VerificationResult['status'], claimId: string): VerificationResult {
  return { claimId, status, explanation: `test:${status}`, sources: [] };
}

function makeClaims(texts: string[], importance = 3) {
  return texts.map((text, i) => ({
    id: `c${i + 1}`,
    text,
    type: 'fact' as const,
    importance,
  }));
}

beforeEach(() => { vi.clearAllMocks(); });

// ── guaranteeClaimPerSentence idx (HN1–HN2) ───────────────────────────────────

describe('guaranteeClaimPerSentence — synthetic claim IDs (HN1–HN2)', () => {
  it('HN1: first synthetic ID is result.length + 1 (not result.length - 1)', () => {
    // 2 existing claims → idx starts at 3. With `result.length - 1` mutant, idx starts at 1.
    const existing = makeClaims(['Some claim text here for you.', 'Another fact about the world.']);
    const result = guaranteeClaimPerSentence(
      // 3 sentences → 2 won't be covered by the existing claims
      'XYZ totally uncovered sentence is here. ABC another uncovered fact today. ' +
      'Some claim text here for you.',
      existing,
    );
    const synthetics = result.filter(c => c.id.startsWith('s'));
    // First synthetic must be 's3' (idx = result.length + 1 = 2 + 1 = 3)
    // With `result.length - 1` mutant: first synthetic = 's1'
    expect(synthetics.length).toBeGreaterThanOrEqual(1);
    const ids = synthetics.map(c => c.id);
    expect(ids[0]).toBe('s3');
  });

  it('HN2: two synthetic IDs are consecutive and ascending (s3, s4)', () => {
    // 2 existing claims + 2 uncovered sentences → synthetics should be s3 and s4.
    // With idx-- mutant: first push gives idx=3→post-decrement 2, second gives 2→post-decrement 1 → [s3, s2].
    const existing = makeClaims(['Some claim text here for you.', 'Another fact about the world.']);
    const result = guaranteeClaimPerSentence(
      'XYZ totally uncovered sentence is here. ABC another uncovered fact today. ' +
      'Some claim text here for you.',
      existing,
    );
    const synthetics = result.filter(c => c.id.startsWith('s'));
    expect(synthetics.length).toBeGreaterThanOrEqual(2);
    const ids = synthetics.map(c => c.id);
    // IDs must be strictly ascending: s3, s4 (not s3, s2 with idx--)
    for (let i = 1; i < ids.length; i++) {
      const prev = parseInt(ids[i - 1]!.slice(1));
      const curr = parseInt(ids[i]!.slice(1));
      expect(curr).toBeGreaterThan(prev);
    }
    expect(ids[0]).toBe('s3');
    expect(ids[1]).toBe('s4');
  });
});

// ── aggregateResults euTierCounts arithmetic (HN3–HN7) ───────────────────────

describe('batchScan aggregateResults — euTierCounts arithmetic (HN3–HN7)', () => {
  // Employment claim text triggers Annex III §4 (employment domain) → high tier
  const EMPLOYMENT_CLAIM = 'Employment of AI in recruitment and hiring is rising fast.';
  // Social scoring text triggers Article 5(1)(c) → unacceptable tier
  const SOCIAL_SCORING_CLAIM = 'AI social scoring of citizens is now expanding globally.';
  // No domain keywords + status=contradicted → limited tier
  const NEUTRAL_CLAIM = 'AI systems produce creative outputs for everyday tasks now.';

  it('HN3: euTierCounts.high accumulates additive across two files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn3-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'Employment of AI in recruitment and hiring is rising fast.');
      writeFileSync(join(dir, 'b.txt'), 'Employment of AI in recruitment and hiring is rising fast.');
      mockExtractClaims.mockResolvedValue(makeClaims([EMPLOYMENT_CLAIM]));
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // Each file contributes 1 high-tier claim → total = 2
      // With += → -= mutant: 0 - 1 - 1 = -2
      expect(r.summary.euTierCounts.high).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN4: euTierCounts.unacceptable accumulates additive across two files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn4-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI social scoring of citizens is now expanding globally.');
      writeFileSync(join(dir, 'b.txt'), 'AI social scoring of citizens is now expanding globally.');
      mockExtractClaims.mockResolvedValue(makeClaims([SOCIAL_SCORING_CLAIM]));
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // Each file: 1 unacceptable claim → total = 2
      expect(r.summary.euTierCounts.unacceptable).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN5: euTierCounts.limited accumulates additive across two files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn5-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce creative outputs for everyday tasks now.');
      writeFileSync(join(dir, 'b.txt'), 'AI systems produce creative outputs for everyday tasks now.');
      mockExtractClaims.mockResolvedValue(makeClaims([NEUTRAL_CLAIM]));
      // contradicted → limited tier (no high-risk domain keyword, transparency obligation)
      mockVerifyClaim.mockResolvedValue(vr('contradicted', 'c1'));
      const r = await batchScan(dir, 'mock');
      // Each file: 1 limited claim → total = 2
      expect(r.summary.euTierCounts.limited).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN6: euTierCounts.minimal accumulates additive across two files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn6-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce creative outputs for everyday tasks now.');
      writeFileSync(join(dir, 'b.txt'), 'AI systems produce creative outputs for everyday tasks now.');
      mockExtractClaims.mockResolvedValue(makeClaims([NEUTRAL_CLAIM]));
      // supported + no domain keywords → minimal tier (default)
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // Each file: 1 minimal claim → total = 2
      expect(r.summary.euTierCounts.minimal).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN7: all euTierCounts fields are defined numbers (ObjectLiteral not empty {})', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn7-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce creative outputs for everyday tasks now.');
      mockExtractClaims.mockResolvedValue(makeClaims([NEUTRAL_CLAIM]));
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      const { euTierCounts } = r.summary;
      // With `{}` mutation, += sets these to NaN (undefined += number = NaN)
      expect(typeof euTierCounts.unacceptable).toBe('number');
      expect(typeof euTierCounts.high).toBe('number');
      expect(typeof euTierCounts.limited).toBe('number');
      expect(typeof euTierCounts.minimal).toBe('number');
      expect(euTierCounts.unacceptable).toBeGreaterThanOrEqual(0);
      expect(euTierCounts.high).toBeGreaterThanOrEqual(0);
      expect(euTierCounts.limited).toBeGreaterThanOrEqual(0);
      expect(euTierCounts.minimal).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── aggregateResults totalClaims / totalVerifications (HN8–HN9) ───────────────

describe('batchScan aggregateResults — totalClaims/totalVerifications (HN8–HN9)', () => {
  it('HN8: totalClaims accumulates additive across two files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn8-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce useful output results now.');
      writeFileSync(join(dir, 'b.txt'), 'AI systems produce useful output results now.');
      // Single-sentence text → guaranteeClaimPerSentence returns early → exactly 1 claim
      mockExtractClaims.mockResolvedValue(makeClaims(['AI systems produce useful output results now.']));
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // 2 files × 1 claim = 2 total. With -= mutant: 0 - 1 - 1 = -2.
      expect(r.summary.totalClaims).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN9: totalVerifications accumulates additive across two files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn9-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce useful output results now.');
      writeFileSync(join(dir, 'b.txt'), 'AI systems produce useful output results now.');
      mockExtractClaims.mockResolvedValue(makeClaims(['AI systems produce useful output results now.']));
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // 2 files × 1 verified claim = 2 total verifications. With -= mutant: -2.
      expect(r.summary.totalVerifications).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── batchScan glob field (HN10–HN11) ─────────────────────────────────────────

describe('batchScan — glob field in result (HN10–HN11)', () => {
  afterEach(() => vi.clearAllMocks());

  it('HN10: r.glob equals provided pattern string (not false/true/null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn10-'));
    try {
      writeFileSync(join(dir, 'article.txt'), 'AI systems produce useful output results now.');
      mockExtractClaims.mockResolvedValue([]);
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock', undefined, '*.txt');
      // With `false` mutant: r.glob = false; `true`: r.glob = true; `&&null`: r.glob = null.
      // All killed by strict equality check.
      expect(r.glob).toBe('*.txt');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN11: r.glob is null when no pattern provided (not false/true/undefined)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn11-'));
    try {
      writeFileSync(join(dir, 'doc.txt'), 'AI systems produce useful output results now.');
      mockExtractClaims.mockResolvedValue([]);
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // `globPattern || null` with undefined → null.
      // `false` mutant: r.glob = false; `true`: r.glob = true; `&&null`: r.glob = undefined.
      expect(r.glob).toBe(null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── collectFiles ArrayDeclaration (HN12) ─────────────────────────────────────

describe('batchScan — collectFiles ArrayDeclaration (HN12)', () => {
  it('HN12: filesSkipped is 0 when all scanned files are valid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn12-'));
    try {
      writeFileSync(join(dir, 'valid.txt'), 'AI systems produce useful output results now.');
      mockExtractClaims.mockResolvedValue([]);
      mockVerifyClaim.mockResolvedValue(vr('supported', 'c1'));
      const r = await batchScan(dir, 'mock');
      // With `["Stryker was here!"]` ArrayDeclaration: a phantom path is added to files[].
      // readFileSync("Stryker was here!") throws → filesSkipped = 1.
      // Without mutation: all real files succeed → filesSkipped = 0.
      expect(r.filesSkipped).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── normalizeSentence multi-space (HN13) ─────────────────────────────────────

describe('guaranteeClaimPerSentence — normalizeSentence multi-space (HN13)', () => {
  it('HN13: triple-space sentence is covered by matching single-space claim (no synthetic added)', () => {
    // sentence "Hello   world is correct today." has triple-space.
    // After normalizeSentence with /\s+/g: "hello world is correct today" (collapsed).
    // Claim NC: "hello world is correct today" (no extra spaces).
    // Fingerprint (first 40): "hello world is correct today" → nc.includes(fp) = TRUE → covered.
    //
    // With `' '` → `"Stryker was here!"` StringLiteral mutation:
    //   normSentence = "helloStryker was here!world is correct today" (not collapsing to space)
    //   Fingerprint = "helloStryker was here!world is correct tod"
    //   nc = "hello world is correct today" (normal — no triple-space in claim)
    //   nc.includes(fp) = FALSE; normSentence.includes(nc.slice(0,40)) = FALSE
    //   → sentence not covered → synthetic claim added → result.length = 3
    //
    // With `/\s/g` mutation:
    //   "hello   world..." → replace(/\s/g, ' ') → "hello   world..." (each space→space, triple stays)
    //   Same asymmetry → synthetic added.
    //
    // Requires 2 sentences to bypass early return.
    const claims = makeClaims([
      'Hello world is correct today.',         // covers the triple-space sentence
      'AI systems verify data accuracy now.',  // covers the second sentence
    ]);
    const result = guaranteeClaimPerSentence(
      'Hello   world is correct today. AI systems verify data accuracy now.',
      claims,
    );
    // Both sentences covered → no synthetic claims added
    expect(result.length).toBe(2);
    expect(result.every(c => c.id.startsWith('c'))).toBe(true);
  });
});

// ── riskOrder StringLiteral mutations (HN14–HN15) ────────────────────────────

describe('batchScan aggregateResults — riskOrder StringLiteral (HN14–HN15)', () => {
  it('HN14: highestRisk is "critical" when 3+ claims are contradicted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn14-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce useful output results now.');
      // 3 claims all contradicted → calculateRisk returns 'critical'
      mockExtractClaims.mockResolvedValue(makeClaims([
        'AI produces useful output always.',
        'Data confirms all results clearly now.',
        'Systems verify accuracy of content here.',
      ]));
      mockVerifyClaim.mockResolvedValue(vr('contradicted', 'cx'));
      const r = await batchScan(dir, 'mock');
      // riskCounts = { critical: 1 }, highestRisk should be 'critical'.
      // With `'critical'→''` mutation: riskOrder[''] has no count → falls to 'low'.
      expect(r.summary.highestRisk).toBe('critical');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('HN15: highestRisk is "high" when exactly 1 claim is contradicted (not critical)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn15-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AI systems produce useful output results now.');
      // 1 claim contradicted → calculateRisk: contradicted=1, not >2 → 'high'
      mockExtractClaims.mockResolvedValue(makeClaims(['AI produces useful output always.']));
      mockVerifyClaim.mockResolvedValue(vr('contradicted', 'c1'));
      const r = await batchScan(dir, 'mock');
      // riskCounts = { high: 1 }, highestRisk should be 'high'.
      // With `'high'→''` mutation: riskOrder[''] has no count → falls to 'low'.
      expect(r.summary.highestRisk).toBe('high');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
