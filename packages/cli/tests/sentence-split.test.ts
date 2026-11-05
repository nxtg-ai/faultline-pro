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
import { guaranteeClaimPerSentence, splitSentences } from '../cli/scan.js';
import type { Claim } from '../types.js';
import { MAX_CLAIM_ID_LENGTH } from '../lib/verdict-guard.js';

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
    expect(result.find(c => c.id === 'c1')).toMatchObject({ id: 'c1' });
    expect(result.find(c => c.id === 'c2')).toMatchObject({ id: 'c2' });
  });

  it('does not add fragments shorter than 3 words as claims', () => {
    const claims: Claim[] = [];
    // "OK. Yes. No." — all fragments, none qualify as sentence candidates
    const result = guaranteeClaimPerSentence('OK. Yes. No.', claims);
    expect(result).toHaveLength(0);
  });
});

// ── Abbreviation-aware splitting (ce proof run, al:4e0038613d2563e1, 2026-10-12) ──
// The splitter used to cut at every ". ", so a case caption became fragments and
// "The Ninth Circuit later reached a similar result in Delmont v." was verified on
// its own and came back SUPPORTED against an unrelated case.

const CE_RUN2 =
  'In Park v. Kim, 91 F.4th 610 (2d Cir. 2024), the Second Circuit referred an attorney to its Grievance Panel ' +
  'after her brief cited a nonexistent case that she had obtained from ChatGPT. The Ninth Circuit later reached a ' +
  'similar result in Delmont v. Arcadia Freight Systems, Inc., 947 F.3d 1182 (9th Cir. 2020), holding that an ' +
  'attorney who files AI-generated citations without reading them violates Rule 11 even if a paralegal prepared the brief.';

describe('splitSentences(): case citations and abbreviations', () => {
  it('splits the ce run-2 input into its two whole sentences', () => {
    const s = splitSentences(CE_RUN2);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatch(/^In Park v\. Kim, .* from ChatGPT\.$/);
    expect(s[1]).toMatch(/^The Ninth Circuit later .*Delmont v\. Arcadia Freight Systems, Inc\., 947 F\.3d 1182 \(9th Cir\. 2020\), holding .* the brief\.$/);
  });

  it('never yields a fragment ending in a caption "v." or starting at a year', () => {
    for (const s of splitSentences(CE_RUN2)) {
      expect(s).not.toMatch(/\bv\.$/);
      expect(s).not.toMatch(/^\d{4}\)/);
    }
  });

  it('keeps initials, dotted abbreviations and titles inside the sentence', () => {
    expect(splitSentences('John F. Kennedy was president. The U.S. Supreme Court ruled on it. Dr. Smith of Acme Corp. agreed with that.'))
      .toEqual(['John F. Kennedy was president.', 'The U.S. Supreme Court ruled on it.', 'Dr. Smith of Acme Corp. agreed with that.']);
  });

  it('a lower-case word or a digit after a period continues the sentence', () => {
    expect(splitSentences('The rate fell to 3.5 percent in Jan. 2024 and then rose. It rose again in spring.'))
      .toEqual(['The rate fell to 3.5 percent in Jan. 2024 and then rose.', 'It rose again in spring.']);
  });

  it('still splits at ! and ? and at a closing quote', () => {
    expect(splitSentences('GPT-5 has 98% accuracy! Is that really true? He said it was "final." Then it ended there.'))
      .toEqual(['GPT-5 has 98% accuracy!', 'Is that really true?', 'He said it was "final."', 'Then it ended there.']);
  });

  it('guaranteeClaimPerSentence adds no caption fragment for the ce run-2 claims', () => {
    // c1..c6 exactly as the extractor returned them in ce run 2.
    const extracted: Claim[] = [
      { id: 'c1', type: 'fact', importance: 5, text: 'In Park v. Kim, 91 F.4th 610 (2d Cir. 2024), the Second Circuit referred an attorney to its Grievance Panel.' },
      { id: 'c2', type: 'fact', importance: 4, text: "The attorney's brief cited a nonexistent case." },
      { id: 'c3', type: 'fact', importance: 4, text: 'The nonexistent case was obtained from ChatGPT.' },
      { id: 'c4', type: 'fact', importance: 5, text: 'The Ninth Circuit reached a similar result in Delmont v. Arcadia Freight Systems, Inc., 947 F.3d 1182 (9th Cir. 2020).' },
      { id: 'c5', type: 'fact', importance: 5, text: 'The Ninth Circuit held that an attorney who files AI-generated citations without reading them violates Rule 11.' },
      { id: 'c6', type: 'fact', importance: 4, text: 'This violation of Rule 11 occurs even if a paralegal prepared the brief.' },
    ];
    const synthetic = guaranteeClaimPerSentence(CE_RUN2, extracted).filter(c => c.id.startsWith('s'));
    for (const c of synthetic) {
      expect(c.text).not.toMatch(/\bv\.$/);
      expect(c.text).not.toMatch(/^\d{4}\)/);
      // A backstop claim is a whole sentence, so it carries the citation it is about.
      if (/Ninth Circuit/.test(c.text)) expect(c.text).toContain('Delmont v. Arcadia Freight Systems');
    }
  });
});

