#!/usr/bin/env node

/**
 * faultline-mcp — the verify_claims MCP stdio server, shipped as a bin of
 * @nxtg/faultline:
 *
 *   npx -y -p @nxtg/faultline faultline-mcp
 *
 * The package ships TypeScript sources, so the server runs under the tsx
 * loader. tsx is resolved via createRequire against THIS file's URL rather
 * than as a bare specifier: a bare '--import tsx' resolves from the caller's
 * cwd and breaks under npx and global installs.
 *
 * The child inherits stdio, so the MCP JSON-RPC stream on stdin/stdout passes
 * straight through. Nothing in this file may write to stdout. Signals are
 * forwarded so an MCP client stopping the server does not orphan the child.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '..', 'cli', 'mcp', 'index.ts');

const pkgRequire = createRequire(import.meta.url);
let tsxLoaderUrl;
try {
  tsxLoaderUrl = pathToFileURL(pkgRequire.resolve('tsx')).href;
} catch {
  process.stderr.write(
    'faultline-mcp: could not resolve the tsx loader from this install. ' +
      'Run via `npx -y -p @nxtg/faultline faultline-mcp` or reinstall `npm i -g @nxtg/faultline`.\n',
  );
  process.exit(1);
}

const child = spawn(process.execPath, ['--import', tsxLoaderUrl, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(`faultline-mcp: failed to start — ${err.message}\n`);
  process.exit(1);
});
