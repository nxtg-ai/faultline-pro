// @vitest-environment node
// Validates: N-1.18.11.7.35 (the @nxtg/faultline release that puts the faultline-mcp bin on npm:
// one-command `npx -y -p @nxtg/faultline faultline-mcp`, same verify_claims tool contract as the
// hosted /mcp, published by the existing tokenless trusted-publishing workflow)
/**
 * Release gate for the faultline-mcp bin on npm.
 *
 * mcp-bin.test.ts drives the bin from the working tree. That is not what npm
 * serves. This file packs packages/cli with `npm pack` (the same file list
 * publish.yml uploads), unpacks the tarball into a temp dir OUTSIDE the repo,
 * and starts the bin from there, so a file missing from `files`, or a bin that
 * only runs inside the monorepo, fails here.
 *
 * The unpacked package gets one thing it would get from `npm install`: its
 * dependencies, as a symlink to the repo's installed node_modules. No network:
 * the key is fake, FAULTLINE_API_URL points at a closed loopback port, proxy
 * variables are stripped, and verify_claims is only listed, never called.
 *
 * The release half asserts what makes this tarball publishable: npm holds
 * 0.11.1 (2026-10-02), which predates the bin, and publish.yml cannot
 * republish a version, so the packed version must be newer, and the CHANGELOG
 * and README must describe the bin for that version.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const REPO_ROOT = join(PKG_DIR, '..', '..');

/** The last @nxtg/faultline on npm (2026-10-02). It has no faultline-mcp bin. */
const NPM_VERSION_WITHOUT_BIN = '0.11.1';
const NPX_COMMAND = 'npx -y -p @nxtg/faultline faultline-mcp';

function semverGt(a: string, b: string): boolean {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/** Child env: no proxy, no provider or Faultline keys from the host, no history writes. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) continue;
    if (/^(FAULTLINE_|GEMINI_|OPENAI_|ANTHROPIC_|PERPLEXITY_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, FAULTLINE_MCP_NO_HISTORY: '1', ...extra };
}

let workDir = '';
let tarball = '';
let unpacked = '';
let tarList: string[] = [];
let packedPkg: { name: string; version: string; bin: Record<string, string> };

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'faultline-npm-release-'));
  const out = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', workDir],
    { cwd: PKG_DIR, encoding: 'utf-8', env: { ...process.env, npm_config_offline: 'true' } },
  );
  const [info] = JSON.parse(out) as Array<{ filename: string }>;
  tarball = join(workDir, info.filename.replace(/^@[^/]+\//, '').replace(/\//g, '-'));
  if (!existsSync(tarball)) {
    const tgz = readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
    tarball = join(workDir, tgz[0]);
  }
  tarList = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
  execFileSync('tar', ['-xzf', tarball, '-C', workDir]);
  unpacked = join(workDir, 'package');
  packedPkg = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf-8'));
  // What `npm install` would add: the package's dependencies. Offline, from the repo's install.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(unpacked, 'node_modules'), 'dir');
}, 120_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('npm pack @nxtg/faultline — the tarball publish.yml uploads', () => {
  it('contains the faultline-mcp bin and the cli/mcp entry it spawns', () => {
    expect(tarList.length).toBeGreaterThan(0);
    expect(tarList).toContain('package/bin/faultline-mcp.js');
    expect(tarList).toContain('package/cli/mcp/index.ts');
    expect(tarList).toContain('package/cli/mcp/server.ts');
    expect(tarList).toContain('package/cli/mcp/verify.ts');
    // The bin spawns ../cli/mcp/index.ts relative to itself; that path must resolve in the tarball.
    const bin = readFileSync(join(unpacked, 'bin', 'faultline-mcp.js'), 'utf-8');
    expect(bin).toContain("resolve(__dirname, '..', 'cli', 'mcp', 'index.ts')");
  });

  it('declares faultline-mcp in the packed manifest, beside faultline', () => {
    expect(packedPkg.name).toBe('@nxtg/faultline');
    expect(packedPkg.bin['faultline-mcp']).toBe('./bin/faultline-mcp.js');
    expect(packedPkg.bin.faultline).toBe('./bin/faultline.js');
  });

  it('answers an MCP tools/list over stdio from the unpacked tarball with verify_claims', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(unpacked, 'bin', 'faultline-mcp.js')],
      cwd: workDir,
      env: childEnv({
        FAULTLINE_API_KEY: 'fl_fake_release_probe_key_not_real',
        // Closed loopback port: if anything tried to scan, it would fail at once, offline.
        FAULTLINE_API_URL: 'http://127.0.0.1:9',
      }),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    const client = new Client({ name: 'faultline-npm-release-probe', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(1);
      expect(tools.map((t) => t.name)).toEqual(['verify_claims']);
      const schema = tools[0].inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toEqual(['text']);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['max_claims', 'provider', 'text']);
    } finally {
      await client.close();
    }
    // Nothing about a scan, a key or a provider call: the tool was listed, never called.
    expect(stderr).not.toMatch(/ECONNREFUSED|fatal/i);
  }, 60_000);
});

describe('release 0.12.0 — a version npm does not have yet, documented', () => {
  it('packs a version newer than 0.11.1, the npm release that predates the bin', () => {
    expect(packedPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      semverGt(packedPkg.version, NPM_VERSION_WITHOUT_BIN),
      `packed ${packedPkg.version}; publish.yml cannot republish ${NPM_VERSION_WITHOUT_BIN}`,
    ).toBe(true);
    expect(tarball.endsWith(`faultline-${packedPkg.version}.tgz`)).toBe(true);
  });

  it('has a CHANGELOG section for the packed version that names the bin and the npx command', () => {
    const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
    const heading = `## [v${packedPkg.version}] — `;
    const start = changelog.indexOf(heading);
    expect(start, `CHANGELOG.md has no "${heading}" section`).toBeGreaterThan(-1);
    const next = changelog.indexOf('\n## [', start + heading.length);
    const section = changelog.slice(start, next === -1 ? undefined : next);
    expect(section).toContain('faultline-mcp');
    expect(section).toContain(NPX_COMMAND);
    // The section is the released one: an empty [Unreleased] stays above it.
    expect(changelog.indexOf('## [Unreleased]')).toBeLessThan(start);
  });

  it('README tells an MCP client how to run it with a key, and no longer says npx cannot find it', () => {
    const readme = readFileSync(join(PKG_DIR, 'README.md'), 'utf-8');
    expect(readme).toContain(NPX_COMMAND);
    expect(readme).toContain('FAULTLINE_API_KEY');
    expect(readme).toContain('verify_claims');
    expect(readme).toContain('https://faultline-api.fly.dev/mcp');
    expect(readme).toContain(`@nxtg/faultline@${packedPkg.version}`);
    expect(readme).not.toContain('`npx` cannot find it');
  });
});
