// Validates: GoPMO 1.18.11.7.127 (ruling Dx3 abccffac item 4): the daily Tier-0 check of the fallback
// judge's share wakes fp and the program owner once a day above 10%, and a bad probe is never an OK.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readBlock, alertPost } from '../../../scripts/judge-fallback-check.mjs';

const KEY = ['judge', 'check', 'key', 'never-printed'].join('-');
let dir: string;

const block = (over: Record<string, unknown> = {}) => ({
  windowDays: 7, from: '2026-11-14', to: '2026-11-20', primary: 'gemini-3.1-pro-preview',
  byModel: { 'gemini-3.1-pro-preview': 90, 'gemini-3.8-flash': 10 }, total: 100, fallbackShare: 0.1,
  alertShare: 0.1, alert: false, ledgerWriteFailures: 0, ...over,
});
const fetchOf = (status: number, body: unknown): typeof fetch => (async (_url: string | URL | Request, init?: RequestInit) => {
  expect((init?.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  return { status, json: async () => body } as Response;
}) as typeof fetch;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'judge-check-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(fetchImpl: typeof fetch, now = new Date('2026-11-20T15:00:00Z')) {
  const lines: string[] = [];
  const posts: string[] = [];
  const pastes: string[] = [];
  const env = { FAULTLINE_API_KEY: KEY, JUDGE_STATE_DIR: dir, JUDGE_MONITOR_LOG: join(dir, 'monitor.jsonl'), FAULTLINE_API_URL: 'http://api.test' };
  const done = main({ env, fetchImpl, now, log: (l: string) => lines.push(l), post: (t: string) => posts.push(t), pane: (t: string) => pastes.push(t) });
  return done.then((code: number) => ({ code, lines, posts, pastes }));
}

describe('judge-fallback-check', () => {
  it('at or under 10%: exit 0, no wake, one monitor row', async () => {
    const r = await run(fetchOf(200, { judgeModels: block() }));
    expect(r.code).toBe(0);
    expect(r.posts).toHaveLength(0);
    expect(r.pastes).toHaveLength(0);
    expect(r.lines[0]).toMatch(/^OK judge calls 2026-11-14 to 2026-11-20: 100 \(gemini-3.1-pro-preview 90, gemini-3.8-flash 10\); fallback share 10\.0%/);
    const rows = readFileSync(join(dir, 'monitor.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]).status).toBe('ok');
  });

  it('above 10%: exit 1, wakes the owner by post and fp by pane, once per UTC day', async () => {
    const alerting = fetchOf(200, { judgeModels: block({ fallbackShare: 0.2, alert: true, byModel: { 'gemini-3.1-pro-preview': 80, 'gemini-3.8-flash': 20 } }) });
    const first = await run(alerting);
    expect(first.code).toBe(1);
    expect(first.posts).toHaveLength(1);
    expect(first.posts[0]).toMatch(/^@emma-soul JUDGE FALLBACK ALERT, GoPMO 1\.18\.11\.7\.127 item 4/);
    expect(first.posts[0]).toContain('fallback share 20.0%');
    expect(first.pastes).toHaveLength(1);
    const again = await run(alerting);
    expect(again.code).toBe(1);
    expect(again.posts).toHaveLength(0);
    expect(again.pastes).toHaveLength(0);
    const nextDay = await run(alerting, new Date('2026-11-21T15:00:00Z'));
    expect(nextDay.posts).toHaveLength(1);
  });

  it('a probe failure is exit 2, never OK: no key, a non-200, no block, a malformed block', async () => {
    const noKey = await main({ env: { JUDGE_STATE_DIR: dir, JUDGE_MONITOR_LOG: join(dir, 'm.jsonl'), HOME: dir }, fetchImpl: async () => { throw new Error('must not call'); }, log: () => {} });
    expect(noKey).toBe(2);
    expect((await run(fetchOf(401, {}))).code).toBe(2);
    expect((await run(fetchOf(200, { usage: {} }))).code).toBe(2);
    expect((await run(fetchOf(200, { judgeModels: { total: 'x' } }))).code).toBe(2);
  });

  it('never prints the key', async () => {
    const r = await run(fetchOf(200, { judgeModels: block({ alert: true, fallbackShare: 0.5 }) }));
    expect([...r.lines, ...r.posts, ...r.pastes].join('\n')).not.toContain(KEY);
  });

  it('readBlock and alertPost carry the instrument', () => {
    expect(() => readBlock({})).toThrow(/no judgeModels block/);
    expect(alertPost(block({ fallbackShare: 0.3 }), ['emma-soul'])).toContain('Instrument: admin GET /usage judgeModels');
  });
});
