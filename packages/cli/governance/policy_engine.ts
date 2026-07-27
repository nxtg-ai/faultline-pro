import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import yaml from 'js-yaml';
import type {
  ActionPolicy,
  ActionRule,
  AgentAction,
  PolicyDecision,
  PolicyEvaluation,
} from './types.js';

/**
 * Deterministic action-gating engine.
 *
 * Pure, non-LLM evaluation: an {@link AgentAction} is matched against ordered
 * {@link ActionRule}s and resolved to a single {@link PolicyDecision}. Matching is
 * total and order-stable, so the same (action, policy) pair always yields the same
 * decision — the property that makes this a gate, not a judge.
 */

const VALID_DECISIONS: readonly PolicyDecision[] = ['allow', 'deny', 'require_approval'];

/**
 * Compile a glob matcher (`*` = any sequence, `?` = one char) into an anchored RegExp.
 * A pattern with no glob metacharacters is treated as an exact match by the caller's
 * fast path; this is the general case.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * True when `value` matches `pattern`. Exact string equality is tried first (fast
 * path and the common case); patterns containing `*` or `?` fall back to glob.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  return globToRegExp(pattern).test(value);
}

/** True when a rule's matchers (action, and optional resource/actor) all match the action. */
export function ruleMatches(rule: ActionRule, action: AgentAction): boolean {
  if (!matchesGlob(rule.action, action.action)) return false;
  if (rule.resource !== undefined) {
    if (action.resource === undefined) return false;
    if (!matchesGlob(rule.resource, action.resource)) return false;
  }
  if (rule.actor !== undefined) {
    if (!matchesGlob(rule.actor, action.actor)) return false;
  }
  return true;
}

/**
 * Evaluate a single action against a single policy. First matching rule wins;
 * if no rule matches, the policy's fail-closed `default` decision is returned.
 */
export function evaluate(action: AgentAction, policy: ActionPolicy): PolicyEvaluation {
  const start = process.hrtime.bigint();

  let decision: PolicyDecision = policy.default;
  let matchedRuleIndex = -1;
  let reason = `no rule matched; policy default "${policy.default}"`;

  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if (ruleMatches(rule, action)) {
      decision = rule.decision;
      matchedRuleIndex = i;
      reason = rule.reason ?? `matched rule ${i} (${rule.action})`;
      break;
    }
  }

  const latencyNs = Number(process.hrtime.bigint() - start);
  return { decision, policyId: policy.id, matchedRuleIndex, reason, latencyNs, action };
}

/** Restrictiveness ordering: deny is strictest, then require_approval, then allow. */
const DECISION_RANK: Record<PolicyDecision, number> = {
  deny: 2,
  require_approval: 1,
  allow: 0,
};

/**
 * Evaluate an action against multiple policies and combine by most-restrictive-wins:
 * any `deny` -> deny; else any `require_approval` -> require_approval; else `allow`.
 * The winning policy's evaluation (id, matched rule, reason) is returned so the
 * decision is always attributable. An empty policy set fails closed (deny).
 */
export function governAction(action: AgentAction, policies: ActionPolicy[]): PolicyEvaluation {
  if (policies.length === 0) {
    return {
      decision: 'deny',
      policyId: '(none)',
      matchedRuleIndex: -1,
      reason: 'no policies configured; fail-closed deny',
      latencyNs: 0,
      action,
    };
  }

  let winner: PolicyEvaluation | null = null;
  let totalLatency = 0;
  for (const policy of policies) {
    const evaln = evaluate(action, policy);
    totalLatency += evaln.latencyNs;
    if (winner === null || DECISION_RANK[evaln.decision] > DECISION_RANK[winner.decision]) {
      winner = evaln;
    }
  }

  // winner is non-null here (policies.length > 0); surface the summed latency.
  return { ...(winner as PolicyEvaluation), latencyNs: totalLatency };
}

/**
 * Validate a parsed policy object. Returns an error message, or null when valid.
 */
export function validateActionPolicy(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'Policy must be a non-null object';
  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string' || !obj.id) return 'Policy must have an "id" string';
  if (typeof obj.name !== 'string' || !obj.name) return 'Policy must have a "name" string';
  if (typeof obj.description !== 'string' || !obj.description) {
    return 'Policy must have a "description" string';
  }
  if (typeof obj.default !== 'string' || !VALID_DECISIONS.includes(obj.default as PolicyDecision)) {
    return `Policy "default" must be one of: ${VALID_DECISIONS.join(', ')}`;
  }
  if (!Array.isArray(obj.rules)) return 'Policy must have a "rules" array';

  for (let i = 0; i < obj.rules.length; i++) {
    const r = obj.rules[i];
    if (!r || typeof r !== 'object') return `Rule ${i} must be an object`;
    if (typeof r.action !== 'string' || !r.action) return `Rule ${i} must have an "action" string`;
    if (typeof r.decision !== 'string' || !VALID_DECISIONS.includes(r.decision)) {
      return `Rule ${i} "decision" must be one of: ${VALID_DECISIONS.join(', ')}`;
    }
    if (r.resource !== undefined && typeof r.resource !== 'string') {
      return `Rule ${i} "resource" must be a string when present`;
    }
    if (r.actor !== undefined && typeof r.actor !== 'string') {
      return `Rule ${i} "actor" must be a string when present`;
    }
    if (r.reason !== undefined && typeof r.reason !== 'string') {
      return `Rule ${i} "reason" must be a string when present`;
    }
  }

  return null;
}

/** Parse a YAML policy string into a validated {@link ActionPolicy}, or throw. */
export function parseActionPolicy(content: string): ActionPolicy {
  const data = yaml.load(content);
  const error = validateActionPolicy(data);
  if (error) throw new Error(error);
  return data as ActionPolicy;
}

/**
 * Load all YAML policy files from a directory. Invalid files log a warning and are
 * skipped; a missing/unreadable directory yields an empty array (mirrors the rules loader).
 */
export function loadPoliciesFromDir(dir: string): ActionPolicy[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => extname(f) === '.yaml' || extname(f) === '.yml');
  } catch {
    return [];
  }

  const policies: ActionPolicy[] = [];
  for (const file of files.sort()) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      policies.push(parseActionPolicy(content));
    } catch (err) {
      console.warn(`[warn] Skipping invalid policy "${file}": ${(err as Error).message}`);
    }
  }
  return policies;
}
