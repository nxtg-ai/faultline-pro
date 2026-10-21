/**
 * Every model call carries its output ceiling, and Gemini its thinking budget,
 * from the one table in providers/call-ceilings.ts (GoPMO 1.18.11.7.18).
 *
 * Behavioural: each of the 10 call sites is driven through its public entry
 * point with the SDK and fetch mocked at the boundary, and the request it sent
 * is read back. Static: the number of call sites in services/ and providers/
 * must equal the number this file drives, so an 11th call without a ceiling
 * fails here until it is added to the table and to CASES.
 */
// Validates: N-234 (cost ceilings, GoPMO 1.18.11.7.18)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Claim } from '../types';

const sdk = vi.hoisted(() => ({ requests: [] as Array<Record<string, any>>, text: '' }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: Record<string, any>) => {
        sdk.requests.push(req);
        return { text: sdk.text, candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    };
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { CALL_CEILINGS } from '../providers/call-ceilings';
import { extractClaims, verifyClaim, retrieveSources, verifyClaimGrounded, generateCritiqueAndPrompt } from '../services/geminiService';
import { createOpenAIProvider } from '../providers/openai_provider';
import { createClaudeProvider } from '../providers/claude_provider';
import { createPerplexityProvider } from '../providers/perplexity_provider';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever';

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 };
const SOURCES = [{ title: 's', uri: 'https://example.org/a' }];
const VERDICT = '{"status":"supported","explanation":"Holds."}';
const CRITIQUE = '{"critique":"c","improvedPrompt":"p"}';
const CLAIM_ARRAY = '[{"id":"c1","text":"The Eiffel Tower is in Paris.","type":"fact","importance":3}]';
const CLAIM_ENVELOPE = `{"claims":${CLAIM_ARRAY}}`;

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}
const chat = (content: string) => ok({ choices: [{ message: { content }, finish_reason: 'stop' }], citations: [], usage: {} });
const anthropic = (text: string) => ok({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} });

/** The ceiling fields one request carried, normalised across wires. */
interface Sent {
  maxOutputTokens: unknown;
  thinkingBudget?: unknown;
}

const lastGemini = (): Sent => {
  const config = sdk.requests.at(-1)?.config ?? {};
  return { maxOutputTokens: config.maxOutputTokens, thinkingBudget: config.thinkingConfig?.thinkingBudget };
};
const lastBody = (): Record<string, any> => JSON.parse(mockFetch.mock.calls.at(-1)![1].body);

type Table = typeof CALL_CEILINGS;
type Wire = keyof Table;

interface CeilingCase {
  /** `<file under packages/cli>#<call site>`: one entry per distinct call site, several purposes may share one. */
  site: string;
  wire: Wire;
  purpose: string;
  run: () => Promise<unknown>;
  sent: () => Sent;
}

const gemini = (purpose: keyof Table['gemini'], site: string, text: string, run: () => Promise<unknown>): CeilingCase => ({
  site: `services/geminiService.ts#${site}`,
  wire: 'gemini',
  purpose,
  run: async () => { sdk.text = text; return run(); },
  sent: lastGemini,
});

const fetchCase = (
  wire: Exclude<Wire, 'gemini'>,
  site: string,
  purpose: string,
  reply: () => unknown,
  run: () => Promise<unknown>,
  field: string,
): CeilingCase => ({
  site,
  wire,
  purpose,
  run: async () => { mockFetch.mockResolvedValueOnce(reply()); return run(); },
  sent: () => ({ maxOutputTokens: lastBody()[field] }),
});

const OPENAI = 'providers/openai_provider.ts#callAPI';
const CLAUDE = 'providers/claude_provider.ts#callAPI';
const PPLX = 'providers/perplexity_provider.ts#callAPI';
const PPLX_CITE = 'providers/perplexity_provider.ts#callAPIWithCitations';

