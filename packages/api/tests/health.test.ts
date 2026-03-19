import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('GET /health — subsystem info', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('H1. /health returns status, service, version, subsystems, providers', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('faultline-api');
    expect(body.version).toBe('0.2.0');
    expect(body.subsystems).toBeDefined();
    expect(body.subsystems.keyStore).toBeDefined();
    expect(body.subsystems.scanEngine).toBeDefined();
    expect(body.providers).toBeDefined();
  });

  it('H2. /health subsystems.keyStore.activeKeys is a non-negative integer', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body);
    expect(typeof body.subsystems.keyStore.activeKeys).toBe('number');
    expect(body.subsystems.keyStore.activeKeys).toBeGreaterThanOrEqual(0);
  });
});
