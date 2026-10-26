/**
 * isDocumentRelative: claims about the document itself versus claims about the world.
 *
 * A false positive hides a real world claim from verification, from the charge
 * and from the risk score, so the world tables matter more than the document ones.
 */
import { describe, it, expect } from 'vitest';
import {
  isDocumentRelative,
  markDocumentScope,
  scopeTokens,
  hasProposition,
  hasAttribution,
  isScopeStatement,
} from '../lib/claim-scope.js';
import type { Claim } from '../types.js';

/** Statements about the document's own scope or structure. */
const DOCUMENT_RELATIVE: string[] = [
  'The focus of the analysis is on roughly 7B-class models.',
  'The analysis does not focus on 70B+ models with small active parameter counts.',
  'This report covers three open-weight models.',
  'This document compares Llama 3 8B and Mistral 7B.',
  'Here we compare latency on consumer GPUs.',
  'We focus on models that run on a single GPU.',
  'We exclude mixture-of-experts models from the comparison.',
  'This comparison excludes closed-weight models.',
  'This post is about running language models locally.',
  'This section discusses licensing terms.',
  'The overview only includes models released after 2023.',
  'The write-up doesn’t cover fine-tuning.',
  'The main focus of this report is inference cost.',
  'Below, we compare memory use at 4-bit and 8-bit precision.',
  'In this report, we compare three open-weight models.',
  'These sections cover licensing and hardware requirements.',
  'The report is organised into four sections.',
];

/** The ten document-relative formulations the independent review found missed. */
const REVIEW_DOCUMENT_RELATIVE: string[] = [
  'This study focuses on small language models.',
  'Our analysis focuses on open source models.',
  'This answer considers only models with fewer than 10 billion parameters.',
  'I discuss three approaches in the following sections.',
  'We discuss the limitations of this comparison.',
  'This analysis evaluates three models.',
  'This report contains five sections.',
  'This essay has three parts.',
  'This document presents our methodology.',
  'The following section outlines the evaluation criteria.',
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
  // Adversarial controls for each kind of pattern the check accepts.
  'This report compares three vaccines and concludes that Pfizer is the safest.',
  'Our analysis focuses on vaccines and shows that they reduce infections.',
  'This section discusses how smoking causes lung cancer.',
  'The analysis includes 50 hospitals in France.',
  'The study focuses on 2,000 women in Denmark.',
  'The report compares inflation in 2022 and 2023.',
  'Our report covers models released by Meta in 2024.',
  'The paper has three authors from Oxford.',
  'This treaty has three parts.',
  'We discuss politics at dinner every Sunday.',
  'The focus of the report was on rising crime in Chicago.',
  'The report covers why interest rates rose in 2022.',
];

/**
 * Formerly expected true. Each carries a world proposition (or has no scope
 * predicate), so it is now checked like any other claim.
 */
const MOVED_TO_WORLD: Array<[string, string]> = [
  ['The article argues that quantization matters more than parameter count.', '"argues that" introduces a proposition about quantization'],
  ['In this analysis, Phi-3 is treated as the baseline.', 'no scope or structure verb; the predicate is about Phi-3'],
  ['The table below lists each model\'s context window.', '"lists" carries the listed context windows, which are world facts'],
  ['The authors recommend Qwen2 7B for multilingual tasks.', '"recommend" asserts that Qwen2 7B suits multilingual tasks; "the authors" is ambiguous'],
  ['The summary concludes that 7B models are good enough for most chat use.', '"concludes that" introduces a proposition'],
  ['This guide recommends 4-bit quantization for laptops.', '"recommends" asserts that 4-bit quantization suits laptops'],
  ['Overall, this review shows Mistral 7B ahead on code tasks.', '"shows" asserts a benchmark result'],
  ['We do not recommend running 13B models on 8 GB of memory.', '"recommend" asserts a claim about memory requirements'],
];

/** The independent review's 30 world claims. Every one must stay checkable. */
const REVIEW_WORLD: string[] = [
  'The report concludes that smoking causes lung cancer.',
  'The analysis shows that global temperatures rose by 1.2 degrees Celsius.',
  'The paper argues that dark matter explains galactic rotation curves.',
  'The review recommends annual influenza vaccination.',
  'The summary lists 2023 revenue as $10 billion.',
  'The comparison shows that the RTX 4090 is faster than the RTX 3080.',
  'The report describes a 20 percent increase in malaria cases in Kenya.',
  'The analysis includes data from 50 hospitals in France.',
  'The article concludes that lead exposure damages the nervous system.',
  'The author recommends aspirin to reduce cardiovascular risk.',
  'The authors show that the vaccine reduced infections by 60 percent.',
  'The author of Dune was Frank Herbert.',
  'The analysis by the CDC found that vaccination reduced hospitalizations.',
  'The report states that inflation fell to 3 percent in June.',
  'The study found that exercise reduces blood pressure.',
  'Studies above 30 participants have greater statistical power.',
  'Temperatures below zero Celsius freeze pure water at standard pressure.',
  'We know that water boils at 100 degrees Celsius at sea level.',
  'We recommend vaccination because it prevents measles.',
  'We exclude patients with kidney failure from metformin treatment.',
  'This paper shows that the drug reduces mortality, according to the FDA.',
  'Scientists found errors in this report after its publication in Nature.',
  'The focus of the analysis was a clinical trial conducted at Oxford in 2020.',
  'Here we know that smoking causes cancer.',
  'The table below sea level is part of the regional groundwater aquifer.',
  'The report from the FDA concludes that the treatment is effective.',
  'The analysis published by the CDC shows a decline in infections.',
  'Above we know atmospheric pressure decreases with altitude.',
  'The author describes the discovery of penicillin in 1928.',
  'This paper is about the discovery of gravitational waves by LIGO in 2015.',
];

