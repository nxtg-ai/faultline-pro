/**
 * Claim scope: is a claim about the world, or about the document it came from?
 *
 * "The focus of the analysis is on 7B-class models" is true by construction for
 * the author of the analysis. Checking it against the web compares it with other
 * people's analyses and can return a contradiction that means nothing. Such a
 * claim is never sent for verification and never gets a verdict.
 *
 * Only a statement about the document's own scope or structure counts: what it
 * covers, focuses on, includes or excludes, compares, how it is organised. A
 * sentence that reports a proposition ("The report concludes that smoking causes
 * lung cancer") is a world claim even though its subject is a report: the
 * proposition still has to be checked. So the check fires only when all four hold:
 *
 *   1. no proposition: no verb such as shows, finds, concludes, argues,
 *      recommends or describes anywhere, and no "states that" clause;
 *   2. no third-party attribution anywhere: by, from (another source),
 *      according to, published, a capitalised possessive ("Gartner's");
 *   3. a scope statement: an explicit document subject ("this report", "our
 *      analysis", "the following section", "we") followed by a scope or
 *      structure verb. A bare "the report" only counts with a narrow set of
 *      scope verbs, because it often names someone else's report;
 *   4. the allow-shape (isPlainScopeObject, below): everything after the scope
 *      verb is a short list of plain noun phrases and nothing else. Rules 1
 *      and 2 are lists of words that block; rule 4 is a shape that must be
 *      met, so a sentence the lists did not foresee ("covers the fact that
 *      ...", "covers three models, all of which ...", "covers climate; la
 *      Tierra es plana") fails it.
 *
 * The check is deterministic and makes no model call. It works on word tokens
 * with fixed-position comparisons against small word sets, so its cost is linear
 * in the claim length and there is nothing to backtrack (no ReDoS surface).
 *
 * When unsure it answers false. A missed document-relative claim is checked as
 * any other claim; a false positive would hide a real world claim and take it out
 * of the charge and the risk score, which is worse.
 */

/** The fields the check reads. Structural, so the CLI, API and web app can all pass their own claim type. */
interface ScopedClaim {
  text: string;
  type: string;
  scope?: 'document';
}

/** Explanation reported for a claim the check took out of verification. */
export const DOCUMENT_SCOPE_EXPLANATION =
  'About this document, not a claim about the world; not checked against the web.';

/** Nouns that can name the document after "this", "these" or "our". */
const DOC_NOUNS = new Set([
  'analysis', 'analyses', 'document', 'report', 'article', 'text', 'post', 'piece',
  'paper', 'summary', 'essay', 'write-up', 'writeup', 'guide', 'review', 'comparison',
  'overview', 'study', 'answer', 'response', 'section', 'sections', 'chapter',
  'chapters', 'table', 'tables', 'list', 'page', 'pages', 'paragraph', 'paragraphs',
  'memo', 'brief', 'tutorial', 'evaluation', 'assessment',
]);

/**
 * Nouns accepted after a bare sentence-initial "the". Narrower than DOC_NOUNS:
 * "the study", "the table" and "the list" usually name something else.
 */
const BARE_DOC_NOUNS = new Set([
  'analysis', 'document', 'report', 'article', 'text', 'post', 'paper', 'summary',
  'essay', 'write-up', 'writeup', 'guide', 'review', 'comparison', 'overview',
  'answer', 'response',
]);

/** Parts of a document named by "the following ..." or "the preceding ...". */
const PART_NOUNS = new Set([
  'section', 'sections', 'chapter', 'chapters', 'table', 'tables', 'list', 'paragraph',
  'paragraphs', 'part', 'parts', 'page', 'pages', 'figure', 'figures',
]);

/** Words that point at a part of the text in hand ("the following section"). */
const POINTERS = new Set(['following', 'preceding', 'next', 'previous']);

/** Plural structure nouns counted by "has three parts", "contains five sections". */
const STRUCTURE_NOUNS = new Set([
  'parts', 'sections', 'chapters', 'subsections', 'tables', 'figures', 'appendices',
  'pages', 'paragraphs',
]);

