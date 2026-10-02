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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/accuracy-g0.mjs');
const GOLD = join(REPO_ROOT, 'docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl');
const SUBSAMPLE_IDS: number[] = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/research/data/accuracy-g0-verify-subsample-ids.json'), 'utf8'),
).ids;
const KEY = ['runner', 'ADMINKEY', 'must-never-print', '4242'].join('-');

interface FakeState {
  groundedPrompts: number;
  commit: string | null;
  version: string;
  model: (call: number) => string;
  /** id → number of leading attempts answered with apiError (Infinity = always). */
  failFirst: Map<number, number>;
  verifyCalls: number;
  requests: number;
  seenKeys: Set<string>;
  attemptsById: Map<number, number>;
  verifyStatus: number;
  verifyBody?: unknown;
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
    attemptsById: new Map(),
    verifyStatus: 200,
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
  state.seenKeys.add(String(req.headers['x-api-key'] ?? ''));
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { status: 'ok', version: state.version, commit: state.commit });
  }
  if (req.method === 'GET' && req.url === '/usage') {
    return send(res, 200, {
      keyId: 'admin',
      groundingAllowance: { day: '2026-10-02', groundedPrompts: state.groundedPrompts, resetsAt: '2026-10-03T07:00:00.000Z' },
    });
  }
  if (req.method === 'POST' && req.url === '/admin/verify-claims') {
    state.verifyCalls += 1;
    if (state.verifyStatus !== 200) return send(res, state.verifyStatus, state.verifyBody ?? {});
    const { claims } = JSON.parse(await readBody(req)) as { claims: Array<{ id: string; text: string }> };
    const results = claims.map(({ id }) => {
      const n = Number(id);
      const attempt = (state.attemptsById.get(n) ?? 0) + 1;
      state.attemptsById.set(n, attempt);
      const fail = attempt <= (state.failFirst.get(n) ?? 0);
      if (!fail) state.groundedPrompts += 1;
      return fail
        ? { id, status: 'unverified', apiError: true, parseFallback: false, model: null }
        : { id, status: n % 3 === 0 ? 'contradicted' : 'supported', apiError: false, parseFallback: n % 7 === 0, model: state.model(state.verifyCalls) };
    });
    return send(res, 200, { provider: 'gemini', results });
  }
  return send(res, 404, { error: 'not found' });
}

interface RunResult { code: number | null; out: string }

function run(args: string[], env: Record<string, string> = { FAULTLINE_ADMIN_KEY: KEY }): Promise<RunResult> {
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

  it('refuses with no admin key anywhere (exit 2, zero requests)', async () => {
    const r = await run(['--set', 'full', '--out', join(dir, 'out.jsonl')], {});
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no admin key/);
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
      ['apiError', 'attempts', 'engineSha', 'gold', 'id', 'model', 'parseFallback', 'status', 'ts'],
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
  });

  it('refuses to start when the day is already at the cap (zero verify calls)', async () => {
    state.groundedPrompts = 990;
    const r = await run(['--set', 'verify-subsample', '--out', join(dir, 'sub.jsonl')]);
    expect(r.code).toBe(3);
    expect(state.verifyCalls).toBe(0);
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
