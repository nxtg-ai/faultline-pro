/**
 * isDocumentRelative: claims about the document itself versus claims about the world.
 *
 * A false positive hides a real world claim from verification, so the world
 * table is as important as the document table.
 */
import { describe, it, expect } from 'vitest';
import {
  isDocumentRelative,
  markDocumentScope,
  scopeTokens,
  DOCUMENT_SCOPE_PATTERNS,
} from '../lib/claim-scope.js';
import type { Claim } from '../types.js';

const DOCUMENT_RELATIVE: string[] = [
  'The focus of the analysis is on roughly 7B-class models.',
  'The analysis does not focus on 70B+ models with small active parameter counts.',
  'This report covers three open-weight models.',
  'This document compares Llama 3 8B and Mistral 7B.',
  'The article argues that quantization matters more than parameter count.',
  'In this analysis, Phi-3 is treated as the baseline.',
  'Here we compare latency on consumer GPUs.',
  'The table below lists each model\'s context window.',
  'The authors recommend Qwen2 7B for multilingual tasks.',
  'We focus on models that run on a single GPU.',
  'We exclude mixture-of-experts models from the comparison.',
  'This comparison excludes closed-weight models.',
  'The summary concludes that 7B models are good enough for most chat use.',
  'This post is about running language models locally.',
  'This guide recommends 4-bit quantization for laptops.',
  'This section discusses licensing terms.',
  'The overview only includes models released after 2023.',
  'The write-up doesn’t cover fine-tuning.',
  'The main focus of this report is inference cost.',
  'Overall, this review shows Mistral 7B ahead on code tasks.',
  'Below, we compare memory use at 4-bit and 8-bit precision.',
  'We do not recommend running 13B models on 8 GB of memory.',
];

const WORLD: string[] = [
  "Gartner's analysis focuses on enterprise AI adoption.",
  'The IPCC report concludes that warming is accelerating.',
  'A 2024 report by McKinsey covers generative AI spending.',
  'The report from the FDA recommends new labeling rules.',
  'The analysis published in Nature shows a decline in bee populations.',
  'An analysis of 500 companies shows rising AI budgets.',
  'A report by the WHO covers air pollution deaths.',
  'A study found that grounded 7B models hallucinate less.',
  'Mistral 7B was released in September 2023.',
  'Llama 3 8B has a context window of 8,192 tokens.',
  'Temperatures above 30 degrees reduce wheat yields.',
  'Unemployment fell below 4 percent in 2023.',
  'The authors of the study found a 12 percent improvement.',
  'We are living through the warmest decade on record.',
  'In the report, the FDA said the drug was safe.',
  'The paper by Vaswani et al. introduced the transformer architecture.',
  'The Mueller report was released in April 2019.',
  'The analysis by Gartner covers 300 vendors.',
  'The table tennis world championships were held in Durban in 2023.',
  'The list price of the iPhone 15 was $799.',
  'The review board approved the drug in 2021.',
  'The report was released in 2019.',
  'In this report by McKinsey, AI adoption doubled.',
  'The author was born in 1950.',
];

describe('isDocumentRelative: claims about the document itself', () => {
  it.each(DOCUMENT_RELATIVE)('true: %s', (text) => {
    expect(isDocumentRelative(text), `expected document-relative: ${text}`).toBe(true);
  });

  it('has at least 15 document cases', () => {
    expect(DOCUMENT_RELATIVE.length).toBeGreaterThanOrEqual(15);
  });
});

describe('isDocumentRelative: claims about the world', () => {
  it.each(WORLD)('false: %s', (text) => {
    expect(isDocumentRelative(text), `expected a world claim: ${text}`).toBe(false);
  });

  it('has at least 15 world cases', () => {
    expect(WORLD.length).toBeGreaterThanOrEqual(15);
  });
});

describe('isDocumentRelative: edge inputs', () => {
  it('returns false for empty and whitespace-only text', () => {
    expect(isDocumentRelative('')).toBe(false);
    expect(isDocumentRelative('   ')).toBe(false);
  });

  it('returns false for a non-string value', () => {
    expect(isDocumentRelative(undefined as unknown as string)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isDocumentRelative('THIS REPORT COVERS THREE MODELS.')).toBe(true);
  });

  it('handles a long claim in linear time', () => {
    const long = 'this report covers '.repeat(20_000);
    const start = Date.now();
    expect(isDocumentRelative(long)).toBe(true);
    expect(isDocumentRelative('x '.repeat(50_000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe('scopeTokens', () => {
  it('splits contractions and keeps hyphens, plus signs and apostrophes inside words', () => {
    expect(scopeTokens("The write-up doesn't cover 70B+ models' costs.")).toEqual(
      ['the', 'write-up', 'does', 'not', 'cover', '70b+', "models'", 'costs'],
    );
  });
});

describe('DOCUMENT_SCOPE_PATTERNS', () => {
  it('every pattern fires on at least one document case and on no world case', () => {
    expect(DOCUMENT_SCOPE_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of DOCUMENT_SCOPE_PATTERNS) {
      const fires = DOCUMENT_RELATIVE.filter((text) => pattern.test(scopeTokens(text)));
      expect(fires.length, `pattern ${pattern.name} has no document case`).toBeGreaterThan(0);
      const falseFires = WORLD.filter((text) => pattern.test(scopeTokens(text)));
      expect(falseFires, `pattern ${pattern.name} fires on a world case`).toEqual([]);
    }
  });
});

describe('markDocumentScope', () => {
  it('sets scope on document-relative facts only and leaves other claims unchanged', () => {
    const claims: Claim[] = [
      { id: 'c1', text: 'This report covers three models.', type: 'fact', importance: 3 },
      { id: 'c2', text: 'Mistral 7B was released in September 2023.', type: 'fact', importance: 3 },
      { id: 'c3', text: 'This report covers three models.', type: 'opinion', importance: 3 },
    ];
    const marked = markDocumentScope(claims);
    expect(marked).toHaveLength(3);
    expect(marked[0].scope).toBe('document');
    expect(marked[1]).toBe(claims[1]);
    expect(marked[2]).toBe(claims[2]);
    expect(claims[0].scope).toBeUndefined();
  });
});