const NUMBER_WORDS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]);

/** Objects of "presents": the document's own method, not a finding. */
const METHOD_NOUNS = new Set(['methodology', 'methodologies', 'method', 'methods', 'approach', 'framework', 'criteria']);

/** Words that may lead the sentence before its subject ("Here, we compare ..."). */
const LEADING_WORDS = new Set([
  'here', 'below', 'above', 'overall', 'instead', 'first', 'finally', 'specifically', 'also', 'so',
]);

/** Adverbs that may sit between the subject and its verb ("this report only covers"). */
const ADVERBS = new Set([
  'only', 'also', 'mainly', 'primarily', 'mostly', 'specifically', 'deliberately',
  'intentionally', 'largely', 'chiefly',
]);

/** Third-person scope verbs, mapped to their base form. */
const THIRD_PERSON: Record<string, string> = {
  focuses: 'focus', covers: 'cover', compares: 'compare', considers: 'consider',
  includes: 'include', excludes: 'exclude', discusses: 'discuss', evaluates: 'evaluate',
  examines: 'examine', outlines: 'outline', presents: 'present', has: 'have',
  contains: 'contain', consists: 'consist',
};

/** Base-form scope verbs (after "does not", "will", "we", "I", plural subjects). */
const BASE_SCOPE_VERBS = new Set([
  'focus', 'cover', 'compare', 'consider', 'include', 'exclude', 'discuss', 'evaluate',
  'examine', 'outline', 'present', 'have', 'contain', 'consist',
]);

/** "is ..." continuations that state the document's scope or structure. */
const BE_CONTINUATIONS = new Set([
  'about', 'focused', 'limited', 'restricted', 'organised', 'organized', 'structured', 'divided',
]);

/**
 * Verbs that introduce a proposition. Any one of them anywhere in the claim means
 * it asserts something about the world, so the check answers false. Words that are
 * also common nouns ("list", "claims", "states", "reports") are left out here and
 * caught by NOUN_OR_VERB + "that" instead.
 */
const PROPOSITION_VERBS = new Set([
  'show', 'shows', 'showed', 'shown', 'find', 'finds', 'found', 'conclude', 'concludes',
  'concluded', 'argue', 'argues', 'argued', 'demonstrate', 'demonstrates', 'demonstrated',
  'suggest', 'suggests', 'suggested', 'recommend', 'recommends', 'recommended',
  'describe', 'describes', 'described', 'lists', 'listed', 'prove', 'proves', 'proved',
  'proven', 'reveal', 'reveals', 'revealed', 'confirm', 'confirms', 'confirmed',
  'indicate', 'indicates', 'indicated', 'know', 'knows', 'knew', 'believe', 'believes',
  'believed', 'stated', 'reported', 'claimed', 'predict', 'predicts', 'predicted',
  'says', 'said', 'explains', 'explained', 'asserts', 'asserted', 'warns', 'warned',
  'contends', 'contended', 'establishes', 'established',
]);

/** Noun-or-verb words that introduce a proposition only when followed by "that". */
const NOUN_OR_VERB = new Set(['states', 'reports', 'claims', 'notes', 'holds', 'maintains', 'estimates']);

/** Words that tie the claim to an outside source wherever they appear. */
const ATTRIBUTION_WORDS = new Set([
  'by', 'according', 'published', 'publication', 'commissioned', 'authored', 'cited',
  'sponsored', 'funded',
]);

