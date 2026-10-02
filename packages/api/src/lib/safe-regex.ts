/**
 * Conservative ReDoS guard for caller-supplied regular expressions.
 *
 * Custom rules (`condition: 'regex_match'`) run a caller's pattern against
 * claim text on the request thread. V8's backtracking engine cannot be
 * interrupted, and the API runs on one Fly machine, so a single catastrophic
 * pattern is an outage for every customer. Measured on Node with a
 * 10,000-character input (2026-10-02): `.*x` 29 ms, `.*.*x` 93 s, `a*a*b` 100 s.
 *
 * Policy (static, no native dependency). A pattern is REJECTED when any of
 * these hold:
 *
 *   1. It is longer than MAX_PATTERN_LENGTH characters.
 *   2. It contains a backreference (`\1`..`\9`, `\k<name>`). Backreferences
 *      make matching NP-hard and no rule use needs them.
 *   3. A repeating quantifier (`*`, `+`, `{n,m}` with m > 1, `{n,}`) applies
 *      to a group whose body contains a quantifier or an alternation `|`.
 *      This is the exponential class: `(a+)+`, `(a*)*`, `(a|a)*`, `(\w+\s?)*`.
 *   4. It has more than one UNBOUNDED quantifier (`*`, `+`, `{n,}`, or
 *      `{n,m}` with m > MAX_BOUNDED_REPEAT). Two overlapping unbounded
 *      quantifiers are the polynomial class (`.*.*x`, `\d+\d+x`); telling
 *      overlapping from disjoint ones needs character-set analysis, so any
 *      second one is refused.
 *   5. The PATH PRODUCT, (max + 1) over every bounded quantifier times the
 *      branch count of every alternation, exceeds MAX_BOUNDED_PRODUCT, or
 *      exceeds MAX_PATHS_WITH_UNBOUNDED when the pattern also has an unbounded
 *      quantifier. This caps the paths tried per start position and catches
 *      quantifier-free exponential shapes (`(a|a)(a|a)(a|a)...x`, `a?a?a?...aaa`).
 *      The tighter limit exists because the unbounded quantifier already costs
 *      O(n^2) on a failed match and the path product multiplies it: measured at
 *      10,000 chars, `.*x` 50 ms but `.*(?:a|a){x8 groups}x` (product 256) 6.4 s.
 *
 * The checker over-rejects on purpose: `\w+\s+\w+` and `(?:a|b)*` are linear
 * in practice but refused. They can be rewritten as `\w+\s\w{1,20}` and `[ab]*`.
 * The input a pattern runs against is also capped (MAX_MATCH_TEXT_LENGTH),
 * because even one unbounded quantifier is quadratic on a failed match.
 */

/** Longest pattern accepted, in UTF-16 code units. */
export const MAX_PATTERN_LENGTH = 256;

/** Longest text any rule regex is executed against; longer text is truncated. */
export const MAX_MATCH_TEXT_LENGTH = 10_000;

/** A `{n,m}` with m above this counts as unbounded. */
export const MAX_BOUNDED_REPEAT = 20;

/** Path-product cap for a pattern with no unbounded quantifier. */
export const MAX_BOUNDED_PRODUCT = 256;

/** Path-product cap for a pattern that has one unbounded quantifier. */
export const MAX_PATHS_WITH_UNBOUNDED = 8;

export type RegexSafetyResult = { ok: true } | { ok: false; reason: string };

interface Quantifier {
  /** Characters consumed by the quantifier token, including a lazy `?`. */
  length: number;
  /** Maximum repetitions; Infinity when unbounded. */
  max: number;
}

interface GroupFrame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
  /** Number of `|`-separated branches directly inside this group. */
  branches: number;
}

interface Atom {
  /** True when the atom is a group whose body quantifies or alternates. */
  isRiskyGroup: boolean;
}

/** Reads a quantifier starting at `i`, or returns null when there is none. */
function readQuantifier(pattern: string, i: number): Quantifier | null {
  const ch = pattern[i];
  let length: number;
  let max: number;
  if (ch === '*' || ch === '+') {
    length = 1;
    max = Infinity;
  } else if (ch === '?') {
    length = 1;
    max = 1;
  } else if (ch === '{') {
    // Annex B: a `{` that is not a well-formed quantifier is a literal.
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
    if (!match) return null;
    length = match[0].length;
    if (match[2] === undefined) max = Number(match[1]);
    else max = match[3] === '' ? Infinity : Number(match[3]);
  } else {
    return null;
  }
  if (pattern[i + length] === '?') length += 1; // lazy suffix, same complexity
  return { length, max };
}

/** Index just past the `]` closing the class that opens at `i`. */
function skipCharacterClass(pattern: string, i: number): number {
  let j = i + 1;
  while (j < pattern.length && pattern[j] !== ']') {
    j += pattern[j] === '\\' ? 2 : 1;
  }
  return j + 1;
}

