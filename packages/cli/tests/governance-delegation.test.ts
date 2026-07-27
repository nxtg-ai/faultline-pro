import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isGrantActive,
  scopeCovers,
  checkAuthorization,
  govern,
  DelegationStore,
  ProvenanceLedger,
  type ActionPolicy,
  type DelegationGrant,
  type AgentAction,
} from '../governance/index';
import { governCommand } from '../cli/govern';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function grant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
  return {
    id: 'g1',
    principal: 'principal:asif',
    grantee: 'agent:planner',
    scope: { actions: ['file.write'] },
    issuedAt: '2026-07-27T00:00:00.000Z',
    revoked: false,
    ...overrides,
  };
}

// deny-by-default policy where file.write is allowed and email denied
const policy: ActionPolicy = {
  id: 'p',
  name: 'P',
  description: 'd',
  default: 'deny',
  rules: [
    { action: 'read.*', decision: 'allow' },
    { action: 'file.write', decision: 'allow' },
    { action: 'deploy.*', decision: 'require_approval' },
    { action: 'email.send', decision: 'deny' },
  ],
};

// ---------- isGrantActive ----------
describe('isGrantActive', () => {
  it('active when not revoked and not expired', () => {
    expect(isGrantActive(grant(), NOW)).toBe(true);
  });
  it('inactive when revoked', () => {
    expect(isGrantActive(grant({ revoked: true }), NOW)).toBe(false);
  });
  it('inactive when expired', () => {
    expect(isGrantActive(grant({ expiresAt: '2026-07-27T11:00:00.000Z' }), NOW)).toBe(false);
  });
  it('active when expiry is in the future', () => {
    expect(isGrantActive(grant({ expiresAt: '2026-07-27T13:00:00.000Z' }), NOW)).toBe(true);
  });
  it('treats an expiry exactly at now as expired (<=)', () => {
    expect(isGrantActive(grant({ expiresAt: NOW.toISOString() }), NOW)).toBe(false);
  });
});

// ---------- scopeCovers ----------
describe('scopeCovers', () => {
  it('covers an exact action verb', () => {
    expect(scopeCovers({ actions: ['file.write'] }, { actor: 'a', action: 'file.write' })).toBe(true);
  });
  it('covers a glob action verb', () => {
    expect(scopeCovers({ actions: ['file.*'] }, { actor: 'a', action: 'file.write' })).toBe(true);
  });
  it('does not cover an out-of-scope verb', () => {
    expect(scopeCovers({ actions: ['read.*'] }, { actor: 'a', action: 'file.write' })).toBe(false);
  });
  it('enforces a resource constraint when present', () => {
    const scope = { actions: ['file.write'], resources: ['/src/*'] };
    expect(scopeCovers(scope, { actor: 'a', action: 'file.write', resource: '/src/x.ts' })).toBe(true);
    expect(scopeCovers(scope, { actor: 'a', action: 'file.write', resource: '/etc/passwd' })).toBe(false);
  });
  it('does not cover when a resource is required but absent', () => {
    expect(scopeCovers({ actions: ['file.write'], resources: ['/src/*'] }, { actor: 'a', action: 'file.write' })).toBe(false);
  });
});

// ---------- checkAuthorization ----------
describe('checkAuthorization', () => {
  it('authorizes when an active covering grant matches the actor', () => {
    const r = checkAuthorization({ actor: 'agent:planner', action: 'file.write' }, [grant()], NOW);
    expect(r.authorized).toBe(true);
    expect(r.grantId).toBe('g1');
  });
  it('holds when no grant matches the actor', () => {
    const r = checkAuthorization({ actor: 'agent:other', action: 'file.write' }, [grant()], NOW);
    expect(r.authorized).toBe(false);
    expect(r.grantId).toBeUndefined();
  });
  it('holds when the only covering grant is revoked (revocation wins)', () => {
    const r = checkAuthorization({ actor: 'agent:planner', action: 'file.write' }, [grant({ revoked: true })], NOW);
    expect(r.authorized).toBe(false);
  });
  it('holds when the action is outside the grant scope', () => {
    const r = checkAuthorization({ actor: 'agent:planner', action: 'email.send' }, [grant()], NOW);
    expect(r.authorized).toBe(false);
  });
  it('returns the first covering grant among several', () => {
    const g2 = grant({ id: 'g2', scope: { actions: ['file.*'] } });
    const r = checkAuthorization({ actor: 'agent:planner', action: 'file.write' }, [grant(), g2], NOW);
    expect(r.grantId).toBe('g1');
  });
});

