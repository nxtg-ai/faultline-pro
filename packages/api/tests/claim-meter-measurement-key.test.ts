// Validates: claim meter and usage-record contract (the measurement key is never metered)
//
// The measurement key (FAULTLINE_MEASUREMENT_KEY, keyId 'measurement') runs
// internal measurement through POST /admin/verify-claims and reads GET /usage.
// It is not a customer, so with the meter on it holds no reservation, commits
// no usage row and gets no claims block, like the server key and admin keys.
// Keys are built at runtime from parts; none is a key-shaped literal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { ONE_SOURCE, placeholderProviderKey } from './helpers/engine-stand-in.js';

const control = { verifyCalls: 0 };

// The fixture answers as the engine's own 'gemini' instance, so its verdicts are billable.
vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
  return engineStandInRegistry(await importOriginal(), () => ({
    name: 'Measurement fixture',
    modelId: 'fixture-v1',
    extractClaims: async (): Promise<Claim[]> => [],
    verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
      control.verifyCalls += 1;
      return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: ONE_SOURCE };
    },
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }));
});

import { buildServer } from '../src/server.js';
import { MEASUREMENT_KEY_ID } from '../src/plugins/auth.js';
import { isMeteredKey, meterCheck, reserveClaimsFor } from '../src/lib/claim-meter.js';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger } from '../src/store/grounding-allowance.js';

const SERVER_KEY = ['meter', 'server', 'part', String(process.pid)].join('-');
const MEASUREMENT_KEY = ['meter', 'measure', 'part', String(process.pid)].join('-');

const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_MEASUREMENT_KEY', 'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER',
  'FAULTLINE_CUSTOMER_KEYS', 'GEMINI_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_GROUNDING_LEDGER',
];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-measurement-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_MEASUREMENT_KEY = MEASUREMENT_KEY;
  process.env.FAULTLINE_CLAIM_METER = '1';
  process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  process.env.GEMINI_API_KEY = placeholderProviderKey();
  control.verifyCalls = 0;
  resetClaimMeter();
  resetKeyStore();
  resetRateLimiter();
  resetProviderSpendLedger();
  resetGroundingAllowanceLedger();
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
  resetProviderSpendLedger();
  resetGroundingAllowanceLedger();
  rmSync(dir, { recursive: true, force: true });
});

describe('the measurement key is never metered', () => {
  it('with the meter on, its identity is unmetered and reserves nothing', () => {
    expect(MEASUREMENT_KEY_ID).toBe('measurement');
    expect(meterCheck(MEASUREMENT_KEY_ID)).toEqual({ kind: 'unmetered' });
    expect(isMeteredKey(MEASUREMENT_KEY_ID)).toBe(false);
    const outcome = reserveClaimsFor(MEASUREMENT_KEY_ID, 8);
    expect(outcome).toEqual({ ok: true });
    expect(getClaimMeter().reservedFor(MEASUREMENT_KEY_ID)).toBe(0);
  });

  it('POST /admin/verify-claims verifies for it and writes no usage row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/verify-claims',
      headers: { 'x-api-key': MEASUREMENT_KEY, 'content-type': 'application/json' },
      payload: { claims: [{ id: '0', text: 'The Eiffel Tower is in Paris.' }, { id: '1', text: 'Water is wet.' }], provider: 'gemini' },
    });
    expect(res.statusCode).toBe(200);
    expect(control.verifyCalls).toBe(2);
    const totals = getClaimMeter().totals();
    expect(totals).toMatchObject({ used: 0, reserved: 0, keys: 0 });
    expect(getClaimMeter().usageFor(MEASUREMENT_KEY_ID).used).toBe(0);
    expect(existsSync(process.env.FAULTLINE_CLAIM_METER_LEDGER as string)).toBe(false);
  });

  it('GET /usage for it carries no claims block', async () => {
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': MEASUREMENT_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json().claims).toBeUndefined();
  });
});
