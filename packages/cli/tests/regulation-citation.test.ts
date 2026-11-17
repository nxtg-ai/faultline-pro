/**
 * Recognition of CFR, NCD and LCD citations, and paragraph paths in a recorded
 * eCFR section (42 CFR 422.101, issue date 2026-06-01). No network.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cfrHeading,
  cfrParagraphPaths,
  findRegulationCitations,
  isIdentityClaim,
} from '../lib/regulation-citation.js';

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/regulation', name), 'utf8');

describe('findRegulationCitations', () => {
  it('recognizes the three citation forms, including legal punctuation', () => {
    const text = [
      'See 42 CFR 422.101(c), 42 C.F.R. § 422.101(b)(3)(ii) and Title 42 CFR 422.101.',
      'NCD 220.6.17 and National Coverage Determination 220.6.',
      'LCD L33797, LCD 33794 and Local Coverage Determination L33791.',
    ].join(' ');
    const cites = findRegulationCitations(text);
    expect(cites.map((c) => c.label)).toEqual([
      '42 CFR 422.101(c)',
      '42 CFR 422.101(b)(3)(ii)',
      '42 CFR 422.101',
      'NCD 220.6.17',
      'NCD 220.6',
      'LCD L33797',
      'LCD L33794',
      'LCD L33791',
    ]);
    expect(cites[0]).toMatchObject({ kind: 'cfr', cfrTitle: '42', part: '422', section: '422.101', paragraphs: ['c'] });
    expect(cites[1]!.paragraphs).toEqual(['b', '3', 'ii']);
    expect(cites[5]).toMatchObject({ kind: 'lcd', lcdNumber: '33797' });
  });

  it('takes a quoted or parenthetical title and leaves a sentence parenthetical alone', () => {
    const quoted = findRegulationCitations('NCD 220.6.17 "Positron Emission Tomography (FDG) for Oncologic Conditions" applies.');
    expect(quoted[0]!.title).toBe('Positron Emission Tomography (FDG) for Oncologic Conditions');
    const paren = findRegulationCitations('42 CFR 422.101 (Requirements relating to basic benefits)');
    expect(paren[0]!.title).toBe('Requirements relating to basic benefits');
    expect(paren[0]!.paragraphs).toEqual([]);
    const note = findRegulationCitations('42 CFR 422.101(c) (see also the program manual).');
    expect(note[0]!.title).toBeUndefined();
    expect(note[0]!.paragraphs).toEqual(['c']);
  });

  it('does not treat a DOI, an LCD screen or a bare CFR part as a regulation citation', () => {
    expect(findRegulationCitations('The work "Deep learning", DOI 10.1038/nature14539 exists as cited.')).toEqual([]);
    expect(findRegulationCitations('The LCD screen is 27 inches across the desk.')).toEqual([]);
    expect(findRegulationCitations('45 CFR 164 and 34 CFR Part 99 are cited without a section.')).toEqual([]);
    expect(findRegulationCitations('NCD 220')).toEqual([]);
  });

  it('cuts the identifier before anything that is not part of it', () => {
    const [cite] = findRegulationCitations('42 CFR 422.101(c)/../../Confidential-Merger-Project-Zephyr');
    expect(cite).toMatchObject({ label: '42 CFR 422.101(c)', section: '422.101', paragraphs: ['c'] });
    expect(cite!.label).not.toContain('Confidential');
  });

  it('an identity claim is only the citation; a further assertion is not', () => {
    const cites = findRegulationCitations('See 42 CFR 422.101(c).');
    expect(isIdentityClaim('See 42 CFR 422.101(c).', cites.map((c) => ({ start: c.start, end: c.spanEnd })))).toBe(true);
    const more = '42 CFR 422.101(c) requires plans to cover every emergency service.';
    const found = findRegulationCitations(more);
    expect(isIdentityClaim(more, found.map((c) => ({ start: c.start, end: c.spanEnd })))).toBe(false);
    const titled = 'NCD 220.6.17 "Positron Emission Tomography (FDG) for Oncologic Conditions" exists as cited.';
    const titledCites = findRegulationCitations(titled);
    expect(isIdentityClaim(titled, titledCites.map((c) => ({ start: c.start, end: c.spanEnd })))).toBe(true);
  });
});

describe('eCFR section heading and paragraphs (recorded 42 CFR 422.101)', () => {
  const xml = fixture('ecfr-42-422.101.xml');
  const paths = cfrParagraphPaths(xml, '422.101');

  it('reads the heading off the versions record', () => {
    const versions = JSON.parse(fixture('ecfr-42-422.101-versions.json')) as { content_versions: Array<{ name: string }> };
    expect(cfrHeading(versions.content_versions.at(-1)!.name)).toBe('Requirements relating to basic benefits');
  });

  it('finds the paragraphs a citation names, and not ones the section does not have', () => {
    expect(paths).not.toBeNull();
    for (const path of ['c', 'c.1', 'b.3.ii', 'e.1', 'f.3.i', 'f.1.iii.B.1']) expect(paths!.has(path)).toBe(true);
    for (const path of ['z', 'a.1', 'c.9']) expect(paths!.has(path)).toBe(false);
  });

  it('a document that is not this section is not a paragraph index', () => {
    expect(cfrParagraphPaths('<html>422.101</html>', '422.101')).toBeNull();
    expect(cfrParagraphPaths(xml, '422.9999')).toBeNull();
  });

  it('a tag nested inside another tag does not hide a paragraph or invent one', () => {
    const nested = '<DIV8 N="422.101"><P><scr<script>ipt>(c) The plan covers emergency care.</P><P><E T="(z)">(a) The plan offers a benefit.</P></DIV8>';
    const found = cfrParagraphPaths(nested, '422.101');
    expect(found).not.toBeNull();
    expect(found!.has('c')).toBe(true);
    expect(found!.has('a')).toBe(true);
    expect(found!.has('z')).toBe(false);
    const unclosed = cfrParagraphPaths('<DIV8 N="1.1"><P><script(c) this marker stays inside the tag</P></DIV8>', '1.1');
    expect(unclosed).not.toBeNull();
    expect(unclosed!.has('c')).toBe(false);
  });
});
