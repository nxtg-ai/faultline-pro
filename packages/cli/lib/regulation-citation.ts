/**
 * US healthcare regulation citations found in claim text.
 *
 * A citation is recognized here, before any network call, and reduced to the
 * identifiers an official lookup may carry: a CFR title, part and section
 * (and paragraph designators), an NCD display id, or an LCD number. Nothing
 * else in the claim — a title, a secret, a query — can leave in a lookup URL,
 * because the URL is built only from these allowlisted pieces.
 *
 * Forms recognized (case-insensitive keywords):
 *   42 CFR 422.101(c)     42 C.F.R. § 422.101(b)(3)(ii)     Title 42 CFR 422.101
 *   NCD 220.6.17          National Coverage Determination 220.6.17
 *   LCD L33797            LCD 33797     Local Coverage Determination L33797
 *
 * An explicit title is only a quoted string, or a parenthetical of at least
 * three words that is not a sentence and does not start with "see" /
 * "including" / "e.g." / "i.e." / "cf" / "formerly". A parenthetical paragraph
 * marker such as (c) is part of the citation, not a title.
 */
const ROMANS: ReadonlySet<string> = new Set(
  'i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi xvii xviii xix xx xxi xxii xxiii xxiv xxv xxvi xxvii xxviii xxix xxx'.split(' '),
);

/** At most this many regulation citations are checked on one claim. More than that falls through. */
export const MAX_REGULATION_CITATIONS = 4;

const DESIGNATOR = String.raw`[a-z]{1,6}|\d{1,3}|[A-Z]`;
const CITATION_RE = new RegExp(String.raw`\b(?:title\s+)?(\d{1,2})\s*C\.?\s*F\.?\s*R\.?\s*(?:§\s*|section\s+)?(\d{1,4}\.\d{1,4})((?:\((?:${DESIGNATOR})\)){0,6})(?!\.\d)|\b(?:National\s+Coverage\s+Determination|NCD)\s+(?:NCD\s+)?(\d{1,3}(?:\.\d{1,3}){1,5})(?!\.\d)|\b(?:Local\s+Coverage\s+Determination|LCD)\s+(?:LCD\s+)?L?(\d{4,6})\b`, 'gi');

/** Words that carry no assertion of their own, so a claim that is only a citation still reads as one. */
const BOILERPLATE: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'as', 'by', 'in', 'on', 'at', 'is', 'are', 'was', 'were',
  'be', 'been', 'this', 'that', 'these', 'those', 'its', 'their', 'under', 'per', 'pursuant', 'see', 'cited',
  'exists', 'exist', 'regulation', 'regulations', 'section', 'sections', 'cfr', 'ncd', 'lcd', 'also', 'with',
  'from', 'titled', 'entitled', 'called', 'named', 'heading',
]);

export type RegulationKind = 'cfr' | 'ncd' | 'lcd';

export interface RegulationCitation {
  kind: RegulationKind;
  /** Canonical label, e.g. "42 CFR 422.101(c)", "NCD 220.6.17", "LCD L33797". */
  label: string;
  /** Start index in the claim text. */
  start: number;
  /** End index of the citation id, before an attached title. */
  end: number;
  /** End index including an attached title, for stripping the claim down to what else it asserts. */
  spanEnd: number;
  /** An explicit title attached to this citation, when the text gives one. */
  title?: string;
  /** CFR title number, "1" to "99", with no leading zero. */
  cfrTitle?: string;
  /** CFR part, the integer prefix of the section. */
  part?: string;
  /** CFR section, e.g. "422.101". */
  section?: string;
  /** Paragraph designators in order, e.g. ["c"] or ["b", "3", "ii"]. */
  paragraphs?: string[];
  /** NCD display id, e.g. "220.6.17". */
  ncdId?: string;
  /** LCD numeric id, e.g. "33797" (no L prefix, no leading zero). */
  lcdNumber?: string;
}

/** True for a paragraph mark the eCFR actually uses: a letter, a roman numeral, or a number. */
export function isDesignator(mark: string): boolean {
  if (/^\d{1,3}$/.test(mark)) return mark.length === 1 || !mark.startsWith('0');
  if (/^[A-Z]$/.test(mark)) return true;
  if (/^[a-z]$/.test(mark)) return true;
  return ROMANS.has(mark);
}

