/**
 * measure-consensus-cost.ts — v0.9.0 consensus unit-economics measurement harness.
 *
 * Measures REAL per-scan LLM cost under multi-model consensus by capturing
 * provider-reported token usage across the 1 + K·(1+N) fan-out. Standalone
 * instrumentation — imports the engine, changes NO product code.
 *
 * Modes:
 *   (default / --dry-run)  STRUCTURAL. Zero network, zero spend. Runs the engine
 *                          over sample docs with a stubbed transport, prints the
 *                          fan-out plan + captured prompts/envelopes, runs G1.
 *   --paid --confirm-spend PAID. Runs the REAL consensus pipeline (engine `scan`,
 *                          consensus:true) over the matrix docs with a pass-through
 *                          transport that TEES provider-reported usage off the wire
 *                          (the engine discards it; we read it). Requires G1 PASS
 *                          and G2 live rates pinned. Logs append-only per scan-id.
 *
 * Run:
 *   npx tsx scripts/measure-consensus-cost.ts               # dry structural
 *   npx tsx scripts/measure-consensus-cost.ts --paid --confirm-spend
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureAll, extractPrompt, type CallType } from './consensus-cost/capture';
import { LIVE_RATES, LIVE_RATES_PINNED_ON, ENGINE_DEFAULT_MODELS, MANAGED_RATES_MIRROR, liveRatesReady, type Rate } from './consensus-cost/rates';

const LOG_PATH = `${process.cwd()}/scripts/consensus-cost/measured-usage.jsonl`;
const DEFAULT_N = 3; // DEFAULT_CONSENSUS_PROVIDERS = [openai, gemini, claude] (scan.ts:187)
const K_CAP = 8;     // filterClaimsForVerification .slice(0,8) (scan.ts:145)

/** Representative matrix: doc size → text + expected K (claim count after cap). */
const MATRIX: Array<{ size: 'SMALL' | 'MEDIUM' | 'LARGE'; text: string; reps: number }> = [
  { size: 'SMALL', text: sampleDoc(3), reps: 3 },
  { size: 'MEDIUM', text: sampleDoc(6), reps: 3 },
  { size: 'LARGE', text: sampleDoc(12), reps: 3 },
];

function sampleDoc(nFacts: number): string {
  // Neutral, verifiable public-fact sentences — representative extraction load.
  const facts = [
    'The Eiffel Tower was completed in 1889.',
    'Mount Everest is the highest mountain above sea level.',
    'The speed of light is approximately 299,792 kilometres per second.',
    'Water boils at 100 degrees Celsius at sea level.',
    'The Great Wall of China is over 13,000 miles long.',
    'The human body has 206 bones in adulthood.',
    'The Pacific Ocean is the largest ocean on Earth.',
    'Mercury is the closest planet to the Sun.',
    'The Amazon River is the largest river by discharge volume.',
    'Gold has the chemical symbol Au.',
    'The Sahara is the largest hot desert in the world.',
    'A leap year occurs every four years with exceptions.',
  ];
  return facts.slice(0, nFacts).join(' ');
}

interface UsageRecord {
  scanId: string;
  size: string;
  rep: number;
  callType: CallType | 'unknown';
  provider: 'openai' | 'gemini' | 'anthropic' | 'unknown';
  model: string;
  inputTokens: number;
  outputTokens: number;
  isGrounding: boolean;
  ts: string;
}

function providerOf(url: string): UsageRecord['provider'] {
  if (url.includes('anthropic.com')) return 'anthropic';
  if (url.includes('openai.com')) return 'openai';
  if (url.includes('googleapis') || url.includes('generativelanguage')) return 'gemini';
  return 'unknown';
}

/**
 * Resolve the real model. openai/anthropic carry `model` in the request body;
 * Gemini carries it in the URL path (`/v1beta/models/<model>:generateContent`),
 * NOT the body — so `body.model` is undefined for gemini. Extract from the URL.
 */
function modelOf(url: string, body: any): string {
  if (body?.model) return body.model;
  const m = url.match(/\/models\/([^:?/]+)/); // gemini path model
  return m ? m[1] : '?';
}

function callTypeOf(url: string, body: any): CallType | 'unknown' {
  if (url.includes('/v1/responses')) return 'web_search';
  if (url.includes('generativelanguage') || url.includes('googleapis')) {
    // extraction has generationConfig.responseSchema; grounded verify does not
    return body?.generationConfig?.responseSchema || body?.config?.responseSchema ? 'extraction' : 'grounded-verify:gemini';
  }
  if (url.includes('anthropic.com')) return 'grounded-verify:claude';
  if (url.includes('openai.com')) return 'grounded-verify:openai';
  return 'unknown';
}

/** Read provider-reported usage from a real response JSON, per provider shape. */
function readUsage(provider: UsageRecord['provider'], data: any): { input: number; output: number } {
  if (provider === 'gemini') {
    const u = data?.usageMetadata ?? {};
    return { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0 };
  }
  if (provider === 'anthropic') {
    const u = data?.usage ?? {};
    return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  }
  // openai chat: prompt_tokens/completion_tokens; responses: input_tokens/output_tokens
  const u = data?.usage ?? {};
  return { input: u.prompt_tokens ?? u.input_tokens ?? 0, output: u.completion_tokens ?? u.output_tokens ?? 0 };
}

