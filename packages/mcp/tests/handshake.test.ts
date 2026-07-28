/**
 * DoD probe §4.1 — the server starts and answers an MCP `tools/list` handshake.
 *
 * This spawns the REAL bin entry as a child process and speaks newline-delimited
 * JSON-RPC over its stdio, exactly as an MCP client does. It deliberately does
 * not import the server in-process: the thing being proven is that the shipped
 * executable works, including the tsx-loader resolution that npx installs
 * depend on.
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'faultline-mcp.js');

interface RpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Drive one MCP session: initialize → initialized → the supplied requests.
 * Resolves with every response received, keyed by request id.
 */
function mcpSession(requests: Array<Record<string, unknown>>): Promise<{
  responses: Map<number, RpcResponse>;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No provider key: the server must still handshake. Verification quality
      // is a separate probe; this one is about protocol liveness.
      env: { ...process.env, FAULTLINE_MCP_NO_HISTORY: '1' },
    });

    const responses = new Map<number, RpcResponse>();
    let stdoutBuf = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(`handshake timed out. stderr:\n${stderr}\nstdout:\n${stdoutBuf}`));
    }, 25_000);

    function finish(err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGTERM');
      if (err) reject(err);
      else resolvePromise({ responses, stderr });
    }

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line);
        } catch {
          // A non-JSON line on stdout is itself a protocol violation; surface it.
          finish(new Error(`non-JSON line on stdout (corrupts MCP stream): ${line}`));
          return;
        }
        if (typeof msg.id === 'number') responses.set(msg.id, msg);

        // Once initialize (id 1) is answered, send initialized + the rest.
        if (msg.id === 1) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
          );
          for (const req of requests) {
            child.stdin.write(JSON.stringify(req) + '\n');
          }
        }

        if (requests.length > 0) {
          const lastId = requests[requests.length - 1].id as number;
          if (responses.has(lastId)) finish();
        } else if (responses.has(1)) {
          finish();
        }
      }
    });

    child.on('error', (err) => finish(err as Error));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`server exited early with code ${code}. stderr:\n${stderr}`));
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'faultline-dod-probe', version: '1.0.0' },
        },
      }) + '\n',
    );
  });
}

describe('DoD §4.1 — MCP stdio handshake', () => {
  it('answers initialize with server identity', async () => {
    const { responses } = await mcpSession([]);
    const init = responses.get(1);
    expect(init, 'no response to initialize').toBeDefined();
    expect(init!.error).toBeUndefined();
    expect(init!.result?.serverInfo).toMatchObject({ name: 'faultline' });
    expect(init!.result?.protocolVersion).toBeTypeOf('string');
  });

  it('answers tools/list with verify_claims and its schema', async () => {
    const { responses } = await mcpSession([
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    const list = responses.get(2);
    expect(list, 'no response to tools/list').toBeDefined();
    expect(list!.error).toBeUndefined();

    const tools = list!.result?.tools as Array<{
      name: string;
      description?: string;
      inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
    }>;

    expect(Array.isArray(tools)).toBe(true);
    const verify = tools.find((t) => t.name === 'verify_claims');
    expect(verify, 'verify_claims not advertised').toBeDefined();
    expect(verify!.inputSchema?.properties).toHaveProperty('text');
    expect(verify!.inputSchema?.properties).toHaveProperty('max_claims');
    expect(verify!.inputSchema?.required).toContain('text');
  });

  it('does not advertise verify_url — cut from v1, no URL ingestion in the engine', async () => {
    const { responses } = await mcpSession([
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    const tools = responses.get(2)!.result?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).not.toContain('verify_url');
  });

  it('warns on stderr — never stdout — when running without a provider key', async () => {
    const { stderr } = await mcpSession([]);
    // stdout purity is asserted by the JSON parse guard above; this confirms the
    // operator actually gets told the mock provider verifies nothing.
    expect(stderr).toMatch(/mock|provider/i);
  });
});
