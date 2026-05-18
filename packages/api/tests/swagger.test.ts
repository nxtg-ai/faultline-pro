import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { FAULTLINE_API_VERSION } from '../src/version.js';
import type { FastifyInstance } from 'fastify';

describe('D-155: Swagger UI', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'swagger-test-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SW1. GET /docs returns 200 HTML', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('SW2. GET /docs/json returns OpenAPI JSON spec', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec).toHaveProperty('openapi');
    expect(spec.info.title).toBe('Faultline API');
    expect(spec.info.version).toBe(FAULTLINE_API_VERSION);
  });

  it('SW3. OpenAPI spec includes server URLs', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs/json' });
    const spec = res.json();
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.servers.length).toBeGreaterThan(0);
  });

  it('SW4. OpenAPI spec has apiKey security scheme', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs/json' });
    const spec = res.json();
    expect(spec.components?.securitySchemes?.apiKey).toBeDefined();
    expect(spec.components.securitySchemes.apiKey.in).toBe('header');
  });

  it('SW5. GET /docs/yaml returns OpenAPI YAML spec', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs/yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
  });
});
