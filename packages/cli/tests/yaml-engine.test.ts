import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseYamlRule,
  validateYamlRule,
  yamlRuleToRule,
  loadYamlRulesFromDir,
  loadYamlRuleFactories,
} from '../rules/engine';
import type { YamlRuleDefinition } from '../rules/engine';

// ---------- validateYamlRule ----------

describe('validateYamlRule', () => {
  const validRule = {
    name: 'Test Rule',
    description: 'A test rule.',
    severity: 'high',
    category: 'test',
    patterns: [{ name: 'test-pattern', regex: '\\btest\\b' }],
  };

  it('should accept valid rule', () => {
    expect(validateYamlRule(validRule)).toBeNull();
  });

  it('should reject null', () => {
    expect(validateYamlRule(null)).toContain('non-null object');
  });

  it('should reject undefined', () => {
    expect(validateYamlRule(undefined)).toContain('non-null object');
  });

  it('should reject string', () => {
    expect(validateYamlRule('not an object')).toContain('non-null object');
  });

  it('should reject missing name', () => {
    const { name, ...noName } = validRule;
    expect(validateYamlRule(noName)).toContain('"name"');
  });

  it('should reject empty name', () => {
    expect(validateYamlRule({ ...validRule, name: '' })).toContain('"name"');
  });

  it('should reject missing description', () => {
    const { description, ...noDesc } = validRule;
    expect(validateYamlRule(noDesc)).toContain('"description"');
  });

  it('should reject missing severity', () => {
    const { severity, ...noSev } = validRule;
    expect(validateYamlRule(noSev)).toContain('"severity"');
  });

  it('should reject invalid severity', () => {
    expect(validateYamlRule({ ...validRule, severity: 'extreme' })).toContain('Invalid severity');
  });

  it('should accept all valid severities', () => {
    for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(validateYamlRule({ ...validRule, severity: sev })).toBeNull();
    }
  });

  it('should reject missing category', () => {
    const { category, ...noCat } = validRule;
    expect(validateYamlRule(noCat)).toContain('"category"');
  });

  it('should reject missing patterns', () => {
    const { patterns, ...noPat } = validRule;
    expect(validateYamlRule(noPat)).toContain('"patterns"');
  });

  it('should reject empty patterns array', () => {
    expect(validateYamlRule({ ...validRule, patterns: [] })).toContain('non-empty');
  });

  it('should reject pattern without name', () => {
    expect(validateYamlRule({
      ...validRule,
      patterns: [{ regex: '\\btest\\b' }],
    })).toContain('Pattern 0');
  });

  it('should reject pattern without regex', () => {
    expect(validateYamlRule({
      ...validRule,
      patterns: [{ name: 'test' }],
    })).toContain('Pattern 0');
  });

  it('should reject pattern with invalid regex', () => {
    const result = validateYamlRule({
      ...validRule,
      patterns: [{ name: 'bad', regex: '(unclosed' }],
    });
    expect(result).toContain('invalid regex');
  });

  it('should reject pattern with invalid severity', () => {
    const result = validateYamlRule({
      ...validRule,
      patterns: [{ name: 'test', regex: 'test', severity: 'extreme' }],
    });
    expect(result).toContain('invalid severity');
  });

  it('should accept pattern with optional severity', () => {
    expect(validateYamlRule({
      ...validRule,
      patterns: [{ name: 'test', regex: 'test', severity: 'low' }],
    })).toBeNull();
  });

  it('should accept pattern with optional message', () => {
    expect(validateYamlRule({
      ...validRule,
      patterns: [{ name: 'test', regex: 'test', message: 'Found it' }],
    })).toBeNull();
  });

  it('should accept pattern with optional flags', () => {
    expect(validateYamlRule({
      ...validRule,
      patterns: [{ name: 'test', regex: 'test', flags: 'gi' }],
    })).toBeNull();
  });

  it('should validate multiple patterns', () => {
    expect(validateYamlRule({
      ...validRule,
      patterns: [
        { name: 'a', regex: 'a' },
        { name: 'b', regex: '(bad' },
      ],
    })).toContain('Pattern 1');
  });
});

// ---------- parseYamlRule ----------

describe('parseYamlRule', () => {
  it('should parse valid YAML string', () => {
    const yaml = `
name: Test Rule
description: Detects test patterns.
severity: high
category: test
patterns:
  - name: keyword
    regex: "\\\\btest\\\\b"
    severity: medium
    message: Found test keyword
`;
    const def = parseYamlRule(yaml);
    expect(def.name).toBe('Test Rule');
    expect(def.severity).toBe('high');
    expect(def.patterns).toHaveLength(1);
    expect(def.patterns[0].name).toBe('keyword');
  });

  it('should throw on invalid YAML syntax', () => {
    expect(() => parseYamlRule('{{{')).toThrow();
  });

  it('should throw on missing required fields', () => {
    expect(() => parseYamlRule('name: Only Name')).toThrow();
  });

  it('should include remediation if present', () => {
    const yaml = `
name: Test
description: Test
severity: high
category: test
remediation: Fix it.
patterns:
  - name: p
    regex: "test"
`;
    const def = parseYamlRule(yaml);
    expect(def.remediation).toBe('Fix it.');
  });
});

