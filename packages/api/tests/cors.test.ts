import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('CORS', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('C1. allowed origin faultline.nxtg.ai → CORS headers present', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://faultline.nxtg.ai' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://faultline.nxtg.ai');
  });

  it('C2. allowed origin subdomain *.nxtg.ai → CORS headers present', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.nxtg.ai' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.nxtg.ai');
  });

  it('C3. disallowed origin → no CORS header', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.com' },
    });
    // @fastify/cors returns 500 or omits the header for disallowed origins
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
