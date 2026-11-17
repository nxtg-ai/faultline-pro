/**
 * The regulation lookup on the API: eCFR through the guarded fetch, never
 * global fetch. The only scan data sent is the allowlisted CFR identifier.
 * A missing section is contradicted. FAULTLINE_REGULATION_CHECK=off sends the
 * claim to the normal verify. No network: the outbound fetch is stubbed with
 * the recorded eCFR not-found body (2026-11-17).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SECRET = 'Confidential Merger Project Zephyr';
const CLAIM_TEXT = `42 CFR 422.9999 ${SECRET} requires a secret benefit.`;

const verifyClaim = vi.fn(async (c: { id: string }) => ({ claimId: c.id, status: 'supported', explanation: 'searched', sources: [] }));
vi.mock('@nxtg/faultline/providers/mock_provider.js', async () => {
  const { parseExtractedClaims } = await import('@nxtg/faultline/providers/extraction-error.js');
  return {
    createMockProvider: () => ({
      name: 'Regulation fixture',
      modelId: 'fixture-v1',
      extractClaims: async (text: string) => parseExtractedClaims(JSON.stringify([
        { id: 'c1', text, type: 'fact', importance: 4 },
      ])),
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
import { API_REGULATION_CHECK, installRegulationCheck } from '../src/lib/evidence.js';
import { resolveRegulationCheck, resetDefaultRegulationCheck, REGULATION_USER_AGENT, ecfrVersionsUrl, checkRegulationCitation } from '@nxtg/faultline/evidence/regulation.js';
import { isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';

const MISSING_BODY = '{"content_versions":[],"meta":{"title":"42","part":"422","section":"422.9999","result_count":"0"}}';
const VERSIONS_URL = ecfrVersionsUrl('42', '422', '422.9999');

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_CONSENSUS', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'FAULTLINE_DOI_CHECK', 'FAULTLINE_REGULATION_CHECK'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
const outbound: Array<{ url: string; init: RequestInit }> = [];
const resolved: string[] = [];
const globalFetch = vi.fn(async () => new Response('global fetch must not be used', { status: 500 }));

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_EVIDENCE_FETCH;
  delete process.env.FAULTLINE_OUTBOUND_ALLOW_PRIVATE;
  delete process.env.FAULTLINE_DOI_CHECK;
  delete process.env.FAULTLINE_REGULATION_CHECK;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-reg-'));
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
    if (url === VERSIONS_URL) return new Response(MISSING_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
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
  resetDefaultRegulationCheck();
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
      payload: { text: CLAIM_TEXT, provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  } finally {
    await server.close();
  }
}

describe('POST /scan: a CFR citation is checked through the guarded fetch', () => {
  it('a section the eCFR does not have is contradicted, and the claim text does not leave', async () => {
    const body = await postScan();
    const v = body.verifications.c1;
    expect(v.status).toBe('contradicted');
    expect(v.explanation).toContain('42 CFR 422.9999');
    expect(v.sources[0].uri).toBe(VERSIONS_URL);
    expect(v.provenance.retriever).toBe('regulation-resolver');
    expect(isBillableVerdict(v)).toBe(true);
    expect(verifyClaim).not.toHaveBeenCalled();
    expect(outbound.map((o) => o.url)).toEqual([VERSIONS_URL]);
    expect(outbound[0]!.init.headers).toEqual({ 'user-agent': REGULATION_USER_AGENT });
    expect(outbound[0]!.init.body).toBeUndefined();
    expect(JSON.stringify(outbound)).not.toContain('Confidential');
    expect(JSON.stringify(outbound)).not.toContain('Zephyr');
    expect(resolved).toEqual(['www.ecfr.gov']);
    expect(globalFetch).not.toHaveBeenCalled();
  }, 30_000);

  it('FAULTLINE_REGULATION_CHECK=off: no lookup, the claim goes to the normal verify', async () => {
    process.env.FAULTLINE_REGULATION_CHECK = 'off';
    const body = await postScan();
    expect(outbound).toHaveLength(0);
    expect(verifyClaim).toHaveBeenCalledTimes(1);
    expect(body.verifications.c1.status).toBe('unverified');
    expect(body.verifications.c1.provenance?.retriever).not.toBe('regulation-resolver');
  }, 30_000);
});

describe('the default regulation check buildServer installs', () => {
  it('is API_REGULATION_CHECK, and a host that resolves to a private address produces no verdict', async () => {
    resetDefaultRegulationCheck();
    installRegulationCheck();
    expect(resolveRegulationCheck()).toBe(API_REGULATION_CHECK);
    resetOutboundFetch();
    setOutboundResolver(async (host) => { resolved.push(host); return [{ address: '127.0.0.1', family: 4 }]; });
    const claim = { id: 'c1', text: '42 CFR 422.9999', type: 'fact' as const, importance: 3 };
    expect(await checkRegulationCitation(claim, resolveRegulationCheck()!)).toBeNull();
    expect(resolved).toEqual(['www.ecfr.gov']);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
