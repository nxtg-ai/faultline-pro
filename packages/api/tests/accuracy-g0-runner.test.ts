// Validates: prereg G0 §2, §5, §6, §7 (docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md): the runner's guards
/**
 * scripts/accuracy-g0.mjs against a local fake API on 127.0.0.1. Every run
 * passes --api pointing at the fake, so the hosted API is never reachable from
 * this file, and no provider is called.
 *
 * The script runs as a real subprocess (async spawn, so this process's fake
 * server can answer it), with HOME pointed at a temp dir and the key planted in
 * env or the key file, so "never prints the key" is checked on real stdout and
 * stderr.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The real-server test below runs the API in this process; its Gemini SDK is mocked at the module
// boundary, so no provider is called and nothing leaves the machine.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 't', uri: 'https://example.com/a' } }] } }],
        text: JSON.stringify({ status: 'supported', explanation: 'e' }),
      }),
    };
  },
}));

// Every test here spawns the runner as a real child process. Under machine load (load avg 35-39,
// 2026-10-05 and 2026-10-07) the 5 s default timed out and blocked the pre-push gate.
vi.setConfig({ testTimeout: 30_000 });

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/accuracy-g0.mjs');
const GOLD = join(REPO_ROOT, 'docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl');
const SUBSAMPLE_IDS: number[] = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/research/data/accuracy-g0-verify-subsample-ids.json'), 'utf8'),
).ids;
const KEY = ['runner', 'ADMINKEY', 'must-never-print', '4242'].join('-');

interface FakeState {
  usageExtra?: Record<string, unknown>;
  /** When set, an apiError answer still reports this usage (a call that failed after spending). */
  failUsage?: { costUsd: number; googleGroundingCalls: number };
  dropVerifyOnce?: boolean;
  groundedPrompts: number;
  commit: string | null;
  version: string;
  model: (call: number) => string;
  /** id → number of leading attempts answered with apiError (Infinity = always). */
  failFirst: Map<number, number>;
  /** When set, the parallel arm answers every even id as not checkable (GoPMO 1.18.11.7.19). */
  notCheckableEvenOnParallel?: boolean;
  verifyCalls: number;
  requests: number;
  /** x-api-key values on every request except GET /health. */
  seenKeys: Set<string>;
  /** The key headers each GET /health carried (x-api-key, authorization), '' when absent. */
  healthKeyHeaders: string[];
  attemptsById: Map<number, number>;
  verifyStatus: number;
  verifyBody?: unknown;
  /** The grounding and parallelMode fields of every verify request, in order. */
  arms?: Array<{ grounding?: string; parallelMode?: string }>;
  /** When set, the engine answers this grounding whatever was asked. */
  ranGrounding?: string;
  /** When set, /usage reports the day full (1,000) once this many verify calls happened in the current process. */
  capAfterCallsThisRun?: number;
  /** verifyCalls when the current runner process started. */
  runStartCalls: number;
  /** The judge model each answered verdict names (judge model A/B). */
  judgeModel?: (id: number) => string;
  /** Tokens each answered verdict reports. */
  tokens?: { inputTokens: number; outputTokens: number };
}

let dir: string;
let server: Server;
let api: string;
let state: FakeState;

function freshState(): FakeState {
  return {
    groundedPrompts: 0,
    commit: '4de048a1b2c3d4e5f60718293a4b5c6d7e8f9012',
    version: '0.11.1',
    model: () => 'gemini-2.5-flash',
    failFirst: new Map(),
    verifyCalls: 0,
    requests: 0,
    seenKeys: new Set(),
    healthKeyHeaders: [],
    attemptsById: new Map(),
    verifyStatus: 200,
    runStartCalls: 0,
    usageExtra: undefined,
    failUsage: undefined,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.requests += 1;
  if (req.method === 'GET' && req.url === '/health') {
    state.healthKeyHeaders.push(String(req.headers['x-api-key'] ?? '') + String(req.headers.authorization ?? ''));
    return send(res, 200, { status: 'ok', version: state.version, commit: state.commit });
  }
  state.seenKeys.add(String(req.headers['x-api-key'] ?? ''));
  if (req.method === 'GET' && req.url === '/usage') {
    const full = state.capAfterCallsThisRun !== undefined && state.verifyCalls - state.runStartCalls >= state.capAfterCallsThisRun;
    return send(res, 200, {
      keyId: 'admin',
      groundingAllowance: { day: '2026-10-02', groundedPrompts: full ? 1000 : state.groundedPrompts, resetsAt: '2026-10-03T07:00:00.000Z', ...(state.usageExtra ?? {}) },
    });
  }
  if (req.method === 'POST' && req.url === '/admin/verify-claims') {
    state.verifyCalls += 1;
    if (state.dropVerifyOnce) { state.dropVerifyOnce = false; req.socket.destroy(); return; }
    if (state.verifyStatus !== 200) return send(res, state.verifyStatus, state.verifyBody ?? {});
    const { claims, grounding, parallelMode } = JSON.parse(await readBody(req)) as { claims: Array<{ id: string; text: string }>; grounding?: string; parallelMode?: string };
    (state.arms ??= []).push({ grounding, parallelMode });
    const parallelArm = grounding === 'parallel';
    const results = claims.map(({ id }) => {
      const n = Number(id);
      const attempt = (state.attemptsById.get(n) ?? 0) + 1;
      state.attemptsById.set(n, attempt);
      const fail = attempt <= (state.failFirst.get(n) ?? 0);
      if (!fail) state.groundedPrompts += 1;
      if (!fail && parallelArm && state.notCheckableEvenOnParallel && n % 2 === 0) {
        return {
          id, status: 'unverified', apiError: false, parseFallback: false, noSourceAbstain: false, notCheckable: true,
          model: state.model(state.verifyCalls), sourcesCount: 0,
          usage: { costUsd: 0.00508, googleGroundingCalls: 0, groundingCalls: 1 },
        };
      }
      return fail
        ? { id, status: 'unverified', apiError: true, apiErrorReason: n % 2 === 0 ? 'output_truncated' : 'not a label!', parseFallback: false, model: null, ...(state.failUsage ? { usage: state.failUsage } : {}) }
        : {
          id, status: n % 3 === 0 ? 'contradicted' : 'supported', apiError: false, parseFallback: n % 7 === 0, model: state.model(state.verifyCalls),
          sourcesCount: parallelArm ? 5 : 2,
          usage: { costUsd: parallelArm ? 0.00508 : 0.03508, googleGroundingCalls: parallelArm ? 0 : 1, groundingCalls: 1, ...(state.tokens ?? {}) },
          ...(state.judgeModel ? { judgeModel: state.judgeModel(n) } : {}),
        };
    });
    return send(res, 200, { provider: 'gemini', grounding: state.ranGrounding ?? grounding ?? 'google', results });
  }
  return send(res, 404, { error: 'not found' });
}

interface RunResult { code: number | null; out: string }

function run(args: string[], env: Record<string, string> = { FAULTLINE_ADMIN_KEY: KEY }): Promise<RunResult> {
  state.runStartCalls = state.verifyCalls;
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, '--api', api, '--retry-base-ms', '1', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolvePromise({ code, out }));
  });
}

