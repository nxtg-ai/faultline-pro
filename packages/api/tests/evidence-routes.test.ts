// Validates: N-234 (evidence passage from fetched page bytes on the API, GoPMO 1.18.11.3 P1b; EP4 recert 02-codex-evidence.md row 3)
/**
 * POST /scan attaches, to each cited source, the passage of the fetched page
 * that matches the claim. The fetch is the API's guarded one: a cited link that
 * redirects to a private address is refused, never read. Only the Google SDK
 * and the outbound network are mocked; route, engine and guard are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/kestrel';
const PRIVATE_HOP = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/internal';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (grounded) {
          return {
            // The model's own words name a phrase the page does not contain.
            text: '{"status":"supported","explanation":"Opened on 31 March 1889 to great acclaim."}',
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{ groundingMetadata: { groundingChunks: [
              { web: { title: 'kestrelvane.example', uri: REDIRECT } },
              { web: { title: 'internal.example', uri: PRIVATE_HOP } },
            ] } }],
          };
        }
        return {
          text: JSON.stringify([{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 }]),
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { setOutboundFetch, resetOutboundFetch, setOutboundResolver, resetOutboundResolver } from '../src/lib/outbound-url.js';

const PAGE = '<html><body><p>Construction finished in March 1889, and the Eiffel Tower was completed in time for the Exposition.</p></body></html>';
const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'FAULTLINE_CONSENSUS', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
const requested: string[] = [];

function respond(body: string | null, status: number, headers: Record<string, string>, url: string): Response {
  const res = new Response(body, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_EVIDENCE_FETCH;
  // vitest.config.ts turns the private-address guard off for the suite; this file needs it on.
  delete process.env.FAULTLINE_OUTBOUND_ALLOW_PRIVATE;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-evidence-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetCache();
  requested.length = 0;
  // DNS: the publisher is public; internal.example resolves to a private address.
  setOutboundResolver(async (host) => [{ address: host === 'internal.example' ? '10.0.0.7' : '93.184.216.34', family: 4 }]);
  setOutboundFetch(async (url) => {
    requested.push(url);
    if (url === REDIRECT) return respond(null, 302, { location: 'https://kestrelvane.example/eiffel' }, url);
    if (url === PRIVATE_HOP) return respond(null, 302, { location: 'https://internal.example/admin' }, url);
    if (url === 'https://kestrelvane.example/eiffel') return respond(PAGE, 200, { 'content-type': 'text/html' }, url);
    return respond('not found', 404, { 'content-type': 'text/plain' }, url);
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetOutboundFetch();
  resetOutboundResolver();
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function postScan(): Promise<Record<string, any>> {
  const server = buildServer();
  await server.ready();
  try {
    const apiKey = getKeyStore().create('Pro', ['pro', 'scan']).key;
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      payload: { text: 'The Eiffel Tower was completed in 1889.', provider: 'gemini' },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  } finally {
    await server.close();
  }
}

describe('POST /scan evidence passages', () => {
  it('follows the grounding redirect, reads the publisher page and quotes it, not the model', async () => {
    const body = await postScan();
    const [publisher, internal] = body.verifications.c1.sources;
    expect(publisher.evidence.status).toBe('ok');
    expect(publisher.evidence.passage).toBe('Construction finished in March 1889, and the Eiffel Tower was completed in time for the Exposition.');
    expect(publisher.evidence.passage).not.toContain('great acclaim');
    expect(publisher.evidence.finalUri).toBe('https://kestrelvane.example/eiffel');
    expect(publisher.evidence.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.evidence.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The redirect to a private address is refused before it is requested.
    expect(internal.evidence).toMatchObject({ status: 'blocked', passage: null });
    expect(requested).toContain(PRIVATE_HOP);
    expect(requested).not.toContain('https://internal.example/admin');
  }, 30_000);

  it('FAULTLINE_EVIDENCE_FETCH=off fetches nothing and attaches no evidence', async () => {
    process.env.FAULTLINE_EVIDENCE_FETCH = 'off';
    const body = await postScan();
    expect(body.verifications.c1.sources.length).toBeGreaterThan(0);
    for (const s of body.verifications.c1.sources) expect(s.evidence).toBeUndefined();
    expect(requested).toHaveLength(0);
  }, 30_000);
});
