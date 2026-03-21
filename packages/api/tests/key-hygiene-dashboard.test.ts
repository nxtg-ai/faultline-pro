/**
 * N-95 — Key hygiene HTML dashboard (GET /keys/usage/view)
 *
 * KHD1–KHD5   Content-type, structure, auth guard, empty state
 * KHD6–KHD15  Status chips, summary badges, query params, mixed scenarios
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetScanHistory } from '../src/store/scan-history.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

const ADMIN_KEY = 'admin-key-hygiene-dashboard-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

describe('GET /keys/usage/view — HTML dashboard', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    resetKeyStore();
    resetAuditLogger();
    resetAnalytics();
    resetScanHistory();
    resetCache();
    resetCircuitBreaker();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KHD1: returns 200 with content-type text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('KHD2: response is valid HTML with title and heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('Key Hygiene');
  });

  it('KHD3: 403 without admin key', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view' });
    expect(res.statusCode).toBe(403);
  });

  it('KHD4: empty keystore — shows "No API keys found" empty state', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('No API keys found');
  });

  it('KHD5: includes auto-refresh meta tag', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('http-equiv="refresh"');
  });

  it('KHD6: healthy key — shows HEALTHY chip', async () => {
    getKeyStore().create('Active');
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('HEALTHY');
  });

  it('KHD7: disabled key — shows DISABLED chip', async () => {
    const entry = getKeyStore().create('ToDisable');
    getKeyStore().disable(entry.id);
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('DISABLED');
  });

  it('KHD8: expired key — shows EXPIRED chip', async () => {
    getKeyStore().create('Expired', ['scan'], daysAgo(1));
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('EXPIRED');
  });

  it('KHD9: expiring-soon key — shows EXPIRING SOON chip', async () => {
    getKeyStore().create('Soon', ['scan'], daysFromNow(3));
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('EXPIRING SOON');
  });

  it('KHD10: dormant key — shows DORMANT chip', async () => {
    const entry = getKeyStore().create('Dormant');
    (getKeyStore().validateById(entry.id) as { createdAt: string }).createdAt = daysAgo(31);
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('DORMANT');
  });

  it('KHD11: key name appears in the table', async () => {
    getKeyStore().create('My Production Key');
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('My Production Key');
  });

  it('KHD12: summary badge counts appear in HTML', async () => {
    getKeyStore().create('Normal');
    const disabled = getKeyStore().create('D');
    getKeyStore().disable(disabled.id);

    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    // Two keys → "Total" badge shows 2
    expect(res.body).toContain('>2<');
    // One disabled → "Disabled" badge shows 1
    expect(res.body).toContain('>1<');
    expect(res.body).toContain('Disabled');
  });

  it('KHD13: ?dormantDays shown in page header', async () => {
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view?dormantDays=14', headers: adminHeader() });
    expect(res.body).toContain('14');
    expect(res.body).toContain('dormant');
  });

  it('KHD14: ?expiringSoonDays changes expiring-soon threshold', async () => {
    // Key expiring in 2 days — included at 3d, excluded at default 7d
    getKeyStore().create('Soon2d', ['scan'], daysFromNow(2));

    const resDefault = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    // At default 7d threshold it should show EXPIRING SOON
    expect(resDefault.body).toContain('EXPIRING SOON');

    // Verify ?expiringSoonDays=1 excludes it
    const res1d = await server.inject({ method: 'GET', url: '/keys/usage/view?expiringSoonDays=1', headers: adminHeader() });
    expect(res1d.body).not.toContain('EXPIRING SOON');
  });

  it('KHD15: mixed keys — all four status chips present simultaneously', async () => {
    const dormant = getKeyStore().create('Dormant');
    (getKeyStore().validateById(dormant.id) as { createdAt: string }).createdAt = daysAgo(31);

    getKeyStore().create('Soon', ['scan'], daysFromNow(3));
    getKeyStore().create('Expired', ['scan'], daysAgo(1));

    const dis = getKeyStore().create('Disabled');
    getKeyStore().disable(dis.id);

    getKeyStore().create('Healthy');

    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: adminHeader() });
    expect(res.body).toContain('DORMANT');
    expect(res.body).toContain('EXPIRING SOON');
    expect(res.body).toContain('EXPIRED');
    expect(res.body).toContain('DISABLED');
    expect(res.body).toContain('HEALTHY');
  });
});