function rows(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'accuracy-g0-runner-'));
  state = freshState();
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('accuracy-g0 runner: refusals before anything is sent', () => {
  it('refuses a gold file whose sha256 differs, with exit 2 and zero requests', async () => {
    const tampered = join(dir, 'gold.jsonl');
    copyFileSync(GOLD, tampered);
    writeFileSync(tampered, readFileSync(tampered, 'utf8').replace('"label":"false"', '"label":"true"'));
    const out = join(dir, 'out.jsonl');
    const r = await run(['--set', 'full', '--gold', tampered, '--out', out]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/gold sha256 .* is not b87f971c/);
    expect(state.requests).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(r.out).not.toContain(KEY);
  });

  it('refuses with no measurement or admin key anywhere (exit 2, zero requests)', async () => {
    const r = await run(['--set', 'full', '--out', join(dir, 'out.jsonl')], {});
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no measurement or admin key/);
    expect(state.requests).toBe(0);
  });

  it('refuses when /health exposes no commit and no --engine-sha is given (exit 2, no verify call)', async () => {
    state.commit = null;
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'out.jsonl')]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/exposes no commit/);
    expect(state.verifyCalls).toBe(0);
  });

  it('refuses when --engine-sha disagrees with /health commit', async () => {
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'out.jsonl'), '--engine-sha', 'abcdef1']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/differs from --engine-sha/);
    expect(state.verifyCalls).toBe(0);
  });

  it('refuses an existing out file without --resume', async () => {
    const out = join(dir, 'out.jsonl');
    writeFileSync(out, '');
    const r = await run(['--set', 'verify-subsample', '--out', out]);
    expect(r.code).toBe(2);
    expect(state.verifyCalls).toBe(0);
  });
});

describe('accuracy-g0 runner: a complete run', () => {
  it('verify-subsample writes exactly the 100 committed ids, one row each, with the prereg fields', async () => {
    const out = join(dir, 'sub.jsonl');
    const r = await run(['--set', 'verify-subsample', '--out', out]);
    expect(r.code).toBe(0);
    const written = rows(out);
    expect(written).toHaveLength(100);
    expect(written.map((row) => row.id)).toEqual([...SUBSAMPLE_IDS].sort((a, b) => a - b));
    expect(Object.keys(written[0]).sort()).toEqual(
      ['apiError', 'apiErrorReason', 'arm', 'attempts', 'costUsd', 'engineSha', 'gold', 'googleGroundingCalls', 'id', 'inputTokens', 'judgeModel', 'model', 'noSourceAbstain', 'notCheckable', 'outputTokens', 'parallelCalls',
        'parseFallback', 'sourcesCount', 'status', 'ts', 'verdict'],
    );
    expect(written.every((row) => row.engineSha === state.commit && row.model === 'gemini-2.5-flash')).toBe(true);
    expect(written.every((row) => row.gold === 'true' || row.gold === 'false')).toBe(true);
    // 4 batches of 25: the route's limit is never exceeded.
    expect(state.verifyCalls).toBe(4);
  });

  it('uses --engine-sha when /health exposes no commit', async () => {
    state.commit = null;
    const out = join(dir, 'sub.jsonl');
    const r = await run(['--set', 'verify-subsample', '--out', out, '--engine-sha', '0707F24']);
    expect(r.code).toBe(0);
    expect(rows(out).every((row) => row.engineSha === '0707f24')).toBe(true);
  });
});

describe('accuracy-g0 runner: retries (prereg §6)', () => {
  it('retries an apiError item and records the attempts; gives up after 3 retries as a failure row', async () => {
    const [recovers, neverRecovers] = [SUBSAMPLE_IDS[0], SUBSAMPLE_IDS[1]];
    state.failFirst.set(recovers, 2);
    state.failFirst.set(neverRecovers, Infinity);
    const out = join(dir, 'sub.jsonl');
    const r = await run(['--set', 'verify-subsample', '--out', out]);
    expect(r.code).toBe(0);
    const byId = new Map(rows(out).map((row) => [row.id, row]));
    expect(byId.size).toBe(100);
    expect(byId.get(recovers)).toMatchObject({ apiError: false, attempts: 3 });
    expect(byId.get(neverRecovers)).toMatchObject({ apiError: true, status: 'unverified', attempts: 4, model: null });
    expect(state.attemptsById.get(neverRecovers)).toBe(4);
    expect(byId.get(SUBSAMPLE_IDS[2])).toMatchObject({ attempts: 1 });
    // The reason label travels to the row; anything that is not a short snake_case label is dropped.
    expect(byId.get(neverRecovers)!.apiErrorReason).toBe(neverRecovers % 2 === 0 ? 'output_truncated' : null);
    expect(byId.get(recovers)!.apiErrorReason).toBeNull();
  });
});

