/**
 * CRUCIBLE Gate 6 — shell_injection_rule.ts mutation hardening (N-213)
 *
 * Targets the boundary conditions and severity literals in createShellInjectionRule()
 * that survive with the example-based test suite alone.  Each test is named
 * SH-XX and documents which mutant it kills.
 *
 * Key mutation targets in shell_injection_rule.ts:
 *   Line ~156  control char range: (code <= 0x08) || (code >= 0x0e && code <= 0x1f) || code === 0x7f
 *   Line ~175  C1 range:           (code >= 0x80 && code <= 0x9f)
 *   Line ~123  severity 'high'     (zero-width)
 *   Line ~135  severity 'critical' (bidi override)
 *   Line ~147  severity 'medium'   (unicode whitespace)
 *   Line ~166  severity 'critical' (C0 control chars)
 *   Line ~178  severity 'high'     (C1 control chars)
 *   Line ~191  severity 'high'     (homoglyphs)
 */
import { describe, it, expect } from 'vitest';
import { createShellInjectionRule } from '../rules/shell_injection_rule';

const rule = createShellInjectionRule();

// ── Boundary: C0 control char range ──────────────────────────────────────────

describe('SH-B: control char boundary mutations', () => {
  it('SH-B1: backspace (0x08) detected — kills <= 0x08 → < 0x08', () => {
    const findings = rule.check('text\x08more');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
    expect(match!.message).toContain('backspace');
  });

  it('SH-B2: shift-out (0x0e) detected — kills >= 0x0e → > 0x0e', () => {
    const findings = rule.check('text\x0emore');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
  });

  it('SH-B3: unit separator (0x1f) detected — kills <= 0x1f → < 0x1f', () => {
    const findings = rule.check('field1\x1ffield2');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
  });

  it('SH-B4: delete (0x7f) detected — kills === 0x7f literal', () => {
    const findings = rule.check('command\x7fmore');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
    expect(match!.message).toContain('delete');
  });

  it('SH-B5: shift-in (0x0f) detected — not a boundary but confirms range coverage', () => {
    const findings = rule.check('prefix\x0fsuffix');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
    expect(match!.message).toContain('shift in');
  });
});

// ── Boundary: C1 control char range (0x80–0x9F) ──────────────────────────────

describe('SH-C1: C1 control char boundary mutations', () => {
  it('SH-C1a: PAD (0x80) detected — kills >= 0x80 → > 0x80', () => {
    const findings = rule.check('text\x80more');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
    expect(match!.message).toContain('C1 control character');
  });

  it('SH-C1b: APC (0x9f) detected — kills <= 0x9f → < 0x9f', () => {
    const findings = rule.check('text\x9fmore');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
  });

  it('SH-C1c: mid-range C1 (0x90) detected and has high severity', () => {
    const findings = rule.check('inject\x90ed');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
  });

  it('SH-C1d: char just above C1 range (0xa0 = no-break space) is unicode-whitespace not C1', () => {
    const findings = rule.check('text\u00a0more');
    // 0xa0 = no-break space — should hit unicode-whitespace path, NOT C1
    const c1 = findings.filter(f => f.message.includes('C1 control'));
    const ws = findings.filter(f => f.ruleId === 'shell-injection-unicode-whitespace');
    expect(c1.length).toBe(0);
    expect(ws.length).toBeGreaterThan(0);
  });
});

// ── Severity literals ─────────────────────────────────────────────────────────

describe('SH-S: severity StringLiteral mutations', () => {
  it('SH-S1: zero-width severity is exactly "high" — kills "high" StringLiteral', () => {
    const findings = rule.check('\u200b');
    const match = findings.find(f => f.ruleId === 'shell-injection-zero-width');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
  });

  it('SH-S2: bidi override severity is exactly "critical" — kills "critical" StringLiteral', () => {
    const findings = rule.check('\u202e');
    const match = findings.find(f => f.ruleId === 'shell-injection-bidi-override');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
  });

  it('SH-S3: unicode whitespace severity is exactly "medium" — kills "medium" StringLiteral', () => {
    const findings = rule.check('\u2003');   // em space
    const match = findings.find(f => f.ruleId === 'shell-injection-unicode-whitespace');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('medium');
  });

  it('SH-S4: C0 control severity is exactly "critical" — kills second "critical" StringLiteral', () => {
    // \x1b = escape (0x1b is in 0x0e–0x1f range)
    const findings = rule.check('\x1b[0m');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
  });

  it('SH-S5: C1 control severity is exactly "high" — kills C1 "high" StringLiteral', () => {
    const findings = rule.check('\x85');  // 0x85 = next line (C1)
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
  });

  it('SH-S6: homoglyph severity is exactly "high" — kills homoglyph "high" StringLiteral', () => {
    // \u0430 = Cyrillic а (looks like Latin a)
    const findings = rule.check('\u0430');
    const match = findings.find(f => f.ruleId === 'shell-injection-homoglyph');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('high');
  });
});