const CASES: CeilingCase[] = [
  gemini('extract', 'extractClaims', CLAIM_ARRAY, () => extractClaims('The Eiffel Tower is in Paris.', 'k')),
  gemini('verify', 'verifyClaim', VERDICT, () => verifyClaim(CLAIM, 'k')),
  gemini('retrieve', 'retrieveSources', 'summary', () => retrieveSources(CLAIM.text, 'k')),
  gemini('verifyGrounded', 'verifyClaimGrounded', VERDICT, () => verifyClaimGrounded(CLAIM, SOURCES, 'k')),
  gemini('critique', 'generateCritiqueAndPrompt', CRITIQUE, () => generateCritiqueAndPrompt('text', [CLAIM], 'k')),

  fetchCase('openai', OPENAI, 'extract', () => chat(CLAIM_ENVELOPE), () => createOpenAIProvider('k').extractClaims('text'), 'max_completion_tokens'),
  fetchCase('openai', OPENAI, 'verify', () => chat(VERDICT), () => createOpenAIProvider('k').verifyClaim(CLAIM), 'max_completion_tokens'),
  fetchCase('openai', OPENAI, 'verifyGrounded', () => chat(VERDICT), () => createOpenAIProvider('k').verifyClaimGrounded!(CLAIM, SOURCES), 'max_completion_tokens'),
  fetchCase('openai', OPENAI, 'critique', () => chat(CRITIQUE), () => createOpenAIProvider('k').generateCritiqueAndPrompt('text', [CLAIM]), 'max_completion_tokens'),

  fetchCase('openaiResponses', 'providers/openai_web_search_retriever.ts#callAPI', 'retrieve',
    () => ok({ output: [], usage: {} }), () => new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text), 'max_output_tokens'),

  fetchCase('claude', CLAUDE, 'extract', () => anthropic(CLAIM_ARRAY), () => createClaudeProvider('k').extractClaims('text'), 'max_tokens'),
  fetchCase('claude', CLAUDE, 'verify', () => anthropic(VERDICT), () => createClaudeProvider('k').verifyClaim(CLAIM), 'max_tokens'),
  fetchCase('claude', CLAUDE, 'verifyGrounded', () => anthropic(VERDICT), () => createClaudeProvider('k').verifyClaimGrounded!(CLAIM, SOURCES), 'max_tokens'),
  fetchCase('claude', CLAUDE, 'critique', () => anthropic(CRITIQUE), () => createClaudeProvider('k').generateCritiqueAndPrompt('text', [CLAIM]), 'max_tokens'),

  fetchCase('perplexity', PPLX, 'extract', () => chat(CLAIM_ENVELOPE), () => createPerplexityProvider('k').extractClaims('text'), 'max_tokens'),
  fetchCase('perplexity', PPLX, 'critique', () => chat(CRITIQUE), () => createPerplexityProvider('k').generateCritiqueAndPrompt('text', [CLAIM]), 'max_tokens'),
  fetchCase('perplexity', PPLX_CITE, 'verify', () => chat(VERDICT), () => createPerplexityProvider('k').verifyClaim(CLAIM), 'max_tokens'),
];

function expected(c: CeilingCase): Sent {
  const row = (CALL_CEILINGS[c.wire] as Record<string, { maxOutputTokens: number; thinkingBudget?: number }>)[c.purpose];
  return c.wire === 'gemini'
    ? { maxOutputTokens: row.maxOutputTokens, thinkingBudget: row.thinkingBudget }
    : { maxOutputTokens: row.maxOutputTokens };
}

beforeEach(() => {
  sdk.requests.length = 0;
  mockFetch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the ceiling table', () => {
  it('holds the values sized from the 2026-10-21 sample run, each with a basis', () => {
    const numbers = Object.fromEntries(Object.entries(CALL_CEILINGS).map(([wire, rows]) => [
      wire,
      Object.fromEntries(Object.entries(rows).map(([purpose, row]) => {
        expect((row as { basis: string }).basis.length).toBeGreaterThan(10);
        const { basis: _basis, ...values } = row as Record<string, unknown>;
        return [purpose, values];
      })),
    ]));
    expect(numbers).toEqual({
      gemini: {
        extract: { thinkingBudget: 2048, maxOutputTokens: 34816 },
        verify: { thinkingBudget: 4096, maxOutputTokens: 5120 },
        retrieve: { thinkingBudget: 4096, maxOutputTokens: 5120 },
        verifyGrounded: { thinkingBudget: 4096, maxOutputTokens: 5120 },
        critique: { thinkingBudget: 4096, maxOutputTokens: 6144 },
      },
      openai: {
        extract: { maxOutputTokens: 16384 }, verify: { maxOutputTokens: 1024 },
        verifyGrounded: { maxOutputTokens: 1024 }, critique: { maxOutputTokens: 2048 },
      },
      openaiResponses: { retrieve: { maxOutputTokens: 2048 } },
      claude: {
        extract: { maxOutputTokens: 16384 }, verify: { maxOutputTokens: 1024 },
        verifyGrounded: { maxOutputTokens: 1024 }, critique: { maxOutputTokens: 2048 },
      },
      perplexity: { extract: { maxOutputTokens: 16384 }, verify: { maxOutputTokens: 1024 }, critique: { maxOutputTokens: 2048 } },
    });
  });

  it('gives every Gemini row a visible allowance above its thinking budget', () => {
    for (const row of Object.values(CALL_CEILINGS.gemini)) expect(row.maxOutputTokens).toBeGreaterThan(row.thinkingBudget);
    expect(CALL_CEILINGS.gemini.extract.maxOutputTokens - CALL_CEILINGS.gemini.extract.thinkingBudget).toBe(32768);
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(CALL_CEILINGS)).toBe(true);
    expect(Object.isFrozen(CALL_CEILINGS.gemini.verify)).toBe(true);
    expect(() => { (CALL_CEILINGS.claude.verify as { maxOutputTokens: number }).maxOutputTokens = 1; }).toThrow();
  });

  it('every row is driven by a case below, and every case names a row', () => {
    const rows = Object.entries(CALL_CEILINGS).flatMap(([wire, r]) => Object.keys(r).map((p) => `${wire}.${p}`)).sort();
    expect(CASES.map((c) => `${c.wire}.${c.purpose}`).sort()).toEqual(rows);
  });
});

