/**
 * Citation claims (N-237).
 *
 * A reference list used to come back from extraction as about six field claims
 * per reference (title, year, pages, authors, DOI...). Under the verify cap of 8
 * only about two references were then checked, and each field was judged
 * against whatever the search found, often a different work. A cited work is
 * now ONE `fact` claim carrying a `citation` object, whose text says the work
 * exists as cited. This module holds the shared extraction rule, the parse-time
 * sanitizer and the deterministic claim text.
 */
import type { CitationRef, Claim } from '../types.js';

/** Longest value kept for one citation field; `raw` gets more room for a whole reference. */
const MAX_FIELD_CHARS = 500;
const MAX_RAW_CHARS = 2000;
const MAX_YEAR_CHARS = 16;

/**
 * The extraction rule every provider's prompt includes, so all four extract
 * citations the same way.
 */
export const CITATION_EXTRACTION_RULE = `CITATIONS RULE: A bibliography or reference-list entry, or an inline citation, is ONE claim, never one claim per field. For each cited work return a single claim with type "fact" and a "citation" object with the keys "title", "authors", "year", "venue", "doi" and "raw" (omit any key the text does not give; "raw" is the reference exactly as it appears in the text). Do NOT also return separate claims for the title, authors, year, volume, pages, venue or DOI of that work. An inline citation such as "(Smith et al., 2021)" that matches a reference-list entry adds nothing beyond that entry's claim. An inline citation with no matching entry is one citation claim with the authors and year it gives. The sentence an inline citation supports is still its own claim, without the citation.`;

/** The `citation` property for Gemini's responseSchema: structured output drops any property it does not declare. */
export const GEMINI_CITATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    authors: { type: 'STRING' },
    year: { type: 'STRING' },
    venue: { type: 'STRING' },
    doi: { type: 'STRING' },
    raw: { type: 'STRING' },
  },
} as const;

/** Longest DOI accepted; real DOIs are far shorter. */
export const MAX_DOI_CHARS = 200;
/** The characters a DOI may contain here: a strict subset of the DOI syntax, nothing that changes a URL. */
const DOI_SHAPE = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/;
/** A DOI at the start of a string, cut at the first character outside the allowed set. */
const DOI_HEAD = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/;
const DOI_IN_TEXT = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/;
const DOI_PREFIX = /^(?:https?:\/\/)?(?:dx\.)?(?:doi\.org\/)|^doi:\s*|^doi\s+/i;
const TRAILING_PUNCTUATION = /[.,;:]+$/;

/** Drop a trailing ")" only when it closes nothing inside the DOI (DOIs may contain balanced parentheses). */
function stripUnbalancedParen(doi: string): string {
  let out = doi;
  while (out.endsWith(')')) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }
  return out;
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when every `/`-separated segment is non-empty and none is `.` or `..` (no path traversal). */
function hasSafeSegments(doi: string): boolean {
  return doi.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * A cited DOI in canonical form, or null when `raw` is not a DOI. Strips a
 * resolver prefix (`https://doi.org/`, `dx.doi.org/`, `doi:`) and decodes
 * percent-escapes, then keeps `10.<registrant>/<suffix>` only up to the first
 * character outside `-._;()/:` and ASCII letters and digits (so the rest of a
 * reference is never swallowed), drops trailing punctuation and an unbalanced
 * closing parenthesis, and lowercases (DOIs are case-insensitive). It is then
 * ALLOWLISTED: the strict shape, at most MAX_DOI_CHARS characters, and no
 * empty, `.` or `..` path segment. Only a string that passes reaches a DOI
 * lookup URL, so nothing but a DOI can leave in that request, and it cannot
 * walk the URL path (N-237).
 *
 * @example
 *   normalizeDoi('https://doi.org/10.1038/NATURE14539.') // '10.1038/nature14539'
 *   normalizeDoi('doi: 10.1038/nature14539')            // '10.1038/nature14539'
 *   normalizeDoi('10.1038/../../secret')                // null
 *   normalizeDoi('not a doi')                           // null
 */
export function normalizeDoi(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let doi = raw.trim();
  for (let i = 0; i < 3 && DOI_PREFIX.test(doi); i++) doi = doi.replace(DOI_PREFIX, '').trim();
  const head = DOI_HEAD.exec(decodePercent(doi));
  if (!head) return null;
  doi = stripUnbalancedParen(head[0].replace(TRAILING_PUNCTUATION, '')).toLowerCase();
  if (doi.length > MAX_DOI_CHARS || !DOI_SHAPE.test(doi) || !hasSafeSegments(doi)) return null;
  return doi;
}

/** The first DOI written anywhere in `text`, normalized, or null. */
export function findDoiInText(text: string): string | null {
  const match = DOI_IN_TEXT.exec(text);
  return match ? normalizeDoi(match[0]) : null;
}

/** A field as a single-line string of at most `max` characters, or undefined when empty or not text. */
function cleanField(value: unknown, max: number): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat.slice(0, max) : undefined;
}

/** Authors may arrive as one string or a list of names. */
function cleanAuthors(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const names = value.map((v) => cleanField(v, MAX_FIELD_CHARS)).filter((v): v is string => v !== undefined);
    return names.length > 0 ? cleanField(names.join(', '), MAX_FIELD_CHARS) : undefined;
  }
  return cleanField(value, MAX_FIELD_CHARS);
}

/**
 * The citation object a model returned, reduced to known string fields of
 * bounded length, or undefined when it names neither a title nor authors and
 * a year (nothing to look up). A DOI that fails normalizeDoi is dropped; when
 * no `doi` is given, one written in `raw` is used.
 */