describe('accuracy-g0 runner: the four-call ceiling holds across --resume (A2.7)', () => {
  // Reviewer scenario (codex, al:d9dff4d8f98c5bc2): the allowance guard stops the
  // run after one failed attempt, it is resumed four times, and the provider
  // would succeed on a fifth call. Before the attempt ledger, the counts lived in
  // memory only: the provider was called 5 times and the row said attempts=1.
  it('makes at most 4 calls for an item over 5 processes, and the row records the real count', async () => {
    const target = SUBSAMPLE_IDS[0];
    state.failFirst.set(target, 4); // calls 1-4 fail; a 5th call would succeed
    state.capAfterCallsThisRun = 1; // each process: one batch, then the guard stops it
    const out = join(dir, 'sub.jsonl');
    const codes: Array<number | null> = [];
    let lastRunCalls = -1;
    codes.push((await run(['--set', 'verify-subsample', '--out', out])).code);
    for (let resume = 1; resume <= 4; resume += 1) {
      const before = state.attemptsById.get(target) ?? 0;
      codes.push((await run(['--set', 'verify-subsample', '--out', out, '--resume'])).code);
      if (resume === 4) lastRunCalls = (state.attemptsById.get(target) ?? 0) - before;
    }
    expect(codes).toEqual([3, 3, 3, 3, 0]);
    expect(state.attemptsById.get(target)).toBe(4);
    expect(lastRunCalls).toBe(0); // the 5th call never happens
    const written = rows(out);
    expect(written).toHaveLength(100);
    expect(written.find((row) => row.id === target)).toMatchObject({ apiError: true, status: 'unverified', attempts: 4, model: null });
    // Every row's attempts equals the calls the provider actually received for it.
    for (const row of written) expect(row.attempts).toBe(state.attemptsById.get(row.id as number));
    const ledger = rows(`${out}.attempts.jsonl`).filter((line) => line.id === target);
    expect(ledger.map((line) => line.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('writes an item whose ledger already holds 4 calls as a failure, without calling it again', async () => {
    const out = join(dir, 'sub.jsonl');
    const target = SUBSAMPLE_IDS[5];
    const earlier = SUBSAMPLE_IDS[0];
    writeFileSync(out, JSON.stringify({ id: earlier, gold: 'true', status: 'supported', apiError: false, parseFallback: false, attempts: 1, model: 'gemini-2.5-flash', engineSha: state.commit, ts: 'x' }) + '\n');
    const ledgerLines = [{ id: earlier, attempt: 1 }, ...[1, 2, 3, 4].map((attempt) => ({ id: target, attempt }))];
    writeFileSync(`${out}.attempts.jsonl`, ledgerLines.map((line) => JSON.stringify({ ...line, ts: 'x' })).join('\n') + '\n');
    const r = await run(['--set', 'verify-subsample', '--out', out, '--resume']);
    expect(r.code).toBe(0);
    expect(state.attemptsById.get(target)).toBeUndefined();
    expect(state.attemptsById.get(earlier)).toBeUndefined();
    const byId = new Map(rows(out).map((row) => [row.id, row]));
    expect(byId.size).toBe(100);
    expect(byId.get(target)).toMatchObject({ apiError: true, attempts: 4, model: null });
  });

  it('refuses a fresh run when an attempt ledger already exists (exit 2, no verify call)', async () => {
    const out = join(dir, 'sub.jsonl');
    writeFileSync(`${out}.attempts.jsonl`, JSON.stringify({ id: SUBSAMPLE_IDS[0], attempt: 1, ts: 'x' }) + '\n');
    const r = await run(['--set', 'verify-subsample', '--out', out]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/attempt ledger exists/);
    expect(state.verifyCalls).toBe(0);
  });

  it('refuses to resume rows that have no attempt ledger (exit 2, no verify call)', async () => {
    const out = join(dir, 'sub.jsonl');
    writeFileSync(out, JSON.stringify({ id: SUBSAMPLE_IDS[0], gold: 'true', status: 'supported', apiError: false, parseFallback: false, attempts: 1, model: 'gemini-2.5-flash', engineSha: state.commit, ts: 'x' }) + '\n');
    const r = await run(['--set', 'verify-subsample', '--out', out, '--resume']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no attempt ledger/);
    expect(state.verifyCalls).toBe(0);
  });

  it('writes one ledger line per call, before the call, matching what the provider received', async () => {
    state.failFirst.set(SUBSAMPLE_IDS[3], 2);
    const out = join(dir, 'sub.jsonl');
    expect((await run(['--set', 'verify-subsample', '--out', out])).code).toBe(0);
    const ledger = rows(`${out}.attempts.jsonl`);
    const calls = [...state.attemptsById.values()].reduce((a, b) => a + b, 0);
    expect(ledger).toHaveLength(calls);
    expect(ledger.filter((line) => line.id === SUBSAMPLE_IDS[3]).map((line) => line.attempt)).toEqual([1, 2, 3]);
  });
});

describe('accuracy-g0 runner: grounding allowance guard (prereg §7)', () => {
  it('stops with exit 3 before a batch that would pass 1,000, then --resume finishes from the next id', async () => {
    state.groundedPrompts = 950; // 950+25 ok, 975+25 = 1000 ok, 1000+25 would pass
    const out = join(dir, 'full.jsonl');
    const first = await run(['--set', 'full', '--out', out]);
    expect(first.code).toBe(3);
    expect(first.out).toMatch(/allowance guard/);
    expect(state.groundedPrompts).toBe(1000);
    expect(rows(out).map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => i));

    state.groundedPrompts = 0; // the next Pacific day
    const resumed = await run(['--set', 'full', '--out', out, '--resume']);
    expect(resumed.code).toBe(0);
    const ids = rows(out).map((row) => row.id);
    expect(ids).toHaveLength(661);
    expect(new Set(ids).size).toBe(661);
    expect(state.attemptsById.get(0)).toBe(1); // not re-sent on resume
    expect(state.attemptsById.get(50)).toBe(1);
    expect(first.out + resumed.out).not.toContain(KEY);
  }, 30_000); // two real runner processes over all 661 items: past the 5 s default under load (timed out at load avg 39, 2026-10-05)

  it('refuses to start when the day is already at the cap (zero verify calls)', async () => {
    state.groundedPrompts = 990;
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(3);
    expect(state.verifyCalls).toBe(0);
  });
});

describe('accuracy-g0 runner: allowance shared with production (--allowance-api, GoPMO 1.18.11.7.18 A0)', () => {
  // A branch engine on the runner spends the same Google key as production, so the daily guard
  // must count both. This fake "production" only answers GET /usage.
  async function fakeProduction(groundedPrompts: number | ((call: number) => number), day = '2026-10-02', extra: Record<string, unknown> = {}): Promise<{ url: string; close: () => Promise<void>; usageCalls: () => number }> {
    let usageCalls = 0;
    const prod = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/usage') {
        usageCalls += 1;
        const count = typeof groundedPrompts === 'function' ? groundedPrompts(usageCalls) : groundedPrompts;
        return send(res, 200, { keyId: 'admin', groundingAllowance: { day, groundedPrompts: count, resetsAt: '2026-10-03T07:00:00.000Z', ...extra } });
      }
      return send(res, 404, { error: 'not found' });
    });
    await new Promise<void>((r) => prod.listen(0, '127.0.0.1', () => r()));
    return {
      url: `http://127.0.0.1:${(prod.address() as AddressInfo).port}`,
      close: () => new Promise<void>((r) => prod.close(() => r())),
      usageCalls: () => usageCalls,
    };
  }

  it('stops with exit 3 when production plus the branch engine plus the production headroom would pass 1,000', async () => {
    const prod = await fakeProduction(860);
    try {
      // headroom 100: batch 1: 860 + 0 + 25 + 100 = 985 runs; batch 2: 860 + 25 + 25 + 100 = 1010 stops
      const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl'), '--allowance-api', prod.url]);
      expect(r.code).toBe(3);
      expect(r.out).toMatch(/allowance guard/);
      expect(state.verifyCalls).toBe(1);
      expect(prod.usageCalls()).toBeGreaterThanOrEqual(2);
      expect(r.out).not.toContain(KEY);
    } finally { await prod.close(); }
  });

  it('runs to completion when the sum stays under 1,000, and logs both counts', async () => {
    const prod = await fakeProduction(100);
    try {
      const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl'), '--allowance-api', prod.url]);
      expect(r.code).toBe(0);
      expect(rows(join(dir, 'sub.jsonl'))).toHaveLength(100);
      expect(r.out).toMatch(/allowance \d+\/1000 on 2026-10-02 \(\d+ \+ 100\)/);
    } finally { await prod.close(); }
  });

  it('stops before any verify call when the two engines report different allowance days', async () => {
    const prod = await fakeProduction(0, '2026-10-03');
    try {
      const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl'), '--allowance-api', prod.url]);
      expect(r.code).toBe(3);
      expect(r.out).toMatch(/different allowance days/);
      expect(state.verifyCalls).toBe(0);
    } finally { await prod.close(); }
  });

  it('leaves 100 prompts of headroom for production: 880 in production stops before the first batch', async () => {
    const prod = await fakeProduction(880);
    try {
      const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl'), '--allowance-api', prod.url]);
      expect(r.code).toBe(3);
      expect(r.out).toMatch(/production headroom 100/);
      expect(state.verifyCalls).toBe(0);
    } finally { await prod.close(); }
  });

  it('stops (exit 1, no verify call) on a count it cannot trust: negative, or with ledger write failures', async () => {
    for (const prod of [await fakeProduction(-1000), await fakeProduction(0, '2026-10-02', { ledgerWriteFailures: 2 })]) {
      try {
        state.verifyCalls = 0;
        const r = await run(['--set', 'verify-subsample', '--out', join(dir, `sub-${Math.random()}.jsonl`), '--allowance-api', prod.url]);
        expect(r.code).toBe(1);
        expect(state.verifyCalls).toBe(0);
      } finally { await prod.close(); }
    }
  });

  it('stops (exit 1) when production reports a lower count than before on the same day: its counter was reset', async () => {
    const prod = await fakeProduction((call) => (call === 1 ? 500 : 0));
    try {
      const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl'), '--allowance-api', prod.url]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/counter was reset/);
      expect(state.verifyCalls).toBe(1);
    } finally { await prod.close(); }
  });

  it('branch mode stops (exit 1) instead of re-sending a batch that did not answer', async () => {
    const prod = await fakeProduction(0);
    try {
      state.dropVerifyOnce = true;
      const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl'), '--allowance-api', prod.url]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/did not answer/);
      expect(state.verifyCalls).toBe(1);
    } finally { await prod.close(); }
  });

  it('deployed mode still retries a batch that did not answer (prereg section 6)', async () => {
    state.dropVerifyOnce = true;
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(0);
    expect(rows(join(dir, 'sub.jsonl'))).toHaveLength(100);
    expect(state.verifyCalls).toBe(5);
  });

  it('deployed mode (no flag) keeps the original check: write failures on its own /usage do not stop it', async () => {
    state.usageExtra = { ledgerWriteFailures: 1 };
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(0);
    expect(rows(join(dir, 'sub.jsonl'))).toHaveLength(100);
  });

  it('without the flag, production is not consulted (the existing single-engine guard)', async () => {
    state.groundedPrompts = 960;
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(3);
    expect(state.verifyCalls).toBe(1);
  });
});

