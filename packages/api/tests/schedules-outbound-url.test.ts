/**
 * Scheduled URL scans fetch a caller-supplied URL and feed the body to the scan,
 * so an unguarded fetch reads internal URLs back to the caller (SSRF, same class
 * as CodeQL #5). Validates: GoPMO 1.18.7.3.6 (security evidence, fix for the
 * schedules sink found after 743e855).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import {
  resetOutboundFetch,
  resetOutboundResolver,
  setOutboundFetch,
  type OutboundFetch,
  setOutboundResolver,
  type ResolvedAddress,
} from '../src/lib/outbound-url.js';
import { getScheduleRunner, getScheduleStore, resetScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';
import { resetKeyStore } from '../src/store/keys.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({ overallRisk: 'low', claims: [], verifications: {} }),
}));

const ADMIN = 'admin-secret';
const HEADERS = { 'x-api-key': ADMIN, 'content-type': 'application/json' };
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const PUBLIC_IP = '93.184.216.34';

let fetchSpy: Mock<OutboundFetch>;

/** Hostnames resolve by table; anything unlisted resolves to the public address. */
function resolveBy(table: Record<string, string>): void {
  setOutboundResolver(async (host: string): Promise<ResolvedAddress[]> => {
    const address = table[host] ?? PUBLIC_IP;
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore();
  resetScheduleStore();
  resetScheduleRunner();
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resolveBy({});
  fetchSpy = vi.fn<OutboundFetch>().mockResolvedValue(new Response('Public page text.', { status: 200 }));
  setOutboundFetch(fetchSpy);
  vi.mocked(scan).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOutboundFetch();
  resetOutboundResolver();
  delete process.env.FAULTLINE_API_KEY;
});

describe('POST/PATCH /schedules refuse private URLs', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('SO-01 url at the metadata address → 400, nothing stored, fetch never called', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules', headers: HEADERS,
      payload: { name: 'probe', cron: '0 9 * * *', url: METADATA_URL },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^url: Outbound URL blocked: .*169\.254\.169\.254/);
    expect(getScheduleStore().list()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SO-02 webhookUrl on a name that resolves into the Fly private network → 400', async () => {
    resolveBy({ 'hooks.example.com': 'fdaa::3' });
    const res = await server.inject({
      method: 'POST', url: '/schedules', headers: HEADERS,
      payload: { name: 'probe', cron: '0 9 * * *', text: 'x', webhookUrl: 'https://hooks.example.com/x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^webhookUrl: Outbound URL blocked: .*fdaa::3/);
  });

  it('SO-03 a public url is accepted (201)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules', headers: HEADERS,
      payload: { name: 'ok', cron: '0 9 * * *', url: 'https://news.example.com/a' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe('https://news.example.com/a');
  });

  it('SO-04 PATCH webhookUrl to loopback → 400 and the stored webhookUrl is unchanged', async () => {
    const created = await server.inject({
      method: 'POST', url: '/schedules', headers: HEADERS,
      payload: { name: 'ok', cron: '0 9 * * *', text: 'x', webhookUrl: 'https://hooks.example.com/ok' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const res = await server.inject({
      method: 'PATCH', url: `/schedules/${id}`, headers: HEADERS,
      payload: { webhookUrl: 'http://127.0.0.1:3000/admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(getScheduleStore().get(id)!.webhookUrl).toBe('https://hooks.example.com/ok');
  });
});

describe('scheduled run guards every fetch and every redirect hop', () => {
  function storedUrlSchedule(url: string) {
    // Created through the store, not the route: the run-time guard must hold on
    // its own (DNS can change after registration).
    return getScheduleStore().create({ name: 'run', cron: '0 9 * * *', url }, ADMIN);
  }

  it('SO-05 DNS now resolves private → no fetch, no scan, the run records the refusal', async () => {
    const s = storedUrlSchedule('https://news.example.com/a');
    resolveBy({ 'news.example.com': '10.0.0.7' });
    await getScheduleRunner().runSchedule(s);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    const run = getScheduleStore().get(s.id)!.history[0]!;
    expect(run.error).toMatch(/Outbound URL blocked: .*10\.0\.0\.7/);
  });

  it('SO-06 a public URL that redirects to the metadata address → second hop refused, never requested', async () => {
    const s = storedUrlSchedule('https://news.example.com/a');
    fetchSpy.mockResolvedValueOnce(redirect(METADATA_URL));
    await getScheduleRunner().runSchedule(s);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://news.example.com/a');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(scan).not.toHaveBeenCalled();
    expect(getScheduleStore().get(s.id)!.history[0]!.error).toMatch(/Outbound URL blocked: .*169\.254\.169\.254/);
  });

  it('SO-07 a public-to-public redirect is followed and its body is scanned', async () => {
    const s = storedUrlSchedule('http://news.example.com/a');
    fetchSpy.mockResolvedValueOnce(redirect('https://news.example.com/a', 301));
    await getScheduleRunner().runSchedule(s);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![0]).toBe('https://news.example.com/a');
    expect(scan).toHaveBeenCalledWith('Public page text.', s.provider);
    expect(getScheduleStore().get(s.id)!.history[0]!.error).toBeUndefined();
  });

  it('SO-08 more than 3 redirects → error, no scan', async () => {
    const s = storedUrlSchedule('https://news.example.com/0');
    for (let i = 1; i <= 4; i++) fetchSpy.mockResolvedValueOnce(redirect(`https://news.example.com/${i}`));
    await getScheduleRunner().runSchedule(s);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(scan).not.toHaveBeenCalled();
    expect(getScheduleStore().get(s.id)!.history[0]!.error).toMatch(/Too many redirects/);
  });
});
