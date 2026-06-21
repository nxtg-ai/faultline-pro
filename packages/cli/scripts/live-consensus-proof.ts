/**
 * LIVE adversarial proof of grounded multi-model consensus (CRUCIBLE Gate-9).
 *
 * This is NOT a vitest test — it hits LIVE APIs (OpenAI Responses web_search +
 * Gemini + OpenAI + Claude) using the real keys in packages/api/.env. It is kept
 * OUT of the vitest glob (scripts/, not tests/) so CI never depends on network or
 * funded keys. Run manually:
 *
 *   cd packages/cli && npx tsx scripts/live-consensus-proof.ts
 *
 * It proves, with real observed output, every PART B adversarial point:
 *   1. retriever returns REAL urls (printed)
 *   2. shared E flows to BOTH providers (per-vote sources === E, LOCK A)
 *   3. each LIVE provider returns a REAL distinct verdict
 *   4. the FALSE claim is caught (contradicted/mixed)
 *   5. fuse → consensus verdict with non-empty sources + correct agreement
 *   6. claude surfaces as an unavailable vote, EXCLUDED from providerCount (LOCK B)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGeminiProvider, createOpenAIProvider, createClaudeProvider } from '../providers/index.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import { consensusVerify, type NamedProvider } from '../consensus/consensus_engine.js';
import type { Claim, ProviderVote, Source } from '../types.js';

function loadEnv(): Record<string, string> {
  const path = join(process.cwd(), '..', 'api', '.env');
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const geminiKey = env.GEMINI_API_KEY ?? '';
const openaiKey = env.OPENAI_API_KEY ?? '';
const claudeKey = env.ANTHROPIC_API_KEY ?? '';
process.env.OPENAI_API_KEY = openaiKey; // retriever reads model override from env

const claims: Claim[] = [
  { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 5 },
  { id: 'c2', text: 'The James Webb Space Telescope launched in 2021.', type: 'fact', importance: 5 },
  { id: 'c3', text: 'The Great Wall of China is visible from the Moon with the naked eye.', type: 'fact', importance: 5 },
];

function sourcesEqual(a: Source[], b: Source[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.uri === b[i].uri && s.title === b[i].title);
}

function short(s: string, n = 220): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main(): Promise<void> {
  console.log(`KEYS: gemini=${geminiKey ? 'set' : 'MISSING'} openai=${openaiKey ? 'set' : 'MISSING'} claude=${claudeKey ? 'set' : 'MISSING'}\n`);

  const retriever = new OpenAIWebSearchRetriever(openaiKey);
  // claude is INCLUDED on purpose (no credits) so it ATTEMPTS + FAILS → unavailable
  // vote excluded from providerCount (LOCK B). If it were merely absent we could
  // not prove exclusion-from-count, only absence.
  const providers: NamedProvider[] = [
    { name: 'gemini', provider: createGeminiProvider(geminiKey) },
    { name: 'openai', provider: createOpenAIProvider(openaiKey) },
    { name: 'claude', provider: createClaudeProvider(claudeKey) },
  ];

  for (const claim of claims) {
    console.log('═'.repeat(78));
    console.log(`CLAIM ${claim.id}: ${claim.text}`);

    // Retrieve once standalone so we can print E and compare per-vote sources.
    const E = await retriever.retrieve(claim.text);
    console.log(`\n[1] RETRIEVER (${retriever.name}) returned ${E.length} source(s):`);
    E.forEach((s, i) => {
      console.log(`    [${i + 1}] ${s.uri}`);
      console.log(`        title: ${s.title}`);
      console.log(`        snippet: ${short(s.snippet ?? '(none)', 120)}`);
    });

    const verdict = await consensusVerify(claim, retriever, providers);
    const votes = verdict.providerVotes ?? [];

    console.log('\n[2/3] PER-PROVIDER VOTES:');
    for (const v of votes) {
      const lockA = sourcesEqual(v.sources, verdict.sources) ? 'sources===E ✓' : 'sources≠E ✗';
      console.log(`    ${v.provider.padEnd(7)} status=${(v.status as string).padEnd(12)} ${lockA}`);
      console.log(`            ${short(v.explanation ?? '')}`);
    }

    const claudeVote = votes.find((v: ProviderVote) => v.provider === 'claude');
    console.log(`\n[6] LOCK B — claude vote status="${claudeVote?.status}" (excluded from providerCount=${verdict.consensus?.providerCount})`);

    console.log(`\n[5] FUSE → status=${verdict.status} | agreement=${verdict.consensus?.agreement} | providerCount=${verdict.consensus?.providerCount} | dissenting=${verdict.consensus?.dissenting} | fusedSources=${verdict.sources.length}`);
    console.log(`    explanation: ${short(verdict.explanation, 260)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error('LIVE PROOF FAILED:', e);
  process.exit(1);
});
