#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '..', 'cli', 'index.ts');

try {
  execFileSync(
    process.execPath,
    ['--import', 'tsx', cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
} catch (err) {
  // execFileSync throws on non-zero exit; the child already printed output
  if (err && typeof err === 'object' && 'status' in err) {
    process.exit(err.status);
  }
  process.exit(1);
}
