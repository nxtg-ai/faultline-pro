/**
 * Agent-governance core types.
 *
 * Where the `rules/` engine governs CLAIM CONTENT (`check(content) -> Finding[]`),
 * this surface governs agent ACTIONS: it takes a declared {@link AgentAction} and a
 * set of {@link ActionPolicy} definitions and returns a deterministic
 * {@link PolicyDecision} — allow / deny / require-approval — with no LLM in the
 * blocking path. This is the deterministic action-gating primitive (DoD 4.1, 4.2).
 */

/** The three terminal governance verdicts for a single agent action. */
export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

/**
 * A declared action an agent intends to take, before it executes.
 * The governance layer evaluates this record; it never runs the action itself.
 */
export interface AgentAction {
  /** The agent/actor attempting the action (e.g. 'agent:planner', a lane id). */
  actor: string;
  /** The action verb, dot-namespaced (e.g. 'file.write', 'shell.exec', 'email.send'). */
  action: string;
  /** The target resource the action touches (e.g. a path, URL, table name). */
  resource?: string;
  /** Free-form structured parameters for the action. */
  params?: Record<string, unknown>;
  /** Correlation/session id used to group records in the audit trail. */
  correlationId?: string;
}

/**
 * A single matcher within an {@link ActionPolicy}. Rules are evaluated in order;
 * the first rule that matches an action determines the decision (order = precedence).
 * Matchers support glob syntax: `*` matches any sequence, `?` matches one character.
 */
export interface ActionRule {
  /** Match on the action verb — exact or glob (e.g. 'file.*', 'shell.exec'). Required. */
  action: string;
  /** Optional resource matcher — exact or glob. Omitted = matches any resource. */
  resource?: string;
  /** Optional actor matcher — exact or glob. Omitted = matches any actor. */
  actor?: string;
  /** The decision applied when this rule matches. */
  decision: PolicyDecision;
  /** Human-readable justification surfaced in the evaluation and audit record. */
  reason?: string;
}

/** A named, ordered set of action rules with a fail-closed fallback decision. */
export interface ActionPolicy {
  /** Unique policy identifier (e.g. 'default-deny', 'fleet-baseline'). */
  id: string;
  /** Human-readable policy name. */
  name: string;
  /** Brief description of what the policy governs. */
  description: string;
  /** Fallback decision when no rule matches. Defaults to 'deny' (fail-closed). */
  default: PolicyDecision;
  /** Ordered rules; first match wins. */
  rules: ActionRule[];
}

/**
 * Delegation-scoped authority (I2 — the exceed vector).
 *
 * A {@link DelegationGrant} is a typed, revocable authorization object: it lets a
 * `grantee` act on behalf of a `principal`, but ONLY within a declared scope. An
 * action the policy would permit is still HELD (not executed) unless a valid,
 * unexpired, unrevoked grant covers it. Externally this is research/spec-only
 * (SPIFFE, OAuth RFC 8693 `act` claims); shipping it working is category-leading.
 */
export interface DelegationScope {
  /** Action verbs this grant authorizes — exact or glob (e.g. ['read.*', 'file.write']). */
  actions: string[];
  /** Optional resource matchers — exact or glob. Omitted = any resource in-scope. */
  resources?: string[];
  /**
   * Optional ceiling on the decision this grant can authorize. E.g. a grant with
   * maxDecision 'require_approval' cannot green-light an 'allow' action outright.
   * Omitted = no ceiling (authorizes up to 'allow').
   */
  maxDecision?: PolicyDecision;
}

/** A typed, revocable authorization for a grantee to act on a principal's behalf. */
export interface DelegationGrant {
  /** Unique grant identifier. */
  id: string;
  /** The authority-holder delegating (e.g. 'principal:asif'). */
  principal: string;
  /** The agent authorized to act within the scope (matched against AgentAction.actor). */
  grantee: string;
  /** What the grantee may do. */
  scope: DelegationScope;
  /** ISO-8601 issue time. */
  issuedAt: string;
  /** ISO-8601 expiry; omitted = no expiry. */
  expiresAt?: string;
  /** True once revoked — a revoked grant never authorizes (revocation wins immediately). */
  revoked: boolean;
}

/** The result of checking an action against the active delegation grants. */
export interface AuthorizationResult {
  /** True when a valid grant covers the action. */
  authorized: boolean;
  /** The id of the covering grant, when authorized. */
  grantId?: string;
  /** Why the action was authorized or held. */
  reason: string;
}

/** The combined verdict: 'held' means policy-permitted but not authorized by any grant. */
export type EffectiveDecision = PolicyDecision | 'held';

/** The full governance verdict combining the policy decision and delegation authority. */
export interface GovernanceVerdict {
  /** allow / deny / require_approval / held. 'held' = permitted by policy, no covering grant. */
  effectiveDecision: EffectiveDecision;
  /** The underlying policy evaluation. */
  policy: PolicyEvaluation;
  /** The authorization result, when delegation was enforced. */
  authorization?: AuthorizationResult;
}

/** The deterministic result of evaluating one action against one or more policies. */
export interface PolicyEvaluation {
  /** The terminal decision. */
  decision: PolicyDecision;
  /** Id of the policy that produced the decision. */
  policyId: string;
  /** Index of the matched rule within that policy, or -1 when the default fired. */
  matchedRuleIndex: number;
  /** The matched rule's reason, or a synthesized default reason. */
  reason: string;
  /** Wall-clock evaluation latency in nanoseconds — the deterministic-gating proof. */
  latencyNs: number;
  /** The action that was evaluated, echoed for the audit record. */
  action: AgentAction;
}
