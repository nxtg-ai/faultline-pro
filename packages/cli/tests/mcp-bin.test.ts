// @vitest-environment node
// Validates: N-1.18.11.7.35 (an agent or developer installs the verify_claims MCP server from npm
// with one command — `npx -y -p @nxtg/faultline faultline-mcp` — and calls it with a key; same
// tool contract as the hosted /mcp)
/**
 * The verify_claims MCP server ships as the `faultline-mcp` bin of @nxtg/faultline.
 *
 * Every test here drives the REAL bin as a child process over stdio, exactly as
 * an MCP client launched by npx does. Nothing imports the server in-process:
 * the thing being proven is that the shipped executable works.
 *
 * Contract: the hosted /mcp is not reachable from this repo (2026-11-01:
 * POST https://faultline-api.fly.dev/mcp → 404, https://faultline.nxtg.ai/mcp → 404),
 * so the reference contract is the repo's own MCP server, packages/mcp. The
 * fixture below freezes it, and the parity test compares the two bins'
 * tools/list byte for byte so the copies cannot drift apart silently.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const BIN = join(PKG_DIR, 'bin', 'faultline-mcp.js');
const REFERENCE_BIN = join(PKG_DIR, '..', 'mcp', 'bin', 'faultline-mcp.js');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
};

/** The verify_claims tool contract, frozen from packages/mcp/src/server.ts. */
const CONTRACT = {
  tools: ['verify_claims'],
  required: ['text'],
  properties: ['max_claims', 'provider', 'text'],
  providerEnum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'],
  outputKeys: [
    'claims',
    'claims_total',
    'degraded',
    'grounded',
    'mode',
    'overall_risk',
    'provider',
    'risk_score',
    'summary',
    'truncated',
    'unchecked_count',
    'unsourced_count',
  ],
  /** Present only when an audit record was (audit_ref, audit_path) or was not (audit_skipped) written. */
  optionalOutputKeys: ['audit_path', 'audit_ref', 'audit_skipped'],
};

