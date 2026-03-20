/**
 * Tests for API Playground route (D-167)
 *
 * Covers:
 *   GET /playground — interactive HTML UI for live endpoint testing
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('GET /playground', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('returns 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.statusCode).toBe(200);
  });

  it('returns text/html content-type', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('contains page title', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('Faultline Pro');
    expect(res.body).toContain('Playground');
  });

  it('no auth required (public page)', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.statusCode).toBe(200);
  });

  // ── Sample texts ────────────────────────────────────────────────────────────

  it('contains AI Revenue Claim sample', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('AI Revenue Claim');
  });

  it('contains Medical Research sample', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('Medical Research');
  });

  it('contains Climate Statistics sample', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('Climate Statistics');
  });

  it('contains Product Launch sample', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('Product Launch');
  });

  it('contains Financial Report sample', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('Financial Report');
  });

  // ── Form controls ───────────────────────────────────────────────────────────

  it('contains text input area', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="txt"');
  });

  it('contains provider selector', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="provider"');
  });

  it('contains endpoint selector', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="endpoint"');
  });

  it('contains API key input', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="apikey"');
  });

  it('contains run button', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="run-btn"');
  });

  // ── Endpoint options ────────────────────────────────────────────────────────

  it('lists /scan endpoint option', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('/scan');
  });

  it('lists /scan/batch endpoint option', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('/scan/batch');
  });

  it('lists /scan/eu-report endpoint option', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('/scan/eu-report');
  });

  it('lists /scan/deep endpoint option', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('/scan/deep');
  });

  // ── Result panel tabs ───────────────────────────────────────────────────────

  it('contains result panel', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="result-panel"');
  });

  it('contains overview tab pane', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="tab-overview"');
  });

  it('contains claims tab pane', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="tab-claims"');
  });

  it('contains raw JSON tab pane', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="tab-raw"');
  });

  it('contains request tab pane', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="tab-request"');
  });

  // ── Keyboard shortcut ───────────────────────────────────────────────────────

  it('mentions Ctrl+Enter shortcut', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('Ctrl');
    expect(res.body).toContain('Enter');
  });

  // ── JS interactivity ────────────────────────────────────────────────────────

  it('contains runScan function', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('runScan');
  });

  it('contains fetch call to endpoint', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('fetch(');
  });

  it('contains auth pill element', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('auth-pill');
  });

  it('contains sample chips element', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    expect(res.body).toContain('id="chips"');
  });

  it('embeds sample data as JSON', async () => {
    const res = await server.inject({ method: 'GET', url: '/playground' });
    // SAMPLES array is embedded via JSON.stringify(SAMPLES) in the script
    expect(res.body).toContain('"label"');
    expect(res.body).toContain('"text"');
  });
});
