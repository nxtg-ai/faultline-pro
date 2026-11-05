/**
 * Extraction cost by document size (emma-soul al:2d7d2047383addb3 item 1, CRO pricing pass).
 * Extraction only, no verify and no grounding: the engine's own gemini extraction (production
 * default), then the per-sentence guarantee a scan runs. Tokens come from the provider's own
 * usage report (captureUsage), priced at Gemini 2.5 Flash list: $0.30 input, $2.50 output per
 * million tokens (thinking tokens bill as output).
 * Usage: GEMINI_API_KEY=... npx tsx scripts-extraction-cost.ts <docs dir> <out.jsonl>
 * File names start with the bucket: short-*, p10-*, p50-*.
 */
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { getProvider } from './providers/registry';
import { guaranteeClaimPerSentence } from './cli/scan';
import { captureUsage } from './lib/usage-sink';

const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 2.5;

const [dir, out] = process.argv.slice(2);
const provider = getProvider(process.env.GEMINI_API_KEY ?? '', 'gemini');
const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();

async function one(f: string) {
  const text = readFileSync(path.join(dir, f), 'utf8');
  const t0 = Date.now();
  const { result: raw, legs } = await captureUsage(() => provider.extractClaims(text));
  const claims = guaranteeClaimPerSentence(text, raw);
  const inputTokens = legs.reduce((n, l) => n + l.inputTokens, 0);
  const outputTokens = legs.reduce((n, l) => n + l.outputTokens, 0);
  const row = {
    id: f.replace(/\.txt$/, ''),
    bucket: f.split('-')[0],
    chars: text.length,
    raw: raw.length,
    claims: claims.length,
    facts: claims.filter((c) => c.type === 'fact').length,
    legs: legs.length,
    inputTokens,
    outputTokens,
    usd: (inputTokens * USD_PER_M_INPUT + outputTokens * USD_PER_M_OUTPUT) / 1e6,
    ms: Date.now() - t0,
  };
  appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}

const queue = [...files];
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const f = queue.shift()!;
    try {
      await one(f);
    } catch (e) {
      const row = { id: f.replace(/\.txt$/, ''), error: String(e).slice(0, 200) };
      appendFileSync(out, JSON.stringify(row) + '\n');
      console.log(JSON.stringify(row));
    }
  }
}));