// ---------- yamlRuleToRule ----------

describe('yamlRuleToRule', () => {
  const def: YamlRuleDefinition = {
    name: 'Test Rule',
    description: 'Detects test patterns.',
    severity: 'high',
    category: 'test',
    patterns: [
      { name: 'keyword', regex: '\\btest\\b', severity: 'medium', message: 'Found test' },
      { name: 'another', regex: '\\bfoo\\b' },
    ],
  };

  it('should create a rule with correct metadata', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    expect(rule.id).toBe('yaml-test');
    expect(rule.name).toBe('Test Rule');
    expect(rule.description).toBe('Detects test patterns.');
  });

  it('should match patterns in content', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    const findings = rule.check('This is a test of the system.');
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('yaml-test-keyword');
    expect(findings[0].severity).toBe('medium');
    expect(findings[0].message).toBe('Found test');
    expect(findings[0].match).toBe('test');
  });

  it('should use default severity from rule when pattern omits it', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    const findings = rule.check('I like foo bars.');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high'); // falls back to def.severity
  });

  it('should use default message when pattern omits it', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    const findings = rule.check('foo');
    expect(findings[0].message).toBe('Matched another');
  });

  it('should return empty for no matches', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    const findings = rule.check('Nothing matches here.');
    expect(findings).toHaveLength(0);
  });

  it('should find multiple matches', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    const findings = rule.check('test and test again.');
    expect(findings).toHaveLength(2);
  });

  it('should include correct offset', () => {
    const rule = yamlRuleToRule(def, 'yaml-test');
    const findings = rule.check('hello test world');
    expect(findings[0].offset).toBe(6);
  });

  it('should respect pattern flags', () => {
    const defWithFlags: YamlRuleDefinition = {
      ...def,
      patterns: [{ name: 'case', regex: 'TEST', flags: 'i' }],
    };
    const rule = yamlRuleToRule(defWithFlags, 'yaml-case');
    const findings = rule.check('This is a test.');
    expect(findings).toHaveLength(1);
  });

  it('should add global flag automatically if not present', () => {
    const defNoG: YamlRuleDefinition = {
      ...def,
      patterns: [{ name: 'noglobal', regex: 'match', flags: 'i' }],
    };
    const rule = yamlRuleToRule(defNoG, 'yaml-nog');
    const findings = rule.check('match and match again');
    expect(findings).toHaveLength(2); // global flag added, finds both
  });
});

// ---------- loadYamlRulesFromDir ----------

