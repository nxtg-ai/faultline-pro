#!/usr/bin/env node
/**
 * Cost per verified claim on the live engine (GoPMO 1.18.11.3.8, emma-soul al:354806ed0923bbfb item 1).
 *
 * Sends 25 claims from the G0 corpus (every 26th line: 0, 26, ..., 624) in one POST /admin/verify-claims,
 * the route the accuracy runs use. Reads admin GET /usage before and after: the provider-spend ledger
 * (spentUsd) and today's grounded-prompt count. Cost per claim = ledger delta / claims sent.
 * Any other traffic in the same minutes lands in the same delta; the output prints both counts so a
 * reader can see whether grounded prompts rose by exactly the number sent.
 *
 * The admin key comes from ~/.config/faultline/hosted-api-key.env and is sent only as x-api-key.
 * Usage: node scripts/measure-verify-cost.mjs [--api https://faultline-api.fly.dev] [--out <file.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdminKey } from './accuracy-g0.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLD = path.join(REPO_ROOT, 'docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl');
const STRIDE = 26;
const N = 25;

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const api = flag('--api', 'https://faultline-api.fly.dev').replace(/\/+$/, '');
const out = flag('--out', undefined);

const key = readAdminKey(process.env, path.join(process.env.HOME, '.config/faultline/hosted-api-key.env'));
if (!key) { console.error('no admin key'); process.exit(2); }

async function call(method, route, body) {
  const res = await fetch(api + route, {
    method,
    headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(600_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${json?.error ?? ''}`);
  return json;
}

const lines = readFileSync(GOLD, 'utf8').split('\n').filter(Boolean);
const claims = [];
for (let i = 0; claims.length < N; i += STRIDE) claims.push({ id: String(i), text: JSON.parse(lines[i]).claim });

const health = await call('GET', '/health');
const before = await call('GET', '/usage');
const t0 = Date.now();
const result = await call('POST', '/admin/verify-claims', { claims });
const wallMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 3000)); // ledger appends are fire-and-forget
const after = await call('GET', '/usage');

const spent = after.providerBudget.spentUsd - before.providerBudget.spentUsd;
const sameDay = after.groundingAllowance.day === before.groundingAllowance.day;
const grounded = sameDay ? after.groundingAllowance.groundedPrompts - before.groundingAllowance.groundedPrompts : null;
const statuses = {};
for (const r of result.results) statuses[r.status ?? 'unknown'] = (statuses[r.status ?? 'unknown'] ?? 0) + 1;

const report = {
  measuredAt: new Date().toISOString(),
  api, engineCommit: health.commit, engineVersion: health.version, provider: result.provider,
  claimsSent: claims.length, claimIds: claims.map((c) => c.id), statuses, wallMs,
  ledgerSpentBeforeUsd: before.providerBudget.spentUsd, ledgerSpentAfterUsd: after.providerBudget.spentUsd,
  ledgerDeltaUsd: spent, groundedPromptsDelta: grounded,
  groundedPromptsToday: after.groundingAllowance.groundedPrompts, allowanceDay: after.groundingAllowance.day,
  costPerClaimUsd: spent / claims.length,
};
console.log(JSON.stringify(report, null, 1));
if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