function noLeadingZero(part: string): boolean {
  return part.length === 1 || !part.startsWith('0');
}

function paragraphsOf(group: string): string[] | null {
  if (!group) return [];
  const tokens = [...group.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!);
  if (tokens.length === 0 || tokens.length > 6 || tokens.some((t) => !isDesignator(t))) return null;
  return tokens;
}

function isTitleParenthetical(inner: string): boolean {
  const text = inner.trim();
  if (/^(see|including|e\.g|i\.e|cf|formerly)\b/i.test(text)) return false;
  if (/[.!?]/.test(text)) return false;
  return text.split(/\s+/).filter((w) => w.length > 0).length >= 3;
}

/** A title glued to the citation with quotes or a parenthetical, or null. */
function attachedTitle(text: string, from: number): { title: string; end: number } | null {
  let rest = text.slice(from);
  const lead = rest.match(/^[\t \f\v]*[:,\u2014-]?[\t \f\v]*/);
  const skipped = lead ? lead[0].length : 0;
  // A separator is consumed only together with a title that follows it.
  const body = rest.slice(skipped);
  const quoted = /^[“"]([^”"\n]{1,300})[”"]/.exec(body);
  if (quoted && quoted[1]!.trim()) {
    return { title: quoted[1]!.trim(), end: from + skipped + quoted[0].length };
  }
  const paren = /^\(([^)\n]{1,300})\)/.exec(body);
  if (paren && isTitleParenthetical(paren[1]!)) {
    return { title: paren[1]!.trim(), end: from + skipped + paren[0].length };
  }
  return null;
}

/**
 * Every regulation citation in `text`, left to right, non-overlapping.
 * A match whose paragraph tokens are not designators is not a citation.
 */
export function findRegulationCitations(text: string): RegulationCitation[] {
  if (!text) return [];
  const found: RegulationCitation[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const base = { start, end, spanEnd: end };
    let cite: RegulationCitation | null = null;
    if (match[1] !== undefined && match[2] !== undefined) {
      const cfrTitle = match[1];
      const section = match[2];
      const paragraphs = paragraphsOf(match[3] ?? '');
      if (!/^[1-9]\d?$/.test(cfrTitle) || paragraphs === null) continue;
      const parts = section.split('.');
      if (parts.length !== 2 || !noLeadingZero(parts[0]!) || !noLeadingZero(parts[1]!)) continue;
      const label = `${cfrTitle} CFR ${section}${paragraphs.map((p) => `(${p})`).join('')}`;
      cite = { ...base, kind: 'cfr', label, cfrTitle, part: parts[0], section, paragraphs };
    } else if (match[4] !== undefined) {
      const ncdId = match[4];
      if (ncdId.split('.').some((p) => !noLeadingZero(p))) continue;
      cite = { ...base, kind: 'ncd', label: `NCD ${ncdId}`, ncdId };
    } else if (match[5] !== undefined) {
      const lcdNumber = match[5];
      if (!/^[1-9]\d{3,5}$/.test(lcdNumber)) continue;
      cite = { ...base, kind: 'lcd', label: `LCD L${lcdNumber}`, lcdNumber };
    }
    if (!cite) continue;
    const title = attachedTitle(text, end);
    if (title) {
      cite.title = title.title;
      cite.spanEnd = title.end;
    }
    found.push(cite);
  }
  return found;
}

/**
 * True when `text`, with every citation span (including an attached title)
 * removed, says nothing beyond the citation itself. A claim that still
 * asserts something ("covers emergency care") is not an identity claim.
 */
export function isIdentityClaim(text: string, spans: Array<{ start: number; end: number }>): boolean {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let masked = '';
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    masked += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  masked += text.slice(cursor);
  const words = masked.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  return words.every((w) => BOILERPLATE.has(w));
}

type Level = 'alpha' | 'num' | 'roman' | 'Alpha' | 'num2';

const CHILD: Record<Level, readonly Level[]> = {
  alpha: ['num'],
  num: ['roman', 'Alpha'],
  roman: ['Alpha'],
  Alpha: ['num2'],
  num2: [],
};

interface ParaNode { level: Level; token: string }