/** Contractions split into their two words so "doesn't" reads as "does not". */
const CONTRACTIONS: Record<string, string[]> = {
  "doesn't": ['does', 'not'],
  "don't": ['do', 'not'],
  "isn't": ['is', 'not'],
  "aren't": ['are', 'not'],
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

/** True for a document reference at `i`: "this report", "our analysis", "the comparison", "the following sections". */
function isDocReference(t: string[], i: number, allowBareThe: boolean): boolean {
  if ((t[i] === 'this' || t[i] === 'these' || t[i] === 'our') && DOC_NOUNS.has(t[i + 1])) return true;
  if (t[i] === 'the' && POINTERS.has(t[i + 1]) && PART_NOUNS.has(t[i + 2])) return true;
  return allowBareThe && t[i] === 'the' && BARE_DOC_NOUNS.has(t[i + 1]);
}

/** True when a document reference appears anywhere from `start` on. */
function hasDocReferenceFrom(t: string[], start: number, allowBareThe: boolean): boolean {
  for (let i = start; i < t.length; i++) if (isDocReference(t, i, allowBareThe)) return true;
  return false;
}

/**
 * True when the claim asserts a proposition: a proposition verb anywhere, or a
 * noun-or-verb such as "states" directly followed by "that".
 */
export function hasProposition(tokens: string[]): boolean {
  return tokens.some((w, i) => PROPOSITION_VERBS.has(w) || (NOUN_OR_VERB.has(w) && tokens[i + 1] === 'that'));
}

/** Letters, digits and apostrophes: the characters a word keeps at its end. */
function isWordEndChar(ch: string): boolean {
  return /[A-Za-z0-9'’]/.test(ch);
}

/**
 * `raw` without its trailing punctuation ("Gartner's," -> "Gartner's"). A loop,
 * not a `[^...]+$` regex: that regex retries from every start position and is
 * quadratic on a long run of punctuation.
 */
function trimTrailingPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0 && !isWordEndChar(raw.charAt(end - 1))) end--;
  return raw.slice(0, end);
}

/**
 * True when the claim names an outside source anywhere: an attribution word,
 * "et al", "from" anything other than the document itself ("from the comparison"
 * is fine, "from the FDA" is not), or a capitalised possessive ("Gartner's").
 */
