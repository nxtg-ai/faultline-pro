// Validates: N-234 (Google grounding terms compliance, GoPMO 1.18.11.3; fw al:da4e96a09515f831 item 3)
/**
 * Google Search Suggestions reach the caller with every grounded verdict.
 *
 * Google's grounding terms require the Search Suggestions of a grounded prompt
 * to be shown, unaltered, wherever its result is shown. fw renders them; this
 * file proves the API hands them over byte-for-byte on the real path (route →
 * scan engine → geminiService), with only the SDK mocked at the module boundary,
 * and that no on-disk ledger receives them (the terms forbid caching grounded
 * output).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHIP = '<style>.container{display:flex}</style><div class="container"><a class="chip" href="https://www.google.com/search?q=quillbeacon5521">quillbeacon5521</a></div>';
const QUERIES = ['quillbeacon5521 eiffel tower completion', 'everest height'];

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (grounded) {
          return {
            text: '{"status":"supported","explanation":"Matches the record."}',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{
              groundingMetadata: {
                groundingChunks: [{ web: { title: 'Source', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' } }],
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

/** Every byte the server wrote under tmpDir: the ledgers must hold no suggestion. */
function ledgerBytes(): string {
  return readdirSync(tmpDir).map((f) => readFileSync(join(tmpDir, f), 'utf8')).join('\n');
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-suggestions-'));
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

describe('Search Suggestions on grounded verdicts', () => {
  it('GET /scan/stream: every claim_verified verdict carries them unaltered', async () => {
    await withServer(async (server, apiKey) => {
      const res = await server.inject({
        method: 'GET',
        url: `/scan/stream?text=${encodeURIComponent(TEXT)}&provider=gemini`,
        headers: { 'x-api-key': apiKey },
      });
      expect(res.statusCode).toBe(200);
      const verified = sseEvents(res.body).filter((e) => e.type === 'claim_verified');
      expect(verified).toHaveLength(2);
      for (const e of verified) {
        expect(e.verdict.searchEntryPoint).toEqual({ renderedContent: CHIP });
        expect(e.verdict.webSearchQueries).toEqual(QUERIES);
      }
      const bytes = ledgerBytes();
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes).not.toContain('quillbeacon5521');
    });
  }, 30_000);

  it('POST /scan: every grounded verification carries them unaltered', async () => {
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
      for (const v of verifications) {
        expect(v.searchEntryPoint.renderedContent).toBe(CHIP);
        expect(v.webSearchQueries).toEqual(QUERIES);
      }
      const bytes = ledgerBytes();
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes).not.toContain('quillbeacon5521');
    });
  }, 30_000);
});
