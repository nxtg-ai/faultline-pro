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
 * proposition still has to be checked. So the check fires only when all three hold:
 *
 *   1. no proposition: no verb such as shows, finds, concludes, argues,
 *      recommends or describes anywhere, and no "states that" clause;
 *   2. no third-party attribution anywhere: by, from (another source),
 *      according to, published, a capitalised possessive ("Gartner's");
 *   3. a scope statement: an explicit document subject ("this report", "our
 *      analysis", "the following section", "we") followed by a scope or
 *      structure verb. A bare "the report" only counts with a narrow set of
 *      scope verbs, because it often names someone else's report.
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

/** Words after a scope verb that turn it into a proposition ("covers how smoking causes cancer"). */
const CLAUSE_OPENERS = new Set(['how', 'why', 'whether', 'that']);

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
    const word = raw.replace(/[^A-Za-z0-9'’]+$/, '');
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

/** True when the token after a scope verb does not open a "how/why/that" clause. */
function noClause(t: string[], i: number): boolean {
  return !CLAUSE_OPENERS.has(t[i]);
}

/**
 * True when the tokens from `start` are a scope or structure predicate for a
 * subject of this kind. Present tense only: "the focus of the analysis was ..."
 * describes a past event, not the document's scope.
 */
function isScopePredicate(t: string[], start: number, kind: SubjectKind): boolean {
  let i = start;
  if (kind === 'focus') return t[i] === 'is' && t[i + 1] !== undefined;

  let onlyBefore = false;
  if (ADVERBS.has(t[i])) { onlyBefore = t[i] === 'only'; i++; }

  // "is about", "is not limited to", "are organised into"
  if ((t[i] === 'is' || t[i] === 'are') && kind !== 'author') {
    i++;
    if (t[i] === 'not') i++;
    if (ADVERBS.has(t[i])) i++;
    return BE_CONTINUATIONS.has(t[i]) && t[i + 1] !== undefined && noClause(t, i + 1);
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
  if (verb === undefined) return false;
  const after = i + 1;
  const only = onlyBefore || t[after] === 'only';
  const explicit = kind === 'explicit';

  switch (verb) {
    case 'focus': {
      const on = ADVERBS.has(t[after]) ? after + 1 : after;
      return t[on] === 'on' && t[on + 1] !== undefined && noClause(t, on + 1);
    }
    case 'cover':
      return t[after] !== undefined && noClause(t, after);
    case 'compare':
      return kind !== 'bare' && t[after] !== undefined && noClause(t, after);
    case 'consider':
      return only && t[after] !== undefined;
    case 'include':
    case 'exclude':
      if (kind === 'author') return hasDocReferenceFrom(t, after, true);
      return explicit || only;
    case 'discuss':
    case 'evaluate':
    case 'examine':
    case 'outline':
      // "We discuss ..." only with an explicit document reference later
      // ("... of this comparison", "... in the following sections").
      if (kind === 'author') {
        return (verb === 'discuss' || verb === 'outline') && noClause(t, after) && hasDocReferenceFrom(t, after, false);
      }
      return (explicit || verb === 'outline') && t[after] !== undefined && noClause(t, after);
    case 'present': {
      const object = ['our', 'the', 'its', 'a', 'an'].includes(t[after]) ? after + 1 : after;
      return METHOD_NOUNS.has(t[object]) || (t[object] === 'evaluation' && t[object + 1] === 'criteria');
    }
    case 'have':
    case 'contain':
    case 'consist': {
      if (kind === 'author') return false;
      const n = verb === 'consist' && t[after] === 'of' ? after + 1 : after;
      return (NUMBER_WORDS.has(t[n]) || /^[0-9]+$/.test(t[n] ?? '')) && STRUCTURE_NOUNS.has(t[n + 1]);
    }
    default:
      return false;
  }
}

/** True when the claim is a statement about the document's own scope or structure. */
export function isScopeStatement(tokens: string[]): boolean {
  const subject = findSubject(tokens);
  return subject !== null && isScopePredicate(tokens, subject.next, subject.kind);
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
  return isScopeStatement(tokens);
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
