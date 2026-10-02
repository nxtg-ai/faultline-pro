/**
 * Custom Rule Store — user-defined verification rules that run alongside built-in checks.
 *
 * A rule is a JSON/YAML object with:
 *   name        — human-readable label
 *   description — what the rule checks
 *   condition   — one of: contains_keyword, missing_source, missing_date_citation,
 *                  claim_type, regex_match
 *   params      — condition-specific parameters
 *   severity    — 'info' | 'warning' | 'error'
 *   enabled     — whether the rule is active (default: true)
 *
 * Rules are evaluated against individual claims from a scan result.
 * A RuleViolation is emitted for each claim that fails a rule.
 */

import { randomUUID } from 'node:crypto';
import { compileSafeRegex, MAX_MATCH_TEXT_LENGTH } from '../lib/safe-regex.js';

export type RuleSeverity = 'info' | 'warning' | 'error';

export type RuleCondition =
  | 'contains_keyword'      // claim text contains any of params.keywords[]
  | 'missing_source'        // claim has no source citation
  | 'missing_date_citation' // statistical claim has no date
  | 'claim_type'            // claim.type matches params.types[]
  | 'regex_match';          // claim text matches params.pattern

export interface CustomRule {
  id:          string;
  name:        string;
  description: string;
  condition:   RuleCondition;
  params:      Record<string, unknown>;
  severity:    RuleSeverity;
  enabled:     boolean;
  createdAt:   string;
  updatedAt:   string;
}

export interface RuleViolation {
  ruleId:      string;
  ruleName:    string;
  severity:    RuleSeverity;
  claimIndex:  number;
  claimText:   string;
  description: string;
}

/** A rule that was not (fully) evaluated, and why. Returned to the caller. */
export interface SkippedRule {
  ruleId:   string;
  ruleName: string;
  reason:   string;
}

export interface RuleEvaluation {
  violations: RuleViolation[];
  skipped:    SkippedRule[];
}

export interface CreateRuleInput {
  name:        string;
  description: string;
  condition:   RuleCondition;
  params?:     Record<string, unknown>;
  severity?:   RuleSeverity;
  enabled?:    boolean;
}

const VALID_CONDITIONS: RuleCondition[] = [
  'contains_keyword', 'missing_source', 'missing_date_citation', 'claim_type', 'regex_match',
];

const VALID_SEVERITIES: RuleSeverity[] = ['info', 'warning', 'error'];

