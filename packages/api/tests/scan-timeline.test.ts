import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getScanHistory,
  resetScanHistory,
  hashText,
} from '../src/store/scan-history.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetScanHistory();
  _ts = 0;
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

let _ts = 0;
function makeEntry(text: string, overrides: Partial<{
  overallRisk: string; claimCount: number; provider: string; latencyMs: number;
}> = {}) {
  // Use incrementing timestamp so FIFO insert order == chronological order
  _ts += 1000;
  return {
    textHash:    hashText(text),
    textPreview: text.slice(0, 100),
    provider:    overrides.provider    ?? 'gemini',
    overallRisk: overrides.overallRisk ?? 'Low',
    claimCount:  overrides.claimCount  ?? 3,
    latencyMs:   overrides.latencyMs   ?? 100,
    timestamp:   new Date(1_700_000_000_000 + _ts).toISOString(),
    keyId:       'key1',
  };
}

// ── hashText ──────────────────────────────────────────────────────────────────

describe('hashText', () => {
  it('returns 64-char hex string', () => {
    expect(hashText('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input → same hash', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
  });

  it('different input → different hash', () => {
    expect(hashText('abc')).not.toBe(hashText('xyz'));
  });
});

// ── ScanHistoryStore.getTimeline ──────────────────────────────────────────────

describe('ScanHistoryStore.getTimeline', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns empty array for unknown hash', () => {
    expect(getScanHistory().getTimeline('deadbeef')).toHaveLength(0);
  });

  it('returns entries for matching hash', () => {
    const text = 'test document';
    getScanHistory().record(makeEntry(text, { overallRisk: 'Low', claimCount: 2 }));
    getScanHistory().record(makeEntry(text, { overallRisk: 'Medium', claimCount: 4 }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline).toHaveLength(2);
  });

  it('entries are in chronological order (oldest first)', () => {
    const text = 'ordered doc';
    const hash = hashText(text);
    // Insert in reverse order by manually manipulating timestamps
    getScanHistory().record({ ...makeEntry(text), timestamp: '2026-03-20T10:00:00Z' });
    getScanHistory().record({ ...makeEntry(text), timestamp: '2026-03-19T10:00:00Z' });
    const timeline = getScanHistory().getTimeline(hash);
    expect(new Date(timeline[0].timestamp) < new Date(timeline[1].timestamp)).toBe(true);
  });

  it('scanNumber increments from 1', () => {
    const text = 'numbered doc';
    getScanHistory().record(makeEntry(text));
    getScanHistory().record(makeEntry(text));
    getScanHistory().record(makeEntry(text));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline.map(e => e.scanNumber)).toEqual([1, 2, 3]);
  });

  it('claimDelta is 0 on first scan', () => {
    const text = 'delta doc';
    getScanHistory().record(makeEntry(text, { claimCount: 5 }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline[0].claimDelta).toBe(0);
  });

  it('claimDelta reflects difference from previous scan', () => {
    const text = 'delta doc 2';
    getScanHistory().record(makeEntry(text, { claimCount: 3 }));
    getScanHistory().record(makeEntry(text, { claimCount: 7 }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline[1].claimDelta).toBe(4);
  });

  it('negative claimDelta when claims resolved', () => {
    const text = 'resolved doc';
    getScanHistory().record(makeEntry(text, { claimCount: 10 }));
    getScanHistory().record(makeEntry(text, { claimCount: 6 }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline[1].claimDelta).toBe(-4);
  });

  it('riskChanged=false on first scan', () => {
    const text = 'risk doc';
    getScanHistory().record(makeEntry(text, { overallRisk: 'Low' }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline[0].riskChanged).toBe(false);
  });

  it('riskChanged=true when risk level changes', () => {
    const text = 'risk change doc';
    getScanHistory().record(makeEntry(text, { overallRisk: 'Low' }));
    getScanHistory().record(makeEntry(text, { overallRisk: 'High' }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline[1].riskChanged).toBe(true);
    expect(timeline[1].previousRisk).toBe('Low');
  });

  it('riskChanged=false when risk stays the same', () => {
    const text = 'stable risk doc';
    getScanHistory().record(makeEntry(text, { overallRisk: 'Medium' }));
    getScanHistory().record(makeEntry(text, { overallRisk: 'Medium' }));
    const timeline = getScanHistory().getTimeline(hashText(text));
    expect(timeline[1].riskChanged).toBe(false);
  });

  it('does not return entries from other documents', () => {
    getScanHistory().record(makeEntry('doc A', { overallRisk: 'Low' }));
    getScanHistory().record(makeEntry('doc B', { overallRisk: 'High' }));
    const timeline = getScanHistory().getTimeline(hashText('doc A'));
    expect(timeline).toHaveLength(1);
    expect(timeline[0].overallRisk).toBe('Low');
  });

  it('respects limit', () => {
    const text = 'limited doc';
    for (let i = 0; i < 10; i++) getScanHistory().record(makeEntry(text));
    expect(getScanHistory().getTimeline(hashText(text), 3)).toHaveLength(3);
  });
});

// ── HTTP: GET /scans/timeline ─────────────────────────────────────────────────

describe('GET /scans/timeline', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 400 without text_hash or text', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/timeline', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with empty timeline for unknown hash', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/timeline?text_hash=abc123', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scanCount).toBe(0);
    expect(body.timeline).toHaveLength(0);
  });

  it('returns timeline when text_hash matches recorded scans', async () => {
    const text = 'api timeline doc';
    getScanHistory().record(makeEntry(text, { overallRisk: 'Low', claimCount: 2 }));
    getScanHistory().record(makeEntry(text, { overallRisk: 'High', claimCount: 5 }));
    const hash = hashText(text);
    const res = await server.inject({ method: 'GET', url: `/scans/timeline?text_hash=${hash}`, headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scanCount).toBe(2);
    expect(body.textHash).toBe(hash);
    expect(body.timeline).toHaveLength(2);
  });

  it('accepts text param and computes hash server-side', async () => {
    const text = 'raw text doc';
    getScanHistory().record(makeEntry(text, { overallRisk: 'Medium' }));
    const res = await server.inject({ method: 'GET', url: `/scans/timeline?text=${encodeURIComponent(text)}`, headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).scanCount).toBe(1);
  });

  it('response includes timeline entries with delta fields', async () => {
    const text = 'delta api doc';
    getScanHistory().record(makeEntry(text, { claimCount: 3 }));
    getScanHistory().record(makeEntry(text, { claimCount: 7 }));
    const res = await server.inject({ method: 'GET', url: `/scans/timeline?text_hash=${hashText(text)}`, headers: { 'x-api-key': 'admin-secret' } });
    const body = JSON.parse(res.body);
    const second = body.timeline[1];
    expect(second).toHaveProperty('claimDelta');
    expect(second).toHaveProperty('riskChanged');
    expect(second).toHaveProperty('scanNumber');
    expect(second.claimDelta).toBe(4);
  });
});

// ── HTTP: GET /scans/timeline/view ────────────────────────────────────────────

describe('GET /scans/timeline/view', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/timeline/view', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Scan Timeline heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/timeline/view', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.body).toContain('Scan Timeline');
  });
});
