import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  governAction,
  govern,
  loadPoliciesFromDir,
  ProvenanceLedger,
  type ActionPolicy,
  type AgentAction,
  type DelegationGrant,
} from '../governance/index.js';

/**
 * `faultline govern` — the agent-governance CLI surface (Increment 1).
 *
 *   faultline govern list                     list loaded action policies
 *   faultline govern eval --actor <a> --action <verb> [--resource <r>] [--policy <id>]
 *                                             evaluate one action against the policy set
 *
 * Deterministic action-gating: the same action + policy set always yields the same
 * decision (allow / deny / require_approval), with no LLM in the blocking path.
 */

/** Resolve the built-in policy directory relative to this module. */
export function builtInPolicyDir(): string {
  const thisDir =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(thisDir, '..', 'governance', 'yaml');
}

/**
 * Load policies for a govern invocation. Custom dir (via --policy-dir) supplements
 * the built-ins; a --policy id narrows to a single named policy.
 */
export function loadGovernPolicies(opts: { policyDir?: string; policyId?: string }): ActionPolicy[] {
  const policies = loadPoliciesFromDir(builtInPolicyDir());
  if (opts.policyDir) {
    policies.push(...loadPoliciesFromDir(resolve(opts.policyDir)));
  }
  if (opts.policyId) {
    return policies.filter((p) => p.id === opts.policyId);
  }
  return policies;
}

/** Human-readable glyph for a decision. */
function glyph(decision: string): string {
  if (decision === 'allow') return '[allow]';
  if (decision === 'deny') return '[DENY ]';
  if (decision === 'held') return '[HELD ]';
  return '[gate ]';
}

/** Load delegation grants from a JSON file (an array of DelegationGrant). */
function loadGrants(path: string): DelegationGrant[] {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf-8'));
  if (!Array.isArray(raw)) throw new Error('grants file must contain a JSON array of grants');
  return raw as DelegationGrant[];
}

/**
 * Run the govern command. Pure with respect to I/O except reading policy YAML from
 * disk; returns the CLI contract shape.
 */
export function governCommand(
  subcommand: string,
  flags: Record<string, string>,
): { exitCode: number; output: string } {
  const policyDir = flags['policy-dir'];
  const policyId = flags['policy'];

  if (subcommand === 'list' || subcommand === '') {
    const policies = loadGovernPolicies({ policyDir });
    if (policies.length === 0) {
      return { exitCode: 0, output: 'No action policies loaded.' };
    }
    const lines = [`Action policies (${policies.length}):`, ''];
    for (const p of policies) {
      lines.push(`  ${p.id.padEnd(16)} ${p.name} — default: ${p.default}, rules: ${p.rules.length}`);
    }
    return { exitCode: 0, output: lines.join('\n') };
  }

  if (subcommand === 'eval') {
    const actor = flags['actor'];
    const action = flags['action'];
    if (!actor || !action) {
      return {
        exitCode: 1,
        output: 'Error: govern eval requires --actor and --action. See: faultline govern --help',
      };
    }

    const policies = loadGovernPolicies({ policyDir, policyId });
    if (policies.length === 0) {
      return {
        exitCode: 1,
        output: policyId
          ? `Error: no policy with id "${policyId}" found.`
          : 'Error: no action policies loaded.',
      };
    }

    const agentAction: AgentAction = {
      actor,
      action,
      resource: flags['resource'],
      correlationId: flags['correlation-id'],
    };

    const ledger = new ProvenanceLedger();

    // Delegation-enforced path (I2): when --grants is supplied, the combined verdict
    // HOLDS a policy-permitted action unless a valid grant authorizes it.
    if (flags['grants']) {
      let grants: DelegationGrant[];
      try {
        grants = loadGrants(flags['grants']);
      } catch (err) {
        return { exitCode: 1, output: `Error loading grants: ${(err as Error).message}` };
      }
      const verdict = govern(agentAction, { policies, grants, enforceDelegation: true });
      const record = ledger.appendVerdict(verdict);

      if (flags['json'] === 'true') {
        return { exitCode: 0, output: JSON.stringify({ verdict, record }, null, 2) };
      }
      const d = verdict.effectiveDecision;
      const lines = [
        `${glyph(d)} ${agentAction.actor} -> ${agentAction.action}${agentAction.resource ? ` (${agentAction.resource})` : ''}`,
        `  decision:  ${d}`,
        `  policy:    ${verdict.policy.decision} (${verdict.policy.policyId})`,
        `  authority: ${verdict.authorization?.authorized ? `grant ${verdict.authorization.grantId}` : 'no covering grant'}`,
        `  reason:    ${verdict.authorization?.reason ?? verdict.policy.reason}`,
      ];
      // deny -> 2 (hard block), held -> 3 (unauthorized), else 0.
      const exitCode = d === 'deny' ? 2 : d === 'held' ? 3 : 0;
      return { exitCode, output: lines.join('\n') };
    }

    const evaln = governAction(agentAction, policies);
    ledger.append(evaln);

    if (flags['json'] === 'true') {
      return { exitCode: 0, output: JSON.stringify({ evaluation: evaln, record: ledger.all()[0] }, null, 2) };
    }

    const lines = [
      `${glyph(evaln.decision)} ${agentAction.actor} -> ${agentAction.action}${agentAction.resource ? ` (${agentAction.resource})` : ''}`,
      `  decision: ${evaln.decision}`,
      `  policy:   ${evaln.policyId}${evaln.matchedRuleIndex >= 0 ? ` (rule ${evaln.matchedRuleIndex})` : ' (default)'}`,
      `  reason:   ${evaln.reason}`,
      `  latency:  ${evaln.latencyNs}ns`,
    ];
    // Exit non-zero for a hard deny so the command is usable as a CI/pre-exec gate.
    const exitCode = evaln.decision === 'deny' ? 2 : 0;
    return { exitCode, output: lines.join('\n') };
  }

  return {
    exitCode: 1,
    output: `Unknown govern subcommand: "${subcommand}". Usage: faultline govern <list|eval> [flags]`,
  };
}