export function validateRuleInput(input: unknown): CreateRuleInput {
  if (!input || typeof input !== 'object') throw new Error('Rule must be an object.');
  const r = input as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.trim() === '') throw new Error('Rule name is required.');
  if (typeof r.description !== 'string') throw new Error('Rule description is required.');
  if (!VALID_CONDITIONS.includes(r.condition as RuleCondition)) {
    throw new Error(`Invalid condition. Must be one of: ${VALID_CONDITIONS.join(', ')}.`);
  }
  const severity = (r.severity ?? 'warning') as RuleSeverity;
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}.`);
  }

  // Condition-specific param validation
  const params = (r.params ?? {}) as Record<string, unknown>;
  if (r.condition === 'contains_keyword') {
    if (!Array.isArray(params.keywords) || params.keywords.length === 0) {
      throw new Error('contains_keyword requires params.keywords (non-empty array).');
    }
  }
  if (r.condition === 'regex_match') {
    if (typeof params.pattern !== 'string' || params.pattern === '') {
      throw new Error('regex_match requires params.pattern (non-empty string).');
    }
    try { new RegExp(params.pattern as string, 'i'); } catch {
      throw new Error(`params.pattern is not a valid regex: ${params.pattern}`);
    }
    const compiled = compileSafeRegex(params.pattern as string, 'i');
    if (compiled.ok === false) {
      throw new Error(`params.pattern is refused (ReDoS guard): ${compiled.reason}.`);
    }
  }
  if (r.condition === 'claim_type') {
    if (!Array.isArray(params.types) || params.types.length === 0) {
      throw new Error('claim_type requires params.types (non-empty array).');
    }
  }

  return {
    name:        r.name.trim(),
    description: r.description as string,
    condition:   r.condition as RuleCondition,
    params,
    severity,
    enabled:     r.enabled !== false,
  };
}

/**
 * Wall-clock budget shared by every rule evaluated for one request. A single
 * regex execution cannot be interrupted, so the guard bounds each execution
 * (pattern policy + MAX_MATCH_TEXT_LENGTH) and this bounds their sum: up to
 * 500 rules times every claim in a 1 MB body would otherwise run for minutes.
 */
export const RULE_EVALUATION_BUDGET_MS = 1_000;

export interface EvaluationBudget {
  exhausted(): boolean;
}

/** Start a budget of `budgetMs` milliseconds from now. */
export function createEvaluationBudget(budgetMs: number = RULE_EVALUATION_BUDGET_MS): EvaluationBudget {
  const deadline = performance.now() + budgetMs;
  return { exhausted: () => performance.now() > deadline };
}

// Static patterns for missing_date_citation (CodeQL js/polynomial-redos). The
// original `\d+%|\d+\s*(billion|...)` was quadratic on a long run of digits
// (measured 4.6 s on 50,000 digits). For `.test()` the leading `+` is
// redundant: any match of `\d+X` contains a match of `\dX` at its last digit,
// so `\d%` and `\d\s*(...)` give the same answer in linear time. The input is
// bounded as well.
const STATISTICAL_PATTERN = /\d%|\d\s*(billion|million|thousand|percent)/i;
const DATE_PATTERN = /\b(19|20)\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december/i;

/** The slice of a claim's text that any regex is allowed to see. */
function boundedText(claim: ClaimLike): string {
  return (claim.text ?? '').slice(0, MAX_MATCH_TEXT_LENGTH);
}

type ClaimMatcher =
  | { ok: true; usesRegex: boolean; matches: (claim: ClaimLike) => boolean }
  | { ok: false; reason: string };

function hasNoSources(claim: ClaimLike): boolean {
  return !claim.sources || (Array.isArray(claim.sources) && claim.sources.length === 0);
}

/** Statistical/quantitative claim that lacks a year or month name. */
function lacksDateCitation(claim: ClaimLike): boolean {
  const text = boundedText(claim);
  return STATISTICAL_PATTERN.test(text) && !DATE_PATTERN.test(text);
}

/** Build the per-claim predicate for a rule once, compiling any regex up front. */
function buildMatcher(rule: CustomRule): ClaimMatcher {
  switch (rule.condition) {
    case 'contains_keyword': {
      const keywords = (rule.params.keywords as string[]).map(k => k.toLowerCase());
      const matches = (c: ClaimLike) => keywords.some(kw => (c.text ?? '').toLowerCase().includes(kw));
      return { ok: true, usesRegex: false, matches };
    }
    case 'missing_source':
      return { ok: true, usesRegex: false, matches: hasNoSources };
    case 'missing_date_citation':
      return { ok: true, usesRegex: true, matches: lacksDateCitation };
    case 'claim_type': {
      const types = (rule.params.types as string[]).map(t => t.toLowerCase());
      return { ok: true, usesRegex: false, matches: c => types.includes((c.type ?? '').toLowerCase()) };
    }
    case 'regex_match': {
      // Re-checked here for rules stored before the guard existed.
      const compiled = compileSafeRegex(String(rule.params.pattern ?? ''), 'i');
      if (compiled.ok === false) return { ok: false, reason: `regex_match pattern refused: ${compiled.reason}` };
      return { ok: true, usesRegex: true, matches: c => compiled.regex.test(boundedText(c)) };
    }
    default:
      return { ok: true, usesRegex: false, matches: () => false };
  }
}

function toViolation(rule: CustomRule, claim: ClaimLike, claimIndex: number): RuleViolation {
  return {
    ruleId:      rule.id,
    ruleName:    rule.name,
    severity:    rule.severity,
    claimIndex,
    claimText:   (claim.text ?? '').slice(0, 200),
    description: rule.description,
  };
}

function skip(rule: CustomRule, reason: string): SkippedRule {
  return { ruleId: rule.id, ruleName: rule.name, reason };
}

/**
 * Evaluate a single rule against claims, reporting a rule that was skipped.
 * A rule whose stored pattern fails the ReDoS guard is skipped, never executed.
 * Once the shared budget runs out, regex-based rules stop and are reported as
 * skipped, keeping any violations already found.
 *
 * @param budget - Shared across all rules of one request; defaults to a fresh one.
 */
export function evaluateRuleDetailed(
  rule: CustomRule,
  claims: ClaimLike[],
  budget: EvaluationBudget = createEvaluationBudget(),
): RuleEvaluation {
  if (!rule.enabled) return { violations: [], skipped: [] };
  const matcher = buildMatcher(rule);
  if (matcher.ok === false) return { violations: [], skipped: [skip(rule, matcher.reason)] };

  const violations: RuleViolation[] = [];
  for (let idx = 0; idx < claims.length; idx++) {
    if (matcher.usesRegex && budget.exhausted()) {
      const reason = `evaluation time budget exhausted at claim ${idx} of ${claims.length}`;
      return { violations, skipped: [skip(rule, reason)] };
    }
    if (matcher.matches(claims[idx])) violations.push(toViolation(rule, claims[idx], idx));
  }
  return { violations, skipped: [] };
}

/**
 * Evaluate a single rule against an array of claims.
 * Claims are expected to have at minimum: { text: string, type?: string, sources?: unknown[] }
 */
export function evaluateRule(rule: CustomRule, claims: ClaimLike[]): RuleViolation[] {
  return evaluateRuleDetailed(rule, claims).violations;
}

export interface ClaimLike {
  text?:    string;
  type?:    string;
  sources?: unknown[];
}

const MAX_RULES = 500;

class RuleStore {
  private rules: Map<string, CustomRule> = new Map();

  create(input: CreateRuleInput): CustomRule {
    if (this.rules.size >= MAX_RULES) {
      throw new Error(`Rule limit reached (max ${MAX_RULES}).`);
    }
    const now = new Date().toISOString();
    const rule: CustomRule = {
      id:          randomUUID(),
      name:        input.name,
      description: input.description,
      condition:   input.condition,
      params:      input.params ?? {},
      severity:    input.severity ?? 'warning',
      enabled:     input.enabled !== false,
      createdAt:   now,
      updatedAt:   now,
    };
    this.rules.set(rule.id, rule);
    return rule;
  }

  get(id: string): CustomRule | undefined {
    return this.rules.get(id);
  }

  list(): CustomRule[] {
    return Array.from(this.rules.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Patch a rule. A patched `params` is validated against the rule's condition
   * (the same checks as creation, including the ReDoS guard) and a patched
   * severity must be valid; both throw before anything is written.
   */
  update(id: string, patch: Partial<CreateRuleInput>): CustomRule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;
    if (patch.params !== undefined) {
      validateRuleInput({ ...rule, params: { ...rule.params, ...patch.params } });
    }
    if (patch.severity !== undefined && !VALID_SEVERITIES.includes(patch.severity)) {
      throw new Error(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}.`);
    }
    if (patch.name        !== undefined) rule.name        = patch.name;
    if (patch.description !== undefined) rule.description = patch.description;
    if (patch.severity    !== undefined) rule.severity    = patch.severity;
    if (patch.enabled     !== undefined) rule.enabled     = patch.enabled;
    if (patch.params      !== undefined) rule.params      = { ...rule.params, ...patch.params };
    rule.updatedAt = new Date().toISOString();
    return rule;
  }

  delete(id: string): boolean {
    return this.rules.delete(id);
  }

  /**
   * Apply all enabled rules to a set of claims. Returns violations grouped by severity.
   */
  applyAll(claims: ClaimLike[], budget: EvaluationBudget = createEvaluationBudget()): {
    violations: RuleViolation[];
    skipped: SkippedRule[];
    summary: { error: number; warning: number; info: number; total: number };
  } {
    const violations: RuleViolation[] = [];
    const skipped: SkippedRule[] = [];
    for (const rule of this.rules.values()) {
      const result = evaluateRuleDetailed(rule, claims, budget);
      violations.push(...result.violations);
      skipped.push(...result.skipped);
    }
    const summary = {
      error:   violations.filter(v => v.severity === 'error').length,
      warning: violations.filter(v => v.severity === 'warning').length,
      info:    violations.filter(v => v.severity === 'info').length,
      total:   violations.length,
    };
    return { violations, skipped, summary };
  }

  reset(): void {
    this.rules = new Map();
  }
}

let instance: RuleStore | null = null;

export function getRuleStore(): RuleStore {
  if (!instance) instance = new RuleStore();
  return instance;
}

export function resetRuleStore(): void {
  instance = new RuleStore();
}
