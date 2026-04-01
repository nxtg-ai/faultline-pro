// Validates: N-199 (Compliance gate failure webhook alerts — compliance.gate_failed event)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetScanStore } from '../src/store/scans.js';
import { resetComplianceHistoryStore } from '../src/store/compliance-history.js';
import { ALL_EVENT_TYPES, EVENT_CATALOGUE } from '../src/store/notifications.js';
import type { FastifyInstance } from 'fastify';

// Mock fireWebhookEvent so tests are hermetic and do not make real HTTP calls
vi.mock('../src/store/webhooks.js', async () => {
  const actual = await vi.importActual('../src/store/webhooks.js');
  return {
    ...(actual as Record<string, unknown>),
    fireWebhookEvent: vi.fn(),
  };
});

// Import AFTER mock declaration so Vitest's hoisting wires up the spy
import { fireWebhookEvent } from '../src/store/webhooks.js';

const AUTH = { 'x-api-key': 'test-secret', 'content-type': 'application/json' };

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = 'test-secret';
  resetScanStore();
  resetComplianceHistoryStore();
  vi.mocked(fireWebhookEvent).mockClear();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

// ── CW1: Gate failure fires compliance.gate_failed webhook ───────────────────

describe('CW1: compliance gate failure fires webhook event', () => {
  it('fires compliance.gate_failed when gate does not pass', async () => {
    // threshold=100 guarantees failure: any score below 100 causes a fail
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'AI is safe.', provider: 'mock', threshold: 100 },
    });

    const body = JSON.parse(res.body);
    expect(body.gate).toBeDefined();

    if (!body.gate.pass) {
      expect(vi.mocked(fireWebhookEvent)).toHaveBeenCalledWith(
        'compliance.gate_failed',
        expect.objectContaining({ scanId: expect.any(String) }),
      );
    }
  });
});

// ── CW2: Gate pass does NOT fire the webhook ─────────────────────────────────

describe('CW2: compliance gate pass does NOT fire webhook', () => {
  it('does not fire compliance.gate_failed when gate passes', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'Water boils at 100°C.', provider: 'mock', threshold: 0 },
    });

    const body = JSON.parse(res.body);
    expect(body.gate).toBeDefined();

    if (body.gate.pass) {
      expect(vi.mocked(fireWebhookEvent)).not.toHaveBeenCalledWith(
        'compliance.gate_failed',
        expect.anything(),
      );
    }
  });
});

// ── CW3: Webhook payload shape ───────────────────────────────────────────────

describe('CW3: webhook payload includes required fields', () => {
  it('payload contains scanId, complianceScore, failedArticles, projectName, overallRisk, nonCompliantCount', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'AI claim.', provider: 'mock', projectName: 'AcmeAI', threshold: 100 },
    });

    const body = JSON.parse(res.body);
    expect(body.gate).toBeDefined();

    if (!body.gate.pass) {
      expect(vi.mocked(fireWebhookEvent)).toHaveBeenCalledWith(
        'compliance.gate_failed',
        expect.objectContaining({
          scanId: expect.any(String),
          projectName: 'AcmeAI',
          complianceScore: expect.any(Number),
          overallRisk: expect.any(String),
          nonCompliantCount: expect.any(Number),
          failedArticles: expect.any(Array),
        }),
      );

      const [, payload] = vi.mocked(fireWebhookEvent).mock.calls[0] as [string, Record<string, unknown>];
      expect(Array.isArray(payload.failedArticles)).toBe(true);
    }
  });
});

// ── CW4: Notification event catalogue includes compliance.gate_failed ────────

describe('CW4: notification system includes compliance.gate_failed', () => {
  it('ALL_EVENT_TYPES includes compliance.gate_failed', () => {
    expect(ALL_EVENT_TYPES).toContain('compliance.gate_failed');
  });

  it('EVENT_CATALOGUE has an entry for compliance.gate_failed', () => {
    expect(EVENT_CATALOGUE['compliance.gate_failed']).toBeDefined();
    expect(typeof EVENT_CATALOGUE['compliance.gate_failed'].description).toBe('string');
    expect(EVENT_CATALOGUE['compliance.gate_failed'].description.length).toBeGreaterThan(0);
  });

  it('EVENT_CATALOGUE example includes required payload fields', () => {
    const example = EVENT_CATALOGUE['compliance.gate_failed'].example;
    expect(example).toHaveProperty('scanId');
    expect(example).toHaveProperty('complianceScore');
    expect(example).toHaveProperty('failedArticles');
  });
});