export function hasAttribution(tokens: string[], text: string): boolean {
  const attributed = tokens.some((w, i) =>
    ATTRIBUTION_WORDS.has(w)
    || (w === 'et' && tokens[i + 1] === 'al')
    || (w === 'from' && !isDocReference(tokens, i + 1, true)));
  if (attributed) return true;
  return text.split(/\s+/).some((raw) => {
    const word = trimTrailingPunctuation(raw);
    const first = word.charAt(0);
    return first !== first.toLowerCase() && /['’]s?$/.test(word) && word.length > 2;
  });
}

type SubjectKind = 'explicit' | 'bare' | 'author' | 'focus';

interface Subject {
  kind: SubjectKind;
  /** Index of the first token after the subject. */
  next: number;
}

/**
 * The claim's subject, when it is the document or its author. Skips leading
 * words ("Here, ...", "Overall, ...") and a leading "In this report," frame.
 */
function findSubject(t: string[]): Subject | null {
  let i = 0;
  while (LEADING_WORDS.has(t[i])) i++;
  if (t[i] === 'in' && isDocReference(t, i + 1, false)) i += POINTERS.has(t[i + 2]) ? 4 : 3;

  if ((t[i] === 'this' || t[i] === 'these' || t[i] === 'our') && DOC_NOUNS.has(t[i + 1])) {
    return { kind: 'explicit', next: i + 2 };
  }
  if (t[i] === 'the' && POINTERS.has(t[i + 1]) && PART_NOUNS.has(t[i + 2])) {
    return { kind: 'explicit', next: i + 3 };
  }
  if (t[i] === 'we' || t[i] === 'i') return { kind: 'author', next: i + 1 };
  if (t[i] === 'the') {
    // "The (main) focus of the analysis is ...", "The focus of this report is ..."
    const f = t[i + 1] === 'main' || t[i + 1] === 'primary' ? i + 2 : i + 1;
    if (t[f] === 'focus' && t[f + 1] === 'of') {
      const ownerIsDoc = ((t[f + 2] === 'this' || t[f + 2] === 'our') && DOC_NOUNS.has(t[f + 3]))
        || (t[f + 2] === 'the' && BARE_DOC_NOUNS.has(t[f + 3]));
      return ownerIsDoc ? { kind: 'focus', next: f + 4 } : null;
    }
    if (BARE_DOC_NOUNS.has(t[i + 1])) return { kind: 'bare', next: i + 2 };
  }
  return null;
}

/**
 * Where the object of a scope or structure predicate starts, for a subject of
 * this kind, or -1 when the tokens from `start` are not such a predicate.
 * Present tense only: "the focus of the analysis was ..." describes a past
 * event, not the document's scope. What follows the returned index is the
 * object; isPlainScopeObject decides whether it has the allowed shape.
 */
function scopeObjectStart(t: string[], start: number, kind: SubjectKind): number {
  let i = start;
  if (kind === 'focus') return t[i] === 'is' && t[i + 1] !== undefined ? i + 1 : -1;

  let onlyBefore = false;
  if (ADVERBS.has(t[i])) { onlyBefore = t[i] === 'only'; i++; }

  // "is about", "is not limited to", "are organised into"
  if ((t[i] === 'is' || t[i] === 'are') && kind !== 'author') {
    i++;
    if (t[i] === 'not') i++;
    if (ADVERBS.has(t[i])) i++;
    return BE_CONTINUATIONS.has(t[i]) && t[i + 1] !== undefined ? i + 1 : -1;
  }

  let verb: string | undefined;
  if (t[i] === 'does' || t[i] === 'do' || t[i] === 'will') {
    i++;
    if (t[i] === 'not') i++;
    if (ADVERBS.has(t[i])) { onlyBefore = onlyBefore || t[i] === 'only'; i++; }
    verb = BASE_SCOPE_VERBS.has(t[i]) ? t[i] : undefined;
  } else if (kind === 'author') {
    verb = BASE_SCOPE_VERBS.has(t[i]) ? t[i] : undefined;
  } else {
    // Third person for "this report covers", base form for "these sections cover".
    verb = THIRD_PERSON[t[i]] ?? (BASE_SCOPE_VERBS.has(t[i]) ? t[i] : undefined);
  }
  if (verb === undefined) return -1;
  const after = i + 1;
  const only = onlyBefore || t[after] === 'only';
  const explicit = kind === 'explicit';
  // The object starts at `index` when `ok` holds and there is a word there.
  const at = (ok: boolean, index: number = after): number => (ok && t[index] !== undefined ? index : -1);

  switch (verb) {
    case 'focus': {
      const on = ADVERBS.has(t[after]) ? after + 1 : after;
      return at(t[on] === 'on', on + 1);
    }
    case 'cover':
      return at(true);
    case 'compare':
      return at(kind !== 'bare');
    case 'consider':
      return at(only);
    case 'include':
    case 'exclude':
      if (kind === 'author') return at(hasDocReferenceFrom(t, after, true));
      return at(explicit || only);
    case 'discuss':
    case 'evaluate':
    case 'examine':
    case 'outline':
      // "We discuss ..." only with an explicit document reference later
      // ("... of this comparison", "... in the following sections").
      if (kind === 'author') {
        return at((verb === 'discuss' || verb === 'outline') && hasDocReferenceFrom(t, after, false));
      }
      return at(explicit || verb === 'outline');
    case 'present': {
      const object = ['our', 'the', 'its', 'a', 'an'].includes(t[after]) ? after + 1 : after;
      return at(METHOD_NOUNS.has(t[object]) || (t[object] === 'evaluation' && t[object + 1] === 'criteria'));
    }
    case 'have':
    case 'contain':
    case 'consist': {
      if (kind === 'author') return -1;
      const n = verb === 'consist' && t[after] === 'of' ? after + 1 : after;
      return at((NUMBER_WORDS.has(t[n]) || /^[0-9]+$/.test(t[n] ?? '')) && STRUCTURE_NOUNS.has(t[n + 1]));
    }
    default:
      return -1;
  }
}

/** Where the object of the claim's scope predicate starts, or -1 when the claim is not a scope statement. */
function scopeObjectIndex(tokens: string[]): number {
  const subject = findSubject(tokens);
  return subject === null ? -1 : scopeObjectStart(tokens, subject.next, subject.kind);
}

/**
 * True when the claim's subject and verb are a statement about the document's
 * own scope or structure (rule 3). The object's shape is rule 4's, separately.
 */
export function isScopeStatement(tokens: string[]): boolean {
  return scopeObjectIndex(tokens) !== -1;
}

// ---------------------------------------------------------------------------
// Rule 4, the allow-shape.
//
// After the scope subject and verb, the rest of the sentence must be a short
// list of plain noun phrases and nothing else:
//
//   object := [preposition] NP ((preposition | and | or | plus) NP)*
//   NP     := (determiner | number)* content-word{1,5}     (or numbers alone)
//
// It fails, and the claim is verified, on any of:
//   - a clause marker: that, which, who, whom, whose, where, when, why, how,
//     whether, if, because, since, while, although, unless, as, but, so, "the
//     fact", not, ... ("all/some/none/each of which" fail on "which");
//   - a second finite verb: an auxiliary or copula (is, was, has, does, will,
//     can, ...), a proposition or scope verb, a past form or participle after
//     the first word of a noun phrase ("models trained on ..."), a plural-
//     looking word followed by another content word ("vaccines cause autism"),
//     or an -s or past word opening a phrase after "and"/"or" ("and causes");
//   - a determiner after a content word, or a pronoun: the subject of a new
//     clause ("covers the hoax the government staged", "... and it is");
//   - any punctuation after the verb other than a final full stop: a comma,
//     percent sign, apostrophe-free symbol, ...;
//   - anywhere in the sentence: a semicolon, colon, dash, bracket, double
//     quote, question or exclamation mark, slash, a non-ASCII character other
//     than a curly apostrophe, or a hyphenated word with a clause marker, verb
//     or empty part inside it ("asserts-that", "-", "climate-");
//   - a common function word of another language (la, es, est, der, ist, ...);
//   - an object over 12 words, a sentence over 30 words.
//
// When in doubt it answers false. A miss costs one ordinary check of a claim;
// a false positive is a world claim nobody checked.
//
// With no lexicon, a noun phrase ending in an -s verb ("... and the Arctic
// melts") has the same shape as one ending in a plural noun ("... the parameter
// counts"). The shape cannot tell them apart, so it refuses both: any noun
// phrase of two or more content words whose last word ends in "s" (not "ss",
// "us", "is") fails. This trades precision for safety on purpose.
// ---------------------------------------------------------------------------

/** Words that open a second clause or introduce a proposition. */
const CLAUSE_MARKERS = new Set([
  'that', 'which', 'who', 'whom', 'whose', 'where', 'when', 'whenever', 'wherever', 'why',
  'how', 'whether', 'if', 'because', 'since', 'although', 'though', 'unless', 'until',
  'while', 'whereas', 'so', 'but', 'yet', 'nor', 'then', 'what', 'whatever', 'whichever',
  'whoever', 'fact', 'facts', 'once', 'as', 'thus', 'hence', 'therefore', 'not', 'like',
  'unlike', 'despite', 'including', 'excluding', 'namely', 'ie', 'eg', 'etc',
]);

/** Auxiliaries and copulas: each one makes a finite verb. */
const AUXILIARIES = new Set([
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'has', 'have', 'had', 'do',
  'does', 'did', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'shall',
  'should', 'ought', 'cannot', 'get', 'gets', 'got',
]);

/** Pronouns: in the object they are the subject of a new clause. */
const PRONOUNS = new Set([
  'it', 'they', 'he', 'she', 'we', 'i', 'you', 'them', 'him', 'her', 'us', 'there', 'here',
  'itself', 'themselves',
]);

/** Common function words of other languages written in ASCII. Text in another language is not read as scope. */
const FOREIGN_WORDS = new Set([
  'la', 'el', 'los', 'las', 'es', 'est', 'son', 'sont', 'une', 'un', 'le', 'les', 'des', 'du',
  'der', 'die', 'das', 'ist', 'und', 'sind', 'ein', 'eine', 'nicht', 'il', 'lo', 'gli', 'och',
  'het', 'een', 'pas', 'ne', 'que', 'qui', 'y', 'e', 'de', 'del', 'en', 'sie', 'er', 'wir',
  'nous', 'vous', 'ils', 'elle', 'esta', 'este', 'sao', 'nao', 'muy', 'pero', 'con', 'por',
  'para', 'sur', 'avec', 'dans', 'mit', 'auf', 'zu', 'non', 'ja', 'si',
]);

/** Irregular past forms and participles: a second verb when they follow a noun ("models built on ..."). */
const IRREGULAR_PAST = new Set([
  'built', 'made', 'sold', 'taken', 'took', 'given', 'gave', 'written', 'wrote', 'held', 'kept',
  'left', 'lost', 'paid', 'put', 'run', 'ran', 'seen', 'saw', 'sent', 'set', 'spent', 'stolen',
  'stole', 'told', 'thought', 'grown', 'grew', 'known', 'knew', 'drawn', 'drew', 'driven', 'drove',
  'eaten', 'ate', 'fallen', 'fell', 'hidden', 'hid', 'broken', 'broke', 'chosen', 'chose', 'done',
  'gone', 'went', 'begun', 'began', 'bought', 'brought', 'caught', 'fought', 'taught', 'sought',
  'dealt', 'felt', 'led', 'meant', 'met', 'hurt', 'lent', 'bred', 'fed', 'fled', 'spread',
  'struck', 'sworn', 'torn', 'worn', 'born', 'became', 'come', 'came', 'rose', 'risen', 'thrown',
  'threw', 'flown', 'flew', 'spoken', 'spoke', 'frozen', 'froze', 'sung', 'sang', 'sunk', 'sank',
  'swum', 'swam', 'won',
]);

/** Words that may only open a noun phrase: determiners, quantifiers and number words. */
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'these', 'those', 'its', 'their', 'our', 'his', 'each', 'every', 'all',
  'some', 'any', 'both', 'several', 'many', 'few', 'fewer', 'more', 'less', 'most', 'roughly',
  'approximately', 'around', 'nearly', 'almost', 'only', 'just', 'than', 'least', 'one', 'other',
  'no', 'such', 'either', 'neither', 'another',
  // Number words and pointers count as determiners: "10 billion parameters", "the following sections".
  'hundred', 'thousand', 'million', 'billion', 'trillion', 'dozen',
  ...POINTERS,
  ...NUMBER_WORDS,
]);