/** Number of characters in the group opener at `i` (`(`, `(?:`, `(?<n>` ...). */
function groupOpenerLength(pattern: string, i: number): number {
  if (pattern[i + 1] !== '?') return 1;
  const rest = pattern.slice(i + 1);
  const named = /^\?<[A-Za-z_$][\w$]*>/.exec(rest);
  if (named) return 1 + named[0].length;
  const look = /^\?(<=|<!|=|!|:)/.exec(rest);
  return look ? 1 + look[0].length : 1;
}

/** True when the escape at `i` (pattern[i] === '\\') is a backreference. */
function isBackreference(pattern: string, i: number): boolean {
  const next = pattern[i + 1];
  return (next !== undefined && next >= '1' && next <= '9') || next === 'k';
}

/**
 * Decide whether a caller-supplied pattern is safe to execute.
 *
 * @param pattern - The regex source, as it will be passed to `new RegExp`.
 * @returns `{ ok: true }` or `{ ok: false, reason }` naming the rule broken.
 *
 * @example
 * checkRegexSafety('\\b(best|largest)\\b') // { ok: true }
 * checkRegexSafety('(a+)+$')               // { ok: false, reason: '... nested quantifier ...' }
 */
export function checkRegexSafety(pattern: string): RegexSafetyResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `pattern is longer than ${MAX_PATTERN_LENGTH} characters` };
  }

  const stack: GroupFrame[] = [newFrame()];
  let lastAtom: Atom | null = null;
  let unbounded = 0;
  let pathProduct = 1; // Infinity on overflow, which still compares correctly
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];
    const top = stack[stack.length - 1];

    if (ch === '\\') {
      if (isBackreference(pattern, i)) {
        return { ok: false, reason: 'backreferences (\\1, \\k<name>) are not allowed' };
      }
      lastAtom = { isRiskyGroup: false };
      i += 2;
      continue;
    }
    if (ch === '[') {
      lastAtom = { isRiskyGroup: false };
      i = skipCharacterClass(pattern, i);
      continue;
    }
    if (ch === '(') {
      stack.push(newFrame());
      lastAtom = null;
      i += groupOpenerLength(pattern, i);
      continue;
    }
    if (ch === ')') {
      const closed = stack.length > 1 ? stack.pop()! : top;
      pathProduct *= closed.branches;
      const parent = stack[stack.length - 1];
      parent.hasQuantifier ||= closed.hasQuantifier;
      parent.hasAlternation ||= closed.hasAlternation;
      lastAtom = { isRiskyGroup: closed.hasQuantifier || closed.hasAlternation };
      i += 1;
      continue;
    }
    if (ch === '|') {
      top.hasAlternation = true;
      top.branches += 1;
      lastAtom = null;
      i += 1;
      continue;
    }

    const quantifier = readQuantifier(pattern, i);
    if (quantifier) {
      const repeats = quantifier.max > 1;
      if (repeats && lastAtom?.isRiskyGroup) {
        return {
          ok: false,
          reason: 'nested quantifier: a repeated group may not contain a quantifier or "|" (use a character class, e.g. [ab]*)',
        };
      }
      if (quantifier.max > MAX_BOUNDED_REPEAT) {
        unbounded += 1;
        if (unbounded > 1) {
          return {
            ok: false,
            reason: `more than one unbounded quantifier (*, +, {n,} or {n,m} with m > ${MAX_BOUNDED_REPEAT}); bound the others, e.g. \\s{1,5}`,
          };
        }
      } else if (quantifier.max > 0) {
        pathProduct *= quantifier.max + 1;
      }
      top.hasQuantifier = true;
      lastAtom = { isRiskyGroup: false };
      i += quantifier.length;
      continue;
    }

    lastAtom = { isRiskyGroup: false };
    i += 1;
  }

  pathProduct *= stack[0].branches;
  return checkPathProduct(pathProduct, unbounded > 0);
}

/** Rule 5: refuse when the number of alternative paths is too large. */
function checkPathProduct(pathProduct: number, hasUnbounded: boolean): RegexSafetyResult {
  const limit = hasUnbounded ? MAX_PATHS_WITH_UNBOUNDED : MAX_BOUNDED_PRODUCT;
  if (pathProduct <= limit) return { ok: true };
  const context = hasUnbounded ? ' alongside an unbounded quantifier' : '';
  return {
    ok: false,
    reason: `too many alternative paths${context} (bounded repeats x alternation branches > ${limit})`,
  };
}

function newFrame(): GroupFrame {
  return { hasQuantifier: false, hasAlternation: false, branches: 1 };
}

/**
 * Validate and compile a caller-supplied pattern in one step.
 *
 * @param pattern - The regex source.
 * @param flags - Flags used at execution time (compiled here so syntax errors surface).
 * @returns The compiled RegExp, or the reason it was refused.
 */
export function compileSafeRegex(
  pattern: string,
  flags: string,
): { ok: true; regex: RegExp } | { ok: false; reason: string } {
  const safety = checkRegexSafety(pattern);
  if (safety.ok === false) return safety;
  try {
    return { ok: true, regex: new RegExp(pattern, flags) };
  } catch {
    return { ok: false, reason: 'not a valid regular expression' };
  }
}
