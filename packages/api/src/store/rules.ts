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
    try { new RegExp(params.pattern as string); } catch {
      throw new Error(`params.pattern is not a valid regex: ${params.pattern}`);
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
 * Evaluate a single rule against an array of claims.
 * Claims are expected to have at minimum: { text: string, type?: string, sources?: unknown[] }
 */
export function evaluateRule(rule: CustomRule, claims: ClaimLike[]): RuleViolation[] {
  if (!rule.enabled) return [];
  const violations: RuleViolation[] = [];

  claims.forEach((claim, idx) => {
    const text = (claim.text ?? '').toLowerCase();
    let violated = false;

    switch (rule.condition) {
      case 'contains_keyword': {
        const keywords = (rule.params.keywords as string[]).map(k => k.toLowerCase());
        violated = keywords.some(kw => text.includes(kw));
        break;
      }
      case 'missing_source': {
        violated = !claim.sources || (Array.isArray(claim.sources) && claim.sources.length === 0);
        break;
      }
      case 'missing_date_citation': {
        // Fire on statistical/quantitative claims that lack a year or date pattern
        const isStatistical = /\d+%|\d+\s*(billion|million|thousand|percent)/i.test(claim.text ?? '');
        const hasDate = /\b(19|20)\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december/i.test(claim.text ?? '');
        violated = isStatistical && !hasDate;
        break;
      }
      case 'claim_type': {
        const types = (rule.params.types as string[]).map(t => t.toLowerCase());
        violated = types.includes((claim.type ?? '').toLowerCase());
        break;
      }
      case 'regex_match': {
        try {
          violated = new RegExp(rule.params.pattern as string, 'i').test(claim.text ?? '');
        } catch { violated = false; }
        break;
      }
    }

    if (violated) {
      violations.push({
        ruleId:      rule.id,
        ruleName:    rule.name,
        severity:    rule.severity,
        claimIndex:  idx,
        claimText:   (claim.text ?? '').slice(0, 200),
        description: rule.description,
      });
    }
  });

  return violations;
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

  update(id: string, patch: Partial<CreateRuleInput>): CustomRule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;
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
  applyAll(claims: ClaimLike[]): {
    violations: RuleViolation[];
    summary: { error: number; warning: number; info: number; total: number };
  } {
    const violations: RuleViolation[] = [];
    for (const rule of this.rules.values()) {
      violations.push(...evaluateRule(rule, claims));
    }
    const summary = {
      error:   violations.filter(v => v.severity === 'error').length,
      warning: violations.filter(v => v.severity === 'warning').length,
      info:    violations.filter(v => v.severity === 'info').length,
      total:   violations.length,
    };
    return { violations, summary };
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
