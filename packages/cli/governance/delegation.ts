import type {
  ActionPolicy,
  AgentAction,
  AuthorizationResult,
  DelegationGrant,
  DelegationScope,
  EffectiveDecision,
  GovernanceVerdict,
  PolicyDecision,
} from './types.js';
import { governAction, matchesGlob } from './policy_engine.js';

/**
 * Delegation-scoped authority (I2).
 *
 * The policy engine (I1) answers "does policy permit this action?" This module
 * answers "is this actor AUTHORIZED to take it?" — via typed, revocable
 * {@link DelegationGrant}s. An action the policy would allow is HELD (not executed)
 * unless a valid grant covers it. Composed by {@link govern}.
 */

/** Restrictiveness order used to apply a grant's optional decision ceiling. */
const DECISION_RANK: Record<PolicyDecision, number> = {
  deny: 2,
  require_approval: 1,
  allow: 0,
};

/** True when a grant is neither revoked nor expired at `now`. */
export function isGrantActive(grant: DelegationGrant, now: Date): boolean {
  if (grant.revoked) return false;
  if (grant.expiresAt !== undefined && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

/** True when a scope covers an action's verb and (if constrained) its resource. */
export function scopeCovers(scope: DelegationScope, action: AgentAction): boolean {
  const actionCovered = scope.actions.some((pattern) => matchesGlob(pattern, action.action));
  if (!actionCovered) return false;
  if (scope.resources !== undefined) {
    if (action.resource === undefined) return false;
    if (!scope.resources.some((pattern) => matchesGlob(pattern, action.resource as string))) {
      return false;
    }
  }
  return true;
}

/**
 * Check an action against a set of grants. Authorized iff some ACTIVE grant whose
 * grantee matches the actor covers the action. Returns the first covering grant.
 * A grant's optional `maxDecision` ceiling does not affect authorization here
 * (it is applied in {@link govern} against the policy decision).
 */
export function checkAuthorization(
  action: AgentAction,
  grants: DelegationGrant[],
  now: Date = new Date(),
): AuthorizationResult {
  for (const grant of grants) {
    if (grant.grantee !== action.actor) continue;
    if (!isGrantActive(grant, now)) continue;
    if (scopeCovers(grant.scope, action)) {
      return { authorized: true, grantId: grant.id, reason: `authorized by grant ${grant.id}` };
    }
  }
  return {
    authorized: false,
    reason: 'no active grant authorizes this action for the actor',
  };
}

/**
 * Apply a grant's optional decision ceiling: a grant with maxDecision
 * 'require_approval' downgrades an 'allow' policy decision to 'require_approval'.
 * A ceiling never makes a decision MORE permissive.
 */
function applyCeiling(decision: PolicyDecision, ceiling: PolicyDecision | undefined): PolicyDecision {
  if (ceiling === undefined) return decision;
  return DECISION_RANK[ceiling] < DECISION_RANK[decision] ? decision : ceiling;
}

/**
 * The combined governance verdict (I1 policy ⊕ I2 delegation).
 *
 * Precedence:
 *  1. Policy `deny` is a hard block — stays 'deny' regardless of any grant.
 *  2. Otherwise, when delegation is enforced and NO active grant covers the action,
 *     the action is 'held' (permitted by policy but unauthorized — not executed).
 *  3. Otherwise the (possibly ceiling-adjusted) policy decision stands.
 *
 * When `enforceDelegation` is false, this reduces to the policy decision (I1).
 */
export function govern(
  action: AgentAction,
  opts: { policies: ActionPolicy[]; grants?: DelegationGrant[]; enforceDelegation?: boolean; now?: Date },
): GovernanceVerdict {
  const policy = governAction(action, opts.policies);
  const enforce = opts.enforceDelegation ?? false;

  // 1. Policy deny is a hard block.
  if (policy.decision === 'deny') {
    return { effectiveDecision: 'deny', policy };
  }

  if (!enforce) {
    return { effectiveDecision: policy.decision, policy };
  }

  const grants = opts.grants ?? [];
  const authorization = checkAuthorization(action, grants, opts.now ?? new Date());

  // 2. Permitted by policy but no covering grant -> held.
  if (!authorization.authorized) {
    return { effectiveDecision: 'held', policy, authorization };
  }

  // 3. Authorized; apply the covering grant's optional decision ceiling.
  const grant = grants.find((g) => g.id === authorization.grantId);
  const effective: EffectiveDecision = applyCeiling(policy.decision, grant?.scope.maxDecision);
  return { effectiveDecision: effective, policy, authorization };
}

/**
 * In-memory registry of delegation grants. Grants are issued and revoked (not
 * deleted — revocation is recorded so the audit trail keeps the grant). The clock
 * is injectable for deterministic tests.
 */
export class DelegationStore {
  private readonly grants = new Map<string, DelegationGrant>();
  private readonly now: () => Date;
  private seq = 0;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Issue a grant. `id` is assigned if not supplied. Returns the stored grant. */
  issue(fields: {
    id?: string;
    principal: string;
    grantee: string;
    scope: DelegationScope;
    expiresAt?: string;
  }): DelegationGrant {
    const id = fields.id ?? `grant-${this.seq++}`;
    const grant: DelegationGrant = {
      id,
      principal: fields.principal,
      grantee: fields.grantee,
      scope: fields.scope,
      issuedAt: this.now().toISOString(),
      expiresAt: fields.expiresAt,
      revoked: false,
    };
    this.grants.set(id, grant);
    return grant;
  }

  /** Revoke a grant by id. Returns true if the grant existed and was revoked. */
  revoke(id: string): boolean {
    const grant = this.grants.get(id);
    if (!grant) return false;
    if (!grant.revoked) this.grants.set(id, { ...grant, revoked: true });
    return true;
  }

  /** Get a grant by id, or undefined. */
  get(id: string): DelegationGrant | undefined {
    return this.grants.get(id);
  }

  /** All grants (issued order not guaranteed; defensive copy). */
  all(): DelegationGrant[] {
    return [...this.grants.values()];
  }

  /** Active grants for a grantee at the given time (default: the store clock). */
  activeFor(grantee: string, now: Date = this.now()): DelegationGrant[] {
    return this.all().filter((g) => g.grantee === grantee && isGrantActive(g, now));
  }
}
