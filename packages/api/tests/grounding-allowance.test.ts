// Validates: N-230 (grounding allowance alert, Asif ruling 2026-10-01)
/**
 * Daily Gemini grounded-prompt meter against Google's free allowance
 * (1,500 grounded prompts a day; alert at 1,200).
 *
 * The SDK is mocked at the module boundary (codebase convention), and the mock
 * counts every generateContent call that carries the googleSearch tool. The
 * end-to-end tests assert the server's count equals THAT number, so the meter
 * is checked against what was actually sent, not against itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sdk = vi.hoisted(() => ({ groundedCalls: 0, plainCalls: 0, rejectedCalls: 0 }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { contents?: unknown; config?: { tools?: Array<Record<string, unknown>> } }) => {
        await new Promise((r) => setTimeout(r, 0));
        if (JSON.stringify(params.contents ?? '').includes('FAIL429')) {
          sdk.rejectedCalls += 1;
          throw new Error('429 RESOURCE_EXHAUSTED');
        }
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (grounded) {
          sdk.groundedCalls += 1;
          return {
            text: '{"status":"supported","explanation":"Matches the record."}',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
          };
        }
        sdk.plainCalls += 1;
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
import { resetKeyStore, getKeyStore, type Permission } from '../src/store/keys.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { recordUsage, type UsageLeg } from '@nxtg/faultline/lib/usage-sink.js';
import {
  FREE_DAILY_GROUNDED_PROMPTS,
  GROUNDING_ALERT_THRESHOLD,
  allowanceDay,
  allowanceResetsAt,
  getGroundingAllowanceLedger,
  getGroundingAllowanceStatus,
  groundingLedgerPath,
  installGroundingCounter,
  isGroundedGeminiLeg,
  recordGroundedLeg,
  resetGroundingAllowanceLedger,
  uninstallGroundingCounter,
} from '../src/store/grounding-allowance.js';

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'FAULTLINE_CONSENSUS'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let ledgerFile: string;

const groundedGemini: UsageLeg = {
  provider: 'gemini', model: 'gemini-2.5-flash', callType: 'grounded-verify:gemini',
  inputTokens: 90, outputTokens: 20, isGrounding: true,
};

function seedLedgerRows(day: string, rows: number): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), day, provider: 'gemini' }) + '\n';
  appendFileSync(ledgerFile, line.repeat(rows));
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.FAULTLINE_CONSENSUS;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-grounding-'));
  ledgerFile = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = ledgerFile;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  sdk.groundedCalls = 0;
  sdk.plainCalls = 0;
  sdk.rejectedCalls = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('allowance day — Google resets RPD at midnight Pacific', () => {
  it('splits days at 00:00 Pacific in summer time (07:00 UTC)', () => {
    expect(allowanceDay(new Date('2026-10-01T06:59:00Z'))).toBe('2026-09-30');
    expect(allowanceDay(new Date('2026-10-01T07:00:00Z'))).toBe('2026-10-01');
  });

  it('splits days at 00:00 Pacific in standard time (08:00 UTC)', () => {
    expect(allowanceDay(new Date('2026-12-01T07:59:00Z'))).toBe('2026-11-30');
    expect(allowanceDay(new Date('2026-12-01T08:00:00Z'))).toBe('2026-12-01');
  });

  it('reports the next Pacific midnight as resetsAt, across both DST switches', () => {
    expect(allowanceResetsAt(new Date('2026-10-01T12:00:00Z'))).toBe('2026-10-02T07:00:00.000Z');
    expect(allowanceResetsAt(new Date('2026-12-01T12:00:00Z'))).toBe('2026-12-02T08:00:00.000Z');
    // DST ends 2026-11-01: that day is 25h long and ends at 08:00 UTC.
    expect(allowanceResetsAt(new Date('2026-11-01T12:00:00Z'))).toBe('2026-11-02T08:00:00.000Z');
    // DST starts 2027-03-14: the day before ends in PST, that day ends in PDT.
    expect(allowanceResetsAt(new Date('2027-03-13T20:00:00Z'))).toBe('2027-03-14T08:00:00.000Z');
    expect(allowanceResetsAt(new Date('2027-03-14T20:00:00Z'))).toBe('2027-03-15T07:00:00.000Z');
  });
});

describe('what counts as a grounded prompt', () => {
  it('counts a Gemini call that carried the googleSearch tool', () => {
    expect(isGroundedGeminiLeg(groundedGemini)).toBe(true);
    expect(recordGroundedLeg(groundedGemini)).toBe(true);
    expect(getGroundingAllowanceLedger().dayCount()).toBe(1);
  });

  it('does not count non-grounded Gemini calls or grounded calls on other providers', () => {
    const notCounted: UsageLeg[] = [
      { ...groundedGemini, isGrounding: false, callType: 'extraction' },
      { ...groundedGemini, isGrounding: false, callType: 'grounded-verify:gemini' },
      { ...groundedGemini, provider: 'openai', model: 'gpt-4o', callType: 'web_search' },
      { ...groundedGemini, provider: 'anthropic', model: 'claude-opus-4-8' },
      { ...groundedGemini, provider: undefined },
    ];
    for (const leg of notCounted) expect(recordGroundedLeg(leg)).toBe(false);
    expect(getGroundingAllowanceLedger().dayCount()).toBe(0);
    expect(() => readFileSync(ledgerFile, 'utf8')).toThrow(); // nothing ledgered
  });

  it('writes one append-only row per grounded prompt, with no key or text', () => {
    const now = new Date('2026-10-01T18:00:00Z');
    recordGroundedLeg(groundedGemini, now);
    recordGroundedLeg({ ...groundedGemini, callType: 'grounded-retrieve:gemini' }, now);
    const rows = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      ts: now.toISOString(), day: '2026-10-01', provider: 'gemini',
      model: 'gemini-2.5-flash', callType: 'grounded-verify:gemini',
    });
    expect(rows[1].callType).toBe('grounded-retrieve:gemini');
  });
});

describe('the counter is wired to the engine usage sink', () => {
  afterEach(() => uninstallGroundingCounter());

  it('counts legs recorded OUTSIDE any capture scope (batch, bulk, schedules)', () => {
    installGroundingCounter();
    recordUsage(groundedGemini);
    recordUsage({ ...groundedGemini, isGrounding: false });
    expect(getGroundingAllowanceLedger().dayCount()).toBe(1);
  });

  it('installing twice never double-counts', () => {
    installGroundingCounter();
    installGroundingCounter();
    recordUsage(groundedGemini);
    expect(getGroundingAllowanceLedger().dayCount()).toBe(1);
  });

  it('counts exactly the googleSearch requests a real gemini scan sends (engine path, uncaptured)', async () => {
    installGroundingCounter();
    const result = await scan('The Eiffel Tower was completed in 1889. Mount Everest is the highest mountain above sea level.', 'gemini');
    expect(Object.keys(result.verifications ?? {}).length).toBeGreaterThan(0);
    expect(sdk.groundedCalls).toBeGreaterThan(0);
    expect(sdk.plainCalls).toBeGreaterThan(0); // extraction ran and was NOT counted
    expect(getGroundingAllowanceLedger().dayCount()).toBe(sdk.groundedCalls);
  });

  it('does not count a grounded request Google rejected (429: no response, not billed)', async () => {
    installGroundingCounter();
    const { verifyClaim } = await import('@nxtg/faultline/services/geminiService.js');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await verifyClaim({ id: 'c1', text: 'FAIL429 claim', type: 'fact', importance: 3 } as never, 'test-gemini');
    quiet.mockRestore();
    expect(sdk.rejectedCalls).toBe(1);   // the request was attempted
    expect(result.apiError).toBe(true);  // and failed
    expect(getGroundingAllowanceLedger().dayCount()).toBe(0);
  });
});

describe('durability — the ledger is the authority', () => {
  it('a process reset re-hydrates the day count from the ledger file', () => {
    recordGroundedLeg(groundedGemini);
    recordGroundedLeg(groundedGemini);
    recordGroundedLeg(groundedGemini);
    resetGroundingAllowanceLedger(); // simulated restart: memory gone, file kept
    expect(getGroundingAllowanceLedger().dayCount()).toBe(3);
    recordGroundedLeg(groundedGemini);
    expect(getGroundingAllowanceLedger().dayCount()).toBe(4); // no double count after hydration
  });

  it('skips corrupt ledger lines instead of zeroing the count', () => {
    const day = allowanceDay();
    seedLedgerRows(day, 2);
    appendFileSync(ledgerFile, '{not json\n\n');
    seedLedgerRows(day, 1);
    expect(getGroundingAllowanceLedger().dayCount(day)).toBe(3);
  });

  it('starts a new allowance-day at zero and keeps the old day intact', () => {
    recordGroundedLeg(groundedGemini, new Date('2026-10-01T06:30:00Z')); // 2026-09-30 Pacific
    recordGroundedLeg(groundedGemini, new Date('2026-10-01T06:59:59Z')); // 2026-09-30 Pacific
    recordGroundedLeg(groundedGemini, new Date('2026-10-01T07:00:00Z')); // 2026-10-01 Pacific
    resetGroundingAllowanceLedger();
    const ledger = getGroundingAllowanceLedger();
    expect(ledger.dayCount('2026-09-30')).toBe(2);
    expect(ledger.dayCount('2026-10-01')).toBe(1);
    expect(getGroundingAllowanceStatus(new Date('2026-10-02T12:00:00Z')).groundedPrompts).toBe(0);
  });

  it('an unwritable ledger never throws, still counts in memory, and surfaces the failures', () => {
    writeFileSync(join(tmpDir, 'blocker'), 'a file, not a directory');
    process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'blocker', 'grounding.jsonl');
    resetGroundingAllowanceLedger();
    expect(groundingLedgerPath()).toContain('blocker');
    expect(() => recordGroundedLeg(groundedGemini)).not.toThrow();
    expect(getGroundingAllowanceLedger().dayCount()).toBe(1);
    expect(getGroundingAllowanceStatus().ledgerWriteFailures).toBe(1);
  });
});

describe('GET /usage — groundingAllowance', () => {
  async function getUsage(caps: Permission[]) {
    const server = buildServer();
    await server.ready();
    try {
      const key = getKeyStore().create('Key', caps);
      const res = await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': key.key } });
      expect(res.statusCode).toBe(200);
      return res.json();
    } finally {
      await server.close();
    }
  }

  it('reports the ruled limits and stays below threshold at 1,199', async () => {
    seedLedgerRows(allowanceDay(), GROUNDING_ALERT_THRESHOLD - 1);
    const body = await getUsage(['admin', 'scan']);
    expect(body.groundingAllowance).toMatchObject({
      day: allowanceDay(),
      clock: 'America/Los_Angeles',
      groundedPrompts: 1199,
      freeDailyLimit: 1500,
      alertThreshold: 1200,
      overThreshold: false,
      overFreeLimit: false,
      ledgerWriteFailures: 0,
    });
    expect(FREE_DAILY_GROUNDED_PROMPTS).toBe(1500);
    expect(new Date(body.groundingAllowance.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.providerBudget.ledgerWriteFailures).toBe(0);
  });

  it('flips overThreshold at exactly 1,200', async () => {
    seedLedgerRows(allowanceDay(), GROUNDING_ALERT_THRESHOLD - 1);
    recordGroundedLeg(groundedGemini);
    const body = await getUsage(['admin', 'scan']);
    expect(body.groundingAllowance.groundedPrompts).toBe(1200);
    expect(body.groundingAllowance.overThreshold).toBe(true);
    expect(body.groundingAllowance.overFreeLimit).toBe(false);
  });

  it('flags overFreeLimit at 1,500', async () => {
    seedLedgerRows(allowanceDay(), FREE_DAILY_GROUNDED_PROMPTS);
    const body = await getUsage(['admin', 'scan']);
    expect(body.groundingAllowance.overThreshold).toBe(true);
    expect(body.groundingAllowance.overFreeLimit).toBe(true);
  });

  it('never shows the allowance to a customer key', async () => {
    seedLedgerRows(allowanceDay(), 5);
    const body = await getUsage(['pro', 'scan']);
    expect(body.groundingAllowance).toBeUndefined();
    expect(body.providerBudget).toBeUndefined();
  });

  it('counts a real POST /scan on gemini end to end (server-installed counter)', async () => {
    const server = buildServer(); // installs the counter, as production does
    await server.ready();
    try {
      const key = getKeyStore().create('Pro', ['pro', 'scan']);
      const res = await server.inject({
        method: 'POST',
        url: '/scan',
        headers: { 'x-api-key': key.key, 'content-type': 'application/json' },
        payload: { text: 'The Eiffel Tower was completed in 1889. Mount Everest is the highest mountain above sea level.', provider: 'gemini' },
      });
      expect(res.statusCode).toBe(200);
      expect(sdk.groundedCalls).toBeGreaterThan(0);
      expect(getGroundingAllowanceStatus().groundedPrompts).toBe(sdk.groundedCalls);
    } finally {
      await server.close();
      uninstallGroundingCounter();
    }
  });
});