// ── Linear time on long punctuation runs ────────────────────────────────────

describe('splitSentences: long punctuation runs', () => {
  it.each(['!', '.'])('returns quickly on a 50,000-character run of %s with no following space', (ch) => {
    const text = 'a ' + ch.repeat(50_000);
    const t0 = performance.now();
    const out = splitSentences(text);
    const elapsed = performance.now() - t0;
    expect(Array.isArray(out)).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  // Expected outputs were recorded from splitSentences before the lookbehind
  // was added, so these pin the behaviour on ordinary text.
  const cases: Array<[string, string[]]> = [
    ['He said "This is true." Then he left the room quickly.',
      ['He said "This is true."', 'Then he left the room quickly.']],
    ['Is that really the case?! Nobody seems to know the answer.',
      ['Is that really the case?!', 'Nobody seems to know the answer.']],
    ['Wait for it... The results came in late last night.',
      ['Wait for it...', 'The results came in late last night.']],
    ['Dr. Smith treated the patient. The patient recovered fully afterwards.',
      ['Dr. Smith treated the patient.', 'The patient recovered fully afterwards.']],
    ['The sky is blue.  The grass is green today.',
      ['The sky is blue.', 'The grass is green today.']],
    ['The study (published in 2020.) was cited widely. Critics disagreed with its method.',
      ['The study (published in 2020.) was cited widely.', 'Critics disagreed with its method.']],
    ['This is amazing!!! Everyone should try it today.',
      ['This is amazing!!!', 'Everyone should try it today.']],
    ['The trial ended in March. It was a total success!!!',
      ['The trial ended in March.', 'It was a total success!!!']],
    ["She asked 'why not?' Then she walked away from the desk.",
      ["She asked 'why not?'", 'Then she walked away from the desk.']],
    ['Prices rose 5.2 percent in 2023. Wages did not keep up.',
      ['Prices rose 5.2 percent in 2023.', 'Wages did not keep up.']],
  ];

  it.each(cases)('splits %j exactly as before', (input, expected) => {
    const out = splitSentences(input);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toEqual(expected);
  });
});

describe('splitSentences: long word before a boundary', () => {
  it.each([' . ', '. '])('returns quickly when 50,000 letters are followed by %j', (sep) => {
    const text = 'a'.repeat(50_000) + sep + 'Next three words.';
    const t0 = performance.now();
    const out = splitSentences(text);
    const elapsed = performance.now() - t0;
    expect(out.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });

  // Expected outputs were recorded from splitSentences before the last word was
  // found with a backward scan, so these pin the behaviour on ordinary text.
  const cases: Array<[string, string[]]> = [
    ['Dr. Smith arrived at noon. He examined the patient carefully.',
      ['Dr. Smith arrived at noon.', 'He examined the patient carefully.']],
    ['Use a solvent, e.g. Acetone works well. Then rinse the glass twice.',
      ['Use a solvent, e.g. Acetone works well.', 'Then rinse the glass twice.']],
    ['John F. Kennedy was elected in 1960. He served until 1963 in office.',
      ['John F. Kennedy was elected in 1960.', 'He served until 1963 in office.']],
    ['The U.S. Army grew quickly. Recruitment doubled within one year.',
      ['The U.S. Army grew quickly.', 'Recruitment doubled within one year.']],
    ['Growth was 3.75 percent last year. Analysts expected far more than that.',
      ['Growth was 3.75 percent last year.', 'Analysts expected far more than that.']],
    ['It cost $4.50 at the store. Nobody complained about the price.',
      ['It cost $4.50 at the store.', 'Nobody complained about the price.']],
    ['"We won the case." The lawyer smiled at the waiting crowd.',
      ['"We won the case."', 'The lawyer smiled at the waiting crowd.']],
    ['She said “no.” Then she left the room quietly.',
      ['She said “no.” Then she left the room quietly.']],
    ['See the report (Fig. 3) for details. Results varied by region.',
      ['See the report (Fig. 3) for details.', 'Results varied by region.']],
    ['The value was high \t. Then it fell sharply after lunch.',
      ['The value was high \t.', 'Then it fell sharply after lunch.']],
    ['The value was high\n. Then it fell sharply after lunch.',
      ['The value was high\n.', 'Then it fell sharply after lunch.']],
    ['The vote was close . Then the count was repeated twice.',
      ['The vote was close .', 'Then the count was repeated twice.']],
    ['He met Mr. Jones at the bank. They talked about rates.',
      ['He met Mr. Jones at the bank.', 'They talked about rates.']],
    ['He met Dr. Smith at the clinic today.',
      ['He met Dr. Smith at the clinic today.']],
    ['He thanked Prof. Lee for the long talk.',
      ['He thanked Prof. Lee for the long talk.']],
    ['The note said\tMr. Jones would come back tomorrow.',
      ['The note said\tMr. Jones would come back tomorrow.']],
    ['The list read\ne.g. Apples and pears were fine. Nothing else was.',
      ['The list read\ne.g. Apples and pears were fine.', 'Nothing else was.']],
  ];

  it.each(cases)('splits %j exactly as before', (input, expected) => {
    const out = splitSentences(input);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toEqual(expected);
  });
});

describe('guaranteeClaimPerSentence: synthetic ids are unique within the scan and within the meter limit', () => {
  it('never reuses an id the model already returned (a model claim named "s2" or "s3")', () => {
    const text = 'Alpha is first. Beta is second. Gamma is third. Delta is fourth.';
    const claims: Claim[] = [
      { id: 's2', text: 'Alpha is first', type: 'fact', importance: 3 },
      { id: 's3', text: 'Beta is second', type: 'fact', importance: 3 },
    ];
    const result = guaranteeClaimPerSentence(text, claims);
    expect(result.length).toBe(4);
    const ids = result.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2)).toEqual(['s2', 's3']);
    expect(ids.slice(2)).toEqual(['s4', 's5']);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(MAX_CLAIM_ID_LENGTH);
  });

  it('many synthetic claims: every id distinct and within the limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} states fact ${i * 7}.`).join(' ');
    const claims: Claim[] = Array.from({ length: 5 }, (_, i) => ({ id: `s${i + 3}`, text: `unrelated claim ${i}`, type: 'fact' as const, importance: 3 }));
    const result = guaranteeClaimPerSentence(text, claims);
    expect(result.length).toBe(305);
    const ids = result.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(MAX_CLAIM_ID_LENGTH);
  });
});
