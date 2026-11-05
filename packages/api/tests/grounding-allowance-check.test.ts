// Validates: N-230 (provider spend alert at 90% and 100% of the monthly cap)
/**
 * scripts/grounding-allowance-check.mjs: the provider-budget alert. fetch, the
 * Telegram sender, the state file and the monitor ledger are injected, and the
 * fp handoff and pane wake are off, so these tests never touch the network,
 * Telegram, tmux or ~/.cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerBudgetLevel, runGroundingCheck } from '../../../scripts/grounding-allowance-check.mjs';

const API_KEY = 'test-server-key-never-printed';

interface Budget {
  month: string;
  capUsd: number;
  spentUsd: number;
  enforced: boolean;
}

function usageBody(budget: Budget | null) {
  return {
    keyId: 'admin',
    groundingAllowance: {
      day: '2026-10-26', clock: 'America/Los_Angeles', resetsAt: '2026-10-27T07:00:00.000Z',
      groundedPrompts: 3, freeDailyLimit: 1500, alertThreshold: 1200,
      processStartedAt: '2026-10-26T00:00:00.000Z', ledgerWriteFailures: 0,
    },
    ...(budget ? { providerBudget: { ...budget, appliesTo: ['free', 'anon'], ledgerWriteFailures: 0 } } : {}),
  };
}

let dir: string;
let stateFile: string;
let monitorLog: string;
let notify: Mock<(message: string) => boolean>;
let fetchMock: Mock<(url: string, init?: { headers?: Record<string, string> }) => Promise<Response>>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grounding-check-'));
  stateFile = join(dir, 'state.json');
  monitorLog = join(dir, 'monitor.jsonl');
  notify = vi.fn(() => true);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

async function runWith(budget: Budget | null): Promise<number> {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(usageBody(budget)), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  return runGroundingCheck({
    apiUrl: 'https://api.test',
    apiKey: API_KEY,
    fetch: fetchMock,
    notify,
    stateFile,
    monitorLog,
    wakeFp: false,
  });
}

const budgetAlerts = () => notify.mock.calls.map((c) => c[0]).filter((m) => m.includes('provider spend'));
const monitorRows = () => readFileSync(monitorLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const at = (spentUsd: number, month = '2026-10', enforced = true): Budget => ({ month, capUsd: 100, spentUsd, enforced });

describe('providerBudgetLevel', () => {
  it('is null below 90%, threshold from 90%, limit from 100%', () => {
    expect(providerBudgetLevel(89.99, 100)).toBeNull();
    expect(providerBudgetLevel(90, 100)).toBe('threshold');
    expect(providerBudgetLevel(99.99, 100)).toBe('threshold');
    expect(providerBudgetLevel(100, 100)).toBe('limit');
    expect(providerBudgetLevel(0, 0)).toBe('limit'); // a zero cap is spent from the start
  });
});

describe('grounding-allowance-check: provider budget alert', () => {
  it('reads GET /usage with the server key and never prints it', async () => {
    await runWith(at(10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/usage');
    expect(fetchMock.mock.calls[0][1]?.headers?.['x-api-key']).toBe(API_KEY);
    const printed = logSpy.mock.calls.flat().join('\n') + readFileSync(monitorLog, 'utf8') + readFileSync(stateFile, 'utf8');
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).not.toContain(API_KEY);
  });

  it('at 89%: no alert, and the ledger row records the position', async () => {
    expect(await runWith(at(89))).toBe(0);
    expect(budgetAlerts()).toHaveLength(0);
    const rows = monitorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].providerBudget).toMatchObject({ month: '2026-10', percent: 89, level: null, notified: false });
  });

  it('at 90%: one alert naming the percent, the amounts and the free and anonymous stop', async () => {
    await runWith(at(90));
    const alerts = budgetAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe(
      'Faultline provider spend at 90% of the monthly cap, 90.00 of 100.00 USD for 2026-10; '
      + 'free and anonymous scans stop at 100%.',
    );
    const rows = monitorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].providerBudget).toMatchObject({ level: 'threshold', notified: true, enforced: true });
  });

  it('when the cap is not enforced, the alert says so', async () => {
    await runWith(at(92, '2026-10', false));
    const alerts = budgetAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('92% of the monthly cap, 92.00 of 100.00 USD');
    expect(alerts[0]).toContain('the cap is not enforced');
  });

  it('a second run in the same month at the same level sends no second alert', async () => {
    await runWith(at(90));
    await runWith(at(95));
    expect(budgetAlerts()).toHaveLength(1);
    const rows = monitorRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].providerBudget).toMatchObject({ level: 'threshold', alerted: false, notified: false });
  });

  it('at 100%: one more alert, then nothing more that month', async () => {
    await runWith(at(90));
    await runWith(at(100));
    await runWith(at(130));
    const alerts = budgetAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain('100% of the monthly cap, 100.00 of 100.00 USD');
    expect(alerts[1]).toContain('free and anonymous scans are refused until the budget resets');
  });

  it('a new month resets: 90% alerts again', async () => {
    await runWith(at(90, '2026-10'));
    await runWith(at(100, '2026-10'));
    await runWith(at(91, '2026-11'));
    const alerts = budgetAlerts();
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toContain('for 2026-11');
  });

  it('a failed Telegram send is retried on the next run', async () => {
    notify.mockImplementationOnce(() => false);
    await runWith(at(90));
    await runWith(at(90));
    expect(budgetAlerts()).toHaveLength(2);
    expect(monitorRows()[1].providerBudget).toMatchObject({ notified: true });
  });

  it('a response without providerBudget is a probe failure: exit 2 and a PROBE_FAIL row', async () => {
    expect(await runWith(null)).toBe(2);
    expect(budgetAlerts()).toHaveLength(0);
    const rows = monitorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('PROBE_FAIL');
    expect(String(rows[0].error)).toMatch(/no providerBudget/);
    // The same failure path as a failed fetch: one probe-failure alert.
    const failAlerts = notify.mock.calls.map((c) => c[0]).filter((m) => m.includes('grounding check FAILED'));
    expect(failAlerts).toHaveLength(1);
    expect(failAlerts[0]).toMatch(/no providerBudget/);
  });

  it('a providerBudget without numeric spend and cap is a probe failure too', async () => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...usageBody(null), providerBudget: { month: '2026-10', enforced: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const code = await runGroundingCheck({
      apiUrl: 'https://api.test', apiKey: API_KEY, fetch: fetchMock, notify, stateFile, monitorLog, wakeFp: false,
    });
    expect(code).toBe(2);
    const rows = monitorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('PROBE_FAIL');
  });
});