describe('accuracy-g0 runner: invalid-run checks (prereg §5)', () => {
  it('stops with exit 4 when the engine model changes mid-run', async () => {
    state.model = (call) => (call === 1 ? 'gemini-2.5-flash' : 'gemini-3.0-pro');
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/model changed .*gemini-2\.5-flash -> gemini-3\.0-pro/);
  });

  it('stops with exit 4 when the engine commit changes mid-run', async () => {
    const out = join(dir, 'sub.jsonl');
    let healthCalls = 0;
    const original = state.commit;
    Object.defineProperty(state, 'commit', {
      get: () => (healthCalls++ < 3 ? original : 'ffffffffffffffffffffffffffffffffffffffff'),
      configurable: true,
    });
    const r = await run(['--set', 'verify-subsample', '--out', out]);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/engine changed during the run/);
    expect(rows(out).length).toBeGreaterThan(0);
    expect(rows(out).length).toBeLessThan(100);
  });

  it('refuses to resume a file written by a different engine commit (exit 4)', async () => {
    const out = join(dir, 'sub.jsonl');
    writeFileSync(out, JSON.stringify({ id: SUBSAMPLE_IDS[0], gold: 'true', status: 'supported', apiError: false, parseFallback: false, attempts: 1, model: 'gemini-2.5-flash', engineSha: '1111111', ts: 'x' }) + '\n');
    const r = await run(['--set', 'verify-subsample', '--out', out, '--resume']);
    expect(r.code).toBe(4);
    expect(state.verifyCalls).toBe(0);
  });

  it('stops with exit 5 on the provider-spend cap, writing nothing', async () => {
    state.verifyStatus = 503;
    state.verifyBody = { error: 'Monthly provider budget exhausted. Scanning is paused until the budget resets.' };
    const out = join(dir, 'sub.jsonl');
    const r = await run(['--set', 'verify-subsample', '--out', out]);
    expect(r.code).toBe(5);
    expect(rows(out)).toHaveLength(0);
  });
});