// ── DRY (structural) mode ────────────────────────────────────────────────────
async function runDry(): Promise<void> {
  console.log('MODE: DRY / STRUCTURAL — zero network, zero spend.\n');
  console.log('FAN-OUT PLAN (per scan): total LLM calls = 1 + K·(1+N)');
  console.log(`  N (consensus voters) = ${DEFAULT_N}   K (verified claims, cap) = ${K_CAP}`);
  for (const m of MATRIX) {
    const kApprox = m.text.split('.').filter((s) => s.trim()).length;
    const K = Math.min(kApprox, K_CAP);
    console.log(`  ${m.size.padEnd(6)} K≈${K}  → calls/scan = 1 + ${K}·(1+${DEFAULT_N}) = ${1 + K * (1 + DEFAULT_N)}  ×${m.reps} reps ×(consensus+single)`);
  }

  console.log('\nCAPTURED ENGINE PROMPTS (by-construction, from real engine code):');
  const captured = await captureAll();
  for (const ct of Object.keys(captured) as CallType[]) {
    const c = captured[ct];
    console.log(`\n── ${ct}  [${providerOf(c.url)}]  ${c.method} ${c.url}`);
    console.log(`   envelope keys: ${Object.keys(c.body ?? {}).join(', ')}`);
    console.log(`   prompt (${c.prompt.length} chars): ${c.prompt.slice(0, 140).replace(/\n/g, ' ')}…`);
  }

  console.log('\nG2 RATE STATUS:');
  const models = Object.values(ENGINE_DEFAULT_MODELS);
  const { ready, missing } = liveRatesReady(models);
  console.log(`  live rates pinned on: ${LIVE_RATES_PINNED_ON ?? 'NOT PINNED (operator TODO)'}`);
  console.log(`  models needing live rates: ${models.join(', ')}`);
  if (!ready) console.log(`  MISSING live rates for: ${missing.join(', ') || '(date unset)'} → paid run REFUSED until pinned.`);
  console.log(`  cross-check mirror (costs.ts MANAGED_PROVIDER_RATES): claude assumes HAIKU ($${MANAGED_RATES_MIRROR.claude.inputPerM}/$${MANAGED_RATES_MIRROR.claude.outputPerM}) but CLI consensus default model is ${ENGINE_DEFAULT_MODELS['grounded-verify:claude']} — DIVERGENCE, re-pin on run date.`);

  console.log('\nDRY OK. To run the paid matrix: G1 must PASS (npx tsx scripts/assert-prompt-fidelity.ts),');
  console.log('G2 live rates pinned in scripts/consensus-cost/rates.ts, then --paid --confirm-spend.');
}

// ── PAID mode ────────────────────────────────────────────────────────────────
async function runPaid(): Promise<void> {
  const models = Object.values(ENGINE_DEFAULT_MODELS);
  const { ready, missing } = liveRatesReady(models);
  if (!ready) {
    console.error(`REFUSED: G2 live rates not pinned (missing: ${missing.join(', ') || 'run date unset'}). Fill scripts/consensus-cost/rates.ts.`);
    process.exit(2);
  }

  const { scan } = await import('../packages/cli/cli/scan');
  const records: UsageRecord[] = [];
  let ctx: { scanId: string; size: string; rep: number } = { scanId: '', size: '', rep: 0 };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const res = await realFetch(input, init);
    try {
      const provider = providerOf(url);
      if (provider !== 'unknown') {
        const clone = res.clone();
        const data = await clone.json();
        let body: any;
        try { body = init?.body ? JSON.parse(init.body as string) : undefined; } catch { /* ignore */ }
        const callType = callTypeOf(url, body);
        const u = readUsage(provider, data);
        records.push({ ...ctx, callType, provider, model: modelOf(url, body), inputTokens: u.input, outputTokens: u.output, isGrounding: callType === 'web_search', ts: new Date().toISOString() });
      }
    } catch { /* teeing must never break the real call */ }
    return res;
  }) as typeof fetch;

  try {
    for (const m of MATRIX) {
      for (let rep = 1; rep <= m.reps; rep++) {
        for (const consensus of [true, false]) {
          ctx = { scanId: randomUUID(), size: `${m.size}${consensus ? '' : ':single'}`, rep };
          console.error(`[paid] ${ctx.size} rep${rep} scan=${ctx.scanId} consensus=${consensus}`);
          await scan(m.text, 'openai', undefined, undefined, undefined, undefined, { consensus });
        }
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  // Compose measured cost per scan from LIVE rates + persist append-only.
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  for (const r of records) appendFileSync(LOG_PATH, JSON.stringify(r) + '\n');

  const byScan = new Map<string, { size: string; usd: number }>();
  for (const r of records) {
    const rate: Rate | null = LIVE_RATES[r.model] ?? null;
    if (!rate) { console.error(`WARN: no live rate for model ${r.model} — scan ${r.scanId} incomplete`); continue; }
    const usd = (r.inputTokens / 1e6) * rate.inputPerM + (r.outputTokens / 1e6) * rate.outputPerM + (r.isGrounding ? rate.groundingPerCall : 0);
    const agg = byScan.get(r.scanId) ?? { size: r.size, usd: 0 };
    agg.usd += usd;
    byScan.set(r.scanId, agg);
  }
  console.log('\nMEASURED $/scan (live-rate composed, real provider usage):');
  for (const [scanId, v] of byScan) console.log(`  ${v.size.padEnd(14)} ${scanId}  $${v.usd.toFixed(6)}`);
  console.log(`\nRaw per-call usage: ${LOG_PATH}`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const paid = args.has('--paid');
  if (paid && !args.has('--confirm-spend')) {
    console.error('REFUSED: --paid requires --confirm-spend (this makes real, billed API calls).');
    process.exit(2);
  }
  if (paid) await runPaid();
  else await runDry();
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