/** Prepositions that may join two noun phrases of the object. */
const PREPOSITIONS = new Set([
  'on', 'in', 'of', 'for', 'from', 'with', 'without', 'at', 'into', 'to', 'across', 'between',
  'among', 'under', 'over', 'after', 'before', 'within', 'beyond', 'about', 'per', 'via',
  'versus', 'vs', 'against', 'through', 'during', 'up', 'onto', 'toward', 'towards', 'above',
  'below', 'beside', 'inside', 'outside', 'throughout',
]);

/** Coordinators that may join two noun phrases. */
const COORDINATORS = new Set(['and', 'or', 'plus']);

/** Words that are a second clause's verb wherever they appear: proposition verbs, noun-or-verbs, scope verbs. */
const VERB_WORDS = new Set([...PROPOSITION_VERBS, ...NOUN_OR_VERB, ...Object.keys(THIRD_PERSON)]);

const MAX_OBJECT_WORDS = 12;
const MAX_CONTENT_RUN = 5;
const MAX_CLAIM_WORDS = 30;

/** A word that starts with a digit: "2023", "70b+", "8b". */
function isNumberish(word: string): boolean {
  return /^[0-9]/.test(word);
}

/** Looks like a past form or participle: "trained", "released", "built". */
function looksPast(word: string): boolean {
  return (!word.includes('-') && word.length > 4 && word.endsWith('ed')) || IRREGULAR_PAST.has(word);
}