describe('accuracy-g0 runner: the measurement key', () => {
  const MEASUREMENT = ['runner', 'MEASUREKEY', 'must-never-print', '7171'].join('-');

  it('sends FAULTLINE_MEASUREMENT_KEY over the admin key when both are set, prints no warning and never the key', async () => {
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')], { FAULTLINE_MEASUREMENT_KEY: MEASUREMENT, FAULTLINE_ADMIN_KEY: KEY });
    expect(r.code).toBe(0);
    expect(state.requests).toBeGreaterThan(0);
    expect(state.seenKeys).toEqual(new Set([MEASUREMENT]));
    expect(r.out).not.toMatch(/not labelled/);
    expect(r.out).not.toContain(MEASUREMENT);
    expect(r.out).not.toContain('MEASUREKEY');
  });

  it('reads GET /health with no key header at all, and sends the key on every other request', async () => {
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')], { FAULTLINE_MEASUREMENT_KEY: MEASUREMENT });
    expect(r.code).toBe(0);
    expect(state.healthKeyHeaders.length).toBeGreaterThan(0);
    expect(state.healthKeyHeaders.every((h) => h === '')).toBe(true);
    expect(state.seenKeys).toEqual(new Set([MEASUREMENT]));
  });

  it('reads the key from ~/.config/faultline/measurement-key.env', async () => {
    mkdirSync(join(dir, '.config/faultline'), { recursive: true });
    writeFileSync(join(dir, '.config/faultline/measurement-key.env'), `# measurement\nFAULTLINE_MEASUREMENT_KEY=${MEASUREMENT}\n`);
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(0);
    expect(state.seenKeys).toEqual(new Set([MEASUREMENT]));
    expect(r.out).not.toMatch(/not labelled/);
    expect(r.out).not.toContain(MEASUREMENT);
  });

  it('an empty FAULTLINE_MEASUREMENT_KEY falls back to the admin key with the unlabelled warning', async () => {
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')], { FAULTLINE_MEASUREMENT_KEY: '', FAULTLINE_ADMIN_KEY: KEY });
    expect(r.code).toBe(0);
    expect(state.seenKeys).toEqual(new Set([KEY]));
    expect(r.out).toMatch(/WARNING: no measurement key .* not labelled/);
    expect(r.out).not.toContain(KEY);
  });
});

describe('accuracy-g0 runner: the admin key', () => {
  it('reads the key from ~/.config/faultline/hosted-api-key.env, sends it, and never prints it', async () => {
    mkdirSync(join(dir, '.config/faultline'), { recursive: true });
    writeFileSync(join(dir, '.config/faultline/hosted-api-key.env'), `# hosted\nFAULTLINE_API_KEY=${KEY}\n`);
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')], {});
    expect(r.code).toBe(0);
    expect(state.seenKeys).toEqual(new Set([KEY]));
    expect(r.out.length).toBeGreaterThan(0);
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain('ADMINKEY');
  });
});