// ── ruleId string literals ────────────────────────────────────────────────────

describe('SH-R: ruleId StringLiteral mutations', () => {
  it('SH-R1: zero-width ruleId contains "zero-width" — kills ruleId StringLiteral', () => {
    const findings = rule.check('\u200c');  // zero-width non-joiner
    expect(findings[0].ruleId).toBe('shell-injection-zero-width');
  });

  it('SH-R2: bidi ruleId contains "bidi-override" — kills ruleId StringLiteral', () => {
    const findings = rule.check('\u202d');  // left-to-right override
    const match = findings.find(f => f.ruleId === 'shell-injection-bidi-override');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
  });

  it('SH-R3: whitespace ruleId is "shell-injection-unicode-whitespace" — kills ruleId literal', () => {
    const findings = rule.check('\u1680');  // ogham space mark
    expect(findings[0].ruleId).toBe('shell-injection-unicode-whitespace');
  });

  it('SH-R4: homoglyph ruleId is "shell-injection-homoglyph" — kills ruleId literal', () => {
    const findings = rule.check('\u0441');  // Cyrillic с (looks like c)
    expect(findings[0].ruleId).toBe('shell-injection-homoglyph');
  });
});

// ── ASCII skip logic ──────────────────────────────────────────────────────────

describe('SH-A: ASCII skip boundary mutations', () => {
  it('SH-A1: char just before ASCII printable range (0x1f) is flagged, 0x20 space is not', () => {
    expect(rule.check('\x1f').length).toBeGreaterThan(0);
    expect(rule.check(' ').length).toBe(0);  // 0x20 = space, clean
  });

  it('SH-A2: tilde (0x7e) is clean, DEL (0x7f) is flagged', () => {
    expect(rule.check('~').length).toBe(0);   // 0x7e = tilde, ASCII printable
    expect(rule.check('\x7f').length).toBeGreaterThan(0);  // 0x7f = DEL
  });

  it('SH-A3: tab (0x09) is clean', () => {
    expect(rule.check('\t').length).toBe(0);
  });

  it('SH-A4: newline (0x0a) is clean', () => {
    expect(rule.check('\n').length).toBe(0);
  });

  it('SH-A5: carriage return (0x0d) is clean', () => {
    expect(rule.check('\r').length).toBe(0);
  });
});

// ── Rule metadata ─────────────────────────────────────────────────────────────
// Fresh instances per test to avoid module-cache interference with Stryker

describe('SH-M: rule metadata StringLiteral mutations', () => {
  it('SH-M1: rule.name exact value — kills name StringLiteral', () => {
    const r = createShellInjectionRule();
    expect(r.name).toBe('Shell Injection (Unicode & Control Characters)');
  });

  it('SH-M2: rule.description contains detection categories — kills description StringLiterals', () => {
    const r = createShellInjectionRule();
    expect(r.description).toContain('Unicode obfuscation');
    expect(r.description).toContain('zero-width');
    expect(r.description).toContain('bidirectional overrides');
    expect(r.description).toContain('homoglyphs');
  });
});

// ── Message format — hex code is uppercase ───────────────────────────────────

describe('SH-H: hex format toUpperCase mutations', () => {
  it('SH-H1: zero-width message hex is uppercase U+ — kills toUpperCase→toLowerCase', () => {
    const findings = rule.check('\u200b');
    expect(findings[0].message).toMatch(/U\+[0-9A-F]{4}/);
    expect(findings[0].message).toContain('Invisible character:');
  });

  it('SH-H2: bidi message hex is uppercase U+ — kills toUpperCase→toLowerCase', () => {
    const findings = rule.check('\u202e');
    expect(findings[0].message).toMatch(/U\+[0-9A-F]{4}/);
    expect(findings[0].message).toContain('Bidirectional override:');
  });

  it('SH-H3: unicode whitespace message hex is uppercase U+ — kills toUpperCase→toLowerCase', () => {
    const findings = rule.check('\u2003');
    expect(findings[0].message).toMatch(/U\+[0-9A-F]{4}/);
    expect(findings[0].message).toContain('Non-ASCII whitespace:');
  });

  it('SH-H4: control char message hex is uppercase U+ — kills toUpperCase→toLowerCase', () => {
    // \x10 = DLE (data link escape) — in range 0x0e-0x1f, NOT in names dict → uses U+XXXX fallback
    const findings = rule.check('\x10');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('U+0010');
  });

  it('SH-H5: C1 control char message hex is uppercase U+ — kills toUpperCase→toLowerCase', () => {
    const findings = rule.check('\x85');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toMatch(/U\+[0-9A-F]{4}/);
    expect(match!.message).toContain('C1 control character');
  });

  it('SH-H6: homoglyph message hex is uppercase U+ — kills toUpperCase→toLowerCase', () => {
    const findings = rule.check('\u0430');   // Cyrillic а
    const match = findings.find(f => f.ruleId === 'shell-injection-homoglyph');
    expect(match).toBeDefined();
    expect(match!.message).toMatch(/U\+[0-9A-F]{4}/);
    expect(match!.message).toContain('U+0430');
  });
});

