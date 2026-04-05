/**
 * Regulatory Calendar Tests (D-206)
 *
 * Covers: GET /compliance/deadlines, POST /compliance/scan-check,
 * POST /compliance/deadlines/notify, and ComplianceCalendar store behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getComplianceCalendar, resetComplianceCalendar } from '../src/store/compliance-calendar.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'test-key';
const JSON_HDR = { 'content-type': 'application/json' };

function authHeaders() {
  return { 'x-api-key': API_KEY, ...JSON_HDR };
}

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = API_KEY;
  resetComplianceCalendar();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

// ── CC1: GET /compliance/deadlines ────────────────────────────────────────────

describe('GET /compliance/deadlines', () => {
  it('CC1: returns 200 with deadlines array', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/deadlines' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.deadlines)).toBe(true);
  });

  it('CC2: each deadline has id, name, regulation, deadline, daysUntil, severity, url', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/deadlines' });
    const { deadlines } = JSON.parse(res.body);
    // Use getAll() to check against full set regardless of date
    const all = getComplianceCalendar().getAll();
    expect(all.length).toBeGreaterThan(0); // Gate 2

    // Use a wider window to ensure we always get items in tests
    const res2 = await server.inject({ method: 'GET', url: '/compliance/deadlines?days=99999' });
    const { deadlines: all2 } = JSON.parse(res2.body);
    expect(all2.length).toBeGreaterThan(0); // Gate 2
    for (const d of all2) {
      expect(d.id).toBeDefined();
      expect(d.name).toBeDefined();
      expect(d.regulation).toBeDefined();
      expect(d.deadline).toBeDefined();
      expect(typeof d.daysUntil).toBe('number');
      expect(d.severity).toBeDefined();
      expect(d.url).toMatch(/^https?:\/\//);
    }

    // Suppress TS unused-variable warning for `deadlines`
    void deadlines;
  });

  it('CC3: GET /compliance/deadlines?days=30 returns only deadlines within 30 days', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/deadlines?days=30' });
    expect(res.statusCode).toBe(200);
    const { deadlines } = JSON.parse(res.body);
    const now = Date.now();
    const cutoff = now + 30 * 24 * 60 * 60 * 1000;
    for (const d of deadlines) {
      const ms = new Date(d.deadline).getTime();
      expect(ms).toBeGreaterThanOrEqual(now);
      expect(ms).toBeLessThanOrEqual(cutoff);
    }
  });

  it('CC4: daysUntil is a number (can be positive, zero, or negative)', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/deadlines?days=99999' });
    const { deadlines } = JSON.parse(res.body);
    expect(deadlines.length).toBeGreaterThan(0); // Gate 2
    for (const d of deadlines) {
      expect(typeof d.daysUntil).toBe('number');
    }
  });

  it('CC5: deadlines are sorted by deadline date ascending', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/deadlines?days=99999' });
    const { deadlines } = JSON.parse(res.body);
    expect(deadlines.length).toBeGreaterThan(0); // Gate 2
    for (let i = 1; i < deadlines.length; i++) {
      expect(deadlines[i].deadline >= deadlines[i - 1].deadline).toBe(true);
    }
  });
});

// ── CC6–CC9: POST /compliance/scan-check ──────────────────────────────────────

describe('POST /compliance/scan-check', () => {
  it('CC6: returns alerts for matching claims', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compliance/scan-check',
      headers: authHeaders(),
      body: JSON.stringify({ claims: ['This system uses biometric surveillance to identify people.'] }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThan(0); // Gate 2
  });

  it('CC7: POST /compliance/scan-check with "high-risk ai system" returns EU AI Act alert', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compliance/scan-check',
      headers: authHeaders(),
      body: JSON.stringify({ claims: ['This is a high-risk ai system used in recruitment.'] }),
    });
    expect(res.statusCode).toBe(200);
    const { alerts } = JSON.parse(res.body);
    expect(alerts.length).toBeGreaterThan(0); // Gate 2
    const euAlert = alerts.find((a: { regulation: string }) => a.regulation === 'EU AI Act');
    expect(typeof (euAlert as { severity: string }).severity).toBe('string');
  });

  it('CC8: returns empty alerts for non-matching text', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compliance/scan-check',
      headers: authHeaders(),
      body: JSON.stringify({ claims: ['The weather is sunny and warm today.'] }),
    });
    expect(res.statusCode).toBe(200);
    const { alerts, total } = JSON.parse(res.body);
    expect(Array.isArray(alerts)).toBe(true);
    expect(total).toBe(0);
  });

  it('CC9: requires api key — returns 401 without key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compliance/scan-check',
      headers: JSON_HDR,
      body: JSON.stringify({ claims: ['test claim'] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('CC12: alerts have deadlineId, deadlineName, matchedKeywords, daysUntil', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compliance/scan-check',
      headers: authHeaders(),
      body: JSON.stringify({ claims: ['The LLM foundation model must comply with GPAI obligations.'] }),
    });
    expect(res.statusCode).toBe(200);
    const { alerts } = JSON.parse(res.body);
    expect(alerts.length).toBeGreaterThan(0); // Gate 2
    const alert = alerts[0];
    expect(alert.deadlineId).toBeDefined();
    expect(alert.deadlineName).toBeDefined();
    expect(Array.isArray(alert.matchedKeywords)).toBe(true);
    expect(alert.matchedKeywords.length).toBeGreaterThan(0); // Gate 2
    expect(typeof alert.daysUntil).toBe('number');
  });
});

// ── CC10–CC11: POST /compliance/deadlines/notify ──────────────────────────────

describe('POST /compliance/deadlines/notify', () => {
  it('CC10: requires admin — returns 403 without admin key', async () => {
    // Send with no x-api-key and no content-type (avoid JSON parse 400 on empty body)
    const noKeyRes = await server.inject({
      method: 'POST',
      url: '/compliance/deadlines/notify',
    });
    expect(noKeyRes.statusCode).toBe(403);
  });

  it('CC11: returns { fired, alerts } for admin', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/compliance/deadlines/notify',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.fired).toBe('number');
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});

// ── CC13–CC14: ComplianceCalendar store unit tests ─────────────────────────────

describe('ComplianceCalendar store', () => {
  it('CC13: getAll() returns 5 built-in deadlines', () => {
    const calendar = getComplianceCalendar();
    const all = calendar.getAll();
    expect(all.length).toBe(5); // Gate 2
  });

  it('CC14: checkClaims() matches keywords case-insensitively', () => {
    const calendar = getComplianceCalendar();
    // Use mixed case to verify case-insensitive matching
    const alerts = calendar.checkClaims(['This system uses BIOMETRIC SURVEILLANCE in public spaces.']);
    expect(alerts.length).toBeGreaterThan(0); // Gate 2
    const matched = alerts.find((a) => a.deadline.id === 'eu-ai-act-prohibited');
    expect(matched).toBeDefined();
    expect(matched?.matchedKeywords).toContain('biometric surveillance');
  });
});
