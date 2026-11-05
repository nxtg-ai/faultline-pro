/**
 * buildServer(deps): the one verify_claims tool, with an injectable transport.
 *
 * The hosted endpoint in packages/api builds the tool by calling this with a
 * hosted transport whose fetch runs POST /scan in-process. These tests check
 * the deps reach the tool and that the tool list does not depend on them.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import type { VerifyDeps } from '../src/verify.js';

async function connected(deps?: VerifyDeps) {
  const server = deps === undefined ? buildServer() : buildServer(deps);
  const client = new Client({ name: 'build-server-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('buildServer(deps)', () => {
  it('lists the same tool with or without deps', async () => {
    const plain = await connected();
    const withDeps = await connected({ transport: { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' }, audit: false });
    try {
      const a = await plain.client.listTools();
      const b = await withDeps.client.listTools();
      expect(a.tools.map((t) => t.name)).toEqual(['verify_claims']);
      expect(b).toEqual(a);
    } finally {
      await plain.close();
      await withDeps.close();
    }
  });

  it('runs the tool on the injected transport and fetch', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          provider: 'Google Gemini',
          claims: [{ id: 'c1', text: 'Claim one', type: 'fact', importance: 5 }],
          verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [{ title: 's', uri: 'https://example.org' }] } },
          overallRisk: 'low',
          billing: { billedClaims: 1, unbilled: [] },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const { client, close } = await connected({
      transport: { mode: 'hosted', apiUrl: 'https://in-process.test', apiKey: 'caller-key' },
      fetchImpl,
      audit: false,
    });
    try {
      const result = await client.callTool({ name: 'verify_claims', arguments: { text: 'Claim one.' } });
      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://in-process.test/scan');
      expect(calls[0].headers['x-api-key']).toBe('caller-key');
      expect(calls[0].body).toEqual({ text: 'Claim one.' });
      const out = result.structuredContent as Record<string, unknown>;
      expect(out.mode).toBe('hosted');
      expect(out.overall_risk).toBe('low');
      expect(out.billing).toEqual({ billedClaims: 1, unbilled: [] });
      expect(out.audit_ref).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('a refused scan comes back as a tool error that says nothing was checked', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 402,
      json: async () => ({}),
      text: async () => '{"error":"claim_cap_reached"}',
    })) as unknown as typeof fetch;
    const { client, close } = await connected({ transport: { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' }, fetchImpl, audit: false });
    try {
      const result = await client.callTool({ name: 'verify_claims', arguments: { text: 'Claim one.' } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/\(402\)/);
      expect(text).toMatch(/claim_cap_reached/);
      expect(text).toMatch(/NOT a verdict/);
    } finally {
      await close();
    }
  });
});
