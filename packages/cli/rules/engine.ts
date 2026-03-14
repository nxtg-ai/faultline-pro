import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import yaml from 'js-yaml';
import type { Rule, Finding, FindingSeverity } from './base_rule.js';

/**
 * Schema for a single pattern within a YAML rule file.
 */
export interface YamlPattern {
  name: string;
  regex: string;
  severity?: FindingSeverity;
  message?: string;
  flags?: string;
}

/**
 * Schema for a YAML rule file.
 */
export interface YamlRuleDefinition {
  name: string;
  description: string;
  severity: FindingSeverity;
  category: string;
  remediation?: string;
  patterns: YamlPattern[];
}

/**
 * Validate a parsed YAML object has the required rule fields.
 * Returns an error message if invalid, or null if valid.
 */
export function validateYamlRule(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'Rule must be a non-null object';
  const obj = data as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) return 'Rule must have a "name" string';
  if (typeof obj.description !== 'string' || !obj.description) return 'Rule must have a "description" string';
  if (typeof obj.severity !== 'string') return 'Rule must have a "severity" string';
  if (typeof obj.category !== 'string' || !obj.category) return 'Rule must have a "category" string';

  const validSeverities: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
  if (!validSeverities.includes(obj.severity as FindingSeverity)) {
    return `Invalid severity "${obj.severity}". Must be one of: ${validSeverities.join(', ')}`;
  }

  if (!Array.isArray(obj.patterns) || obj.patterns.length === 0) {
    return 'Rule must have a non-empty "patterns" array';
  }

  for (let i = 0; i < obj.patterns.length; i++) {
    const p = obj.patterns[i];
    if (!p || typeof p !== 'object') return `Pattern ${i} must be an object`;
    if (typeof p.name !== 'string' || !p.name) return `Pattern ${i} must have a "name" string`;
    if (typeof p.regex !== 'string' || !p.regex) return `Pattern ${i} must have a "regex" string`;

    // Validate the regex compiles
    try {
      new RegExp(p.regex, p.flags || 'g');
    } catch (e) {
      return `Pattern ${i} ("${p.name}") has invalid regex: ${(e as Error).message}`;
    }

    if (p.severity !== undefined) {
      if (!validSeverities.includes(p.severity)) {
        return `Pattern ${i} ("${p.name}") has invalid severity "${p.severity}"`;
      }
    }
  }

  return null;
}

/**
 * Parse a YAML string into a validated rule definition.
 * Returns the definition or throws on invalid YAML/schema.
 */
export function parseYamlRule(content: string): YamlRuleDefinition {
  const data = yaml.load(content);
  const error = validateYamlRule(data);
  if (error) throw new Error(error);
  return data as YamlRuleDefinition;
}

/**
 * Convert a validated YAML rule definition into a Rule object.
 */
export function yamlRuleToRule(def: YamlRuleDefinition, ruleId: string): Rule {
  return {
    id: ruleId,
    name: def.name,
    description: def.description,

    check(content: string): Finding[] {
      const findings: Finding[] = [];

      for (const pattern of def.patterns) {
        const flags = pattern.flags ? (pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g') : 'g';
        const regex = new RegExp(pattern.regex, flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(content)) !== null) {
          findings.push({
            ruleId: `${ruleId}-${pattern.name}`,
            severity: pattern.severity || def.severity,
            message: pattern.message || `Matched ${pattern.name}`,
            match: match[0],
            offset: match.index,
          });

          // Prevent infinite loops on zero-length matches
          if (match[0].length === 0) {
            regex.lastIndex++;
          }
        }
      }

      return findings;
    },
  };
}

/**
 * Load all YAML rule files from a directory.
 * Invalid files log a warning and are skipped.
 * Returns an array of [ruleId, Rule] pairs.
 */
export function loadYamlRulesFromDir(dir: string): Array<{ id: string; rule: Rule }> {
  const results: Array<{ id: string; rule: Rule }> = [];

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => extname(f) === '.yaml' || extname(f) === '.yml');
  } catch {
    // Directory doesn't exist or can't be read
    return results;
  }

  for (const file of files.sort()) {
    const filePath = join(dir, file);
    const ruleId = 'yaml-' + basename(file, extname(file));

    try {
      const content = readFileSync(filePath, 'utf-8');
      const def = parseYamlRule(content);
      results.push({ id: ruleId, rule: yamlRuleToRule(def, ruleId) });
    } catch (err) {
      console.warn(`[warn] Skipping invalid YAML rule "${file}": ${(err as Error).message}`);
    }
  }

  return results;
}

/**
 * Load YAML rules from a directory and return them as RuleFactory entries
 * suitable for registry registration.
 */
export function loadYamlRuleFactories(dir: string): Record<string, () => Rule> {
  const loaded = loadYamlRulesFromDir(dir);
  const factories: Record<string, () => Rule> = {};
  for (const { id, rule } of loaded) {
    factories[id] = () => rule;
  }
  return factories;
}
