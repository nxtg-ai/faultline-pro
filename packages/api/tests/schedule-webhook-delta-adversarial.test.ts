/**
 * Delta seat (transcript-blind Opus, CLX9) on 43264e7..231adeb, adopted into the suite (emma-soul al:9be00e6659a44221).
 * Exercises the new schedule.webhookUrl delivery in schedules.ts with the
 * test-only private override OFF, so the production guard path runs.
 * No live network: DNS is injected; sockets only reach loopback listeners.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resetBlockedAddressPolicy, resetOutboundFetch, resetOutboundResolver,
  setBlockedAddressPolicy, setOutboundFetch, setOutboundResolver, type ResolvedAddress,
} from '../src/lib/outbound-url.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getScheduleStore, getScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';
import { resetNotificationStore } from '../src/store/notifications.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));

const CLAIM = 'The Eiffel Tower was completed in 1889.';
const EXPL = 'Multiple sources confirm completion in March 1889.';
const GURI = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf';
const PLAIN = {
  input: CLAIM, provider: 'mock', overallRisk: 'low',
  claims: [{ id: 'c1', text: CLAIM, type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: EXPL, sources: [] } },
};
const GROUNDED_OPENAI_LABEL = {
  ...PLAIN, provider: 'openai',
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPL, sources: [{ title: 't', uri: GURI }],
    provenance: { provider: 'gemini', retriever: 'gemini-grounding' } } },
};
const SUGGESTIONS_ONLY = { ...PLAIN, provider: 'openai',
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: EXPL, sources: [], searchEntryPoint: { renderedContent: '<div>Search Suggestions</div>' } } } };

interface Seen { url: string; body: string }
let seen: Seen[];

beforeEach(async () => {
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resetKeyStore?.(); resetScheduleStore(); resetNotificationStore?.();
  seen = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  const { scan } = await import('@nxtg/faultline/cli/scan.js');
  vi.mocked(scan).mockReset().mockResolvedValue(PLAIN as never);
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  resetOutboundFetch(); resetOutboundResolver(); resetBlockedAddressPolicy();
  delete process.env.FAULTLINE_API_KEY;
});

function spySeam(): void {
  setOutboundFetch(async (url, init) => { seen.push({ url, body: String(init.body) }); return new Response(null, { status: 200 }); });
}
function sched(webhookUrl: string, keyId: string) {
  return getScheduleStore().create({ name: 'n', cron: '0 9 * * *', text: CLAIM, webhookUrl } as never, keyId);
}

describe('SSRF at send time (store bypasses route validation = a rebind or legacy row)', () => {
  const forms = [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://localhost/', 'http://foo.localhost/',
    'http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://0.0.0.0/', 'http://[64:ff9b::a9fe:a9fe]/',
    'http://LOCALHOST./', 'http://metadata.google.internal/', 'file:///etc/passwd', 'http://u:p@example.com/',
  ];
  it.each(forms)('D-S1 %s is never sent', async (u) => {
    spySeam();
    setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    const k = getKeyStore().create('A', ['scan']);
    await getScheduleRunner().runSchedule(sched(u, k.id));
    expect(seen).toEqual([]);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter((c) => String(c[0]) === u)).toEqual([]);
  });

  it('D-S1 control: a public URL IS sent through the same seam', async () => {
    spySeam();
    setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    const k = getKeyStore().create('A', ['scan']);
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', k.id));
    expect(seen.length).toBe(1);
  });

  it('D-S2 DNS now resolves private (rebind after create): not sent', async () => {
    spySeam();
    setOutboundResolver(async () => [{ address: '10.0.0.5', family: 4 }]);
    const k = getKeyStore().create('A', ['scan']);
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', k.id));
    expect(seen).toEqual([]);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter((c) => String(c[0]).includes('hook.example.com'))).toEqual([]);
  });
});

describe('real sockets (loopback listeners only)', () => {
  let a: Server; let b: Server; let aConn = 0; let bConn = 0; let aPort = 0; let bPort = 0;
  beforeEach(async () => {
    aConn = 0; bConn = 0;
    b = createServer((_q, r) => r.end('b')); b.on('connection', () => { bConn++; });
    await new Promise<void>((r) => b.listen(0, '127.0.0.1', r)); bPort = (b.address() as AddressInfo).port;
    a = createServer((_q, r) => { r.statusCode = 302; r.setHeader('location', `http://127.0.0.1:${bPort}/`); r.end(); });
    a.on('connection', () => { aConn++; });
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', r)); aPort = (a.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const s of [a, b]) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  });

  it('D-R1 connect-time rebind: pre-check public, connect answers 127.0.0.1 -> no socket', async () => {
    let call = 0;
    setOutboundResolver(async (): Promise<ResolvedAddress[]> => (call++ === 0
      ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]));
    const k = getKeyStore().create('A', ['scan']);
    await getScheduleRunner().runSchedule(sched(`http://hook.rebind.test:${aPort}/`, k.id));
    await new Promise((r) => setTimeout(r, 100));
    expect(call).toBeGreaterThanOrEqual(2);
    expect(aConn).toBe(0);
  });

  it('D-R2 control + redirect: permissive policy reaches A once; 302 to B is NOT followed', async () => {
    setBlockedAddressPolicy(() => false);
    setOutboundResolver(async () => [{ address: '127.0.0.1', family: 4 }]);
    const k = getKeyStore().create('A', ['scan']);
    await getScheduleRunner().runSchedule(sched(`http://hook.rebind.test:${aPort}/`, k.id));
    await new Promise((r) => setTimeout(r, 100));
    expect(aConn).toBe(1);
    expect(bConn).toBe(0);
  });
});

describe('owner key liveness and content', () => {
  it('D-K1 expired owner key: not sent', async () => {
    spySeam(); setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    const k = getKeyStore().create('A', ['scan']);
    getKeyStore().validateById(k.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', k.id));
    expect(seen).toEqual([]);
  });

  it("D-K2 keyId 'unknown' (no request.keyId at create): not sent", async () => {
    spySeam(); setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', 'unknown'));
    expect(seen).toEqual([]);
  });

  it('D-K3 rotated key (same id): still sent to the same owner', async () => {
    spySeam(); setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    const k = getKeyStore().create('A', ['scan']);
    getKeyStore().rotate(k.id);
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', k.id));
    expect(seen.length).toBe(1);
  });

  it("D-K4 server key 'admin' schedule: SENT while FAULTLINE_API_KEY set (no per-user scoping)", async () => {
    spySeam(); setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    process.env.FAULTLINE_API_KEY = 'srv';
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', 'admin'));
    expect(seen.length).toBe(1);
  });

  it.each([['grounding provenance under openai label', GROUNDED_OPENAI_LABEL], ['search suggestions only', SUGGESTIONS_ONLY]])(
    'D-G %s: counts only, no claim text, link, suggestions or overallRisk', async (_n, res) => {
      spySeam(); setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
      const { scan } = await import('@nxtg/faultline/cli/scan.js');
      vi.mocked(scan).mockResolvedValueOnce(res as never);
      const k = getKeyStore().create('A', ['scan']);
      await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', k.id));
      expect(seen.length).toBe(1);
      const body = JSON.parse(seen[0].body);
      expect(body.grounded).toBe(true);
      expect(body).not.toHaveProperty('overallRisk');
      for (const s of [CLAIM, EXPL, 'vertexaisearch', 'Search Suggestions']) expect(seen[0].body).not.toContain(s);
    });

  it.each([
    ['provider text', `Gemini said ${EXPL} ${GURI}`],
    ['own prefix carrying a grounding link', `All providers failed: ${GURI} ${EXPL}`],
    ['URL fetch failure', 'URL fetch failed: 500 Internal'],
  ])('D-E %s: error text sanitized', async (_n, msg) => {
    spySeam(); setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    vi.mocked(scan).mockRejectedValueOnce(new Error(msg));
    const k = getKeyStore().create('A', ['scan']);
    await getScheduleRunner().runSchedule(sched('https://hook.example.com/x', k.id));
    expect(seen.length).toBe(1);
    expect(seen[0].body).not.toContain('vertexaisearch');
    expect(JSON.parse(seen[0].body).event).toBe('scan.failed');

  });
});
