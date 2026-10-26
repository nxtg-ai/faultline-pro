/**
 * Claim scope: is a claim about the world, or about the document it came from?
 *
 * "The focus of the analysis is on 7B-class models" is true by construction for
 * the author of the analysis. Checking it against the web compares it with other
 * people's analyses and can return a contradiction that means nothing. Such a
 * claim is never sent for verification and never gets a verdict.
 *
 * The check is deterministic and makes no model call. It works on word tokens,
 * not regular expressions: every pattern below is a fixed-position comparison
 * against small word sets, so its cost is linear in the claim length and there
 * is nothing to backtrack (no ReDoS surface at all).
 *
 * When unsure it answers false. A missed document-relative claim is checked as
 * any other claim; a false positive would hide a real world claim, which is worse.
 */
import type { Claim } from '../types.js';

/** Explanation reported for a claim the check took out of verification. */
export const DOCUMENT_SCOPE_EXPLANATION =
  'About this document, not a claim about the world; not checked against the web.';

/** Nouns that can name the document a claim was extracted from. */
const DOC_NOUNS = new Set([
  'analysis', 'document', 'report', 'article', 'text', 'post', 'piece', 'paper',
  'summary', 'essay', 'write-up', 'writeup', 'guide', 'review', 'comparison',
  'overview', 'section', 'table', 'list',
]);

/** Third-person verbs the document can be the subject of ("this report covers ..."). */
const DOC_VERBS = new Set([
  'focuses', 'covers', 'discusses', 'includes', 'excludes', 'compares',
  'recommends', 'argues', 'concludes', 'shows', 'lists', 'describes',
  'summarizes', 'summarises', 'examines', 'assumes',
]);

/** Base forms, used after "does not", "will", "we" and "the authors". */
const BASE_VERBS = new Set([
  'focus', 'cover', 'discuss', 'include', 'exclude', 'compare', 'recommend',
  'argue', 'conclude', 'show', 'list', 'describe', 'summarize', 'summarise',
  'examine', 'assume',
]);

/** Verbs "we" can lead with in a document-relative claim. Kept short on purpose. */
const WE_VERBS = new Set(['focus', 'compare', 'cover', 'exclude', 'recommend']);

/** Adverbs that may sit between the subject and its verb ("this report only covers"). */
const ADVERBS = new Set([
  'only', 'also', 'mainly', 'primarily', 'mostly', 'specifically', 'deliberately',
  'intentionally', 'largely', 'chiefly',
]);

/** "is ..." continuations that describe the document's subject matter. */
const IS_CONTINUATIONS = new Set(['about', 'focused', 'limited', 'restricted', 'concerned']);

/** Words after a noun that tie it to an outside owner ("the report from the FDA"). */
const ATTRIBUTION_WORDS = new Set([
  'by', 'from', 'of', 'published', 'released', 'issued', 'commissioned', 'prepared',
  'written', 'authored', 'produced', 'conducted', 'for', 'at',
]);

/** Contractions split into their two words so "doesn't" reads as "does not". */
const CONTRACTIONS: Record<string, string[]> = {
  "doesn't": ['does', 'not'],
  "don't": ['do', 'not'],
  "isn't": ['is', 'not'],
  "won't": ['will', 'not'],
};

/** Lowercase word tokens. Hyphens, plus signs and apostrophes stay inside a word. */
export function scopeTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'+-]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '');
  return words.flatMap((word) => CONTRACTIONS[word] ?? [word]);
}

/**
 * True when the tokens from `start` are a document verb phrase:
 * "covers", "only covers", "does not cover", "will compare", "is about".
 */
function isDocVerbPhrase(t: string[], start: number): boolean {
  let i = start;
  if (ADVERBS.has(t[i])) i++;
  if (DOC_VERBS.has(t[i])) return true;
  if (t[i] === 'does' || t[i] === 'will') {
    i++;
    if (t[i] === 'not') i++;
    if (ADVERBS.has(t[i])) i++;
    return BASE_VERBS.has(t[i]);
  }
  if (t[i] === 'is') {
    i++;
    if (t[i] === 'not') i++;
    if (ADVERBS.has(t[i])) i++;
    return IS_CONTINUATIONS.has(t[i]);
  }
  return false;
}

/** True when the tokens from `start` are a base-form verb phrase: "recommend", "do not cover". */
function isBaseVerbPhrase(t: string[], start: number, verbs: Set<string>): boolean {
  let i = start;
  if (t[i] === 'do') {
    i++;
    if (t[i] !== 'not') return false;
    i++;
  }
  if (ADVERBS.has(t[i])) i++;
  return verbs.has(t[i]);
}

/** One document-scope pattern: a name for tests and docs, and a test over tokens. */
export interface DocumentScopePattern {
  name: string;
  test: (tokens: string[]) => boolean;
}

