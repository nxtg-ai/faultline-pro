#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '..', 'cli', 'index.ts');

// Resolve tsx loader relative to this package's own node_modules, not from CWD.
// '--import tsx' (bare specifier) resolves from CWD and fails in global/npx installs.
// createRequire(import.meta.url) scopes resolution to the package install directory,
// guaranteeing tsx is found in the package's own dependency tree.
const pkgRequire = createRequire(import.meta.url);
const tsxLoaderUrl = `file://${pkgRequire.resolve('tsx')}`;

try {
  execFileSync(
    process.execPath,
    ['--import', tsxLoaderUrl, cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
} catch (err) {
  // execFileSync throws on non-zero exit; the child already printed output
  if (err && typeof err === 'object' && 'status' in err) {
    process.exit(err.status);
  }
  process.exit(1);
}