export function sanitizeCitation(value: unknown): CitationRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const raw = cleanField(v.raw, MAX_RAW_CHARS);
  const citation: CitationRef = {
    title: cleanField(v.title, MAX_FIELD_CHARS),
    authors: cleanAuthors(v.authors),
    year: cleanField(v.year, MAX_YEAR_CHARS),
    venue: cleanField(v.venue, MAX_FIELD_CHARS),
    doi: normalizeDoi(v.doi) ?? (raw ? findDoiInText(raw) : null) ?? undefined,
    raw,
  };
  if (!citation.title && !(citation.authors && citation.year)) return undefined;
  for (const key of Object.keys(citation) as Array<keyof CitationRef>) {
    if (citation[key] === undefined) delete citation[key];
  }
  return citation;
}

/**
 * The claim text for a citation, built from its fields so every provider
 * phrases it the same way and the verifier is asked whether the work exists
 * as cited.
 *
 * @example
 *   citationClaimText({ title: 'Deep learning', authors: 'LeCun, Y.', year: '2015', venue: 'Nature', doi: '10.1038/nature14539' })
 *   // 'The work "Deep learning" by LeCun, Y. (2015), DOI 10.1038/nature14539 exists as cited.'
 *   citationClaimText({ authors: 'Smith et al.', year: '2021' })
 *   // 'A work by Smith et al. (2021) exists as cited.'
 */
export function citationClaimText(c: CitationRef): string {
  const head = c.title ? `The work "${c.title}"` : 'A work';
  const by = c.authors ? ` by ${c.authors}` : '';
  const year = c.year ? ` (${c.year})` : '';
  // The venue stays on the claim's citation fields but out of the text the
  // verifier judges: volume, issue and conference numbering often differ for a
  // correct citation (NeurIPS 2017 is the 31st conference, proceedings volume
  // 30), and a judge asked about them contradicted a real paper.
  const doi = c.doi ? `, DOI ${c.doi}` : '';
  return `${head}${by}${year}${doi} exists as cited.`;
}

/** True for a claim extraction marked as a citation. */
export function isCitationClaim(claim: Claim): boolean {
  return claim.citation !== undefined && claim.citation !== null && typeof claim.citation === 'object';
}

/**
 * `item` (one extracted claim, already checked) with its citation applied: a
 * valid citation makes it a `fact` with the canonical text; an invalid one is
 * removed so nothing unchecked rides on the claim.
 */
export function applyCitation(claim: Claim): Claim {
  if (!('citation' in claim)) return claim;
  const citation = sanitizeCitation(claim.citation);
  if (!citation) {
    const { citation: _dropped, ...rest } = claim;
    return rest;
  }
  return { ...claim, type: 'fact', text: citationClaimText(citation), citation };
}

/** Lowercase alphanumerics and single spaces, for coverage matching. */
function normalizeForCoverage(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

const NOT_SURNAMES = new Set(['et', 'al', 'and', 'eds', 'ed']);

/** Author surnames (words of 2+ letters, lowercased) from an authors string; initials and "et al." left out. */
export function authorSurnames(authors: string | undefined): string[] {
  if (!authors) return [];
  return (authors.match(/\p{L}[\p{L}'\u2019-]+/gu) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => !NOT_SURNAMES.has(w));
}

/**
 * True when `line` is itself the reference entry for `c`: it names the work
 * (its DOI, or its title of at least 3 words) AND carries the citation's year
 * AND at least one author surname. A body sentence that only mentions the
 * title is not a reference entry.
 */
function isReferenceLine(line: string, c: CitationRef): boolean {
  const lower = line.toLowerCase();
  const title = c.title && c.title.split(/\s+/).length >= 3 ? c.title.toLowerCase() : undefined;
  const namesWork = (c.doi !== undefined && lower.includes(c.doi)) || (title !== undefined && lower.includes(title));
  if (!namesWork || !c.year || !lower.includes(c.year.toLowerCase())) return false;
  const words = new Set(lower.match(/\p{L}[\p{L}'\u2019-]+/gu) ?? []);
  return authorSurnames(c.authors).some((surname) => words.has(surname));
}

/**
 * The stretches of `text` the citation claims account for, normalized like
 * the per-sentence guarantee normalizes sentences: each citation's `raw`, or,
 * only when the model gave none, each line of `text` that is itself the
 * reference entry (isReferenceLine: the work, its year and an author surname
 * on one line). A sentence inside one of these is a fragment of a reference,
 * not a separate assertion. A body sentence that merely contains a cited
 * title is never suppressed (N-237).
 */
export function citationSpans(text: string, claims: Claim[]): string[] {
  const lines = text.split(/\r?\n/);
  const spans: string[] = [];
  for (const claim of claims) {
    const c = claim.citation;
    if (!c || typeof c !== 'object') continue;
    if (c.raw) {
      spans.push(normalizeForCoverage(c.raw));
      continue;
    }
    for (const line of lines) {
      if (isReferenceLine(line, c)) spans.push(normalizeForCoverage(line));
    }
  }
  return spans.filter((s) => s.length > 0);
}

/**
 * True when `sentence` is made of reference fragments: each of its lines
 * either starts inside one of `spans` (its first 40 normalized characters
 * appear in a span, the per-sentence guarantee's fingerprint) or is a short
 * line of under 3 words, such as a "References" heading the splitter joined to
 * the first entry; and at least one line is inside a span. A sentence can run
 * across two entries when one lacks closing punctuation, so lines are checked
 * one by one.
 */
export function isInsideReferences(sentence: string, spans: string[]): boolean {
  if (spans.length === 0) return false;
  const lines = sentence.split(/\r?\n/).map(normalizeForCoverage).filter((l) => l.length > 0);
  const inSpan = (line: string): boolean => spans.some((span) => span.includes(line.slice(0, 40)));
  return lines.some(inSpan) && lines.every((line) => inSpan(line) || line.split(' ').length < 3);
}
