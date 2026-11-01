// Validates: billing rule, a result's billing.billedClaims equals the claims the claim meter commits
//
// Two claim-id defects made the billing field disagree with the meter:
// - a claim id longer than MAX_CLAIM_ID_LENGTH was accepted by extraction, so
//   billing counted it billed while the meter refused to commit it;
// - two claims sharing an id were accepted, so on /scan/stream the meter
//   committed the first claim_verified while the second verdict overwrote
//   verifications[id] and the complete event's billing counted that one.
// Extraction now fails such a list (invalid_output). These tests send each case
// through POST /scan and GET and POST /scan/stream with the meter on and a
// metered customer key.
//
// The engine runs for real. The fixture provider answers as the engine's own
// 'gemini' (helpers/engine-stand-in.ts), and its extractClaims parses a claim
// list with the real parseExtractedClaims, the path every live provider takes.
// No network call and no real provider key.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { MAX_CLAIM_ID_LENGTH } from '@nxtg/faultline/lib/verdict-guard.js';
import { ENGINE_PROVIDER, ONE_SOURCE, placeholderProviderKey } from './helpers/engine-stand-in.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter, MAX_CLAIM_ID_LENGTH as METER_MAX_CLAIM_ID_LENGTH } from '../src/store/claim-meter.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';

/** The claim list the fixture's model "returns", as JSON items, set per test. */
const control = vi.hoisted(() => ({ items: [] as unknown[] }));

/** The first sentence gets a sourced supported verdict (billable); any other an unverified one, 20 ms later. */
const BILLABLE_TEXT = 'Claim one is a fact';

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
  const { parseExtractedClaims } = await import('@nxtg/faultline/providers/extraction-error.js');
  return engineStandInRegistry(await importOriginal(), () => ({
    name: 'Claim id fixture',
    modelId: 'fixture-v1',
    extractClaims: async (): Promise<Claim[]> => parseExtractedClaims(JSON.stringify(control.items)),
    // The unbillable answer arrives later, so with a shared id it is the one
    // left in verifications[id] after the billable one was streamed and metered.
    verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
      if (claim.text.startsWith(BILLABLE_TEXT)) {
        return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: ONE_SOURCE } as VerificationResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { claimId: claim.id, status: 'unverified', explanation: 'ok', sources: [] } as VerificationResult;
    },
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }));
});

const item = (id: unknown, text: string) => ({ id, text, type: 'fact', importance: 5 });

const ONE_SENTENCE = 'Claim one is a fact.';
const TWO_SENTENCES = 'Claim one is a fact. Claim two is a fact.';

const SERVER_KEY = 'claim-id-billing-server-key-0123456789';
const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY', 'FAULTLINE_API_KEY',
  'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_EVIDENCE_FETCH',
];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-id-billing-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_CLAIM_METER = '1';
  // A placeholder key for every provider in POST /scan's failover chain, so
  // each one resolves to the fixture and the chain ends at extraction.
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY']) process.env[k] = placeholderProviderKey();
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  resetClaimMeter();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetProviderSpendLedger();
  resetCircuitBreaker();
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

/** A metered customer key, as in the claim meter tests. */
function customer() {
  return getKeyStore().create('customer', ['scan'], undefined, { claimCap: 100, metered: true });
}

function claimMeterRows(): Array<Record<string, unknown>> {
  const path = process.env.FAULTLINE_CLAIM_METER_LEDGER as string;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === 'usage');
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split('\n\n').filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

type Route = 'POST /scan' | 'GET /scan/stream' | 'POST /scan/stream';
const ROUTES: Route[] = ['POST /scan', 'GET /scan/stream', 'POST /scan/stream'];

interface Outcome {
  /** billing from the 200 body or the complete event; undefined when the scan failed. */
  billing?: { billedClaims: number };
  /** The extraction failure, as the route reports it. */
  failure?: { status: number; body: Record<string, unknown> };
  claimVerified: number;
}