// ---------- govern (combined verdict) ----------
describe('govern — policy ⊕ delegation', () => {
  const action: AgentAction = { actor: 'agent:planner', action: 'file.write' };

  it('policy deny is a hard block regardless of grants', () => {
    const v = govern({ actor: 'agent:planner', action: 'email.send' }, {
      policies: [policy], grants: [grant({ scope: { actions: ['email.send'] } })], enforceDelegation: true, now: NOW,
    });
    expect(v.effectiveDecision).toBe('deny');
  });

  it('reduces to the policy decision when delegation is not enforced', () => {
    const v = govern(action, { policies: [policy] });
    expect(v.effectiveDecision).toBe('allow');
    expect(v.authorization).toBeUndefined();
  });

  it('HOLDS a policy-allowed action when no grant authorizes it', () => {
    const v = govern(action, { policies: [policy], grants: [], enforceDelegation: true, now: NOW });
    expect(v.effectiveDecision).toBe('held');
    expect(v.authorization?.authorized).toBe(false);
  });

  it('allows a policy-allowed action when a grant authorizes it', () => {
    const v = govern(action, { policies: [policy], grants: [grant()], enforceDelegation: true, now: NOW });
    expect(v.effectiveDecision).toBe('allow');
    expect(v.authorization?.grantId).toBe('g1');
  });

  it('holds when the covering grant is revoked', () => {
    const v = govern(action, { policies: [policy], grants: [grant({ revoked: true })], enforceDelegation: true, now: NOW });
    expect(v.effectiveDecision).toBe('held');
  });

  it('applies a grant maxDecision ceiling: allow downgraded to require_approval', () => {
    const capped = grant({ scope: { actions: ['file.write'], maxDecision: 'require_approval' } });
    const v = govern(action, { policies: [policy], grants: [capped], enforceDelegation: true, now: NOW });
    expect(v.effectiveDecision).toBe('require_approval');
  });

  it('a ceiling never makes a decision more permissive', () => {
    // policy says require_approval for deploy.*; a grant maxDecision allow must NOT upgrade it
    const deployGrant = grant({ scope: { actions: ['deploy.*'], maxDecision: 'allow' } });
    const v = govern({ actor: 'agent:planner', action: 'deploy.prod' }, {
      policies: [policy], grants: [deployGrant], enforceDelegation: true, now: NOW,
    });
    expect(v.effectiveDecision).toBe('require_approval');
  });
});

// ---------- DelegationStore ----------
describe('DelegationStore', () => {
  const clock = () => NOW;

  it('issues a grant with an auto id and issuedAt from the clock', () => {
    const store = new DelegationStore(clock);
    const g = store.issue({ principal: 'p', grantee: 'agent:x', scope: { actions: ['read.*'] } });
    expect(g.id).toBe('grant-0');
    expect(g.issuedAt).toBe(NOW.toISOString());
    expect(g.revoked).toBe(false);
    expect(store.get('grant-0')).toEqual(g);
  });

  it('revokes a grant (revocation persists)', () => {
    const store = new DelegationStore(clock);
    store.issue({ id: 'g', principal: 'p', grantee: 'agent:x', scope: { actions: ['read.*'] } });
    expect(store.revoke('g')).toBe(true);
    expect(store.get('g')!.revoked).toBe(true);
  });

  it('revoke returns false for an unknown grant', () => {
    expect(new DelegationStore(clock).revoke('nope')).toBe(false);
  });

  it('activeFor returns only unrevoked, unexpired grants for the grantee', () => {
    const store = new DelegationStore(clock);
    store.issue({ id: 'a', principal: 'p', grantee: 'agent:x', scope: { actions: ['read.*'] } });
    store.issue({ id: 'b', principal: 'p', grantee: 'agent:x', scope: { actions: ['file.*'] } });
    store.issue({ id: 'c', principal: 'p', grantee: 'agent:y', scope: { actions: ['read.*'] } });
    store.revoke('b');
    const active = store.activeFor('agent:x');
    expect(active.map((g) => g.id)).toEqual(['a']);
  });
});