describe('loadYamlRulesFromDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-yaml-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load a valid YAML rule file', () => {
    writeFileSync(join(tmpDir, 'test.yaml'), `
name: Test
description: Test rule
severity: high
category: test
patterns:
  - name: kw
    regex: "test"
`);

    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('yaml-test');
    expect(rules[0].rule.name).toBe('Test');
  });

  it('should load multiple YAML files sorted by name', () => {
    writeFileSync(join(tmpDir, 'b.yaml'), `
name: B Rule
description: B
severity: low
category: test
patterns:
  - name: b
    regex: "b"
`);
    writeFileSync(join(tmpDir, 'a.yaml'), `
name: A Rule
description: A
severity: low
category: test
patterns:
  - name: a
    regex: "a"
`);

    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('yaml-a');
    expect(rules[1].id).toBe('yaml-b');
  });

  it('should skip invalid YAML files gracefully', () => {
    writeFileSync(join(tmpDir, 'good.yaml'), `
name: Good
description: Good rule
severity: low
category: test
patterns:
  - name: g
    regex: "good"
`);
    writeFileSync(join(tmpDir, 'bad.yaml'), 'this is not valid yaml: {{{}}}');

    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('yaml-good');
  });

  it('should skip files missing required fields', () => {
    writeFileSync(join(tmpDir, 'incomplete.yaml'), `
name: Incomplete
severity: high
`);

    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it('should handle .yml extension', () => {
    writeFileSync(join(tmpDir, 'alt.yml'), `
name: YML Rule
description: Uses yml extension
severity: low
category: test
patterns:
  - name: y
    regex: "yml"
`);

    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('yaml-alt');
  });

  it('should ignore non-YAML files', () => {
    writeFileSync(join(tmpDir, 'readme.txt'), 'Not a rule.');
    writeFileSync(join(tmpDir, 'config.json'), '{}');

    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it('should return empty for nonexistent directory', () => {
    const rules = loadYamlRulesFromDir('/nonexistent/path');
    expect(rules).toHaveLength(0);
  });

  it('should return empty for empty directory', () => {
    const rules = loadYamlRulesFromDir(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it('loaded rules should produce findings', () => {
    writeFileSync(join(tmpDir, 'detect.yaml'), `
name: Detect Test
description: Detects "test"
severity: medium
category: test
patterns:
  - name: kw
    regex: "\\\\btest\\\\b"
`);

    const rules = loadYamlRulesFromDir(tmpDir);
    const findings = rules[0].rule.check('this is a test sentence');
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('yaml-detect-kw');
  });
});

// ---------- loadYamlRuleFactories ----------

describe('loadYamlRuleFactories', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-yaml-factories-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return factory functions', () => {
    writeFileSync(join(tmpDir, 'fac.yaml'), `
name: Factory Test
description: Test
severity: low
category: test
patterns:
  - name: x
    regex: "x"
`);

    const factories = loadYamlRuleFactories(tmpDir);
    expect(Object.keys(factories)).toEqual(['yaml-fac']);
    expect(typeof factories['yaml-fac']).toBe('function');

    const rule = factories['yaml-fac']();
    expect(rule.name).toBe('Factory Test');
  });

  it('should return empty object for empty directory', () => {
    const factories = loadYamlRuleFactories(tmpDir);
    expect(Object.keys(factories)).toHaveLength(0);
  });
});

// ---------- Built-in YAML rules ----------

describe('Built-in YAML rules', () => {
  describe('pii.yaml', () => {
    it('should load and detect emails', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const piiRule = rules.find(r => r.id === 'yaml-pii');
      expect(piiRule).toBeDefined();
      const findings = piiRule!.rule.check('Contact user@example.com please.');
      expect(findings.some(f => f.ruleId === 'yaml-pii-email')).toBe(true);
    });

    it('should detect SSNs', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const piiRule = rules.find(r => r.id === 'yaml-pii')!;
      const findings = piiRule.rule.check('SSN: 123-45-6789');
      expect(findings.some(f => f.ruleId === 'yaml-pii-ssn')).toBe(true);
      expect(findings.find(f => f.ruleId === 'yaml-pii-ssn')?.severity).toBe('critical');
    });

    it('should detect phone numbers', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const piiRule = rules.find(r => r.id === 'yaml-pii')!;
      const findings = piiRule.rule.check('Call 555-123-4567.');
      expect(findings.some(f => f.ruleId === 'yaml-pii-phone')).toBe(true);
    });
  });

  describe('bias.yaml', () => {
    it('should load and detect gender stereotypes', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const biasRule = rules.find(r => r.id === 'yaml-bias');
      expect(biasRule).toBeDefined();
      const findings = biasRule!.rule.check("Women can't do engineering.");
      expect(findings.some(f => f.ruleId === 'yaml-bias-gender-stereotype')).toBe(true);
    });

    it('should detect racial generalizations', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const biasRule = rules.find(r => r.id === 'yaml-bias')!;
      const findings = biasRule.rule.check('All asian people are the same.');
      expect(findings.some(f => f.ruleId === 'yaml-bias-racial-generalization')).toBe(true);
    });
  });

  describe('security.yaml', () => {
    it('should load and detect API keys', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const secRule = rules.find(r => r.id === 'yaml-security');
      expect(secRule).toBeDefined();
      const findings = secRule!.rule.check('api_key=sk_live_1234567890abcdef');
      expect(findings.some(f => f.ruleId === 'yaml-security-api-key-generic')).toBe(true);
    });

    it('should detect AWS access keys', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const secRule = rules.find(r => r.id === 'yaml-security')!;
      const findings = secRule.rule.check('Key: AKIAIOSFODNN7EXAMPLE');
      expect(findings.some(f => f.ruleId === 'yaml-security-aws-access-key')).toBe(true);
    });

    it('should detect inline passwords', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const secRule = rules.find(r => r.id === 'yaml-security')!;
      const findings = secRule.rule.check('password=MyS3cr3tP@ss!');
      expect(findings.some(f => f.ruleId === 'yaml-security-password-inline')).toBe(true);
    });

    it('should detect bearer tokens', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const secRule = rules.find(r => r.id === 'yaml-security')!;
      const findings = secRule.rule.check('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef');
      expect(findings.some(f => f.ruleId === 'yaml-security-bearer-token')).toBe(true);
    });

    it('should detect private key headers', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const secRule = rules.find(r => r.id === 'yaml-security')!;
      const findings = secRule.rule.check('-----BEGIN RSA PRIVATE KEY-----');
      expect(findings.some(f => f.ruleId === 'yaml-security-private-key-header')).toBe(true);
      expect(findings[0].severity).toBe('critical');
    });

    it('should return empty for clean content', () => {
      const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
      const secRule = rules.find(r => r.id === 'yaml-security')!;
      const findings = secRule.rule.check('This is a clean paragraph about security best practices.');
      expect(findings).toHaveLength(0);
    });
  });

  it('should load all 4 built-in YAML rule files', () => {
    const rules = loadYamlRulesFromDir(join(__dirname, '..', 'rules', 'yaml'));
    const ids = rules.map(r => r.id);
    expect(ids).toContain('yaml-pii');
    expect(ids).toContain('yaml-bias');
    expect(ids).toContain('yaml-security');
    expect(ids).toContain('yaml-shell-injection');
    expect(rules).toHaveLength(4);
  });
});