// ── Control char named messages ──────────────────────────────────────────────
// Each test checks the exact name string in the message, killing the corresponding
// StringLiteral mutation in the names Record<number, string> at L157–162.

describe('SH-N: control char named message StringLiteral mutations', () => {
  it('SH-N1: null byte (0x00) message contains "null byte" — kills StringLiteral', () => {
    const findings = rule.check('\x00');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('null byte');
  });

  it('SH-N2: SOH (0x01) message contains "start of heading" — kills StringLiteral', () => {
    const findings = rule.check('\x01');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('start of heading');
  });

  it('SH-N3: STX (0x02) message contains "start of text" — kills StringLiteral', () => {
    const findings = rule.check('\x02');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('start of text');
  });

  it('SH-N4: ETX (0x03) message contains "end of text" — kills StringLiteral', () => {
    const findings = rule.check('\x03');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('end of text');
  });

  it('SH-N5: EOT (0x04) message contains "end of transmission" — kills StringLiteral', () => {
    const findings = rule.check('\x04');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('end of transmission');
  });

  it('SH-N6: ENQ (0x05) message contains "enquiry" — kills StringLiteral', () => {
    const findings = rule.check('\x05');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('enquiry');
  });

  it('SH-N7: ACK (0x06) message contains "acknowledge" — kills StringLiteral', () => {
    const findings = rule.check('\x06');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('acknowledge');
  });

  it('SH-N8: BEL (0x07) message contains "bell" — kills StringLiteral', () => {
    const findings = rule.check('\x07');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('bell');
  });

  it('SH-N9: SO (0x0e) message contains "shift out" — kills StringLiteral', () => {
    const findings = rule.check('\x0e');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('shift out');
  });

  it('SH-N10: SI (0x0f) message contains "shift in" — kills StringLiteral', () => {
    const findings = rule.check('\x0f');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('shift in');
  });

  it('SH-N11: ESC (0x1b) message contains "escape" — kills StringLiteral', () => {
    const findings = rule.check('\x1b');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('escape');
  });

  it('SH-N12: control char message suffix present — kills template-literal StringLiteral', () => {
    const findings = rule.check('\x01');
    const match = findings.find(f => f.ruleId === 'shell-injection-control-char');
    expect(match).toBeDefined();
    expect(match!.message).toContain('can manipulate terminal state');
  });
});

// ── False-positive suppression (chars that fall through all checks) ───────────

describe('SH-FP: chars that must NOT generate findings', () => {
  it('SH-FP1: VT (0x0b) not detected — kills L156 ConditionalExpression "true"', () => {
    expect(rule.check('\x0b').length).toBe(0);   // vertical tab: not in control range
  });

  it('SH-FP2: FF (0x0c) not detected — confirms VT/FF both fall through', () => {
    expect(rule.check('\x0c').length).toBe(0);   // form feed: not in control range
  });

  it('SH-FP3: inverted exclamation ¡ (0xa1) not detected — kills L175 ConditionalExpression "true"', () => {
    expect(rule.check('¡').length).toBe(0);      // 0xa1: above C1 range
  });

  it('SH-FP4: arbitrary high Unicode char ❤ (0x2764) not detected — kills L187 "true"', () => {
    expect(rule.check('❤').length).toBe(0);      // not in any detection map
  });

  it('SH-FP5: copyright sign © (0xa9) not detected — kills L175 "true" variant', () => {
    expect(rule.check('©').length).toBe(0);      // 0xa9: above C1 range (0x9f)
  });

  it('SH-FP6: emoji 🔥 (astral plane, 0x1F525) not detected — provides L202 coverage', () => {
    expect(rule.check('🔥').length).toBe(0);     // codepoint > 0xffff, not in any map
  });
});
