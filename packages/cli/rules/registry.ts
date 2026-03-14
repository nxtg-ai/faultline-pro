import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rule, RuleFactory, Finding } from './base_rule.js';
import { createPiiRule } from './pii_rule.js';
import { createBiasRule } from './bias_rule.js';
import { createToxicityRule } from './toxicity_rule.js';
import { loadYamlRuleFactories } from './engine.js';

const builtInFactories: Record<string, RuleFactory> = {
  pii: createPiiRule,
  bias: createBiasRule,
  toxicity: createToxicityRule,
};

const yamlFactories: Record<string, RuleFactory> = {};
const customFactories: Record<string, RuleFactory> = {};

let yamlLoaded = false;

/**
 * Load YAML rules from the built-in yaml/ directory.
 * Called lazily on first access. Safe to call multiple times (no-op after first).
 */
export function loadBuiltInYamlRules(): void {
  if (yamlLoaded) return;
  yamlLoaded = true;

  try {
    // Resolve the yaml/ directory relative to this file
    const thisDir = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    const yamlDir = join(thisDir, 'yaml');
    const factories = loadYamlRuleFactories(yamlDir);
    Object.assign(yamlFactories, factories);
  } catch {
    // If yaml directory doesn't exist or can't be read, skip silently
  }
}

/**
 * Load YAML rules from a custom directory.
 * These are additive — they supplement built-in and built-in YAML rules, never override.
 */
export function loadCustomYamlRules(dir: string): number {
  const factories = loadYamlRuleFactories(dir);
  let count = 0;
  for (const [name, factory] of Object.entries(factories)) {
    customFactories[name] = factory;
    count++;
  }
  return count;
}

/**
 * Register a custom rule factory at runtime.
 */
export function registerRule(name: string, factory: RuleFactory): void {
  customFactories[name] = factory;
}

/**
 * Unregister a previously registered custom rule.
 * Returns true if the rule was found and removed.
 */
export function unregisterRule(name: string): boolean {
  if (name in customFactories) {
    delete customFactories[name];
    return true;
  }
  return false;
}

/**
 * Get a single rule instance by name.
 * Checks custom rules first, then YAML rules, then built-ins.
 *
 * @throws Error if the rule is not registered.
 */
export function getRule(name: string): Rule {
  loadBuiltInYamlRules();
  const factory = customFactories[name] ?? yamlFactories[name] ?? builtInFactories[name];
  if (!factory) {
    const available = listRules().join(', ');
    throw new Error(`Unknown rule "${name}". Available: ${available}`);
  }
  return factory();
}

/**
 * List all registered rule names (custom + YAML + built-in).
 */
export function listRules(): string[] {
  loadBuiltInYamlRules();
  return [...new Set([
    ...Object.keys(builtInFactories),
    ...Object.keys(yamlFactories),
    ...Object.keys(customFactories),
  ])];
}

/**
 * Get all rule instances (custom + YAML + built-in).
 */
export function getAllRules(): Rule[] {
  const names = listRules();
  return names.map((name) => getRule(name));
}

/**
 * Run all registered rules against content.
 * Returns aggregated findings sorted by offset.
 */
export function runAllRules(content: string): Finding[] {
  const rules = getAllRules();
  const findings: Finding[] = [];

  for (const rule of rules) {
    findings.push(...rule.check(content));
  }

  return findings.sort((a, b) => a.offset - b.offset);
}

/**
 * Run specific rules by name against content.
 *
 * @throws Error if any named rule is not registered.
 */
export function runRules(content: string, ruleNames: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const name of ruleNames) {
    const rule = getRule(name);
    findings.push(...rule.check(content));
  }

  return findings.sort((a, b) => a.offset - b.offset);
}

/**
 * Reset YAML loading state. Used for testing.
 */
export function _resetYamlState(): void {
  yamlLoaded = false;
  for (const key of Object.keys(yamlFactories)) {
    delete yamlFactories[key];
  }
}
