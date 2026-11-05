/**
 * Entry point for the faultline-mcp stdio server.
 *
 * Diagnostics go to stderr only — stdout is the JSON-RPC channel.
 */

import { main } from './server.js';

main().catch((err: unknown) => {
  process.stderr.write(
    `faultline-mcp: fatal — ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(1);
});
