/**
 * N-125 — Mutation hardening round 2 for cli/scan.ts (MH16–MH30)
 *
 * Targets surviving and NoCoverage mutants from N-118 Stryker run (60.91%):
 *
 * Survived (splitSentences lines 39–45):
 *   - line 41: `>= 3` word threshold (Equality)
 *   - line 41: `/[a-zA-Z]/` letter guard (Regex)
 *   - line 41: `&&` → `||` in filter (LogicalOperator)
 *   - line 41: `s.split(/\s+/)` → `/\s/` (Regex — double-space words)
 *   - line 41: `s.split(/\s+/)` → `/\S+/` (Regex — 2-word sentence)
 *
 * NoCoverage (collectFiles, onProgress, default provider):
 *   - line 98:  `providerName || 'gemini'` default (StringLiteral)
 *   - line 121: `onProgress?.('Extracting claims...')` (StringLiteral)
 *   - line 128: `onProgress?.(\`Verifying claim ${i + 1}/...\`)` (StringLiteral + Arithmetic)
 *   - line 132: `onProgress?.('Generating report...')` (StringLiteral)
 *   - line 181: isDirectory branch (BlockStatement/ConditionalExpression)
 *   - line 183: `.startsWith('.')` guard (multiple mutations)
 *   - line 183: `!== 'node_modules'` guard (multiple mutations)
 *   - lines 187–188: `if (matcher)` branch (BlockStatement/ConditionalExpression)
 *   - lines 204–209: `globToRegex` (Regex/StringLiteral)
 *
 * Tests MH16–MH30.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VerificationResult } from '../types.js';

// ── Mock setup (mirrors hardening-1) ─────────────────────────────────────────

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim:   vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name:    'hardening-provider',
    modelId: 'hardening-v1',
    extractClaims:             mockExtractClaims,
    verifyClaim:               mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { scan, batchScan, guaranteeClaimPerSentence } from '../cli/scan.js';

function vr(status: VerificationResult['status'], claimId: string): VerificationResult {
  return { claimId, status, explanation: `test:${status}`, sources: [] };
}

function makeClaims(n: number, importance = 3) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Verifiable claim number ${i + 1} is demonstrably true here now.`,
    type: 'fact' as const,
    importance,
  }));
}

// ── splitSentences word-count boundary (MH16–MH17) ────────────────────────────

describe('guaranteeClaimPerSentence — word count and letter guard', () => {
  // MH16: exactly 3-word sentence IS included → kills `>= 3` → `> 3`
  it('MH16: exact 3-word sentence is added as synthetic claim', () => {
    // "Foo is true." = 3 words (Foo, is, true.) — must pass >= 3 filter
    const result = guaranteeClaimPerSentence(
      'Foo is true. Bar is false.',
      [],
    );
    // Both are 3-word sentences → both should be added
    expect(result.length).toBeGreaterThanOrEqual(2);
    // With `> 3` mutant, 3-word sentences are excluded → result.length === 0
    expect(result.some(c => c.text.includes('Foo is true.'))).toBe(true);
  });

  // MH17: sentence with no letters is excluded → kills `/[a-zA-Z]/` → `/[^a-zA-Z]/`
  it('MH17: sentence containing only digits is not added as synthetic claim', () => {
    // "123 456 789." has 3 space-separated tokens but no letters → must be excluded.
    // Need 2 valid (letter) sentences to bypass the `sentences.length < 2` early return.
    const result = guaranteeClaimPerSentence(
      '123 456 789. AI is transforming this field today. Climate data shows warming trends.',
      [],
    );
    // All added claims must have letters (digit-only sentence excluded)
    expect(result.every(c => /[a-zA-Z]/.test(c.text))).toBe(true);
    expect(result.some(c => c.text.includes('AI is transforming'))).toBe(true);
    // digit-only sentence must NOT appear
    expect(result.every(c => !c.text.includes('123 456 789'))).toBe(true);
  });
});

// ── splitSentences logical operator boundary (MH18) ───────────────────────────

describe('guaranteeClaimPerSentence — logical operator in filter', () => {
  // MH18: `s.length > 0 && /[a-zA-Z]/` not `||` → number-only not included
  // With `&&` → `||` mutant: `s.length > 0 || /[a-zA-Z]/...`
  // A number-only 3-word token "999 888 777." passes `s.length > 0` → slips through with `||`
  // Need 2 valid letter sentences so we don't early-return before the digit-only check matters.
  it('MH18: a digit-only sentence is excluded even when length > 0', () => {
    const result = guaranteeClaimPerSentence(
      '999 888 777. Climate data shows warming in recent decades. AI systems improve yearly performance.',
      [],
    );
    // digit-only sentence MUST be absent
    expect(result.every(c => !/^\d/.test(c.text.trim()))).toBe(true);
    // Both letter-containing sentences must be present
    expect(result.some(c => c.text.includes('Climate data shows'))).toBe(true);
    expect(result.some(c => c.text.includes('AI systems improve'))).toBe(true);
  });
});

// ── splitSentences regex variants in word-count split (MH19–MH20) ─────────────

describe('guaranteeClaimPerSentence — word-count split regex', () => {
  // MH19: sentence with 2 real words but double-space → kills `split(/\s+/)` → `split(/\s/)`
  // "Foo  bar." split(/\s+/) = ["Foo", "bar."] → length 2 → EXCLUDED
  // "Foo  bar." split(/\s/)  = ["Foo", "", "bar."] → length 3 → INCLUDED with mutant
  // Need 2 valid sentences so we bypass the `sentences.length < 2` early return.
  it('MH19: double-space 2-word sentence is excluded from synthetic claims', () => {
    const result = guaranteeClaimPerSentence(
      'Foo  bar. AI is verifying claims today. GPT confirms data accuracy always.',
      [],
    );
    // "Foo  bar." must NOT be added as a synthetic claim
    expect(result.every(c => !c.text.trim().startsWith('Foo'))).toBe(true);
    // Both valid sentences MUST be added
    expect(result.some(c => c.text.includes('AI is verifying'))).toBe(true);
    expect(result.some(c => c.text.includes('GPT confirms'))).toBe(true);
  });

  // MH20: plain 2-word sentence excluded → kills `split(/\s+/)` → `split(/\S+/)`
  // "Foo bar." split(/\s+/) = ["Foo", "bar."] → length 2 → EXCLUDED
  // "Foo bar." split(/\S+/) = ["", " ", ""] → length 3 → INCLUDED with mutant
  // Need 2 valid sentences to bypass the `sentences.length < 2` early return.
  it('MH20: plain 2-word sentence is not added as a synthetic claim', () => {
    const result = guaranteeClaimPerSentence(
      'Foo bar. GPT-5 achieves high accuracy on benchmarks. Climate models confirm rising temperatures.',
      [],
    );
    // "Foo bar." has only 2 words → must not appear as synthetic
    expect(result.every(c => !c.text.trim().startsWith('Foo bar'))).toBe(true);
    // Both valid sentences must appear
    expect(result.some(c => c.text.includes('GPT-5 achieves'))).toBe(true);
    expect(result.some(c => c.text.includes('Climate models confirm'))).toBe(true);
  });
});

// ── onProgress callbacks (MH21–MH23) ─────────────────────────────────────────

describe('scan — onProgress callback messages', () => {
  beforeEach(() => vi.clearAllMocks());

  // MH21: 'Extracting claims...' message is sent → kills NoCoverage StringLiteral line 121
  it('MH21: onProgress receives "Extracting claims..." at the start of scan', async () => {
    mockExtractClaims.mockResolvedValue([]);
    const messages: string[] = [];
    await scan('Some verifiable text here.', 'mock', undefined, undefined, (m) => messages.push(m));
    expect(messages).toContain('Extracting claims...');
  });

  // MH22: per-claim progress with correct 1-based index → kills ArithmeticOperator i+1→i-1 line 128
  it('MH22: onProgress sends "Verifying claim 1/2..." and "Verifying claim 2/2..."', async () => {
    mockExtractClaims.mockResolvedValue(makeClaims(2));
    mockVerifyClaim.mockResolvedValue(vr('supported', 'cx'));
    const messages: string[] = [];
    await scan('Two claims text here now.', 'mock', undefined, undefined, (m) => messages.push(m));
    // 1-based: claim 1/2 then claim 2/2 — with i-1 mutant: "claim 0/2" and "claim 1/2"
    expect(messages.some(m => m.includes('Verifying claim 1/2'))).toBe(true);
    expect(messages.some(m => m.includes('Verifying claim 2/2'))).toBe(true);
    expect(messages.every(m => !m.includes('Verifying claim 0/'))).toBe(true);
  });

  // MH23: 'Generating report...' message is sent → kills NoCoverage StringLiteral line 132
  it('MH23: onProgress receives "Generating report..." after verification', async () => {
    mockExtractClaims.mockResolvedValue([]);
    const messages: string[] = [];
    await scan('Text for report generation.', 'mock', undefined, undefined, (m) => messages.push(m));
    expect(messages).toContain('Generating report...');
  });
});

// ── Default provider 'gemini' (MH24) ──────────────────────────────────────────

describe('scan — default provider fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  // MH24: `providerName || 'gemini'` → kills StringLiteral `'gemini'` → `''`
  // With mutant `|| ''`: resolvedProvider = '' → error says `No API key found for ""`
  // Original: error says `No API key found for "gemini"`
  it('MH24: scan() without providerName throws naming "gemini" as the missing provider', async () => {
    const orig = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    try {
      await expect(scan('Some text here.')).rejects.toThrow(/No API key found for "gemini"/);
    } finally {
      if (orig !== undefined) process.env['GEMINI_API_KEY'] = orig;
    }
  });
});

// ── collectFiles / walk filesystem traversal (MH25–MH30) ─────────────────────

describe('batchScan — collectFiles filesystem traversal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractClaims.mockResolvedValue([]);
  });

  // MH25: walk recurses into subdirectory → kills BlockStatement on isDirectory branch (line 181)
  it('MH25: batchScan finds files in subdirectories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-mh25-'));
    try {
      const sub = join(dir, 'subdir');
      mkdirSync(sub);
      writeFileSync(join(sub, 'deep.txt'), 'This is verifiable text from a subdirectory file.');
      const r = await batchScan(dir, 'mock');
      // Without recursion (BlockStatement removed) → 0 files; with → 1 file
      expect(r.filesScanned).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // MH26: hidden directories are skipped → kills `.startsWith('.')` mutations (line 183)
  it('MH26: batchScan skips hidden directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-mh26-'));
    try {
      const hidden = join(dir, '.hidden');
      mkdirSync(hidden);
      writeFileSync(join(hidden, 'secret.txt'), 'This text should not be scanned.');
      const r = await batchScan(dir, 'mock');
      // Hidden dir skipped → 0 files
      expect(r.filesScanned).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // MH27: node_modules directory is skipped → kills `!== 'node_modules'` mutations (line 183)
  it('MH27: batchScan skips node_modules directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-mh27-'));
    try {
      const nm = join(dir, 'node_modules');
      mkdirSync(nm);
      writeFileSync(join(nm, 'package.txt'), 'This text should not be scanned.');
      const r = await batchScan(dir, 'mock');
      // node_modules skipped → 0 files
      expect(r.filesScanned).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // MH28: glob includes matching files → kills ConditionalExpression `if (matcher)` → false (line 188)
  it('MH28: batchScan with glob pattern includes matching files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-mh28-'));
    try {
      writeFileSync(join(dir, 'article.txt'), 'This is verifiable article text content.');
      writeFileSync(join(dir, 'notes.md'), 'These are markdown notes content.');
      const r = await batchScan(dir, 'mock', undefined, '*.txt');
      // Only .txt file matches glob → 1 file scanned
      expect(r.filesScanned).toBe(1);
      expect(r.results[0].file).toMatch(/\.txt$/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // MH29: glob excludes non-matching files → kills ConditionalExpression `if (matcher)` → true (line 188)
  it('MH29: batchScan with glob pattern excludes non-matching files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-mh29-'));
    try {
      writeFileSync(join(dir, 'article.txt'), 'Verifiable article text content here.');
      writeFileSync(join(dir, 'data.csv'), 'CSV data content should be excluded here.');
      const r = await batchScan(dir, 'mock', undefined, '*.txt');
      // .csv does NOT match *.txt glob
      expect(r.filesScanned).toBe(1);
      expect(r.results.every(res => res.file.endsWith('.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // MH30: globToRegex handles * wildcard and ? → kills NoCoverage in globToRegex (lines 204–209)
  it('MH30: batchScan glob with ? wildcard matches single character correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stryker-mh30-'));
    try {
      writeFileSync(join(dir, 'doc1.txt'), 'First document verifiable claim content.');
      writeFileSync(join(dir, 'doc2.txt'), 'Second document verifiable claim content.');
      writeFileSync(join(dir, 'document.txt'), 'Long name should not match single char.');
      writeFileSync(join(dir, 'other.md'), 'Markdown file should not match txt glob.');
      // "doc?.txt" matches doc1.txt and doc2.txt but NOT document.txt or other.md
      const r = await batchScan(dir, 'mock', undefined, 'doc?.txt');
      expect(r.filesScanned).toBe(2);
      expect(r.results.every(res => /^doc\d\.txt$/.test(res.file))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
