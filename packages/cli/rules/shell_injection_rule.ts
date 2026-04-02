import type { Rule, Finding } from './base_rule.js';

/**
 * Unicode and control-character shell injection detection.
 *
 * Detects obfuscation techniques that regex-based YAML rules cannot catch:
 * zero-width characters, bidirectional overrides, control characters,
 * and homoglyph confusables.  These are the stealth vectors used in
 * prompt-injection attacks targeting AI-assisted development tools.
 *
 * Inspired by Claude Code's 21-check bash security layer (Tree-sitter AST
 * parsing, Unicode whitespace, backslash escape, control char detection).
 */

// ── Zero-width & invisible characters ────────────────────────────────────────

const ZERO_WIDTH: Record<number, string> = {
  0x200b: 'zero-width space',
  0x200c: 'zero-width non-joiner',
  0x200d: 'zero-width joiner',
  0xfeff: 'byte-order mark / zero-width no-break space',
  0x2060: 'word joiner',
  0x2061: 'function application',
  0x2062: 'invisible times',
  0x2063: 'invisible separator',
  0x2064: 'invisible plus',
};

// ── Bidirectional override characters ────────────────────────────────────────

const BIDI_OVERRIDES: Record<number, string> = {
  0x202a: 'left-to-right embedding',
  0x202b: 'right-to-left embedding',
  0x202c: 'pop directional formatting',
  0x202d: 'left-to-right override',
  0x202e: 'right-to-left override',
  0x2066: 'left-to-right isolate',
  0x2067: 'right-to-left isolate',
  0x2068: 'first strong isolate',
  0x2069: 'pop directional isolate',
};

// ── Unicode whitespace variants (beyond ASCII 0x20/0x09/0x0A/0x0D) ──────────

const UNICODE_WHITESPACE: Record<number, string> = {
  0x00a0: 'no-break space',
  0x1680: 'ogham space mark',
  0x2000: 'en quad',
  0x2001: 'em quad',
  0x2002: 'en space',
  0x2003: 'em space',
  0x2004: 'three-per-em space',
  0x2005: 'four-per-em space',
  0x2006: 'six-per-em space',
  0x2007: 'figure space',
  0x2008: 'punctuation space',
  0x2009: 'thin space',
  0x200a: 'hair space',
  0x2028: 'line separator',
  0x2029: 'paragraph separator',
  0x202f: 'narrow no-break space',
  0x205f: 'medium mathematical space',
  0x3000: 'ideographic space',
};

// ── Confusable Latin homoglyphs (Cyrillic/Greek → Latin) ─────────────────────
// Only the highest-risk confusables that could disguise shell commands.

const HOMOGLYPHS: Record<number, { looks_like: string; script: string }> = {
  0x0410: { looks_like: 'A', script: 'Cyrillic' },   // А
  0x0412: { looks_like: 'B', script: 'Cyrillic' },   // В
  0x0421: { looks_like: 'C', script: 'Cyrillic' },   // С
  0x0415: { looks_like: 'E', script: 'Cyrillic' },   // Е
  0x041d: { looks_like: 'H', script: 'Cyrillic' },   // Н
  0x041a: { looks_like: 'K', script: 'Cyrillic' },   // К
  0x041c: { looks_like: 'M', script: 'Cyrillic' },   // М
  0x041e: { looks_like: 'O', script: 'Cyrillic' },   // О
  0x0420: { looks_like: 'P', script: 'Cyrillic' },   // Р
  0x0422: { looks_like: 'T', script: 'Cyrillic' },   // Т
  0x0425: { looks_like: 'X', script: 'Cyrillic' },   // Х
  0x0430: { looks_like: 'a', script: 'Cyrillic' },   // а
  0x0435: { looks_like: 'e', script: 'Cyrillic' },   // е
  0x043e: { looks_like: 'o', script: 'Cyrillic' },   // о
  0x0440: { looks_like: 'p', script: 'Cyrillic' },   // р
  0x0441: { looks_like: 'c', script: 'Cyrillic' },   // с
  0x0443: { looks_like: 'y', script: 'Cyrillic' },   // у
  0x0445: { looks_like: 'x', script: 'Cyrillic' },   // х
  0x0391: { looks_like: 'A', script: 'Greek' },       // Α
  0x0392: { looks_like: 'B', script: 'Greek' },       // Β
  0x0395: { looks_like: 'E', script: 'Greek' },       // Ε
  0x0397: { looks_like: 'H', script: 'Greek' },       // Η
  0x039a: { looks_like: 'K', script: 'Greek' },       // Κ
  0x039c: { looks_like: 'M', script: 'Greek' },       // Μ
  0x039f: { looks_like: 'O', script: 'Greek' },       // Ο
  0x03a1: { looks_like: 'P', script: 'Greek' },       // Ρ
  0x03a4: { looks_like: 'T', script: 'Greek' },       // Τ
  0x03bf: { looks_like: 'o', script: 'Greek' },       // ο
};

