/**
 * Extraction-M run (GoPMO 1.18.11.3.8, emma-soul al:354806ed0923bbfb item 2). Extraction only, no verify.
 * For each document: the engine's own extraction (gemini provider, the production default), then the same
 * guaranteeClaimPerSentence and filterClaimsForVerification a scan runs (scan.ts:304-306).
 *   raw      = claims the model returned
 *   M        = claims after the per-sentence guarantee (what a scan holds before the cap)
 *   eligible = M filtered to type 'fact' and importance >= 2 (what competes for the 8 slots)
 *   verified = after the cap of 8
 * Usage: GEMINI_API_KEY=... npx tsx scripts-extraction-m.ts <docs dir> <out.jsonl>
 */
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { getProvider } from './providers/registry';
import { guaranteeClaimPerSentence, filterClaimsForVerification } from './cli/scan';

const [dir, out] = process.argv.slice(2);
const provider = getProvider(process.env.GEMINI_API_KEY ?? '', 'gemini');
const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();

async function one(f: string) {
  const text = readFileSync(path.join(dir, f), 'utf8');
  const t0 = Date.now();
  const raw = await provider.extractClaims(text);
  const claims = guaranteeClaimPerSentence(text, raw);
  const eligible = claims.filter((c) => c.type === 'fact' && c.importance >= 2);
  const verified = filterClaimsForVerification(claims);
  const row = {
    id: f.replace(/\.txt$/, ''), chars: text.length, raw: raw.length, M: claims.length,
    synthetic: claims.filter((c) => String(c.id).startsWith('s')).length,
    eligible: eligible.length, verified: verified.length, ms: Date.now() - t0,
    types: claims.reduce((m: Record<string, number>, c) => ({ ...m, [c.type]: (m[c.type] ?? 0) + 1 }), {}),
  };
  appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}

const queue = [...files];
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const f = queue.shift()!;
    try { await one(f); } catch (e) { console.log(JSON.stringify({ id: f, error: String(e).slice(0, 200) })); }
  }
}));
