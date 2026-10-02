// Validates: GoPMO 1.18.7.3.2 (alerting fires on a hosted-API failure)
/**
 * scripts/api-health-check.mjs: the cron health check of the hosted API.
 * fetch, notify, sleep and the state file are injected, so these tests never
 * touch the network, Telegram or ~/.cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHealthCheck } from '../../../scripts/api-health-check.mjs';

const URL = 'https://api.test/health';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const healthy = () => jsonResponse(200, { status: 'ok', version: '0.11.1', stage: 'alpha' });

let dir: string;
let stateFile: string;
let notify: Mock<(message: string) => boolean>;
let sleep: Mock<(ms: number) => Promise<void>>;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'api-health-'));
  stateFile = join(dir, 'state.json');
  notify = vi.fn(() => true);
  sleep = vi.fn(async () => {});
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(fetchImpl: (...a: unknown[]) => Promise<Response>, extra: Record<string, unknown> = {}) {
  return runHealthCheck({
    url: URL,
    stateFile,
    fetch: fetchImpl,
    notify,
    sleep,
    log: (l: string) => lines.push(l),
    ...extra,
  });
}

describe('api-health-check', () => {
  it('AH-01 healthy: exit 0, one attempt, no alert, one log line with code and latency', async () => {
    const fetchImpl = vi.fn(async () => healthy());
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(URL);
    expect(notify).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z UP url=https:\/\/api\.test\/health code=200 latency_ms=\d+ attempts=1 notified=false$/);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).status).toBe('up');
  });

  it('AH-02 non-200: retries twice 20 s apart, exit 1, one DOWN alert naming the code', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { status: 'ok' }));
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 20_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('Faultline hosted API DOWN');
    expect(notify.mock.calls[0][0]).toContain('HTTP 503');
    expect(lines[0]).toContain(' DOWN ');
    expect(lines[0]).toContain('code=503');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.status).toBe('down');
    expect(state.alertedAt).toBeTruthy();
  });

  it('AH-03 timeout: a TimeoutError on every attempt is DOWN with code=timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('timeout after 10000 ms');
    expect(lines[0]).toContain('code=timeout');
  });

  it('AH-03b network error is DOWN with code=error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    });
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('network error: ENOTFOUND');
    expect(lines[0]).toContain('code=error');
  });

  it('AH-03c passes a 10 s abort signal to fetch', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init: unknown) => {
      expect((init as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
      return healthy();
    });
    await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('AH-04 bad body: 200 with status other than "ok" is DOWN', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'degraded', version: '0.11.1' }));
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('body.status is "degraded"');
  });

  it('AH-04b bad body: 200 with non-JSON body is DOWN', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(1);
    expect(notify.mock.calls[0][0]).toContain('body is not JSON');
  });

  it('AH-05 a later attempt that succeeds is healthy, no alert', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(healthy());
    const r = await run(fetchImpl);
    expect(r.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it('AH-06 dedup: a second failing run does not re-alert', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    const first = await run(fetchImpl);
    const second = await run(fetchImpl);
    const third = await run(fetchImpl);
    expect([first.exitCode, second.exitCode, third.exitCode]).toEqual([1, 1, 1]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(second.notified).toBe(false);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('notified=false');
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).since).toBe(first.state.since);
  });

  it('AH-06b a failed alert send is retried on the next run', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    notify.mockReturnValueOnce(false);
    await run(fetchImpl);
    await run(fetchImpl);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).alertedAt).toBeTruthy();
  });

  it('AH-07 recovery: down then healthy sends one RECOVERED message, then nothing', async () => {
    await run(vi.fn(async () => jsonResponse(500, {})));
    expect(notify).toHaveBeenCalledTimes(1);
    const back = await run(vi.fn(async () => healthy()));
    expect(back.exitCode).toBe(0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain('Faultline hosted API RECOVERED');
    expect(notify.mock.calls[1][0]).toContain('version 0.11.1');
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).status).toBe('up');
    await run(vi.fn(async () => healthy()));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('AH-08 alert prefix marks a drill message as TEST', async () => {
    await run(vi.fn(async () => jsonResponse(404, {})), { alertPrefix: 'TEST' });
    expect(notify.mock.calls[0][0]).toMatch(/^TEST Faultline hosted API DOWN/);
  });

  it('AH-09 missing state file is treated as up, and the file is created', async () => {
    expect(existsSync(stateFile)).toBe(false);
    await run(vi.fn(async () => healthy()));
    expect(existsSync(stateFile)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});
