import type { AgentAction, PolicyDecision, EffectiveDecision, GovernanceVerdict } from './types.js';
import type { PolicyEvaluation } from './types.js';

/**
 * A typed, first-class record of one governed decision (DoD 4.4).
 *
 * Increment 1 seeds the record shape and an append-only in-memory ledger with a
 * monotonic sequence number. Tamper-evident hash-chaining (DoD 4.4 exceed-vector)
 * is added in Increment 3; this record shape is forward-compatible with it.
 */
export interface GovernanceRecord {
  /** Monotonic sequence within a single ledger, starting at 0. */
  seq: number;
  /** ISO-8601 timestamp of when the record was appended. */
  timestamp: string;
  /** The action that was governed. */
  action: AgentAction;
  /** The terminal decision. */
  decision: PolicyDecision;
  /** Id of the policy that produced the decision. */
  policyId: string;
  /** Index of the matched rule, or -1 when the policy default fired. */
  matchedRuleIndex: number;
  /** The decision's justification. */
  reason: string;
  /** Evaluation latency in nanoseconds. */
  latencyNs: number;
  /**
   * The combined effective decision when delegation was in force (I2): may be
   * 'held' when policy permitted the action but no grant authorized it. Absent on
   * pure policy records (I1), where `decision` is authoritative.
   */
  effectiveDecision?: EffectiveDecision;
  /** The id of the authorizing grant, when the action was authorized by delegation. */
  grantId?: string;
}

/**
 * Append-only ledger of governed decisions. Records can be appended and read; there
 * is no update or delete API by design (an audit trail is append-only). The
 * `now` clock is injectable so callers/tests get deterministic timestamps.
 */
export class ProvenanceLedger {
  private readonly records: GovernanceRecord[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Append a record built from a {@link PolicyEvaluation}. Returns the stored record. */
  append(evaln: PolicyEvaluation): GovernanceRecord {
    const record: GovernanceRecord = {
      seq: this.records.length,
      timestamp: this.now().toISOString(),
      action: evaln.action,
      decision: evaln.decision,
      policyId: evaln.policyId,
      matchedRuleIndex: evaln.matchedRuleIndex,
      reason: evaln.reason,
      latencyNs: evaln.latencyNs,
    };
    this.records.push(record);
    return record;
  }

  /**
   * Append a record from a combined {@link GovernanceVerdict} (I2). Captures the
   * effective decision (which may be 'held') and the authorizing grant id, on top
   * of the underlying policy evaluation.
   */
  appendVerdict(verdict: GovernanceVerdict): GovernanceRecord {
    const base = this.append(verdict.policy);
    const enriched: GovernanceRecord = {
      ...base,
      effectiveDecision: verdict.effectiveDecision,
      grantId: verdict.authorization?.grantId,
    };
    this.records[this.records.length - 1] = enriched;
    return enriched;
  }

  /** All records in append order (defensive copy). */
  all(): GovernanceRecord[] {
    return [...this.records];
  }

  /** Number of records in the ledger. */
  size(): number {
    return this.records.length;
  }

  /** Records whose decision matches `decision`, in append order. */
  byDecision(decision: PolicyDecision): GovernanceRecord[] {
    return this.records.filter((r) => r.decision === decision);
  }

  /** Serialize the full ledger to newline-delimited JSON (durable audit export). */
  toJSONL(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }
}
