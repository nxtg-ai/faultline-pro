/**
 * Packaging regression tests.
 *
 * `@nxtg/faultline@0.9.1` shipped to npm unable to run a single command —
 * `faultline version`, `faultline scan`, and the README's own no-API-key
 * `faultline scan --demo` quick start all died with:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '.../consensus/consensus_engine.js'
 *       imported from .../cli/scan.ts
 *
 * The cause was a one-word omission: `package.json` `files` listed every source
 * directory except `consensus/` and `governance/`, both of which the shipped
 * code imports. Nothing in the repo could catch it, because every test ran
 * against the working tree, where those directories are present. The suite was
 * green and the product was dead on arrival.
 *
 * These tests close that gap by asserting against the PUBLISHED FILE LIST
 * rather than the working tree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
  files: string[];
  bin: Record<string, string>;
  version: string;
};

/** Directories the `files` array publishes, without trailing slashes. */
const shipped = new Set(pkg.files.map((f) => f.replace(/\/$/, '')));

/** Source directories that exist in the package and are not dev-only. */
const DEV_ONLY = new Set([
  'node_modules',
  'tests',
  'coverage',
  'scripts',
  'vscode-extension',
  '.faultline',
]);

function sourceDirs(): string[] {
  return readdirSync(pkgRoot).filter(
    (name) =>
      !name.startsWith('.') &&
      !DEV_ONLY.has(name) &&
      statSync(join(pkgRoot, name)).isDirectory(),
  );
}

/** Every `from '../<dir>/...'` import found in the shipped source. */
function importedDirs(): Set<string> {
  const found = new Set<string>();
  const pattern = /from\s+'\.\.\/([a-z0-9_-]+)\//gi;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DEV_ONLY.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf-8');
        for (const m of src.matchAll(pattern)) found.add(m[1]);
      }
    }
  };

  for (const dir of sourceDirs()) {
    if (shipped.has(dir)) walk(join(pkgRoot, dir));
  }
  return found;
}

describe('package.json files[] — everything the shipped code imports must ship', () => {
  it('publishes every directory imported by shipped source', () => {
    const missing = [...importedDirs()].filter((d) => !shipped.has(d)).sort();

    expect(
      missing,
      `These directories are imported by published code but are NOT in package.json "files", ` +
        `so they are absent from the npm tarball and every command fails at import time: ` +
        `${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('publishes consensus/ and governance/ specifically', () => {
    // Named explicitly: these two are the exact omission that shipped in 0.9.1.
    expect(shipped.has('consensus')).toBe(true);
    expect(shipped.has('governance')).toBe(true);
  });

  it('publishes the directory the bin entry points into', () => {
    for (const target of Object.values(pkg.bin)) {
      const topLevel = target.replace(/^\.\//, '').split('/')[0];
      expect(shipped.has(topLevel), `bin points at ${target} but "${topLevel}" is not published`).toBe(
        true,
      );
    }
  });

  it('reports the manifest version from the binary itself', async () => {
    // The version-parity gate compares manifests and the deployed API. It never
    // asks the CLI what version it thinks it is — so 0.9.1 shipped while
    // `faultline version` printed 0.8.0, and that number was stamped into
    // telemetry and compliance reports.
    const { main } = await import('../cli/index');
    const result = await main(['version']);
    expect(result.output).toContain(pkg.version);
  });

  it('lists no directory that does not exist', () => {
    const ghosts = [...shipped]
      .filter((f) => !f.endsWith('.ts'))
      .filter((f) => {
        try {
          return !statSync(join(pkgRoot, f)).isDirectory();
        } catch {
          return true;
        }
      });
    expect(ghosts, `files[] lists paths that do not exist: ${ghosts.join(', ')}`).toEqual([]);
  });
});