export function createShellInjectionRule(): Rule {
  return {
    id: 'shell-injection',
    name: 'Shell Injection (Unicode & Control Characters)',
    description:
      'Detects Unicode obfuscation techniques used to hide shell injection: ' +
      'zero-width characters, bidirectional overrides, non-ASCII whitespace, ' +
      'control characters, and script-confusable homoglyphs.',

    check(content: string): Finding[] {
      const findings: Finding[] = [];

      for (let i = 0; i < content.length; i++) {
        const code = content.codePointAt(i)!;

        // Skip ASCII printable + tab + newline + carriage return
        if (code >= 0x20 && code <= 0x7e) continue;
        if (code === 0x09 || code === 0x0a || code === 0x0d) continue;

        // Zero-width characters
        if (code in ZERO_WIDTH) {
          findings.push({
            ruleId: 'shell-injection-zero-width',
            severity: 'high',
            message: `Invisible character: ${ZERO_WIDTH[code]} (U+${code.toString(16).toUpperCase().padStart(4, '0')})`,
            match: content[i],
            offset: i,
          });
          continue;
        }

        // Bidi overrides
        if (code in BIDI_OVERRIDES) {
          findings.push({
            ruleId: 'shell-injection-bidi-override',
            severity: 'critical',
            message: `Bidirectional override: ${BIDI_OVERRIDES[code]} (U+${code.toString(16).toUpperCase().padStart(4, '0')}) — can visually reorder commands`,
            match: content[i],
            offset: i,
          });
          continue;
        }

        // Unicode whitespace variants
        if (code in UNICODE_WHITESPACE) {
          findings.push({
            ruleId: 'shell-injection-unicode-whitespace',
            severity: 'medium',
            message: `Non-ASCII whitespace: ${UNICODE_WHITESPACE[code]} (U+${code.toString(16).toUpperCase().padStart(4, '0')})`,
            match: content[i],
            offset: i,
          });
          continue;
        }

        // Control characters (C0 block: 0x00–0x1F excluding tab/LF/CR, plus DEL 0x7F)
        if ((code <= 0x08) || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
          const names: Record<number, string> = {
            0x00: 'null byte', 0x01: 'start of heading', 0x02: 'start of text',
            0x03: 'end of text', 0x04: 'end of transmission', 0x05: 'enquiry',
            0x06: 'acknowledge', 0x07: 'bell', 0x08: 'backspace',
            0x0e: 'shift out', 0x0f: 'shift in',
            0x1b: 'escape (ANSI sequence prefix)', 0x7f: 'delete',
          };
          findings.push({
            ruleId: 'shell-injection-control-char',
            severity: 'critical',
            message: `Control character: ${names[code] ?? `U+${code.toString(16).toUpperCase().padStart(4, '0')}`} — can manipulate terminal state`,
            match: content[i],
            offset: i,
          });
          continue;
        }

        // C1 control characters (0x80–0x9F) — rarely legitimate in text
        if (code >= 0x80 && code <= 0x9f) {
          findings.push({
            ruleId: 'shell-injection-control-char',
            severity: 'high',
            message: `C1 control character (U+${code.toString(16).toUpperCase().padStart(4, '0')}) — can embed terminal escape sequences`,
            match: content[i],
            offset: i,
          });
          continue;
        }

        // Homoglyph confusables
        if (code in HOMOGLYPHS) {
          const { looks_like, script } = HOMOGLYPHS[code];
          findings.push({
            ruleId: 'shell-injection-homoglyph',
            severity: 'high',
            message: `${script} homoglyph looks like Latin '${looks_like}' (U+${code.toString(16).toUpperCase().padStart(4, '0')}) — can disguise commands`,
            match: content[i],
            offset: i,
          });
          // Handle surrogate pairs for code points > 0xFFFF
          if (code > 0xffff) i++;
          continue;
        }

        // Handle surrogate pairs for any code point > 0xFFFF we didn't match
        if (code > 0xffff) i++;
      }

      return findings;
    },
  };
}
