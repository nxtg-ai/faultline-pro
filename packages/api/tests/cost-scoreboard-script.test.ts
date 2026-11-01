/**
 * scripts/cost-scoreboard.mjs with a stubbed fetch: no network, no key on disk.
 * The key is a sentinel; no output, written file or log line may contain it.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_API, EXIT, costPerBilledClaim, parseArgs, readAdminKey, run, summaryLine, summaryUrl,
} from '../../../scripts/cost-scoreboard.mjs';

const KEY = ['scoreboard', 'ADMINKEY', 'never-print'].join('-');

const SUMMARY = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  generatedAt: '2026-10-28T00:00:00.000Z',
  classes: {
    customer: { costUsd: 1.5, calls: 10, claimsHandled: 40, billableClaims: 30 },
    internal: { costUsd: 2, calls: 3, claimsHandled: 9, billableClaims: 6 },
    measurement: { costUsd: 0, calls: 0, claimsHandled: 0, billableClaims: 0 },
    anonymous: { costUsd: 0, calls: 0, claimsHandled: 0, billableClaims: 0 },
    unlabelled: { costUsd: 0.4, calls: 2, claimsHandled: 3, billableClaims: 1 },
  },
  customerBilledClaims: 25,
  customerUnbilledClaims: 15,
  notes: ['n'],
};

function stub(status = 200, body: unknown = SUMMARY) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string> } }> = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, init });
    return { status, ok: status < 400, json: async () => body };
  };
  return { fetch, calls };
}

function harness() {
  const out: string[] = [];
  const errs: string[] = [];
  const written: Array<{ file: string; text: string }> = [];
  return {
    out, errs, written,
    deps: {
      log: (l: string) => out.push(l),
      err: (l: string) => errs.push(l),
      writeFile: (file: string, text: string) => written.push({ file, text }),
    },
  };
}

describe('cost-scoreboard.mjs', () => {
  it('calls GET /admin/cost-summary with the key as x-api-key, writes the JSON, prints one line', async () => {
    const api = stub();
    const h = harness();
    const code = await run(['--out', 'week.json', '--from', '2026-10-19T00:00:00Z', '--to', '2026-10-26T00:00:00Z'], { ...h.deps, key: KEY, fetch: api.fetch });
    expect(code).toBe(EXIT.OK);
    expect(api.calls).toHaveLength(1);
    const url = new URL(api.calls[0].url);
    expect(url.origin + url.pathname).toBe(`${DEFAULT_API}/admin/cost-summary`);
    expect(url.searchParams.get('from')).toBe('2026-10-19T00:00:00Z');
    expect(url.searchParams.get('to')).toBe('2026-10-26T00:00:00Z');
    expect(api.calls[0].init.method).toBe('GET');
    expect(api.calls[0].init.headers['x-api-key']).toBe(KEY);
    expect(h.written).toHaveLength(1);
    expect(h.written[0].file.endsWith('week.json')).toBe(true);
    expect(JSON.parse(h.written[0].text)).toEqual(SUMMARY);
    expect(h.out).toEqual([
      'cost-scoreboard 2026-10-19T00:00:00.000Z to 2026-10-26T00:00:00.000Z: cost per billed customer claim $0.0600 (customer cost $1.5000, billed claims 25)',
    ]);
  });

  it('never prints or writes the key', async () => {
    const h = harness();
    await run(['--out', 'w.json'], { ...h.deps, key: KEY, fetch: stub().fetch });
    await run(['--out', 'w.json'], { ...h.deps, key: KEY, fetch: stub(403, { error: 'Forbidden' }).fetch });
    await run(['--out', 'w.json'], { ...h.deps, key: KEY, fetch: async () => { throw new Error(`boom ${KEY}`); } });
    const everything = [...h.out, ...h.errs, ...h.written.map((w) => w.text)].join('\n');
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain(KEY);
  });

  it('prints n/a when no customer claim was billed', async () => {
    const h = harness();
    const code = await run(['--out', 'w.json'], { ...h.deps, key: KEY, fetch: stub(200, { ...SUMMARY, customerBilledClaims: 0 }).fetch });
    expect(code).toBe(EXIT.OK);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain('cost per billed customer claim n/a');
  });

  it('with no --from/--to it sends no window, so the API picks the last complete week', () => {
    const url = new URL(summaryUrl(parseArgs(['--out', 'x.json'])));
    expect([...url.searchParams.keys()]).toEqual([]);
    expect(summaryUrl(parseArgs(['--out', 'x.json', '--api', 'http://localhost:3010']))).toBe('http://localhost:3010/admin/cost-summary');
  });

  it('a non-2xx answer exits 1 and writes nothing', async () => {
    const h = harness();
    const code = await run(['--out', 'w.json'], { ...h.deps, key: KEY, fetch: stub(403, { error: 'Forbidden' }).fetch });
    expect(code).toBe(EXIT.ERROR);
    expect(h.written).toHaveLength(0);
    expect(h.errs).toEqual(['cost-scoreboard: GET /admin/cost-summary answered HTTP 403']);
  });

  it('no --out, an unknown flag, or no key exits 2 before any request', async () => {
    const api = stub();
    const h = harness();
    expect(await run([], { ...h.deps, key: KEY, fetch: api.fetch })).toBe(EXIT.USAGE);
    expect(await run(['--out', 'w.json', '--bogus', '1'], { ...h.deps, key: KEY, fetch: api.fetch })).toBe(EXIT.USAGE);
    expect(await run(['--out', 'w.json'], { ...h.deps, env: {}, keyFile: '/nonexistent/hosted-api-key.env', fetch: api.fetch })).toBe(EXIT.USAGE);
    expect(api.calls).toHaveLength(0);
  });

  it('reads the key from FAULTLINE_API_KEY first, then the key file line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-scoreboard-'));
    try {
      const file = join(dir, 'hosted-api-key.env');
      writeFileSync(file, `# hosted\nexport FAULTLINE_API_KEY="${KEY}"\n`);
      expect(readAdminKey({}, file)).toBe(KEY);
      expect(readAdminKey({ FAULTLINE_API_KEY: 'from-env' }, file)).toBe('from-env');
      expect(readAdminKey({}, join(dir, 'missing.env'))).toBe('');
      expect(readFileSync(file, 'utf8')).toContain('FAULTLINE_API_KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('costPerBilledClaim and summaryLine', () => {
    expect(costPerBilledClaim(SUMMARY)).toBeCloseTo(0.06, 10);
    expect(costPerBilledClaim({ ...SUMMARY, customerBilledClaims: 0 })).toBeNull();
    expect(summaryLine({ ...SUMMARY, customerBilledClaims: 0 })).toContain('n/a');
  });
});
