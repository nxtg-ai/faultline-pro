import { describe, it, expect } from 'vitest';
import {
  matchesGlob,
  ruleMatches,
  evaluate,
  governAction,
  validateActionPolicy,
  parseActionPolicy,
  loadPoliciesFromDir,
  ProvenanceLedger,
  type ActionPolicy,
  type AgentAction,
} from '../governance/index';
import { governCommand, builtInPolicyDir, loadGovernPolicies } from '../cli/govern';

// A small deny-by-default policy used across evaluation tests.
const policy: ActionPolicy = {
  id: 'test-policy',
  name: 'Test Policy',
  description: 'deny by default; read allowed; file.write gated; email denied',
  default: 'deny',
  rules: [
    { action: 'read.*', decision: 'allow', reason: 'reads are safe' },
    { action: 'file.write', decision: 'require_approval', reason: 'writes gated' },
    { action: 'email.send', decision: 'deny', reason: 'outbound denied' },
    { action: 'shell.exec', resource: '*rm -rf*', decision: 'deny', reason: 'destructive' },
    { action: 'db.query', actor: 'agent:trusted', decision: 'allow', reason: 'trusted reader' },
  ],
};

// ---------- Glob matching ----------

describe('matchesGlob', () => {
  it('matches exact strings', () => {
    expect(matchesGlob('file.write', 'file.write')).toBe(true);
  });

  it('rejects non-matching exact strings', () => {
    expect(matchesGlob('file.write', 'file.read')).toBe(false);
  });

  it('matches * as any sequence', () => {
    expect(matchesGlob('read.*', 'read.file')).toBe(true);
    expect(matchesGlob('read.*', 'read.db.rows')).toBe(true);
  });

  it('matches ? as one character', () => {
    expect(matchesGlob('v?', 'v1')).toBe(true);
    expect(matchesGlob('v?', 'v12')).toBe(false);
  });

  it('does not treat a literal dot as a wildcard', () => {
    expect(matchesGlob('read.file', 'readxfile')).toBe(false);
  });

  it('matches an embedded substring wildcard', () => {
    expect(matchesGlob('*rm -rf*', 'sudo rm -rf /')).toBe(true);
    expect(matchesGlob('*rm -rf*', 'ls -la')).toBe(false);
  });
});

// ---------- ruleMatches ----------

describe('ruleMatches', () => {
  it('matches on action verb alone', () => {
    expect(ruleMatches({ action: 'read.*', decision: 'allow' }, { actor: 'a', action: 'read.file' })).toBe(true);
  });

  it('requires resource match when rule specifies a resource', () => {
    const rule = { action: 'shell.exec', resource: '*rm -rf*', decision: 'deny' as const };
    expect(ruleMatches(rule, { actor: 'a', action: 'shell.exec', resource: 'rm -rf /tmp' })).toBe(true);
    expect(ruleMatches(rule, { actor: 'a', action: 'shell.exec', resource: 'ls' })).toBe(false);
  });

  it('does not match when rule wants a resource but action has none', () => {
    const rule = { action: 'shell.exec', resource: '*rm*', decision: 'deny' as const };
    expect(ruleMatches(rule, { actor: 'a', action: 'shell.exec' })).toBe(false);
  });

  it('requires actor match when rule specifies an actor', () => {
    const rule = { action: 'db.query', actor: 'agent:trusted', decision: 'allow' as const };
    expect(ruleMatches(rule, { actor: 'agent:trusted', action: 'db.query' })).toBe(true);
    expect(ruleMatches(rule, { actor: 'agent:other', action: 'db.query' })).toBe(false);
  });
});

// ---------- evaluate ----------

