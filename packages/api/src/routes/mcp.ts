/**
 * Hosted MCP endpoint: POST /mcp, Streamable HTTP transport, stateless.
 *
 * An MCP client points at https://faultline-api.fly.dev/mcp with an
 * `x-api-key` header and gets the same `verify_claims` tool the stdio server
 * in packages/mcp exposes. The tool is built by packages/mcp's own
 * `buildServer`, so its name, input schema, descriptions and output shape are
 * one definition, not a copy.
 *
 * Every gate applies by construction. The tool's transport is the hosted
 * transport the stdio server uses with FAULTLINE_API_KEY set, but its fetch is
 * `fastify.inject` against this server's own POST /scan, carrying only the
 * caller's key. So auth, the burst limit, the monthly quota, the provider spend
 * cap, the claim meter and caps, the zero-source rule, overallRisk and the
 * billing field all come from the POST /scan code path. No other header is
 * forwarded: `x-user-tier` cannot reach the inner request.
 *
 * Stateless: a new MCP server and transport per request, no session ids, JSON
 * responses (no SSE). GET and DELETE answer 405 with an Allow header.
 *
 * Origin: absent is allowed (server-to-server clients). A present Origin must
 * be on FAULTLINE_MCP_ALLOWED_ORIGINS (comma-separated, default empty), or the
 * request gets 403 before the key check or any MCP processing. This is the DNS
 * rebinding defence the MCP transport spec asks for.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from 'fastify';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer as buildMcpServer } from '@nxtg/faultline-mcp/src/server.js';
import type { Transport } from '@nxtg/faultline/cli/transport.js';

/** Base URL of the in-process hosted transport. Never resolved on the network. */
export const IN_PROCESS_API_URL = 'http://faultline.in-process';

/** Env var holding the browser origins /mcp accepts, comma-separated. */
export const MCP_ALLOWED_ORIGINS_ENV = 'FAULTLINE_MCP_ALLOWED_ORIGINS';

/** The origins /mcp accepts, read on each request so a config change needs no restart of the route. */
export function mcpAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[MCP_ALLOWED_ORIGINS_ENV] ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
}

/** True when an Origin header value is on the allowlist (exact match, trailing slash ignored). */
export function isMcpOriginAllowed(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return mcpAllowedOrigins(env).includes(origin.replace(/\/+$/, ''));
}

/**
 * The per-route CORS origin check for /mcp. @fastify/cors runs it in its
 * onRequest hook, which runs before the route's key check. No Origin: no CORS
 * headers, carry on. An allowlisted Origin: CORS headers for it. Any other: a
 * 403 error, so the request ends before the key check or MCP processing.
 */
function mcpCorsOrigin(origin: string | undefined, cb: (err: Error | null, allow?: string | boolean) => void): void {
  if (!origin) return cb(null, false);
  if (isMcpOriginAllowed(origin)) return cb(null, origin);
  const err = Object.assign(new Error('Origin not allowed for /mcp.'), { statusCode: 403, code: 'ORIGIN_NOT_ALLOWED' });
  cb(err);
}

/** JSON-RPC error codes this route uses outside the SDK. */
const JSONRPC_SERVER_ERROR = -32000;
const JSONRPC_UNAUTHORIZED = -32001;

function jsonRpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * onSend for the /mcp routes: any error body that is not already JSON-RPC (the
 * 401 from the key check, the 403 for a refused Origin or the measurement key,
 * a 413 for an oversized body) is re-shaped as a JSON-RPC error, so an MCP
 * client reads it as one. The status code and message are kept. No
 * WWW-Authenticate header is set.
 */
const jsonRpcErrorBody: onSendHookHandler = async (_request, reply, payload) => {
  if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!parsed || typeof parsed !== 'object' || 'jsonrpc' in parsed) return payload;
  const message = String((parsed as { error?: unknown }).error ?? (parsed as { message?: unknown }).message ?? 'Request refused.');
  reply.header('content-type', 'application/json; charset=utf-8');
  return jsonRpcError(reply.statusCode === 401 ? JSONRPC_UNAUTHORIZED : JSONRPC_SERVER_ERROR, message);
};

/**
 * A fetch that runs this server's own POST /scan in-process. Only POST /scan
 * is reachable, and the only headers sent are the content type and the
 * caller's key, so the inner request is exactly a customer's POST /scan.
 */
export function inProcessScanFetch(fastify: FastifyInstance, apiKey: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== IN_PROCESS_API_URL || url.pathname !== '/scan' || (init?.method ?? 'GET') !== 'POST') {
      throw new Error(`in-process transport refuses ${init?.method ?? 'GET'} ${url.pathname}: only POST /scan is reachable`);
    }
    const res = await fastify.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      payload: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    });
  }) as typeof fetch;
}

/**
 * The Fastify request as a Fetch Request for the SDK's web-standard transport.
 * It carries headers only: Fastify has parsed the body already (within the
 * route's body limit) and the transport is given it as `parsedBody`.
 */
function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    // The body is handed over already parsed (parsedBody), so no length applies.
    if (value === undefined || name === 'content-length') continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else headers.set(name, String(value));
  }
  return new Request(`http://localhost${request.url}`, { method: request.method, headers });
}

function methodNotAllowed(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .status(405)
    .header('allow', 'POST')
    .header('content-type', 'application/json; charset=utf-8')
    .send(jsonRpcError(JSONRPC_SERVER_ERROR, 'Method not allowed. This endpoint is stateless: use POST.'));
}

export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  const shared = {
    // The per-route origin check; see mcpCorsOrigin.
    cors: {
      origin: mcpCorsOrigin,
      methods: ['POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'x-api-key', 'mcp-protocol-version'],
      credentials: false,
    },
  };

  fastify.post(
    '/mcp',
    {
      // `key`: any valid key reaches the MCP layer; what a key may scan is
      // decided by the inner POST /scan, with that same key.
      config: { access: 'key', ...shared },
      // The same limit POST /scan has (it sets none, so the server default).
      bodyLimit: fastify.initialConfig.bodyLimit,
      onSend: jsonRpcErrorBody,
      schema: { tags: ['MCP'], summary: 'Hosted MCP endpoint (Streamable HTTP, stateless): the verify_claims tool' },
    },
    async (request, reply) => {
      const apiKey = request.headers['x-api-key'] as string;
      const transportConfig: Transport = { mode: 'hosted', apiUrl: IN_PROCESS_API_URL, apiKey };
      const server = buildMcpServer({
        transport: transportConfig,
        fetchImpl: inProcessScanFetch(fastify, apiKey),
        audit: false,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        const res = await transport.handleRequest(toWebRequest(request), { parsedBody: request.body });
        reply.status(res.status);
        res.headers.forEach((value, name) => {
          reply.header(name, value);
        });
        const body = await res.text();
        return reply.send(body);
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  );

  // Stateless: no SSE stream to open and no session to end.
  for (const method of ['GET', 'DELETE'] as const) {
    fastify.route({
      method,
      url: '/mcp',
      config: { access: 'public', ...shared },
      onSend: jsonRpcErrorBody,
      schema: { tags: ['MCP'], summary: 'Not supported on the stateless MCP endpoint (405)' },
      handler: methodNotAllowed,
    });
  }

  // A browser on an allowlisted origin sends a preflight first. Answered by
  // @fastify/cors in its onRequest hook with this route's origin check; a
  // refused Origin gets 403 there, and a preflight with no Origin gets 204.
  fastify.options('/mcp', { config: { access: 'public', ...shared } }, async (_request, reply) => reply.status(204).send());
}