function levelOf(token: string, stack: ParaNode[]): Level | null {
  const top = stack.length > 0 ? stack[stack.length - 1]!.level : null;
  if (/^\d{1,3}$/.test(token)) return top === 'Alpha' || top === 'num2' ? 'num2' : 'num';
  if (/^[A-Z]$/.test(token)) return 'Alpha';
  const numbered = stack.some((n) => n.level === 'num' || n.level === 'roman' || n.level === 'num2');
  if (ROMANS.has(token) && (token.length > 1 || numbered)) return 'roman';
  if (/^[a-z]$/.test(token)) return 'alpha';
  return null;
}

/** Place one designator on a CFR paragraph stack. Null when it cannot sit anywhere. */
function place(stack: ParaNode[], token: string): ParaNode[] | null {
  const level = levelOf(token, stack);
  if (!level) return null;
  const next = stack.slice();
  while (next.length > 0) {
    const top = next[next.length - 1]!;
    if (CHILD[top.level].includes(level) || top.level === level) {
      if (top.level === level) next.pop();
      next.push({ level, token });
      return next;
    }
    next.pop();
  }
  return level === 'alpha' ? [{ level, token }] : null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, ent: string) => {
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', sect: '§', nbsp: ' ',
    };
    if (ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const cp = hex ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return all;
      return String.fromCodePoint(cp);
    }
    return named[ent.toLowerCase()] ?? all;
  });
}

/**
 * Drop XML tags by walking the string. A one-pass removal of `<...>` leaves
 * `<scr<script>ipt>` behind as `<script>`, which both hides a paragraph marker
 * and is the incomplete sanitizer CodeQL rejects. A `<` with no closing `>`
 * consumes the rest of the paragraph, so a marker inside an unclosed tag is
 * not read as a paragraph.
 */
function stripTags(value: string): string {
  let out = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '<') {
      depth += 1;
      continue;
    }
    if (ch === '>' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function plainParagraph(inner: string): string {
  return decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
}

/**
 * Paragraph paths in one eCFR section XML document ("c", "c.1", "b.3.ii").
 * Null when `xml` is not that section's document (no DIV8 for `section`):
 * the caller must not treat a missing path as a missing paragraph.
 * Measured against 42 CFR 422.101 as published for 2026-06-01.
 */
export function cfrParagraphPaths(xml: string, section: string): Set<string> | null {
  if (!xml.includes('<DIV8') || !xml.includes(`N="${section}"`)) return null;
  const paths = new Set<string>();
  let stack: ParaNode[] = [];
  for (const match of xml.matchAll(/<P>([\s\S]*?)<\/P>/gi)) {
    const text = plainParagraph(match[1] ?? '');
    const lead = new RegExp(String.raw`^(\((?:${DESIGNATOR})\))+`).exec(text);
    if (!lead) continue;
    const tokens = [...lead[0].matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!);
    if (!tokens.every((t) => isDesignator(t))) continue;
    let cur: ParaNode[] | null = stack;
    let ok = true;
    for (const token of tokens) {
      const placed = cur ? place(cur, token) : null;
      if (!placed) { ok = false; break; }
      cur = placed;
      paths.add(cur.map((n) => n.token).join('.'));
    }
    if (!ok || !cur) continue;
    stack = cur;
    const rest = text.slice(lead[0].length);
    const dash = /^[\s\S]{0,240}?—\(([a-z]{1,6}|\d{1,3}|[A-Z])\)/.exec(rest);
    const dot = /^[\s\S]{0,180}\. \(([a-z]{1,6}|\d{1,3}|[A-Z])\)/.exec(rest);
    const extra = dash?.[1] ?? dot?.[1] ?? null;
    if (extra && isDesignator(extra)) {
      const placed = place(stack, extra);
      if (placed) {
        stack = placed;
        paths.add(stack.map((n) => n.token).join('.'));
      }
    }
  }
  return paths;
}

/** The section heading without the "§ 422.101" marker, or null when nothing remains. */
export function cfrHeading(name: string): string | null {
  const text = decodeEntities(name).replace(/\s+/g, ' ').trim().replace(/^§\s*[\d.]+\s+/, '').replace(/\.+$/, '').trim();
  return text.length > 0 ? text : null;
}