// Validates: measurement key separation (CHANGELOG [Unreleased]): the G0 runner starts with the measurement key
describe('accuracy-g0 runner: against the real API server with the measurement key', () => {
  const MEASUREMENT = ['real', 'measure', 'part', String(process.pid)].join('-');
  const ADMIN = ['real', 'admin', 'part', String(process.pid)].join('-');
  const ENGINE_COMMIT = '4de048a1b2c3d4e5f60718293a4b5c6d7e8f9012';
  const ENV_KEYS = [
    'FAULTLINE_API_KEY', 'FAULTLINE_MEASUREMENT_KEY', 'GEMINI_API_KEY', 'FAULTLINE_GIT_SHA',
    'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP',
    'FAULTLINE_PROVIDER_SPEND_CAP_USD', 'FAULTLINE_CUSTOMER_KEYS', 'FAULTLINE_GRAPHQL',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reads /health with no key (200) and reaches POST /admin/verify-claims with the measurement key', async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    process.env.FAULTLINE_MEASUREMENT_KEY = MEASUREMENT;
    process.env.GEMINI_API_KEY = ['test', 'gemini'].join('-');
    process.env.FAULTLINE_GIT_SHA = ENGINE_COMMIT;
    process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
    process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
    const { resetGroundingAllowanceLedger } = await import('../src/store/grounding-allowance.js');
    const { resetProviderSpendLedger } = await import('../src/store/provider-spend.js');
    const { resetKeyStore } = await import('../src/store/keys.js');
    const { resetRateLimiter } = await import('../src/store/ratelimit.js');
    resetGroundingAllowanceLedger();
    resetProviderSpendLedger();
    resetKeyStore();
    resetRateLimiter();
    const { buildServer } = await import('../src/server.js');
    const app = buildServer();
    const seen: Array<{ method: string; url: string; key: string; authorization: string; status: number }> = [];
    app.addHook('onResponse', async (request, reply) => {
      seen.push({
        method: request.method,
        url: request.url,
        key: String(request.headers['x-api-key'] ?? ''),
        authorization: String(request.headers.authorization ?? ''),
        status: reply.statusCode,
      });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const realApi = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const out = join(dir, 'real.jsonl');
      const r = await new Promise<RunResult>((resolvePromise) => {
        const child = spawn(process.execPath, [SCRIPT, '--api', realApi, '--retry-base-ms', '1', '--set', 'verify-subsample', '--out', out], {
          env: { PATH: process.env.PATH ?? '', HOME: dir, FAULTLINE_MEASUREMENT_KEY: MEASUREMENT },
        });
        let text = '';
        child.stdout.on('data', (d) => { text += d; });
        child.stderr.on('data', (d) => { text += d; });
        child.on('close', (code) => resolvePromise({ code, out: text }));
      });

      const health = seen.filter((e) => e.method === 'GET' && e.url === '/health');
      expect(health.length).toBeGreaterThan(0);
      expect(health.every((e) => e.status === 200 && e.key === '' && e.authorization === '')).toBe(true);

      const verifies = seen.filter((e) => e.method === 'POST' && e.url === '/admin/verify-claims');
      expect(verifies.length).toBeGreaterThan(0);
      expect(verifies.every((e) => e.key === MEASUREMENT && e.status === 200)).toBe(true);
      expect(seen.some((e) => e.status === 403)).toBe(false);

      expect(r.code).toBe(0);
      const written = rows(out);
      expect(written).toHaveLength(SUBSAMPLE_IDS.length);
      expect(written.every((row) => row.engineSha === ENGINE_COMMIT)).toBe(true);
      expect(r.out).not.toContain(MEASUREMENT);
    } finally {
      await app.close();
      resetGroundingAllowanceLedger();
      resetProviderSpendLedger();
    }
  }, 60_000);
});

