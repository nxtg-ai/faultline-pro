// Validates: claim meter and usage-record contract
//
// A client that disconnects mid-scan must not leave its reservation held: the
// key's remaining would otherwise shrink until the process restarts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { registerProvider } from '@nxtg/faultline/providers/registry.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetCache } from '../src/store/cache.js';

const control = { verifyCalls: 0, gate: null as Promise<void> | null };

registerProvider('mock', () => ({
  name: 'Abort fixture',
  modelId: 'fixture-v1',
  extractClaims: async (text: string): Promise<Claim[]> =>
    text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
      .map((s, i) => ({ id: `c${i + 1}`, text: s, type: 'fact' as const, importance: 5 })),
  verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
    control.verifyCalls += 1;
    if (control.gate) await control.gate;
    return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [] };
  },
  generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
}) as never);

const ENV_KEYS = ['FAULTLINE_API_KEY', 'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_CUSTOMER_KEYS',
  'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_GROUNDING_LEDGER'];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-abort-'));
  process.env.FAULTLINE_API_KEY = 'claim-abort-server-key';
  process.env.FAULTLINE_CLAIM_METER = '1';
  process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  Object.assign(control, { verifyCalls: 0, gate: null });
  resetClaimMeter();
  resetKeyStore();
  resetRateLimiter();
  resetCache();
  app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  control.gate = null;
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('a client that disconnects mid-scan', () => {
  it('frees its reservation; the claims it was verifying still commit when the scan ends', async () => {
    const key = getKeyStore().create('customer', ['scan'], undefined, { metered: true, claimCap: 100 });
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const { port } = app.server.address() as AddressInfo;
    const body = JSON.stringify({ text: 'One checkable fact. Two checkable facts.', provider: 'mock' });
    const req = httpRequest({ host: '127.0.0.1', port, path: '/scan', method: 'POST',
      headers: { 'x-api-key': key.key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.end(body);
    await until(() => control.verifyCalls >= 2, 'the scan to start verifying');
    expect(getClaimMeter().reservedFor(key.id)).toBe(8);
    req.destroy();
    open();
    await until(() => getClaimMeter().usageFor(key.id).used === 2, 'the scan to commit');
    await until(() => getClaimMeter().reservedFor(key.id) === 0, 'the reservation to be freed');
    expect(getClaimMeter().reservedFor(key.id)).toBe(0);
  });
});