/**
 * Every pattern the check uses. A claim is document-relative when any one matches.
 * Each pattern requires the document noun to be "this" or a sentence-initial "the"
 * followed directly by a verb, so an owner ("Gartner's analysis", "the IPCC report"),
 * an article ("a report", "an analysis") or an attribution ("the report from the
 * FDA", "the analysis published in Nature") never matches.
 */
export const DOCUMENT_SCOPE_PATTERNS: DocumentScopePattern[] = [
  {
    // "The analysis does not focus on ...", "The comparison excludes ...":
    // sentence-initial "the" or "this", a document noun, then a document verb phrase.
    name: 'subject-initial',
    test: (t) => (t[0] === 'the' || t[0] === 'this') && DOC_NOUNS.has(t[1]) && isDocVerbPhrase(t, 2),
  },
  {
    // "Overall, this report recommends ...": "this" + document noun + verb phrase
    // anywhere in the claim. "this" points at the text in hand; "the" mid-sentence does not.
    name: 'subject-this-anywhere',
    test: (t) => t.some((w, i) => w === 'this' && DOC_NOUNS.has(t[i + 1]) && isDocVerbPhrase(t, i + 2)),
  },
  {
    // "The focus of the analysis is ...", "The main focus of this report ...":
    // the document's focus as subject, with no outside owner after the noun.
    name: 'focus-of-document',
    test: (t) => {
      const i = t[0] === 'the' && (t[1] === 'main' || t[1] === 'primary') ? 2 : 1;
      return t[0] === 'the' && t[i] === 'focus' && t[i + 1] === 'of'
        && (t[i + 2] === 'the' || t[i + 2] === 'this')
        && DOC_NOUNS.has(t[i + 3]) && !ATTRIBUTION_WORDS.has(t[i + 4]);
    },
  },
  {
    // "In this analysis, Phi-3 is the baseline": "in this" + document noun anywhere,
    // unless an owner follows ("in this report by McKinsey"). "in the report" is not
    // matched: it usually cites someone else's report.
    name: 'in-this-document',
    test: (t) => t.some((w, i) => w === 'in' && t[i + 1] === 'this' && DOC_NOUNS.has(t[i + 2])
      && !ATTRIBUTION_WORDS.has(t[i + 3])),
  },
  {
    // "Here we compare ...", "Here, we focus ...": the author speaking about the text.
    name: 'here-we',
    test: (t) => t[0] === 'here' && t[1] === 'we',
  },
  {
    // "The table below lists ...", "The section above covers ...": a part of the
    // document located by "below" or "above". Bare "below"/"above" is never enough
    // ("temperatures above 30 degrees" is a world claim).
    name: 'part-below-or-above',
    test: (t) => (t[0] === 'the' || t[0] === 'this') && DOC_NOUNS.has(t[1])
      && (t[2] === 'below' || t[2] === 'above'),
  },
  {
    // "Below, we compare ...", "Above we cover ...": the author pointing within the text.
    name: 'below-or-above-we',
    test: (t) => (t[0] === 'below' || t[0] === 'above') && t[1] === 'we',
  },
  {
    // "The authors recommend ...", "The author does not cover ...": the author as
    // subject, directly followed by a document verb. "The authors of the study ..." fails.
    name: 'author-subject',
    test: (t) => t[0] === 'the' && (t[1] === 'author' || t[1] === 'authors')
      && (isDocVerbPhrase(t, 2) || isBaseVerbPhrase(t, 2, BASE_VERBS)),
  },
  {
    // "We focus on ...", "We do not compare ...": the author's "we" with one of a
    // few framing verbs. "We are ..." and other "we" sentences are not matched.
    name: 'we-framing-verb',
    test: (t) => t[0] === 'we' && isBaseVerbPhrase(t, 1, WE_VERBS),
  },
];

/**
 * True when the claim's subject is the document itself rather than the world.
 *
 * @example
 *   isDocumentRelative('The analysis does not focus on 70B+ models.') // true
 *   isDocumentRelative("Gartner's analysis focuses on enterprise AI.")  // false
 *   isDocumentRelative('Mistral 7B was released in September 2023.')   // false
 */
export function isDocumentRelative(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const tokens = scopeTokens(text);
  return DOCUMENT_SCOPE_PATTERNS.some((pattern) => pattern.test(tokens));
}

/**
 * The claims with `scope: 'document'` set on each document-relative fact, so a
 * report can list them apart. Other claims are returned unchanged. This only
 * labels; verification eligibility calls isDocumentRelative on its own.
 */
export function markDocumentScope(claims: Claim[]): Claim[] {
  return claims.map((claim) =>
    claim.type === 'fact' && isDocumentRelative(claim.text) ? { ...claim, scope: 'document' as const } : claim,
  );
}