async function scanVia(route: Route, key: string, text: string): Promise<Outcome> {
  if (route === 'POST /scan') {
    const res = await app.inject({
      method: 'POST', url: '/scan', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: { text, provider: ENGINE_PROVIDER },
    });
    if (res.statusCode === 200) return { billing: res.json().billing, claimVerified: 0 };
    return { failure: { status: res.statusCode, body: res.json() }, claimVerified: 0 };
  }
  const res = route === 'GET /scan/stream'
    ? await app.inject({
      method: 'GET', url: `/scan/stream?provider=${ENGINE_PROVIDER}&text=${encodeURIComponent(text)}`, headers: { 'x-api-key': key },
    })
    : await app.inject({
      method: 'POST', url: '/scan/stream', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: { text, provider: ENGINE_PROVIDER },
    });
  expect(res.statusCode).toBe(200);
  const events = sseEvents(res.body);
  expect(events.length).toBeGreaterThan(0);
  const claimVerified = events.filter((e) => e.type === 'claim_verified').length;
  const complete = events.find((e) => e.type === 'complete');
  if (complete) return { billing: complete.billing as { billedClaims: number }, claimVerified };
  const error = events.find((e) => e.type === 'error') as Record<string, unknown>;
  expect(error).toBeDefined();
  return { failure: { status: 200, body: error }, claimVerified };
}

/** The same extraction failure the API returns for any invalid extraction output. */
function expectInvalidExtraction(route: Route, outcome: Outcome): void {
  expect(outcome.billing).toBeUndefined();
  expect(outcome.failure).toBeDefined();
  if (route === 'POST /scan') {
    expect(outcome.failure!.status).toBe(502);
    expect(outcome.failure!.body).toEqual({ error: 'extraction_failed', reason: 'invalid_output' });
  } else {
    expect(outcome.failure!.body).toMatchObject({ type: 'error', error: 'extraction_failed', reason: 'invalid_output' });
  }
  expect(outcome.claimVerified).toBe(0);
  expect(claimMeterRows()).toEqual([]);
}

describe('claim ids: billing.billedClaims equals the claims the meter commits', () => {
  it('the limit is one constant: the meter uses the engine\'s MAX_CLAIM_ID_LENGTH (58)', () => {
    expect(MAX_CLAIM_ID_LENGTH).toBe(58);
    expect(METER_MAX_CLAIM_ID_LENGTH).toBe(MAX_CLAIM_ID_LENGTH);
  });

  for (const route of ROUTES) {
    it(`${route}: a claim id one longer than the limit fails extraction (invalid_output); nothing is billed or metered`, async () => {
      control.items = [item('x'.repeat(MAX_CLAIM_ID_LENGTH + 1), 'Claim one is a fact.')];
      const key = customer();
      expectInvalidExtraction(route, await scanVia(route, key.key, ONE_SENTENCE));
      expect(getClaimMeter().usageFor(key.id).used).toBe(0);
    });

    it(`${route}: a claim id at the limit scans, is billed once and metered once`, async () => {
      const id = 'y'.repeat(MAX_CLAIM_ID_LENGTH);
      control.items = [item(id, 'Claim one is a fact.')];
      const key = customer();
      const outcome = await scanVia(route, key.key, ONE_SENTENCE);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.billing!.billedClaims).toBe(1);
      const rows = claimMeterRows();
      expect(rows.length).toBe(1);
      expect(rows[0].claimId).toBe(id);
      expect(getClaimMeter().usageFor(key.id).used).toBe(outcome.billing!.billedClaims);
    });

    it(`${route}: two claims sharing an id fail extraction (invalid_output); nothing is billed or metered`, async () => {
      control.items = [item('c1', 'Claim one is a fact.'), item('c1', 'Claim two is a fact.')];
      const key = customer();
      expectInvalidExtraction(route, await scanVia(route, key.key, TWO_SENTENCES));
      expect(getClaimMeter().usageFor(key.id).used).toBe(0);
    });

    it(`${route}: a numeric id and the same id as a string are duplicates too`, async () => {
      control.items = [item(1, 'Claim one is a fact.'), item('1', 'Claim two is a fact.')];
      const key = customer();
      expectInvalidExtraction(route, await scanVia(route, key.key, TWO_SENTENCES));
    });

    it(`${route}: distinct ids scan, and billing equals what the meter committed`, async () => {
      control.items = [item('c1', 'Claim one is a fact.'), item('c2', 'Claim two is a fact.')];
      const key = customer();
      const outcome = await scanVia(route, key.key, TWO_SENTENCES);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.billing!.billedClaims).toBe(1);
      expect(claimMeterRows().map((r) => r.claimId)).toEqual(['c1']);
      expect(getClaimMeter().usageFor(key.id).used).toBe(outcome.billing!.billedClaims);
    });
  }
});