describe('each request carries its row of the table', () => {
  it.each(CASES.map((c) => [`${c.site} (${c.purpose})`, c] as const))('%s', async (_label, c) => {
    await c.run();
    const sent = c.sent();
    expect(sent.maxOutputTokens).toEqual(expect.any(Number));
    expect(sent).toEqual(expected(c));
  });
});

describe('static guard: no model call outside the table', () => {
  // Codex review of 4f4157b, finding 1: the first guard matched only `fetch('https://api.` and
  // `generateContent(` in two flat directories, so a double-quoted URL, a URL held in a variable,
  // whitespace before the parenthesis or a nested module passed unseen. The guard now walks the
  // whole CLI package, ignores comments, and counts every source LINE that names a model host or
  // a model SDK call, plus every fetch call in services/ and providers/. Any new line of either
  // kind fails until the contract above drives it.
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const MODEL_CALL = /generateContent(?:Stream)?\s*\(|api\.openai\.com|api\.anthropic\.com|api\.perplexity\.ai|generativelanguage\.googleapis\.com|\.messages\.create\s*\(|completions\.create\s*\(|responses\.create\s*\(/;
  const ANY_FETCH = /\bfetch\s*\(/;

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  }

  function callLines(rel: string, src: string): number {
    const fetchCounts = rel.startsWith('services/') || rel.startsWith('providers/');
    return stripComments(src).split('\n').filter((line) => MODEL_CALL.test(line) || (fetchCounts && ANY_FETCH.test(line))).length;
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(cliRoot, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['node_modules', 'tests', 'dist', 'coverage', '.stryker-tmp'].includes(entry.name)) continue;
        walk(rel, out);
      } else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name)) {
        out.push(rel);
      }
    }
    return out;
  }

  it('every model-call line in the CLI package is one the contract drives', () => {
    const found: Record<string, number> = {};
    for (const rel of walk('')) {
      const n = callLines(rel, readFileSync(join(cliRoot, rel), 'utf8'));
      if (n > 0) found[rel] = n;
    }
    const driven: Record<string, number> = {};
    for (const site of new Set(CASES.map((c) => c.site))) {
      const file = site.split('#')[0];
      driven[file] = (driven[file] ?? 0) + 1;
    }
    expect(found).toEqual(driven);
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it.each([
    ['a double-quoted URL', 'providers/x.ts', 'export const p = () => fetch("https://api.openai.com/v1/chat/completions");'],
    ['a URL held in a variable', 'providers/x.ts', "const URL = 'https://api.anthropic.com/v1/messages';\nexport const p = () => fetch(URL);"],
    ['whitespace before the parenthesis', 'services/x.ts', 'await ai.models.generateContent ({ model });'],
    ['a streaming call', 'consensus/x.ts', 'await ai.models.generateContentStream({ model });'],
    ['an SDK chat call outside services/', 'cli/x.ts', 'await client.chat.completions.create({ model });'],
    ['a fetch to any host in providers/', 'providers/deep/x.ts', 'await fetch(endpoint, { method: "POST" });'],
  ])('the scanner sees %s', (_label, rel, src) => {
    expect(callLines(rel, src)).toBeGreaterThan(0);
  });

  it('the scanner ignores a model host named only in a comment', () => {
    expect(callLines('providers/x.ts', '// Gemini generateContent: finishReason\n/* fetch("https://api.openai.com") */\nconst a = 1;')).toBe(0);
  });
});
