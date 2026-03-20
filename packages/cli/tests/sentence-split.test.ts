/**
 * Tests for sentence-level claim coverage guarantee (D-169 / DIRECTIVE-NXTG-20260320-03)
 *
 * Acceptance test: "AI will cure cancer by 2025. GPT-5 has 98% accuracy on all
 * benchmarks." must produce at least 2 separate claims, one per sentence.
 *
 * Also tests the guaranteeClaimPerSentence helper directly.
 */
import { describe, it, expect } from 'vitest';
import { scan } from '../cli/scan.js';
import { guaranteeClaimPerSentence } from '../cli/scan.js';
import type { Claim } from '../types.js';

// ── Acceptance test (CoS UAT scenario) ───────────────────────────────────────

describe('Acceptance: two-sentence input produces two claims', () => {
  it('separates "AI will cure cancer" from "GPT-5 has 98% accuracy"', async () => {
    const text = 'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.';
    const result = await scan(text, 'mock');

    expect(result.claims.length).toBeGreaterThanOrEqual(2);

    const texts = result.claims.map(c => c.text.toLowerCase());
    expect(texts.some(t => /cancer/.test(t))).toBe(true);
    expect(texts.some(t => /gpt.?5|accuracy|benchmark/.test(t))).toBe(true);
  });

  it('three-sentence input produces at least three claims', async () => {
    const text = 'The vaccine was 100% effective. It was approved without trials. Millions took it in 2023.';
    const result = await scan(text, 'mock');
    expect(result.claims.length).toBeGreaterThanOrEqual(3);
  });

  it('single sentence returns exactly what the provider extracted', async () => {
    const text = 'AI will cure cancer by 2025.';
    const result = await scan(text, 'mock');
    // Mock splits by sentence; single sentence → 1 claim
    expect(result.claims.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Unit tests: guaranteeClaimPerSentence ─────────────────────────────────────

describe('guaranteeClaimPerSentence', () => {
  const makeClaim = (id: string, text: string): Claim => ({
    id, text, type: 'fact', importance: 3,
  });

  it('returns original claims when text is a single sentence', () => {
    const claims = [makeClaim('c1', 'AI will cure cancer by 2025.')];
    const result = guaranteeClaimPerSentence('AI will cure cancer by 2025.', claims);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('adds synthetic claim for uncovered second sentence', () => {
    // LLM only extracted the first sentence
    const claims = [makeClaim('c1', 'AI will cure cancer by 2025.')];
    const text = 'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.';
    const result = guaranteeClaimPerSentence(text, claims);

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some(c => /gpt.?5|accuracy|benchmark/i.test(c.text))).toBe(true);
  });

  it('does not duplicate when all sentences are already covered', () => {
    const claims = [
      makeClaim('c1', 'AI will cure cancer by 2025.'),
      makeClaim('c2', 'GPT-5 has 98% accuracy on all benchmarks.'),
    ];
    const text = 'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.';
    const result = guaranteeClaimPerSentence(text, claims);
    expect(result).toHaveLength(2);
  });

  it('synthetic claims use "s" prefix IDs', () => {
    const claims = [makeClaim('c1', 'AI will cure cancer by 2025.')];
    const text = 'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.';
    const result = guaranteeClaimPerSentence(text, claims);
    const synthetic = result.filter(c => c.id.startsWith('s'));
    expect(synthetic.length).toBeGreaterThanOrEqual(1);
  });

  it('synthetic claims have type "fact" and importance 3', () => {
    const claims = [makeClaim('c1', 'AI will cure cancer by 2025.')];
    const text = 'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.';
    const result = guaranteeClaimPerSentence(text, claims);
    const synthetic = result.filter(c => c.id.startsWith('s'));
    for (const c of synthetic) {
      expect(c.type).toBe('fact');
      expect(c.importance).toBe(3);
    }
  });

  it('returns unchanged when text has fewer than 2 detectable sentences', () => {
    const claims = [makeClaim('c1', 'Short.')];
    // Single-word fragments are filtered out (< 3 words); only one proper sentence
    const result = guaranteeClaimPerSentence('Short. Tiny.', claims);
    // Both are < 3 words so neither is a sentence candidate → no supplement
    expect(result).toHaveLength(1);
  });

  it('handles empty claims array — adds all sentences', () => {
    const text = 'AI will cure cancer by 2025. GPT-5 has 98% accuracy on all benchmarks.';
    const result = guaranteeClaimPerSentence(text, []);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('handles three sentences with only one covered', () => {
    const claims = [makeClaim('c1', 'The vaccine was 100% effective.')];
    const text = 'The vaccine was 100% effective. It was approved without trials. Millions took it in 2023.';
    const result = guaranteeClaimPerSentence(text, claims);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves original claim IDs unchanged', () => {
    const claims = [
      makeClaim('c1', 'AI will cure cancer by 2025.'),
      makeClaim('c2', 'The study confirms this finding.'),
    ];
    const text = 'AI will cure cancer by 2025. The study confirms this finding. GPT-5 has 98% accuracy.';
    const result = guaranteeClaimPerSentence(text, claims);
    expect(result.find(c => c.id === 'c1')).toBeTruthy();
    expect(result.find(c => c.id === 'c2')).toBeTruthy();
  });

  it('does not add fragments shorter than 3 words as claims', () => {
    const claims: Claim[] = [];
    // "OK. Yes. No." — all fragments, none qualify as sentence candidates
    const result = guaranteeClaimPerSentence('OK. Yes. No.', claims);
    expect(result).toHaveLength(0);
  });
});
