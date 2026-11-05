// CodeQL #6 js/regex-injection: the static ReDoS guard for caller-supplied rule patterns.
import { describe, it, expect } from 'vitest';
import {
  checkRegexSafety,
  compileSafeRegex,
  MAX_PATTERN_LENGTH,
} from '../src/lib/safe-regex.js';

function refused(pattern: string): string {
  const result = checkRegexSafety(pattern);
  if (result.ok === true) throw new Error(`expected "${pattern}" to be refused`);
  return result.reason;
}

describe('checkRegexSafety: refuses dangerous shapes', () => {
  it.each([
    ['(a+)+$'],
    ['(a*)*b'],
    ['(\\w+\\s?)*$'],
    ['(?:a+){2,}'],
    ['(x+y)+z'],
    ['((ab)*c)+'],
  ])('nested quantifier %s', (pattern) => {
    expect(refused(pattern)).toMatch(/nested quantifier/);
  });

  it.each([['(a|a)*$'], ['(?:a|ab)+c'], ['(foo|bar){2,5}']])('quantified alternation %s', (pattern) => {
    expect(refused(pattern)).toMatch(/nested quantifier/);
  });

  it.each([['.*.*x'], ['a*a*b'], ['\\d+\\d+x'], ['\\w+\\s+\\w+'], ['a{1,}b{50}'], ['.*a|.*b']])(
    'more than one unbounded quantifier %s',
    (pattern) => {
      expect(refused(pattern)).toMatch(/more than one unbounded quantifier/);
    },
  );

  it.each([['(a)\\1'], ['(?<w>a)\\k<w>'], ['(a)(b)\\2']])('backreference %s', (pattern) => {
    expect(refused(pattern)).toMatch(/backreferences/);
  });

  it.each([
    ['(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)x'],
    ['a?a?a?a?a?a?a?a?a?aaaaaaaaa'],
    ['.*(?:a|a)(?:a|a)(?:a|a)(?:a|a)x'],
    ['a?a?a?a?.*x'],
  ])('too many alternative paths %s', (pattern) => {
    expect(refused(pattern)).toMatch(/too many alternative paths/);
  });

  it('refuses a pattern longer than the cap', () => {
    expect(refused('a'.repeat(MAX_PATTERN_LENGTH + 1))).toMatch(/longer than 256/);
  });

  it('does not treat quantifier characters inside a class or escape as quantifiers', () => {
    expect(checkRegexSafety('[+*]+x').ok).toBe(true);
    expect(checkRegexSafety('\\(a\\+\\)+').ok).toBe(true);
  });
});

describe('checkRegexSafety: accepts ordinary rule patterns', () => {
  it.each([
    ['\\b(best|largest|biggest|fastest|first.ever|world.record)\\b'],
    ['\\bfoo\\b'],
    ['\\d+%'],
    ['revenue (grew|rose|fell) \\d{1,3}%'],
    ['^\\s*$'],
    ['\\w{1,10}\\s\\w{1,10}'],
    ['a'.repeat(MAX_PATTERN_LENGTH)],
  ])('%s', (pattern) => {
    expect(checkRegexSafety(pattern)).toEqual({ ok: true });
  });
});

describe('compileSafeRegex', () => {
  it('compiles a safe pattern with the given flags', () => {
    const result = compileSafeRegex('\\bbest\\b', 'i');
    expect(result.ok).toBe(true);
    if (result.ok === true) expect(result.regex.test('The BEST one')).toBe(true);
  });

  it('reports a syntax error without throwing', () => {
    expect(compileSafeRegex('[unclosed', 'i')).toEqual({ ok: false, reason: 'not a valid regular expression' });
  });
});