describe('evaluate', () => {
  it('returns the first matching rule decision (order = precedence)', () => {
    const e = evaluate({ actor: 'a', action: 'read.file' }, policy);
    expect(e.decision).toBe('allow');
    expect(e.matchedRuleIndex).toBe(0);
    expect(e.reason).toBe('reads are safe');
    expect(e.policyId).toBe('test-policy');
  });

  it('gates file.write via require_approval', () => {
    const e = evaluate({ actor: 'a', action: 'file.write', resource: '/src/x.ts' }, policy);
    expect(e.decision).toBe('require_approval');
    expect(e.matchedRuleIndex).toBe(1);
  });

  it('fails closed to the policy default when no rule matches', () => {
    const e = evaluate({ actor: 'a', action: 'unknown.verb' }, policy);
    expect(e.decision).toBe('deny');
    expect(e.matchedRuleIndex).toBe(-1);
    expect(e.reason).toContain('default');
  });

  it('denies a destructive shell command via resource match', () => {
    const e = evaluate({ actor: 'a', action: 'shell.exec', resource: 'sudo rm -rf /' }, policy);
    expect(e.decision).toBe('deny');
    expect(e.matchedRuleIndex).toBe(3);
  });

  it('respects actor-scoped rules', () => {
    const allowed = evaluate({ actor: 'agent:trusted', action: 'db.query' }, policy);
    expect(allowed.decision).toBe('allow');
    const denied = evaluate({ actor: 'agent:other', action: 'db.query' }, policy);
    // no other rule matches db.query for an untrusted actor -> default deny
    expect(denied.decision).toBe('deny');
  });

  it('measures a non-negative evaluation latency', () => {
    const e = evaluate({ actor: 'a', action: 'read.file' }, policy);
    expect(e.latencyNs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic — same input yields same decision', () => {
    const action: AgentAction = { actor: 'a', action: 'email.send' };
    const first = evaluate(action, policy);
    const second = evaluate(action, policy);
    expect(first.decision).toBe(second.decision);
    expect(first.matchedRuleIndex).toBe(second.matchedRuleIndex);
    expect(first.decision).toBe('deny');
  });
});

// ---------- governAction (multi-policy, most-restrictive-wins) ----------

describe('governAction', () => {
  const allowAll: ActionPolicy = {
    id: 'allow-all',
    name: 'Allow All',
    description: 'permissive',
    default: 'allow',
    rules: [],
  };
  const denyEmail: ActionPolicy = {
    id: 'deny-email',
    name: 'Deny Email',
    description: 'blocks outbound email',
    default: 'allow',
    rules: [{ action: 'email.send', decision: 'deny', reason: 'no outbound' }],
  };

  it('fails closed to deny with no policies', () => {
    const e = governAction({ actor: 'a', action: 'read.file' }, []);
    expect(e.decision).toBe('deny');
    expect(e.policyId).toBe('(none)');
  });

  it('the strictest decision wins across policies', () => {
    const e = governAction({ actor: 'a', action: 'email.send' }, [allowAll, denyEmail]);
    expect(e.decision).toBe('deny');
    expect(e.policyId).toBe('deny-email');
  });

  it('allows when every policy allows', () => {
    const e = governAction({ actor: 'a', action: 'read.file' }, [allowAll, denyEmail]);
    expect(e.decision).toBe('allow');
  });

  it('require_approval beats allow but loses to deny', () => {
    const gate: ActionPolicy = {
      id: 'gate', name: 'Gate', description: 'gates writes', default: 'allow',
      rules: [{ action: 'file.write', decision: 'require_approval' }],
    };
    const e = governAction({ actor: 'a', action: 'file.write' }, [allowAll, gate]);
    expect(e.decision).toBe('require_approval');
    expect(e.policyId).toBe('gate');
  });

  it('sums latency across evaluated policies', () => {
    const e = governAction({ actor: 'a', action: 'read.file' }, [allowAll, denyEmail]);
    expect(e.latencyNs).toBeGreaterThanOrEqual(0);
  });
});

// ---------- validateActionPolicy ----------

describe('validateActionPolicy', () => {
  const valid = { id: 'p', name: 'P', description: 'd', default: 'deny', rules: [] };

  it('accepts a valid policy', () => {
    expect(validateActionPolicy(valid)).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(validateActionPolicy(null)).toContain('non-null object');
    expect(validateActionPolicy('x')).toContain('non-null object');
  });

  it('rejects a missing id', () => {
    expect(validateActionPolicy({ ...valid, id: '' })).toContain('id');
  });

  it('rejects an invalid default decision', () => {
    expect(validateActionPolicy({ ...valid, default: 'maybe' })).toContain('default');
  });

  it('rejects non-array rules', () => {
    expect(validateActionPolicy({ ...valid, rules: 'nope' })).toContain('rules');
  });

  it('rejects a rule with no action', () => {
    expect(validateActionPolicy({ ...valid, rules: [{ decision: 'allow' }] })).toContain('action');
  });

  it('rejects a rule with an invalid decision', () => {
    expect(validateActionPolicy({ ...valid, rules: [{ action: 'x', decision: 'perhaps' }] })).toContain('decision');
  });

  it('rejects a non-string resource', () => {
    expect(validateActionPolicy({ ...valid, rules: [{ action: 'x', decision: 'allow', resource: 5 }] })).toContain('resource');
  });
});

// ---------- parseActionPolicy ----------

describe('parseActionPolicy', () => {
  it('parses a valid YAML policy', () => {
    const p = parseActionPolicy('id: y\nname: Y\ndescription: d\ndefault: deny\nrules:\n  - action: read.*\n    decision: allow\n');
    expect(p.id).toBe('y');
    expect(p.rules.length).toBe(1);
    expect(p.rules[0].decision).toBe('allow');
  });

  it('throws on an invalid policy', () => {
    expect(() => parseActionPolicy('id: y\nname: Y\ndescription: d\ndefault: bogus\nrules: []\n')).toThrow(/default/);
  });
});

// ---------- loadPoliciesFromDir + built-in policies ----------

describe('loadPoliciesFromDir', () => {
  it('loads the built-in policies from the packaged yaml dir', () => {
    const policies = loadPoliciesFromDir(builtInPolicyDir());
    expect(policies.length).toBeGreaterThan(0);
    const ids = policies.map((p) => p.id);
    expect(ids).toContain('fleet-baseline');
    expect(ids).toContain('read-only');
  });

  it('the fleet-baseline policy is fail-closed and denies outbound email', () => {
    const policies = loadPoliciesFromDir(builtInPolicyDir());
    const baseline = policies.find((p) => p.id === 'fleet-baseline');
    expect(baseline).toBeDefined();
    expect(baseline!.default).toBe('deny');
    const e = evaluate({ actor: 'a', action: 'email.send' }, baseline!);
    expect(e.decision).toBe('deny');
  });

  it('returns an empty array for a missing directory', () => {
    expect(loadPoliciesFromDir('/no/such/dir/anywhere')).toEqual([]);
  });
});

// ---------- ProvenanceLedger ----------

describe('ProvenanceLedger', () => {
  const evalFor = (action: AgentAction) => evaluate(action, policy);

  it('appends records with a monotonic sequence starting at 0', () => {
    const ledger = new ProvenanceLedger(() => new Date('2026-07-26T00:00:00.000Z'));
    const r0 = ledger.append(evalFor({ actor: 'a', action: 'read.file' }));
    const r1 = ledger.append(evalFor({ actor: 'a', action: 'email.send' }));
    expect(r0.seq).toBe(0);
    expect(r1.seq).toBe(1);
    expect(ledger.size()).toBe(2);
  });

  it('uses the injected clock for deterministic timestamps', () => {
    const ledger = new ProvenanceLedger(() => new Date('2026-07-26T12:34:56.000Z'));
    const r = ledger.append(evalFor({ actor: 'a', action: 'read.file' }));
    expect(r.timestamp).toBe('2026-07-26T12:34:56.000Z');
  });

  it('captures the decision and reason on the record', () => {
    const ledger = new ProvenanceLedger();
    const r = ledger.append(evalFor({ actor: 'a', action: 'email.send' }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('outbound denied');
    expect(r.action.action).toBe('email.send');
  });

  it('filters by decision', () => {
    const ledger = new ProvenanceLedger();
    ledger.append(evalFor({ actor: 'a', action: 'read.file' }));
    ledger.append(evalFor({ actor: 'a', action: 'email.send' }));
    ledger.append(evalFor({ actor: 'a', action: 'db.drop' })); // default deny
    expect(ledger.byDecision('deny').length).toBe(2);
    expect(ledger.byDecision('allow').length).toBe(1);
  });

  it('all() returns a defensive copy', () => {
    const ledger = new ProvenanceLedger();
    ledger.append(evalFor({ actor: 'a', action: 'read.file' }));
    const snapshot = ledger.all();
    snapshot.push({} as never);
    expect(ledger.size()).toBe(1);
  });

  it('exports newline-delimited JSON with one record per line', () => {
    const ledger = new ProvenanceLedger(() => new Date('2026-07-26T00:00:00.000Z'));
    ledger.append(evalFor({ actor: 'a', action: 'read.file' }));
    ledger.append(evalFor({ actor: 'a', action: 'email.send' }));
    const lines = ledger.toJSONL().split('\n');
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[1]);
    expect(parsed.decision).toBe('deny');
    expect(parsed.seq).toBe(1);
  });
});

// ---------- govern CLI command (real path through main dispatch shape) ----------

describe('governCommand', () => {
  it('lists the built-in policies', () => {
    const { exitCode, output } = governCommand('list', {});
    expect(exitCode).toBe(0);
    expect(output).toContain('fleet-baseline');
    expect(output).toContain('read-only');
  });

  it('defaults to list when subcommand is empty', () => {
    const { output } = governCommand('', {});
    expect(output).toContain('Action policies');
  });

  it('evaluates an allowed action with exit 0', () => {
    const { exitCode, output } = governCommand('eval', { actor: 'agent:x', action: 'read.file' });
    expect(exitCode).toBe(0);
    expect(output).toContain('allow');
  });

  it('evaluates a denied action with exit 2 (usable as a gate)', () => {
    const { exitCode, output } = governCommand('eval', { actor: 'agent:x', action: 'email.send' });
    expect(exitCode).toBe(2);
    expect(output).toContain('deny');
  });

  it('evaluates a gated action (require_approval) with exit 0 under fleet-baseline', () => {
    // Narrowed to fleet-baseline: read-only (also built-in) would default-deny and win.
    const { exitCode, output } = governCommand('eval', { actor: 'agent:x', action: 'file.write', resource: '/src/a.ts', policy: 'fleet-baseline' });
    expect(exitCode).toBe(0);
    expect(output).toContain('require_approval');
  });

  it('denies a gated action when the read-only sandbox is also in force (most-restrictive-wins)', () => {
    const { exitCode } = governCommand('eval', { actor: 'agent:x', action: 'file.write', resource: '/src/a.ts' });
    expect(exitCode).toBe(2);
  });

  it('errors when actor or action is missing', () => {
    const { exitCode, output } = governCommand('eval', { actor: 'agent:x' });
    expect(exitCode).toBe(1);
    expect(output).toContain('requires --actor and --action');
  });

  it('narrows to a single policy via --policy', () => {
    // read-only policy denies email; against it a write is default-denied too
    const { exitCode } = governCommand('eval', { actor: 'a', action: 'file.write', policy: 'read-only' });
    expect(exitCode).toBe(2);
  });

  it('errors on an unknown --policy id', () => {
    const { exitCode, output } = governCommand('eval', { actor: 'a', action: 'read.file', policy: 'does-not-exist' });
    expect(exitCode).toBe(1);
    expect(output).toContain('does-not-exist');
  });

  it('emits JSON with the evaluation and provenance record when --json is set', () => {
    const { output } = governCommand('eval', { actor: 'a', action: 'email.send', json: 'true' });
    const parsed = JSON.parse(output);
    expect(parsed.evaluation.decision).toBe('deny');
    expect(parsed.record.seq).toBe(0);
    expect(parsed.record.action.action).toBe('email.send');
  });

  it('rejects an unknown subcommand', () => {
    const { exitCode, output } = governCommand('frobnicate', {});
    expect(exitCode).toBe(1);
    expect(output).toContain('Unknown govern subcommand');
  });
});

// ---------- loadGovernPolicies ----------

describe('loadGovernPolicies', () => {
  it('loads built-ins by default', () => {
    const policies = loadGovernPolicies({});
    expect(policies.map((p) => p.id)).toContain('fleet-baseline');
  });

  it('narrows to a single policy id', () => {
    const policies = loadGovernPolicies({ policyId: 'read-only' });
    expect(policies.length).toBe(1);
    expect(policies[0].id).toBe('read-only');
  });
});
