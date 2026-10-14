/**
 * GraphQL is off (emma-soul al:95753eecd4a6025b, CRITICAL). Its key check fired
 * only on an exact POST /graphql, so `POST /graphql?x=1` or `GET /graphql`
 * reached every resolver with no key, createKey included. Until the scoped fix
 * passes two reviews, every method and URL variant under /graphql is a 404.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import type { FastifyInstance } from 'fastify';

const MUTATION = JSON.stringify({ query: 'mutation { createKey(name: "x", permissions: ["admin"]) { id } }' });

describe('GraphQL is off', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    delete process.env.FAULTLINE_GRAPHQL;
    process.env.FAULTLINE_API_KEY = 'off-test-key';
    resetKeyStore();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it.each([
    ['POST', '/graphql'],
    ['POST', '/graphql?x=1'],
    ['GET', '/graphql'],
    ['GET', '/graphql?query=%7Bscans%7Bid%7D%7D'],
  ] as const)('GO-1. %s %s answers 404 without a key', async (method, url) => {
    // Only variants that reach GraphQL when it is on, so each goes red if the
    // switch fails. Trailing slash, other case and /graphiql 404 either way
    // (post-deploy Opus seat on 0ae37a0: those three proved nothing).
    const res = await server.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: MUTATION } : {}) });
    expect(res.statusCode).toBe(404);
  });

  it('GO-2. an exact POST with the server key answers 404 too, and no key is created', async () => {
    const res = await server.inject({ method: 'POST', url: '/graphql', headers: { 'x-api-key': 'off-test-key', 'content-type': 'application/json' }, body: MUTATION });
    expect(res.statusCode).toBe(404);
    expect(getKeyStore().list().length).toBe(0);
  });
});