describe('accuracy-g0 runner: grounding arms and a seeded subsample (GoPMO 1.18.11.7.22 grounding provider)', () => {
  it('a not-checkable answer is written as notCheckable, not retried, and its share is in the arm summary', async () => {
    state.notCheckableEvenOnParallel = true;
    const out = join(dir, 'nc.jsonl');
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '20', '--seed', '7', '--out', out]);
    expect(r.code).toBe(0);
    const written = rows(out);
    expect(written).toHaveLength(20);
    const flagged = written.filter((row) => row.notCheckable === true);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((row) => Number(row.id) % 2 === 0 && row.status === 'unverified' && row.apiError === false && row.attempts === 1)).toBe(true);
    expect(written.filter((row) => Number(row.id) % 2 !== 0).every((row) => row.notCheckable === false)).toBe(true);
    const summaryPath = join(dir, 'nc.summary.json');
    expect(existsSync(summaryPath) || /arm summary was not written/.test(r.out)).toBe(true);
    if (existsSync(summaryPath)) {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      expect(summary.arms.parallel.not_checkable_rate).toBeCloseTo(flagged.length / 20, 10);
    }
  });

  it('--arm both --sample 20 --seed 7: the same 20 items on each arm, one file per arm, the arm sent to the route', async () => {
    const out = join(dir, 'arms.jsonl');
    const r = await run(['--set', 'full', '--arm', 'both', '--sample', '20', '--seed', '7', '--out', out]);
    expect(r.code).toBe(0);
    const google = rows(join(dir, 'arms.google.jsonl'));
    const parallel = rows(join(dir, 'arms.parallel.jsonl'));
    expect(google.length).toBeGreaterThan(0);
    expect(google).toHaveLength(20);
    expect(parallel).toHaveLength(20);
    expect(parallel.map((row) => row.id)).toEqual(google.map((row) => row.id));
    expect(new Set(google.map((row) => row.arm))).toEqual(new Set(['google']));
    expect(new Set(parallel.map((row) => row.arm))).toEqual(new Set(['parallel']));
    expect(parallel[0]).toMatchObject({ verdict: parallel[0].status, sourcesCount: 5, costUsd: 0.00508, googleGroundingCalls: 0 });
    expect(google[0]).toMatchObject({ sourcesCount: 2, costUsd: 0.03508, googleGroundingCalls: 1 });
    expect(new Set(state.arms!.map((a) => JSON.stringify(a)))).toEqual(new Set([
      JSON.stringify({ grounding: 'google' }), JSON.stringify({ grounding: 'parallel', parallelMode: 'advanced' }),
    ]));
    // The summary comes from the scorer; with no python3/numpy the run says how to write it.
    expect(existsSync(join(dir, 'arms.summary.json')) || /arm summary was not written/.test(r.out)).toBe(true);
    if (existsSync(join(dir, 'arms.summary.json'))) {
      const summary = JSON.parse(readFileSync(join(dir, 'arms.summary.json'), 'utf8'));
      expect(Object.keys(summary.arms).sort()).toEqual(['google', 'parallel']);
      expect(summary.arms.parallel.google_grounded_calls).toBe(0);
      expect(summary.arms.google.google_grounded_calls).toBe(20);
      expect(summary.ba_difference['parallel - google'].resamples).toBe(2000);
    }
    expect(r.out).not.toContain(KEY);
  });

  it('the same seed picks the same items; another seed picks others', async () => {
    const a = await run(['--set', 'full', '--arm', 'parallel-fast', '--sample', '15', '--seed', '3', '--out', join(dir, 'a.jsonl')]);
    const b = await run(['--set', 'full', '--arm', 'parallel-fast', '--sample', '15', '--seed', '3', '--out', join(dir, 'b.jsonl')]);
    const c = await run(['--set', 'full', '--arm', 'parallel-fast', '--sample', '15', '--seed', '4', '--out', join(dir, 'c.jsonl')]);
    expect([a.code, b.code, c.code]).toEqual([0, 0, 0]);
    const ids = (f: string) => rows(join(dir, f)).map((row) => row.id);
    expect(ids('a.jsonl').length).toBeGreaterThan(0);
    expect(ids('a.jsonl')).toHaveLength(15);
    expect(ids('b.jsonl')).toEqual(ids('a.jsonl'));
    expect(ids('c.jsonl')).not.toEqual(ids('a.jsonl'));
    expect(state.arms!.every((arm) => arm.grounding === 'parallel' && arm.parallelMode === 'fast')).toBe(true);
  });

  it('--resume keeps the cost and Google calls of attempts made before the stop', async () => {
    // Codex review of the grounding PR, finding 1: the spend map reset on every process.
    const out = join(dir, 'g.jsonl');
    const first = await run(['--set', 'full', '--arm', 'google', '--sample', '2', '--seed', '7', '--out', out]);
    expect(first.code).toBe(0);
    const ids = rows(out).map((row) => row.id);
    expect(ids).toHaveLength(2);
    // A second, failing-then-stopped run on a fresh file: one spent failure, then the allowance stop.
    const out2 = join(dir, 'g2.jsonl');
    state.failFirst.set(ids[0] as number, 1);
    state.failUsage = { costUsd: 0.0351, googleGroundingCalls: 1 };
    state.attemptsById.clear();
    state.capAfterCallsThisRun = 1;
    const stopped = await run(['--set', 'full', '--arm', 'google', '--sample', '2', '--seed', '7', '--out', out2]);
    expect(stopped.code).toBe(3);
    state.capAfterCallsThisRun = undefined;
    state.groundedPrompts = 0;
    const resumed = await run(['--set', 'full', '--arm', 'google', '--sample', '2', '--seed', '7', '--out', out2, '--resume']);
    expect(resumed.code).toBe(0);
    const row = rows(out2).find((r) => r.id === ids[0])!;
    expect(row).toMatchObject({ apiError: false, attempts: 2, googleGroundingCalls: 2 });
    expect(row.costUsd).toBeCloseTo(0.0351 + 0.03508, 6);
  }, 30_000);

  it('--resume keeps the spend of an item that used all its calls before the stop', async () => {
    // Codex round 2 on the grounding PR: closeExhausted wrote such an item at 0 cost.
    const out = join(dir, 'ex.jsonl');
    const id = 4; // the one item --sample 1 --seed 19 picks from the full set
    writeFileSync(`${out}.attempts.jsonl`, [1, 2, 3, 4].map((attempt) => JSON.stringify({ id, attempt, ts: 't' })).join('\n') + '\n');
    writeFileSync(`${out}.spend.jsonl`, [1, 2, 3, 4].map((attempt) => JSON.stringify({ id, arm: 'google', attempt, costUsd: 0.04, googleGroundingCalls: 1 })).join('\n') + '\n');
    writeFileSync(out, '');
    const before = state.verifyCalls;
    const r = await run(['--set', 'full', '--arm', 'google', '--sample', '1', '--seed', '19', '--out', out, '--resume']);
    expect(r.code).toBe(0);
    const written = rows(out);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ id, attempts: 4, apiError: true, googleGroundingCalls: 4 });
    expect(written[0].costUsd).toBeCloseTo(0.16, 6);
    expect(state.verifyCalls).toBe(before); // no fifth call
  }, 30_000);

  it('a fresh run refuses a leftover spend ledger (exit 2, no verify call)', async () => {
    // Codex round 3 on the grounding PR: a stale spend ledger was summed into a fresh run.
    const out = join(dir, 'stale.jsonl');
    writeFileSync(`${out}.spend.jsonl`, JSON.stringify({ id: 4, arm: 'google', attempt: 1, costUsd: 0.007, googleGroundingCalls: 1 }) + '\n');
    const before = state.verifyCalls;
    const r = await run(['--set', 'full', '--arm', 'google', '--sample', '1', '--seed', '19', '--out', out]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/spend ledger exists; pass --resume/);
    expect(state.verifyCalls).toBe(before);
  });

  it('a stop after a paid answer keeps its spend, and the other arm cannot resume that file', async () => {
    // Opus seat on the grounding PR: an engine that ignores the arm answers 200 and is paid,
    // then the arm check stops the run; the spend must be on record, and a google resume refused.
    state.ranGrounding = 'google';
    const out = join(dir, 'ignored.jsonl');
    const stopped = await run(['--set', 'full', '--arm', 'parallel', '--sample', '3', '--seed', '1', '--out', out]);
    expect(stopped.code).toBe(1);
    const spend = rows(`${out}.spend.jsonl`);
    expect(spend).toHaveLength(3);
    expect(spend.every((row) => row.arm === 'parallel' && row.googleGroundingCalls === 0)).toBe(true);
    expect(rows(`${out}.attempts.jsonl`).every((row) => row.arm === 'parallel')).toBe(true);
    const before = state.verifyCalls;
    const resumed = await run(['--set', 'full', '--arm', 'google', '--sample', '3', '--seed', '1', '--out', out, '--resume']);
    expect(resumed.code).toBe(2);
    expect(resumed.out).toMatch(/holds arm parallel, not google/);
    expect(state.verifyCalls).toBe(before);
    // The attempt ledger refuses on its own, without the spend ledger's help.
    rmSync(`${out}.spend.jsonl`);
    const again = await run(['--set', 'full', '--arm', 'google', '--sample', '3', '--seed', '1', '--out', out, '--resume']);
    expect(again.code).toBe(2);
    expect(again.out).toMatch(/attempt ledger .* holds arm parallel, not google/);
    expect(state.verifyCalls).toBe(before);
  }, 30_000);

  it('--resume refuses an out file written by another arm (exit 2, no verify call)', async () => {
    // Codex review of the grounding PR, finding 2: google rows satisfied a parallel resume.
    const out = join(dir, 'mixed.jsonl');
    const first = await run(['--set', 'full', '--arm', 'google', '--sample', '2', '--seed', '7', '--out', out]);
    expect(first.code).toBe(0);
    expect(rows(out)).toHaveLength(2);
    const before = state.verifyCalls;
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '2', '--seed', '7', '--out', out, '--resume']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/holds rows from arm google, not parallel/);
    expect(state.verifyCalls).toBe(before);
  });

  it('stops when the engine ran another grounding than the arm asked for', async () => {
    state.ranGrounding = 'google';
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '5', '--seed', '1', '--out', join(dir, 'p.jsonl')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/asked for the parallel arm, the engine ran google grounding/);
    expect(rows(join(dir, 'p.jsonl'))).toHaveLength(0);
  });

  it.each([
    [['--arm', 'bing'], /--arm must be/],
    [['--sample', '5'], /--sample and --seed go together/],
    [['--sample', '0', '--seed', '1'], /--sample must be/],
    [['--sample', '5', '--seed', '-1'], /--seed must be/],
  ])('refuses %j before anything is sent', async (args, message) => {
    const r = await run(['--set', 'full', ...args, '--out', join(dir, 'x.jsonl')]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(message);
    expect(state.requests).toBe(0);
  });
});

