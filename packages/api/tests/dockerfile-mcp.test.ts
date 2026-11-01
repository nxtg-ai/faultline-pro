// Validates: hosted MCP endpoint contract (POST /mcp): the deployed image carries what it needs
// NEXUS: hosted remote MCP, same verify_claims tool, every POST /scan gate applies
//
// The API image (root Dockerfile, used by packages/api/fly.toml) runs POST /mcp,
// which builds its tool from packages/mcp. The runtime stage installs production
// dependencies from the workspace manifests it is given, so packages/mcp's
// manifest must be there before `npm ci --omit=dev` (that is what links the
// workspace and installs the MCP SDK and zod), and its sources must reach the
// image. A static check: the image build itself runs in the deploy workflow.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const flyToml = readFileSync(join(ROOT, 'packages/api/fly.toml'), 'utf8');

/** The Dockerfile's lines for one stage, by its `AS name`. */
function stage(name: string): string[] {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\b`, 'i').test(l));
  expect(start, `stage ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l));
  return lines.slice(start, end === -1 ? undefined : end).map((l) => l.trim());
}

describe('the API image carries the hosted MCP endpoint', () => {
  it('fly deploys the root Dockerfile', () => {
    expect(flyToml).toMatch(/dockerfile\s*=\s*"\.\.\/\.\.\/Dockerfile"/);
  });

  it('the runtime stage copies the mcp manifest before installing production dependencies', () => {
    const runtime = stage('runtime');
    const manifest = runtime.findIndex((l) => /^COPY\s+packages\/mcp\/package\.json\s/.test(l));
    const install = runtime.findIndex((l) => /^RUN\s+npm ci\b.*--omit=dev/.test(l));
    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(manifest);
  });

  it('the builder installs with the mcp manifest and copies every package, mcp sources included', () => {
    const builder = stage('builder');
    const manifest = builder.findIndex((l) => /^COPY\s+packages\/mcp\/package\.json\s/.test(l));
    const install = builder.findIndex((l) => /^RUN\s+npm ci\b/.test(l));
    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(manifest);
    expect(builder).toContain('COPY packages/ ./packages/');
    expect(stage('runtime')).toContain('COPY --from=builder /build/packages ./packages');
  });

  it('the API declares the packages /mcp imports, so a production install has them', () => {
    const api = JSON.parse(readFileSync(join(ROOT, 'packages/api/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(api.dependencies['@nxtg/faultline-mcp']).toBeDefined();
    expect(api.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
    const mcp = JSON.parse(readFileSync(join(ROOT, 'packages/mcp/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    // One SDK version for the stdio server and the hosted endpoint.
    expect(api.dependencies['@modelcontextprotocol/sdk']).toBe(mcp.dependencies['@modelcontextprotocol/sdk']);
  });
});