// ---------- provenance appendVerdict ----------
describe('ProvenanceLedger.appendVerdict', () => {
  it('records the effective decision and grant id from a verdict', () => {
    const ledger = new ProvenanceLedger(() => NOW);
    const held = govern({ actor: 'agent:planner', action: 'file.write' }, {
      policies: [policy], grants: [], enforceDelegation: true, now: NOW,
    });
    const rec = ledger.appendVerdict(held);
    expect(rec.effectiveDecision).toBe('held');
    expect(rec.decision).toBe('allow'); // underlying policy decision preserved
    expect(rec.grantId).toBeUndefined();
    expect(ledger.size()).toBe(1);
  });

  it('records the authorizing grant id on an authorized verdict', () => {
    const ledger = new ProvenanceLedger(() => NOW);
    const ok = govern({ actor: 'agent:planner', action: 'file.write' }, {
      policies: [policy], grants: [grant()], enforceDelegation: true, now: NOW,
    });
    const rec = ledger.appendVerdict(ok);
    expect(rec.effectiveDecision).toBe('allow');
    expect(rec.grantId).toBe('g1');
  });
});

// ---------- govern CLI --grants path ----------
describe('governCommand eval --grants (delegation-enforced)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-grants-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A grant with no expiry so it stays active regardless of test wall-clock.
  const writeGrants = (grants: DelegationGrant[]): string => {
    const path = join(dir, `grants-${grants.map((g) => g.id).join('-') || 'empty'}.json`);
    writeFileSync(path, JSON.stringify(grants));
    return path;
  };
  const fileWriteGrant = grant({ expiresAt: undefined, scope: { actions: ['file.write'] } });

  it('HOLDS a policy-allowed action (exit 3) when the grants file has no covering grant', () => {
    const path = writeGrants([]);
    const { exitCode, output } = governCommand('eval', {
      actor: 'agent:planner', action: 'file.write', policy: 'fleet-baseline', grants: path,
    });
    // fleet-baseline gives file.write require_approval; with no grant -> held
    expect(exitCode).toBe(3);
    expect(output).toContain('held');
    expect(output).toContain('no covering grant');
  });

  it('authorizes a covered action (exit 0) when a grant covers it', () => {
    const path = writeGrants([fileWriteGrant]);
    const { exitCode, output } = governCommand('eval', {
      actor: 'agent:planner', action: 'file.write', policy: 'fleet-baseline', grants: path,
    });
    // fleet-baseline require_approval, grant authorizes -> require_approval (exit 0)
    expect(exitCode).toBe(0);
    expect(output).toContain('grant g1');
  });

  it('keeps a policy deny as a hard block (exit 2) even with a covering grant', () => {
    const emailGrant = grant({ id: 'gmail', expiresAt: undefined, scope: { actions: ['email.send'] } });
    const path = writeGrants([emailGrant]);
    const { exitCode, output } = governCommand('eval', {
      actor: 'agent:planner', action: 'email.send', policy: 'fleet-baseline', grants: path,
    });
    expect(exitCode).toBe(2);
    expect(output).toContain('deny');
  });

  it('emits combined verdict JSON with --json', () => {
    const path = writeGrants([fileWriteGrant]);
    const { output } = governCommand('eval', {
      actor: 'agent:planner', action: 'file.write', policy: 'fleet-baseline', grants: path, json: 'true',
    });
    const parsed = JSON.parse(output);
    expect(parsed.verdict.effectiveDecision).toBe('require_approval');
    expect(parsed.verdict.authorization.grantId).toBe('g1');
    expect(parsed.record.grantId).toBe('g1');
  });

  it('errors on an unreadable grants file', () => {
    const { exitCode, output } = governCommand('eval', {
      actor: 'a', action: 'read.file', policy: 'fleet-baseline', grants: '/no/such/grants.json',
    });
    expect(exitCode).toBe(1);
    expect(output).toContain('Error loading grants');
  });
});
