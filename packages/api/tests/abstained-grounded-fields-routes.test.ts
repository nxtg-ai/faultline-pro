// NEXUS: GoPMO 1.18.11.7.22 grounding terms, no modify
/**
 * An abstained grounded verdict reaches the caller with none of Google's fields.
 *
 * Google's grounding terms forbid modifying a Grounded Result. When the engine
 * rewrites a Gemini grounded verdict that has no openable source to
 * "unverified" (abstainWithoutSource), the JSON a caller gets must carry
 * Faultline's verdict only: no searchEntryPoint, no webSearchQueries, no
 * grounding metadata and no grounded explanation. Real path (route → scan
 * engine → geminiService), with only the SDK mocked at the module boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHIP = '<div class="container"><a class="chip" href="https://www.google.com/search?q=tallowfinch8830">tallowfinch8830</a></div>';
const QUERIES = ['tallowfinch8830 eiffel tower completion', 'everest height'];

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (grounded) {
          return {
            text: '{"status":"supported","explanation":"Grounded wording brindlequay."}',
            modelVersion: 'gemini-2.5-flash-quillbeacon',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{
              groundingMetadata: {
                // No chunk a reader can open: the engine abstains on every claim.
                groundingChunks: [{ web: { title: 'No uri' } }],
                searchEntryPoint: { renderedContent: CHIP },
                webSearchQueries: QUERIES,
              },
            }],
          };
        }
        return {
          text: JSON.stringify([
            { id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 4 },
            { id: 'c2', text: 'Mount Everest is the highest mountain above sea level.', type: 'fact', importance: 4 },
          ]),
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { isGroundedVerification } from '../src/store/cache.js';
import { NO_SOURCE_EXPLANATION } from '@nxtg/faultline/lib/verdict-guard.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';

const TEXT = 'The Eiffel Tower was completed in 1889. Mount Everest is the highest mountain above sea level.';
const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'FAULTLINE_CONSENSUS'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

function sseEvents(body: string): Array<Record<string, any>> {
  return body.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)));
}


beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-abstain-grounded-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function withServer<T>(fn: (server: ReturnType<typeof buildServer>, apiKey: string) => Promise<T>): Promise<T> {
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server, getKeyStore().create('Pro', ['pro', 'scan']).key);
  } finally {
    await server.close();
  }
}

/** The abstained verdict as a caller receives it: Faultline's words only. */
function expectAbstainedWithoutGroundedFields(v: Record<string, any>): void {
  expect(v.status).toBe('unverified');
  expect(v.noSourceAbstain).toBe(true);
  expect(v.explanation).toBe(NO_SOURCE_EXPLANATION);
  expect(v.sources).toEqual([]);
  for (const k of ['searchEntryPoint', 'webSearchQueries', 'groundingMetadata', 'groundingChunks', 'groundingSupports']) {
    expect(k in v, `${k} present`).toBe(false);
  }
  const json = JSON.stringify(v);
  expect(json).not.toContain('tallowfinch8830');
  expect(json).not.toContain('brindlequay');
  // Still recognised as a Gemini grounded result, so it is never cached.
  expect(v.provenance).toMatchObject({ provider: 'gemini', retriever: 'gemini-grounding' });
  expect(isGroundedVerification(v)).toBe(true);
}

describe('abstained grounded verdicts carry no Google grounded field', () => {
  it('POST /scan: each abstained verification has no Search Suggestions, queries or grounded text', async () => {
    await withServer(async (server, apiKey) => {
      const res = await server.inject({
        method: 'POST',
        url: '/scan',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: { text: TEXT, provider: 'gemini' },
      });
      expect(res.statusCode).toBe(200);
      const verifications = Object.values(res.json().verifications as Record<string, any>);
      expect(verifications).toHaveLength(2);
      for (const v of verifications) expectAbstainedWithoutGroundedFields(v);
      expect(res.body).not.toContain('tallowfinch8830');
    });
  }, 30_000);

  it('GET /scan/stream: each abstained claim_verified verdict has none of them', async () => {
    await withServer(async (server, apiKey) => {
      const res = await server.inject({
        method: 'GET',
        url: `/scan/stream?text=${encodeURIComponent(TEXT)}&provider=gemini`,
        headers: { 'x-api-key': apiKey },
      });
      expect(res.statusCode).toBe(200);
      const verified = sseEvents(res.body).filter((e) => e.type === 'claim_verified');
      expect(verified).toHaveLength(2);
      for (const e of verified) expectAbstainedWithoutGroundedFields(e.verdict);
      expect(res.body).not.toContain('tallowfinch8830');
    });
  }, 30_000);
});
