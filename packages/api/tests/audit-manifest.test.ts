// Validates: N-219 (Art. 12 Tamper-Evident Log)
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
}

function seedEntries(n = 3) {
  const logger = getAuditLogger();
  for (let i = 0; i < n; i++) {
    logger.log({
      timestamp: `2026-04-0${i + 1}T10:00:00.000Z`,
      keyId: 'admin',
      endpoint: `/scan/${i}`,
      method: 'POST',
      statusCode: 200,
      latencyMs: 50 + i * 10,
    });
  }
}

function getManifest(server: FastifyInstance, key = 'admin-secret') {
  return server.inject({
    method: 'GET',
    url: '/audit/log/manifest',
    headers: { 'x-api-key': key },
  });
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('GET /audit/log/manifest — authentication', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AM1. returns 403 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/audit/log/manifest' });
    expect(res.statusCode).toBe(403);
  });

  it('AM2. returns 200 with valid admin key', async () => {
    const res = await getManifest(server);
    expect(res.statusCode).toBe(200);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('GET /audit/log/manifest — response shape', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AM3. response has algorithm, generatedAt, totalEntries, rootHash, entries', async () => {
    const body = JSON.parse((await getManifest(server)).body);
    expect(body.algorithm).toBe('SHA-256-chain');
    expect(typeof body.generatedAt).toBe('string');
    expect(typeof body.totalEntries).toBe('number');
    expect('rootHash' in body).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('AM4. empty log → totalEntries = 0, rootHash = null, entries = []', async () => {
    const body = JSON.parse((await getManifest(server)).body);
    expect(body.totalEntries).toBe(0);
    expect(body.rootHash).toBeNull();
    expect(body.entries).toHaveLength(0);
  });

  it('AM5. generatedAt is an ISO timestamp', async () => {
    const { generatedAt } = JSON.parse((await getManifest(server)).body);
    expect(generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ── Data integrity ────────────────────────────────────────────────────────────

describe('GET /audit/log/manifest — data integrity', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); seedEntries(3); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AM6. totalEntries matches seeded count', async () => {
    const body = JSON.parse((await getManifest(server)).body);
    expect(body.totalEntries).toBe(3);
    expect(body.entries).toHaveLength(3);
  });

  it('AM7. each entry has index, timestamp, keyId, endpoint, method, statusCode, entryHash, chainHash', async () => {
    const { entries } = JSON.parse((await getManifest(server)).body);
    const e = entries[0];
    expect(typeof e.index).toBe('number');
    expect(typeof e.timestamp).toBe('string');
    expect(typeof e.keyId).toBe('string');
    expect(typeof e.endpoint).toBe('string');
    expect(typeof e.method).toBe('string');
    expect(typeof e.statusCode).toBe('number');
    expect(typeof e.entryHash).toBe('string');
    expect(typeof e.chainHash).toBe('string');
  });

  it('AM8. entries are zero-indexed in order', async () => {
    const { entries } = JSON.parse((await getManifest(server)).body);
    expect(entries[0].index).toBe(0);
    expect(entries[1].index).toBe(1);
    expect(entries[2].index).toBe(2);
  });

  it('AM9. entryHash and chainHash are 64-char hex strings (SHA-256)', async () => {
    const { entries } = JSON.parse((await getManifest(server)).body);
    for (const e of entries) {
      expect(e.entryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.chainHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('AM10. rootHash equals the last entry chainHash', async () => {
    const body = JSON.parse((await getManifest(server)).body);
    const last = body.entries[body.entries.length - 1];
    expect(body.rootHash).toBe(last.chainHash);
  });
});

// ── Chain integrity ───────────────────────────────────────────────────────────

describe('GET /audit/log/manifest — chain verification', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); seedEntries(3); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AM11. first entry chainHash = SHA-256(entryHash + "")', async () => {
    const { entries } = JSON.parse((await getManifest(server)).body);
    const e0 = entries[0];
    const expected = createHash('sha256').update(e0.entryHash + '').digest('hex');
    expect(e0.chainHash).toBe(expected);
  });

  it('AM12. second entry chainHash = SHA-256(entryHash[1] + chainHash[0])', async () => {
    const { entries } = JSON.parse((await getManifest(server)).body);
    const expected = createHash('sha256').update(entries[1].entryHash + entries[0].chainHash).digest('hex');
    expect(entries[1].chainHash).toBe(expected);
  });

  it('AM13. full chain verifies end-to-end', async () => {
    const body = JSON.parse((await getManifest(server)).body);
    let prev = '';
    for (const e of body.entries) {
      const expected = createHash('sha256').update(e.entryHash + prev).digest('hex');
      expect(e.chainHash).toBe(expected);
      prev = e.chainHash;
    }
    expect(body.rootHash).toBe(prev);
  });
});