/** Child env: no proxy (the fake API is on loopback), no history writes, no stray keys. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) continue;
    if (/^(FAULTLINE_|GEMINI_|OPENAI_|ANTHROPIC_|PERPLEXITY_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, FAULTLINE_MCP_NO_HISTORY: '1', ...extra };
}

async function connect(bin: string, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  const client = new Client({ name: 'faultline-bin-probe', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

describe('package manifest — faultline-mcp is a bin of @nxtg/faultline', () => {
  it('declares the faultline-mcp bin, and the file it points at exists', () => {
    expect(pkg.name).toBe('@nxtg/faultline');
    expect(pkg.bin['faultline-mcp']).toBe('./bin/faultline-mcp.js');
    expect(existsSync(join(PKG_DIR, pkg.bin['faultline-mcp']))).toBe(true);
  });

  it('keeps `faultline` as the bin `npx -y @nxtg/faultline` runs', () => {
    // npx runs the bin named after the unscoped package; adding a second bin must not change that.
    expect(pkg.bin.faultline).toBe('./bin/faultline.js');
  });

  it('ships every runtime import of the MCP server as a dependency, not a devDependency', () => {
    const dir = join(PKG_DIR, 'cli', 'mcp');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const external = new Set<string>();
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf-8');
      for (const m of src.matchAll(/^import\s+(?!type\b)[^'"]*from\s+'([^']+)'/gm)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        external.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
    expect([...external].sort()).toEqual(['@modelcontextprotocol/sdk', 'zod']);
    for (const dep of external) expect(pkg.dependencies, dep).toHaveProperty(dep);
  });

  it('puts the bin and the server sources in the published tarball', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PKG_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [packed] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const paths = packed.files.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain('bin/faultline-mcp.js');
    for (const f of ['index.ts', 'server.ts', 'verify.ts', 'audit.ts']) {
      expect(paths).toContain(`cli/mcp/${f}`);
    }
  }, 60_000);
});

describe('faultline-mcp bin — stdio handshake and tool contract', () => {
  it('answers initialize with the server identity and the package version', async () => {
    const { client } = await connect(BIN, childEnv());
    try {
      const info = client.getServerVersion();
      expect(info?.name).toBe('faultline');
      expect(info?.version).toBe(
        (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as { version: string }).version,
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it('advertises exactly verify_claims with the frozen input contract', async () => {
    const { client } = await connect(BIN, childEnv());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(CONTRACT.tools);
      const schema = tools[0].inputSchema as {
        properties: Record<string, { type?: string; enum?: string[]; minLength?: number }>;
        required: string[];
      };
      expect(Object.keys(schema.properties).sort()).toEqual(CONTRACT.properties);
      expect(schema.required).toEqual(CONTRACT.required);
      expect(schema.properties.text.type).toBe('string');
      expect(schema.properties.text.minLength).toBe(1);
      expect(schema.properties.max_claims.type).toBe('integer');
      expect(schema.properties.provider.enum).toEqual(CONTRACT.providerEnum);
      expect(tools[0].description).toMatch(/degraded: true/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('lists the same tool definition as the reference server in packages/mcp', async () => {
    const ours = await connect(BIN, childEnv());
    const ref = await connect(REFERENCE_BIN, childEnv());
    try {
      const [a, b] = await Promise.all([ours.client.listTools(), ref.client.listTools()]);
      expect(a.tools.length).toBeGreaterThan(0);
      expect(a.tools).toEqual(b.tools);
    } finally {
      await Promise.all([ours.client.close(), ref.client.close()]);
    }
  }, 30_000);

  it('says on stderr that it verifies nothing when it has neither key', async () => {
    const { client, stderr } = await connect(BIN, childEnv());
    try {
      await client.listTools();
      expect(stderr()).toMatch(/SYNTHETIC/);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('faultline-mcp bin — called with a key runs on the hosted API', () => {
  let api: Server;
  let apiUrl: string;
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        if (req.headers['x-api-key'] !== 'fl_test_hosted_key') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":"Unauthorized"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            input: 'x',
            provider: 'gemini',
            timestamp: '2026-11-01T00:00:00.000Z',
            overallRisk: 'low',
            claims: [{ id: 'c1', text: 'Water boils at 100 C at sea level.', type: 'fact', importance: 5 }],
            verifications: {
              c1: {
                claimId: 'c1',
                status: 'supported',
                explanation: 'Standard reference value.',
                sources: [{ title: 'NIST', uri: 'https://www.nist.gov/' }],
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
  });

  it('sends the key, returns a hosted verdict in the contract shape', async () => {
    const { client, stderr } = await connect(
      BIN,
      childEnv({ FAULTLINE_API_KEY: 'fl_test_hosted_key', FAULTLINE_API_URL: apiUrl }),
    );
    try {
      const res = await client.callTool({
        name: 'verify_claims',
        arguments: { text: 'Water boils at 100 C at sea level.' },
      });
      expect(res.isError).toBeFalsy();

      expect(seen.length).toBe(1);
      expect(seen[0].url).toBe('/scan');
      expect(seen[0].headers['x-api-key']).toBe('fl_test_hosted_key');
      expect(JSON.parse(seen[0].body)).toEqual({ text: 'Water boils at 100 C at sea level.' });

      const out = res.structuredContent as Record<string, unknown>;
      const keys = Object.keys(out);
      expect(keys.filter((k) => !CONTRACT.optionalOutputKeys.includes(k)).sort()).toEqual(
        CONTRACT.outputKeys,
      );
      // History is off in the child env, so the record is skipped and says why.
      expect(out.audit_skipped).toBe('FAULTLINE_MCP_NO_HISTORY=1');
      expect(out).not.toHaveProperty('audit_ref');
      expect(out.mode).toBe('hosted');
      expect(out.grounded).toBe(true);
      expect(out.degraded).toBe(false);
      expect(out.claims_total).toBe(1);
      expect(out.claims).toEqual([
        expect.objectContaining({
          claim: 'Water boils at 100 C at sea level.',
          verdict: 'VERIFIED',
          evidence_urls: ['https://www.nist.gov/'],
        }),
      ]);
      expect(stderr()).toMatch(/hosted API/);
      expect(stderr()).not.toContain('fl_test_hosted_key');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('reports a rejected key as a tool failure, never as a verdict', async () => {
    const { client } = await connect(
      BIN,
      childEnv({ FAULTLINE_API_KEY: 'fl_wrong_key', FAULTLINE_API_URL: apiUrl }),
    );
    try {
      const res = await client.callTool({ name: 'verify_claims', arguments: { text: 'Paris is in France.' } });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/401/);
      expect(text).toMatch(/not a verdict/i);
      expect(res.structuredContent).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 30_000);
});