describe('isDocumentRelative: claims about the document itself', () => {
  it.each(DOCUMENT_RELATIVE)('true: %s', (text) => {
    expect(isDocumentRelative(text), `expected document-relative: ${text}`).toBe(true);
  });
});

describe('isDocumentRelative: document-relative formulations from the review', () => {
  it.each(REVIEW_DOCUMENT_RELATIVE)('true: %s', (text) => {
    expect(isDocumentRelative(text), `expected document-relative: ${text}`).toBe(true);
  });
});

describe('isDocumentRelative: claims about the world', () => {
  it.each(WORLD)('false: %s', (text) => {
    expect(isDocumentRelative(text), `expected a world claim: ${text}`).toBe(false);
  });

  it.each(MOVED_TO_WORLD)('false: %s (%s)', (text, reason) => {
    expect(isDocumentRelative(text), `expected a world claim (${reason}): ${text}`).toBe(false);
  });
});

describe('isDocumentRelative: the review\'s 30 world claims', () => {
  it.each(REVIEW_WORLD.map((text, i) => [i + 1, text] as const))('row %i false: %s', (_row, text) => {
    expect(isDocumentRelative(text), `expected a world claim: ${text}`).toBe(false);
  });
});

describe('isDocumentRelative: each exclusion does its own work', () => {
  it('a proposition verb anywhere blocks a sentence that otherwise reads as scope', () => {
    const text = 'This report compares three vaccines and concludes that Pfizer is the safest.';
    const tokens = scopeTokens(text);
    expect(isScopeStatement(tokens), 'subject and verb alone read as scope').toBe(true);
    expect(hasProposition(tokens)).toBe(true);
    expect(isDocumentRelative(text)).toBe(false);
  });

  it('a third-party attribution anywhere blocks "this paper is about ..."', () => {
    const text = 'This paper is about the discovery of gravitational waves by LIGO in 2015.';
    const tokens = scopeTokens(text);
    expect(isScopeStatement(tokens), 'subject and verb alone read as scope').toBe(true);
    expect(hasAttribution(tokens, text)).toBe(true);
    expect(isDocumentRelative(text)).toBe(false);
  });

  it('"from" a document part is not an attribution, "from" a named source is', () => {
    expect(hasAttribution(scopeTokens('We exclude closed models from the comparison.'), 'We exclude closed models from the comparison.')).toBe(false);
    expect(hasAttribution(scopeTokens('The report from the FDA covers labels.'), 'The report from the FDA covers labels.')).toBe(true);
  });

  it('a capitalised possessive is an attribution', () => {
    const text = "This report covers Gartner's survey.";
    expect(hasAttribution(scopeTokens(text), text)).toBe(true);
    expect(isDocumentRelative(text)).toBe(false);
  });

  it('only present tense states scope: "is" fires, "was" does not', () => {
    expect(isDocumentRelative('The focus of the analysis is a clinical trial.')).toBe(true);
    expect(isDocumentRelative('The focus of the analysis was a clinical trial.')).toBe(false);
  });

  it('"we" fires only with a scope verb: "we compare" yes, "we know" no', () => {
    expect(isDocumentRelative('We compare three models.')).toBe(true);
    expect(isDocumentRelative('We know three models.')).toBe(false);
  });

  it('"we exclude" needs the document as the thing excluded from', () => {
    expect(isDocumentRelative('We exclude closed models from this analysis.')).toBe(true);
    expect(isDocumentRelative('We exclude closed models from production.')).toBe(false);
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

  it('handles a long run of punctuation inside one word in linear time', () => {
    // A trailing-punctuation regex such as /[^A-Za-z0-9']+$/ is quadratic here.
    const word = `${'&'.repeat(100_000)}x`;
    const start = Date.now();
    expect(hasAttribution(scopeTokens(word), word)).toBe(false);
    expect(isDocumentRelative(`This report covers ${word}`)).toBe(isDocumentRelative('This report covers x'));
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('still reads a capitalised possessive followed by punctuation as attribution', () => {
    const text = "This report covers Gartner's, findings.";
    expect(hasAttribution(scopeTokens(text), text)).toBe(true);
  });
});

describe('scopeTokens', () => {
  it('splits contractions and keeps hyphens, plus signs and apostrophes inside words', () => {
    expect(scopeTokens("The write-up doesn't cover 70B+ models' costs.")).toEqual(
      ['the', 'write-up', 'does', 'not', 'cover', '70b+', "models'", 'costs'],
    );
  });
});

describe('markDocumentScope', () => {
  it('sets scope on document-relative facts only and leaves other claims unchanged', () => {
    const claims: Claim[] = [
      { id: 'c1', text: 'This report covers three models.', type: 'fact', importance: 3 },
      { id: 'c2', text: 'Mistral 7B was released in September 2023.', type: 'fact', importance: 3 },
      { id: 'c3', text: 'This report covers three models.', type: 'opinion', importance: 3 },
      { id: 'c4', text: 'The report concludes that smoking causes lung cancer.', type: 'fact', importance: 3 },
    ];
    const marked = markDocumentScope(claims);
    expect(marked).toHaveLength(4);
    expect(marked[0].scope).toBe('document');
    expect(marked[1]).toBe(claims[1]);
    expect(marked[2]).toBe(claims[2]);
    expect(marked[3]).toBe(claims[3]);
    expect(claims[0].scope).toBeUndefined();
  });
});