// Validates: GoPMO 1.18.11.7.127 (judge model A/B pre-registration, docs/research/2026-11-14-prereg-judge-model-ab-v1.md sections 2, 5, 9)
describe('accuracy-g0 runner: judge model A/B options', () => {
  it('--label names the arm in every row, and rows carry tokens, Parallel calls and the judge model', async () => {
    state.judgeModel = () => 'gemini-3.5-flash-lite';
    state.tokens = { inputTokens: 1200, outputTokens: 300 };
    const out = join(dir, 'lite.jsonl');
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '6', '--seed', '7', '--out', out,
      '--label', 'judge-3.5-flash-lite', '--judge-model', 'gemini-3.5-flash-lite']);
    expect(r.code).toBe(0);
    const written = rows(out);
    expect(written).toHaveLength(6);
    for (const row of written) {
      expect(row.arm).toBe('judge-3.5-flash-lite');
      expect(row.grounding).toBe('parallel');
      expect(row.judgeModel).toBe('gemini-3.5-flash-lite');
      expect(row.inputTokens).toBe(1200);
      expect(row.outputTokens).toBe(300);
      expect(row.parallelCalls).toBe(1);
    }
    // The scorer reads the label as the arm name.
    const summary = JSON.parse(readFileSync(join(dir, 'lite.summary.json'), 'utf8'));
    expect(Object.keys(summary.arms ?? summary)).toContain('judge-3.5-flash-lite');
  });

  it('a resumed labelled run is not refused as another arm', async () => {
    state.judgeModel = () => 'gemini-2.5-flash';
    const out = join(dir, 'a.jsonl');
    const args = ['--set', 'full', '--arm', 'parallel', '--sample', '30', '--seed', '7', '--out', out, '--label', 'judge-a'];
    state.capAfterCallsThisRun = 1;
    const first = await run(args);
    expect(first.code).toBe(3);
    expect(rows(out).length).toBeGreaterThan(0);
    state.capAfterCallsThisRun = undefined;
    const second = await run([...args, '--resume']);
    expect(second.code).toBe(0);
    expect(rows(out)).toHaveLength(30);
  });

  it('--judge-model stops the run as invalid (exit 4) when a verdict names another model', async () => {
    state.judgeModel = (id) => (id % 2 === 0 ? 'gemini-2.5-flash' : 'gemini-3.5-flash-lite');
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '6', '--seed', '7', '--out', join(dir, 'x.jsonl'),
      '--label', 'judge-lite', '--judge-model', 'gemini-3.5-flash-lite']);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/was judged by gemini-2\.5-flash, not gemini-3\.5-flash-lite/);
  });

  it('the list-price guard stops the arm (exit 5) after 25 claims when the projection passes the cap', async () => {
    state.judgeModel = () => 'gemini-3.1-pro-preview';
    // 10,000 in and 10,000 out at 2 / 12 USD per million is 0.14 USD, plus 0.005 for the search.
    state.tokens = { inputTokens: 10_000, outputTokens: 10_000 };
    const out = join(dir, 'pro.jsonl');
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '40', '--seed', '7', '--out', out,
      '--label', 'judge-pro', '--judge-model', 'gemini-3.1-pro-preview', '--price-in', '2', '--price-out', '12', '--cap-usd', '5']);
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/projected 5\.8000 USD at list price passes the 5 USD cap/);
    const written = rows(out).length;
    expect(written).toBeGreaterThanOrEqual(25);
    expect(written).toBeLessThan(40);
  });

  it('the guard lets an arm under the cap finish', async () => {
    state.tokens = { inputTokens: 1000, outputTokens: 100 };
    const r = await run(['--set', 'full', '--arm', 'parallel', '--sample', '30', '--seed', '7', '--out', join(dir, 'ok.jsonl'),
      '--price-in', '0.3', '--price-out', '2.5', '--cap-usd', '5']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/list-price projection: 0\.1665 USD for 30 claims/);
  });

  it('refuses the price flags apart, and a label with --arm both', async () => {
    const a = await run(['--set', 'full', '--arm', 'parallel', '--price-in', '1']);
    expect(a.code).not.toBe(0);
    expect(a.out).toMatch(/go together/);
    const b = await run(['--set', 'full', '--arm', 'both', '--label', 'x']);
    expect(b.out).toMatch(/does not go with --arm both/);
    expect(state.verifyCalls).toBe(0);
  });
});
