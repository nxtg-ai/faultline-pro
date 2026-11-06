// Validates: N-237 (citation claims, direct DOI check through the API's guarded fetch)
/**
 * The DOI lookup for citation claims on the API.
 *
 * - Every lookup goes through fetchOutbound (the SSRF guard), never global
 *   fetch, both on the routes that pass API_DOI_CHECK and on any route that
 *   relies on the default buildServer installs.
 * - The only scan data sent is the normalized DOI in the URL path, with only
 *   the fixed User-Agent header.
 * - A DOI verdict is billable and delivered like any other.
 * Only a fixture provider and the outbound network are mocked; route, engine
 * and guard are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FAKE_DOI = '10.4471/jca.2021.0388';
const SECRET_TITLE = 'Confidential pricing study for Example Corp';

// The built-in 'mock' provider is replaced for this file only: it extracts one
// citation claim (parsed through the shared parse, as a model reply would be).
const verifyClaim = vi.fn(async (c: { id: string }) => ({ claimId: c.id, status: 'supported', explanation: 'searched', sources: [] }));
vi.mock('@nxtg/faultline/providers/mock_provider.js', async () => {
  const { parseExtractedClaims } = await import('@nxtg/faultline/providers/extraction-error.js');
  return {
    createMockProvider: () => ({
      name: 'Citation fixture',
      modelId: 'fixture-v1',
      extractClaims: async () => parseExtractedClaims(JSON.stringify([{
        id: 'c1', text: 'cited', type: 'fact', importance: 3,
        citation: { title: SECRET_TITLE, authors: 'Roe, J.', year: '2021', doi: `https://doi.org/${FAKE_DOI.toUpperCase()}.` },
      }])),
      verifyClaim,
      generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
    }) as never,
  };
});

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { setOutboundFetch, resetOutboundFetch, setOutboundResolver, resetOutboundResolver } from '../src/lib/outbound-url.js';
import { API_DOI_CHECK, installDoiCheck } from '../src/lib/evidence.js';
import { resolveDoiCheck, resetDefaultDoiCheck, DOI_USER_AGENT, checkCitationDoi } from '@nxtg/faultline/evidence/doi.js';
import { searchedVerdictCount } from '../src/lib/scan-spend.js';
import { isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_CONSENSUS', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'FAULTLINE_DOI_CHECK'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
const outbound: Array<{ url: string; init: RequestInit }> = [];
const resolved: string[] = [];
const globalFetch = vi.fn(async () => new Response('global fetch must not be used', { status: 500 }));

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_EVIDENCE_FETCH;
  // vitest.config.ts turns the private-address guard and the DOI check off for the suite; this file needs both on.
  delete process.env.FAULTLINE_OUTBOUND_ALLOW_PRIVATE;
  delete process.env.FAULTLINE_DOI_CHECK;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-doi-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetCache();
  outbound.length = 0;
  resolved.length = 0;
  verifyClaim.mockClear();
  globalFetch.mockClear();
  vi.stubGlobal('fetch', globalFetch);
  setOutboundResolver(async (host) => { resolved.push(host); return [{ address: '93.184.216.34', family: 4 }]; });
  setOutboundFetch(async (url, init) => {
    outbound.push({ url, init: init ?? {} });
    if (url === `https://doi.org/api/handles/${FAKE_DOI}`) {
      return new Response(JSON.stringify({ responseCode: 100, handle: FAKE_DOI }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  resetOutboundFetch();
  resetOutboundResolver();
  resetDefaultDoiCheck();
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
      payload: { text: `Roe, J. (2021). ${SECRET_TITLE}. https://doi.org/${FAKE_DOI}`, provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  } finally {
    await server.close();
  }
}

describe('POST /scan: a citation DOI is checked through the guarded fetch', () => {
  it('an unknown DOI is contradicted from the registry, billable, with no search and no global fetch', async () => {
    const body = await postScan();
    const v = body.verifications.c1;
    expect(v.status).toBe('contradicted');
    expect(v.explanation).toContain(`The cited DOI ${FAKE_DOI} does not resolve`);
    expect(v.provenance.retriever).toBe('doi-resolver');
    expect(v.sources[0].uri).toBe(`https://doi.org/api/handles/${FAKE_DOI}`);
    expect(isBillableVerdict(v)).toBe(true);
    expect(body.billing).toMatchObject({ billedClaims: 1, unbilledClaims: 0 });
    expect(verifyClaim).not.toHaveBeenCalled();
    expect(body.claims[0].citation).toMatchObject({ doi: FAKE_DOI, title: SECRET_TITLE });

    // Privacy rule: exactly one lookup, URL = registry + normalized DOI, only our User-Agent.
    expect(outbound.map((o) => o.url)).toEqual([`https://doi.org/api/handles/${FAKE_DOI}`]);
    expect(outbound[0]!.init.headers).toEqual({ 'user-agent': DOI_USER_AGENT });
    expect(outbound[0]!.init.body).toBeUndefined();
    expect(JSON.stringify(outbound)).not.toContain('Confidential');
    expect(resolved).toEqual(['doi.org']);
    expect(globalFetch).not.toHaveBeenCalled();
  }, 30_000);

  it('FAULTLINE_DOI_CHECK=off: no lookup, the claim goes to the normal verify', async () => {
    process.env.FAULTLINE_DOI_CHECK = 'off';
    const body = await postScan();
    expect(outbound).toHaveLength(0);
    expect(verifyClaim).toHaveBeenCalledTimes(1);
    // The fixture judge cites nothing, so the no-source rule reports it unverified; it is not a DOI verdict.
    expect(body.verifications.c1.status).toBe('unverified');
    expect(body.verifications.c1.provenance?.retriever).not.toBe('doi-resolver');
  }, 30_000);
});

describe('the default DOI check buildServer installs', () => {
  it('is API_DOI_CHECK, and it refuses a DOI host that resolves to a private address before any request', async () => {
    resetDefaultDoiCheck();
    installDoiCheck();
    expect(resolveDoiCheck()).toBe(API_DOI_CHECK);
    resetOutboundFetch();
    setOutboundResolver(async (host) => { resolved.push(host); return [{ address: '127.0.0.1', family: 4 }]; });
    const claim = { id: 'c1', text: 'x', type: 'fact' as const, importance: 3, citation: { title: 'A title here', doi: FAKE_DOI } };
    // Blocked by the guard: no verdict is invented, the claim falls back.
    expect(await checkCitationDoi(claim, resolveDoiCheck()!)).toBeNull();
    expect(resolved).toEqual(['doi.org']);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('spend: a DOI verdict ran no search', () => {
  it('searchedVerdictCount leaves out DOI verdicts only', () => {
    expect(searchedVerdictCount({
      a: { provenance: { retriever: 'doi-resolver' } },
      b: { provenance: { retriever: 'gemini-grounding' } },
      c: { status: 'unverified' },
    })).toBe(2);
  });
});
