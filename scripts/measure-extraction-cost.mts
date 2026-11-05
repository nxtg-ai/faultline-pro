// Measures the extraction leg alone on the G0 inputs (docs/research/2026-11-05-extraction-cost.md).
// Run from the repo root: GEMINI_API_KEY=... npx tsx scripts/measure-extraction-cost.mts <out.jsonl>
// Writes one row per call to <out.jsonl> and the per-set means to <out>.summary.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { captureUsage } from '../packages/cli/lib/usage-sink.ts';
import { extractForFullScan } from '../packages/cli/cli/scan.ts';
import { summarizeScanUsage } from '../packages/api/src/store/consensus-cost.ts';

const out = process.argv[2];
const gold = readFileSync('docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).claim as string);
const ids = readFileSync('docs/research/data/judge-not-checkable-2026-11-05.after.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).id as number);
type Job = { set: string; ref: string; text: string; nClaims: number };
const jobs: Job[] = ids.map((id) => ({ set: 'single', ref: String(id), text: gold[id], nClaims: 1 }));
for (let i = 0; i + 10 <= gold.length; i += 10) jobs.push({ set: 'doc10', ref: `${i}-${i + 9}`, text: gold.slice(i, i + 10).join(' '), nClaims: 10 });
const rows: any[] = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    try {
      const { result, legs } = await captureUsage(() => extractForFullScan(j.text, 'gemini'));
      const u = summarizeScanUsage(legs);
      rows.push({ set: j.set, ref: j.ref, chars: j.text.length, inputClaims: j.nClaims, extracted: result.claims.length,
        legs: legs.length, callTypes: [...new Set(legs.map((l) => l.callType))], models: [...new Set(legs.map((l) => l.model))],
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, unratedCalls: u.unratedCalls, error: null });
    } catch (e: any) {
      rows.push({ set: j.set, ref: j.ref, chars: j.text.length, error: String(e?.message ?? e).slice(0, 120) });
    }
  }
}
await Promise.all([1, 2, 3, 4].map(worker));
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const summary: Record<string, unknown> = {};
for (const set of ['single', 'doc10']) {
  const ok = rows.filter((r) => r.set === set && r.error === null);
  const c = ok.map((r) => r.costUsd).sort((a, b) => a - b);
  summary[set] = {
    n: ok.length,
    errors: rows.filter((r) => r.set === set && r.error).length,
    meanUsd: c.reduce((s, x) => s + x, 0) / c.length,
    medianUsd: c[Math.floor(c.length / 2)],
    totalUsd: c.reduce((s, x) => s + x, 0),
    meanInputTokens: ok.reduce((s, r) => s + r.inputTokens, 0) / ok.length,
    meanOutputTokens: ok.reduce((s, r) => s + r.outputTokens, 0) / ok.length,
    unratedCalls: ok.reduce((s, r) => s + r.unratedCalls, 0),
  };
}
writeFileSync(out.replace(/\.jsonl$/, '') + '.summary.json', JSON.stringify(summary, null, 2) + '\n');
