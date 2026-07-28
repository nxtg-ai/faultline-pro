#!/usr/bin/env node

/**
 * npx/global-install entry for the Faultline MCP stdio server.
 *
 * The package ships TypeScript sources (same convention as @nxtg/faultline), so
 * it runs under the tsx loader. tsx is resolved via createRequire against THIS
 * file's URL rather than as a bare specifier: a bare '--import tsx' resolves
 * from the caller's cwd and breaks under npx and global installs, where the
 * cwd has no tsx in its dependency tree.
 *
 * The child inherits stdio, so the MCP JSON-RPC stream on stdin/stdout passes
 * straight through. Signals are forwarded so an MCP client terminating the
 * server does not leave the child orphaned.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '..', 'src', 'index.ts');

const pkgRequire = createRequire(import.meta.url);
let tsxLoaderUrl;
try {
  tsxLoaderUrl = `file://${pkgRequire.resolve('tsx')}`;
} catch {
  process.stderr.write(
    'faultline-mcp: could not resolve the tsx loader from this install. ' +
      'Reinstall with `npm i -g @nxtg/faultline-mcp` or run via `npx -y @nxtg/faultline-mcp`.\n',
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