/** Looks like a plural noun or a third-person verb: "models", "causes". Not "class", "virus", "analysis". */
function looksPluralOrThirdPerson(word: string): boolean {
  return !word.includes('-') && word.length > 3 && word.endsWith('s')
    && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is') && !word.endsWith("'s");
}

/** Ends in "s" but not "ss", "us" or "is": could be a third-person verb ("kills", "melts"). */
function mayBeFiniteVerb(word: string): boolean {
  return word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is');
}

/** Never allowed in the object: clause markers, auxiliaries, verbs, pronouns, other-language words. */
function isBlockedWord(word: string): boolean {
  return CLAUSE_MARKERS.has(word) || AUXILIARIES.has(word) || VERB_WORDS.has(word)
    || PRONOUNS.has(word) || FOREIGN_WORDS.has(word);
}

/** A word that can sit in a noun phrase's run of content words. */
function isContentWord(word: string): boolean {
  return !isBlockedWord(word) && !DETERMINERS.has(word) && !PREPOSITIONS.has(word) && !COORDINATORS.has(word);
}

/** True for a hyphenated word with an empty part ("-", "climate-") or a blocked part ("asserts-that"). */
function hasBlockedHyphenPart(word: string): boolean {
  if (!word.includes('-')) return false;
  const parts = word.split('-');
  if (parts.some((part) => part === '')) return true;
  return parts.some((part) => isBlockedWord(part));
}

