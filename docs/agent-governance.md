# Agent Governance (A-260) — Increment 1: Deterministic Action-Gating

**Status**: Increment 1 SHIPPED (deterministic action-gating core + provenance seed + `govern` CLI).
**Tracking**: PRM-CLX9-20260726-01. Spec: `~/ASIF/initiatives/faultline-agent-governance/BUILD-SPEC-PLAN.md`.
**Decision**: A-260 = BUILD ("Built to earn it!").

## Why this exists

Faultline's existing engine governs **claim content** — `rules/` takes text and returns
`Finding[]` (`check(content) -> Finding[]`). Agent governance is the strictly larger
category: governing an agent's **actions** *before they execute* — allow / deny /
require-approval on a declared action, deterministically, with no LLM in the blocking path.

Output-verification ⊂ agent-governance. This module builds the action-governance surface by
mirroring the proven `rules/` architecture (deterministic, YAML-driven, registry/loader pattern)
onto a new domain: `AgentAction` instead of `content`, `PolicyDecision` instead of `Finding`.

## The external bar

- **Microsoft Agent Governance Toolkit** (Apr 2026): deterministic non-LLM policy engine
  (OPA/Cedar/YAML) at `<0.1ms` p99, plus DID/Ed25519 provenance and a kill switch.
- Increment 1 meets the **deterministic-gating** dimension: pure, order-stable evaluation;
  measured latency **~0.056–0.084ms** per evaluation (under the `<0.1ms` bar).
- The **exceed** vectors (delegation-scoped authority; hash-chained provenance; proven on a live
  multi-agent population) land in Increments 2–4.

## Module layout — `packages/cli/governance/`

| File | Responsibility |
|---|---|
| `types.ts` | `AgentAction`, `PolicyDecision`, `ActionRule`, `ActionPolicy`, `PolicyEvaluation` |
| `policy_engine.ts` | deterministic matcher + evaluator (`evaluate`, `governAction`), YAML load + validate |
| `provenance.ts` | `ProvenanceLedger` — append-only typed audit records (seeds DoD 4.4) |
| `index.ts` | public exports |
| `yaml/fleet-baseline.yaml` | default-deny baseline (reversible→allow, source→gate, irreversible→deny) |
| `yaml/read-only.yaml` | strict sandbox: only read/search allowed |

CLI: `packages/cli/cli/govern.ts`, wired at `case 'govern'` in `cli/index.ts`.

## Semantics (the guarantees that make it a gate, not a judge)

1. **Deterministic**: same `(action, policy)` always yields the same decision. No randomness,
   no LLM in the blocking path.
2. **First-match-wins within a policy**: rule order is precedence.
3. **Fail-closed**: unmatched actions fall to the policy `default` (baseline = `deny`); an empty
   policy set denies.
4. **Most-restrictive-wins across policies**: `governAction` combines by
   `deny > require_approval > allow`. Loading the `read-only` sandbox alongside `fleet-baseline`
   therefore denies anything the sandbox doesn't explicitly allow — composition is safe.
5. **Matchers** support glob: `*` = any sequence, `?` = one char; exact strings take a fast path.
   Optional `resource` and `actor` matchers narrow a rule.

## CLI usage

```bash
faultline govern list                       # list loaded policies
faultline govern eval --actor agent:planner --action read.file --policy fleet-baseline
faultline govern eval --actor agent:x --action email.send --policy fleet-baseline   # exit 2 (deny)
faultline govern eval --actor agent:x --action file.write --resource /src/x.ts --json
```

Exit code `2` on a hard `deny` makes `govern eval` usable as a pre-execution / CI gate.
`--policy-dir <dir>` supplements the built-in policies with your own YAML.

## Tests

`tests/governance.test.ts` — 54 cases: glob matching, rule matching, single/multi-policy
evaluation, fail-closed default, validation (every invalid branch), YAML parse/load, the
provenance ledger (monotonic seq, injectable clock, decision filter, JSONL export, defensive
copy), and the full `govern` CLI through its dispatch shape (allow/deny/gate exit codes, `--json`,
error paths). No mocks; the CLI tests run the real policy files off disk.

## Roadmap

- **I2 — Delegation-scoped authority** (sharpest exceed): typed, revocable `DelegationGrant`;
  an action carries an authorization scope; out-of-scope actions are *held*, not executed.
  Externally this is research/spec-only (SPIFFE, OAuth RFC 8693 `act` claims).
- **I3 — Tamper-evident provenance**: hash-chain the ledger (each record commits to its
  predecessor), matching MS-Toolkit crypto-audit chains.
- **I4 — Population-replay proof**: replay a real multi-agent run where the gate *held* a
  disallowed action; the audit trail is the claim's proof-artifact — the whitespace no shipping
  competitor credibly closes.
