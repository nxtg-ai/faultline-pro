/**
 * Workspace Validation Tests — N-18 React Workspace Split
 *
 * Asserts structural invariants of the npm workspace:
 * - @nxtg/faultline (CLI) has zero React dependencies
 * - @nxtg/faultline-web (web) has React dependencies
 * - Root is a private workspace coordinator
 *
 * These tests guard against accidental re-introduction of React into
 * the CLI package (which would bloat installs for CLI-only users).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, '..');
const repoRoot = resolve(__dirname, '../../..');

function readPkg(pkgPath: string): Record<string, any> {
  return JSON.parse(readFileSync(pkgPath, 'utf-8'));
}

describe('N-18 Workspace Validation: packages/cli (@nxtg/faultline)', () => {
  let cliPkg: Record<string, any>;

  beforeAll(() => {
    cliPkg = readPkg(resolve(cliRoot, 'package.json'));
  });

  it('CLI package name is @nxtg/faultline', () => {
    expect(cliPkg.name).toBe('@nxtg/faultline');
  });

  it('CLI dependencies do not include react', () => {
    expect(cliPkg.dependencies?.react).toBeUndefined();
  });

  it('CLI dependencies do not include react-dom', () => {
    expect(cliPkg.dependencies?.['react-dom']).toBeUndefined();
  });

  it('CLI dependencies do not include lucide-react', () => {
    expect(cliPkg.dependencies?.['lucide-react']).toBeUndefined();
  });

  it('CLI dependencies do not include vite', () => {
    expect(cliPkg.dependencies?.vite).toBeUndefined();
  });

  it('CLI dependencies include tsx (runtime TypeScript execution)', () => {
    expect(cliPkg.dependencies?.tsx).toBeDefined();
  });

  it('CLI dependencies include @google/genai (LLM provider)', () => {
    expect(cliPkg.dependencies?.['@google/genai']).toBeDefined();
  });

  it('CLI package has bin entry for faultline command', () => {
    expect(cliPkg.bin?.faultline).toBeDefined();
    expect(cliPkg.bin.faultline).toBe('./bin/faultline.js');
  });

  it('CLI package files array does not reference services/ (web-only code)', () => {
    const files: string[] = cliPkg.files ?? [];
    expect(files).not.toContain('services/');
    expect(files.some((f: string) => f.startsWith('services'))).toBe(false);
  });

  it('CLI bin entry file exists at packages/cli/bin/faultline.js', () => {
    const binPath = resolve(cliRoot, 'bin', 'faultline.js');
    expect(existsSync(binPath)).toBe(true);
  });
});

describe('N-18 Workspace Validation: packages/web (@nxtg/faultline-web)', () => {
  let webPkg: Record<string, any>;

  beforeAll(() => {
    webPkg = readPkg(resolve(repoRoot, 'packages', 'web', 'package.json'));
  });

  it('Web package name is @nxtg/faultline-web', () => {
    expect(webPkg.name).toBe('@nxtg/faultline-web');
  });

  it('Web package dependencies include react', () => {
    expect(webPkg.dependencies?.react).toBeDefined();
  });

  it('Web package dependencies include react-dom', () => {
    expect(webPkg.dependencies?.['react-dom']).toBeDefined();
  });

  it('Web package dependencies include lucide-react', () => {
    expect(webPkg.dependencies?.['lucide-react']).toBeDefined();
  });
});

describe('N-18 Workspace Validation: monorepo root', () => {
  let rootPkg: Record<string, any>;

  beforeAll(() => {
    rootPkg = readPkg(resolve(repoRoot, 'package.json'));
  });

  it('Root package.json is private (workspace root, not published)', () => {
    expect(rootPkg.private).toBe(true);
  });

  it('Root package.json has workspaces configuration', () => {
    expect(rootPkg.workspaces).toBeDefined();
    expect(Array.isArray(rootPkg.workspaces)).toBe(true);
  });

  it('Root workspaces includes packages/*', () => {
    const workspaces: string[] = rootPkg.workspaces ?? [];
    expect(workspaces.some((w: string) => w.includes('packages'))).toBe(true);
  });

  it('Root dependencies do not include react (moved to packages/web)', () => {
    expect(rootPkg.dependencies?.react).toBeUndefined();
  });

  it('Root dependencies do not include react-dom (moved to packages/web)', () => {
    expect(rootPkg.dependencies?.['react-dom']).toBeUndefined();
  });

  it('Root dependencies do not include lucide-react (moved to packages/web)', () => {
    expect(rootPkg.dependencies?.['lucide-react']).toBeUndefined();
  });
});