/** The claim as word and punctuation parts, in order; its words are exactly scopeTokens(text). */
type ShapePart = { word: string } | { punct: string };

function shapeParts(text: string): ShapePart[] {
  const parts: ShapePart[] = [];
  // The capture group keeps the separators: even pieces are words, odd pieces separators.
  const pieces = text.toLowerCase().replace(/[‘’]/g, "'").split(/([^a-z0-9'+-]+)/);
  pieces.forEach((piece, index) => {
    if (index % 2 === 0) {
      if (piece === '') return;
      for (const word of CONTRACTIONS[piece] ?? [piece]) parts.push({ word });
      return;
    }
    for (const ch of piece) if (ch.trim() !== '') parts.push({ punct: ch });
  });
  return parts;
}

/** Characters that join, quote or question a second clause wherever they are. */
const CLAUSE_PUNCTUATION = new Set([';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '"', '/', '\\', '|']);

/** Whole-sentence checks: punctuation, script, hyphenated words and length. */
function passesSentenceShape(text: string, tokens: string[]): boolean {
  for (const ch of text) {
    if (CLAUSE_PUNCTUATION.has(ch)) return false;
    // Non-ASCII: other-language or mixed-script text, curly quotes, dashes. Curly apostrophes are fine.
    if (ch.charCodeAt(0) > 127 && ch !== '‘' && ch !== '’') return false;
  }
  if (tokens.length > MAX_CLAIM_WORDS) return false;
  return !tokens.some(hasBlockedHyphenPart);
}

/**
 * True when `words`, the object of the scope verb, is a short list of plain
 * noun phrases: [preposition] NP ((preposition | coordinator) NP)*, each NP a
 * run of determiners or numbers, then one to five content words.
 */
function isNounPhraseList(words: string[]): boolean {
  const n = words.length;
  if (n === 0 || n > MAX_OBJECT_WORDS) return false;
  let i = PREPOSITIONS.has(words[0]) ? 1 : 0;
  let afterCoordinator = false;
  for (;;) {
    const start = i;
    while (i < n && (DETERMINERS.has(words[i]) || isNumberish(words[i]))) i++;
    let content = 0;
    while (i < n && !PREPOSITIONS.has(words[i]) && !COORDINATORS.has(words[i])) {
      const word = words[i];
      // Blocked words, and a determiner after a content word (a new clause's subject).
      if (!isContentWord(word) && !isNumberish(word)) return false;
      const next = words[i + 1];
      const nextIsContent = next !== undefined && !PREPOSITIONS.has(next) && !COORDINATORS.has(next);
      // A past form after the phrase's first word is a second verb ("models trained on ...").
      if (content > 0 && looksPast(word)) return false;
      // "vaccines cause autism": a plural-looking word followed by another content
      // word, other than an -ly adverb or a past form (the rule above judges that).
      if (looksPluralOrThirdPerson(word) && nextIsContent && !next.endsWith('ly') && !looksPast(next)) return false;
      // "... and causes autism", "... and kills", "... and killed millions": an -s
      // or past word straight after "and"/"or", with no determiner or number first.
      if (afterCoordinator && content === 0 && i === start && (looksPluralOrThirdPerson(word) || looksPast(word))) return false;
      content++;
      i++;
    }
    if (content > MAX_CONTENT_RUN) return false;
    // "the drug kills", "the Arctic melts": two or more content words ending in an
    // -s word may be a subject and its finite verb. "the parameter counts" has the
    // same shape, so it fails too. That trades precision for safety on purpose:
    // verifying a real scope statement costs one search, while skipping a world
    // claim is the worst outcome. A single-word head ("three models") still passes.
    if (content >= 2 && mayBeFiniteVerb(words[i - 1])) return false;
    // Determiners alone are not a noun phrase; numbers alone are ("after 2023").
    if (content === 0 && !words.slice(start, i).some(isNumberish)) return false;
    if (i >= n) return true;
    afterCoordinator = COORDINATORS.has(words[i]);
    i++;
    if (i >= n) return false;
  }
}

/**
 * Rule 4, the allow-shape: true when the sentence passes the whole-sentence
 * checks and everything after its scope verb is a plain noun-phrase list with
 * no punctuation but a final full stop. False for anything else, including a
 * sentence that is not a scope statement at all.
 */
export function isPlainScopeObject(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const tokens = scopeTokens(text);
  if (!passesSentenceShape(text, tokens)) return false;
  const objectStart = scopeObjectIndex(tokens);
  if (objectStart < 1) return false;
  // The object is every part after the last word before it, punctuation included.
  const parts = shapeParts(text);
  let words = 0;
  let from = -1;
  for (let p = 0; p < parts.length && from === -1; p++) {
    if ('word' in parts[p] && ++words === objectStart) from = p + 1;
  }
  if (from === -1) return false;
  const rest = parts.slice(from);
  let end = rest.length;
  while (end > 0 && 'punct' in rest[end - 1] && (rest[end - 1] as { punct: string }).punct === '.') end--;
  const object: string[] = [];
  for (const part of rest.slice(0, end)) {
    if ('punct' in part) return false;
    object.push(part.word);
  }
  return isNounPhraseList(object);
}

/**
 * True when the claim is about the document itself (its scope or structure)
 * rather than the world.
 *
 * @example
 *   isDocumentRelative('The analysis does not focus on 70B+ models.')            // true
 *   isDocumentRelative('This report contains five sections.')                    // true
 *   isDocumentRelative('The report concludes that smoking causes lung cancer.')  // false
 *   isDocumentRelative('This paper is about gravitational waves found by LIGO.') // false
 */
export function isDocumentRelative(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const tokens = scopeTokens(text);
  if (hasProposition(tokens)) return false;
  if (hasAttribution(tokens, text)) return false;
  return isScopeStatement(tokens) && isPlainScopeObject(text);
}

/**
 * The claims with `scope: 'document'` set on each document-relative fact, so a
 * report can list them apart. Other claims are returned unchanged. This only
 * labels; verification eligibility calls isDocumentRelative on its own.
 */
export function markDocumentScope<T extends ScopedClaim>(claims: T[]): T[] {
  return claims.map((claim) =>
    claim.type === 'fact' && isDocumentRelative(claim.text) ? { ...claim, scope: 'document' as const } : claim,
  );
}
