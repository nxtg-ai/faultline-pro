/**
 * Route access declarations, default-deny (emma-soul al:837ec6cea3437a7d,
 * rule 2). Every route says who may call it with `config: { access }`:
 *
 *   public  no key; the route must be on PUBLIC_ROUTES below
 *   admin   the admin key (requireAdmin)
 *   owner   any key; the handler returns or changes only the caller's own
 *           stored objects (lib/ownership.ts, lib/scan-access.ts)
 *   key     any key; nothing stored per key is returned (stateless compute,
 *           or the caller's own aggregates)
 *
 * `applyRouteAccess` runs from an onRoute hook in server.ts. A route with no
 * declaration, or a `public` route not on the list, throws at registration, so
 * it cannot ship. The key check runs in onRequest, before schema validation, so
 * a request with no key gets 401/403 rather than a 400 describing the schema.
 */
import type { RouteOptions, onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import { requireAdmin, requireApiKey } from '../plugins/auth.js';

export type RouteAccess = 'public' | 'admin' | 'owner' | 'key';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

/**
 * The only routes that answer with no key. Content-free: static pages, docs,
 * catalogues and service status, with no stored text and no key ids.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  // Liveness, status page, changelog, API docs (swagger-ui, below).
  'GET /health',
  'GET /status',
  'GET /status.json',
  'GET /changelog',
  'GET /changelog.json',
  'GET /changelog.md',
  'GET /docs',
  'GET /docs/',
  'GET /docs/json',
  'GET /docs/yaml',
  'GET /docs/static/*',
  'GET /docs/static/index.html',
  'GET /docs/static/swagger-initializer.js',
  // Static HTML shells: the data they show is fetched with a key.
  'GET /claims/view',
  'GET /queue',
  'GET /rate-limits',
  // Fixed catalogues and the telemetry policy.
  'GET /compliance/deadlines',
  'GET /templates/compliance',
  'GET /rules/examples',
  'GET /notifications/events',
  'GET /plugins/search',
  'GET /plugins/:id',
  'GET /telemetry',
  'GET /telemetry/privacy',
  'GET /telemetry/status',
  // Aggregate counters only, no text and no ids (route audit 647bc10, LOW
  // "anonymous aggregate counters"; not in rule 2's scope). Decide before
  // customer keys reopen (docs/runbooks/fp-operating-runbook.md).
  'GET /health/deep',
  'GET /queue/status',
  'GET /notifications',
  // CORS preflight (@fastify/cors).
  'OPTIONS *',
  // The hosted MCP endpoint's non-POST methods: 405 for GET and DELETE (it is
  // stateless) and the CORS preflight. No data. POST /mcp needs a key.
  'GET /mcp',
  'DELETE /mcp',
  'OPTIONS /mcp',
];

/**
 * Routes registered by third-party plugins, which cannot carry a declaration.
 * GraphQL is mounted only with FAULTLINE_GRAPHQL=on.
 */
const PLUGIN_ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'OPTIONS *': 'public',
  'GET /docs': 'public',
  'GET /docs/': 'public',
  'GET /docs/json': 'public',
  'GET /docs/yaml': 'public',
  'GET /docs/static/*': 'public',
  'GET /docs/static/index.html': 'public',
  'GET /docs/static/swagger-initializer.js': 'public',
  'GET /graphql': 'key',
  'POST /graphql': 'key',
};

const PUBLIC_SET = new Set(PUBLIC_ROUTES);
const AUTH_GUARDS = new Set<unknown>([requireApiKey, requireAdmin]);

function routeMethods(route: RouteOptions): string[] {
  return Array.isArray(route.method) ? route.method : [route.method];
}

/** HEAD answers as its GET does (Fastify adds one per GET route), so it is listed as GET. */
function routeKey(method: string, url: string): string {
  const upper = method.toUpperCase();
  return `${upper === 'HEAD' ? 'GET' : upper} ${url}`;
}

function asList<T>(hooks: T | T[] | undefined): T[] {
  if (hooks === undefined) return [];
  return Array.isArray(hooks) ? hooks : [hooks];
}

/** The access a route declared, or the fixed access of a plugin-owned route. */
export function accessOf(route: RouteOptions): RouteAccess | undefined {
  if (route.config?.access) return route.config.access;
  const declared = routeMethods(route).map((m) => PLUGIN_ROUTE_ACCESS[routeKey(m, route.url)]);
  return declared.every((a) => a !== undefined && a === declared[0]) ? declared[0] : undefined;
}

/** A route's leading key checks in its preHandler list, and the hooks after them. */
function splitGuards(route: RouteOptions): { own: unknown[]; rest: unknown[] } {
  const preHandler = asList<unknown>(route.preHandler as preHandlerHookHandler | preHandlerHookHandler[] | undefined);
  let leading = 0;
  while (leading < preHandler.length && AUTH_GUARDS.has(preHandler[leading])) leading += 1;
  return { own: preHandler.slice(0, leading), rest: preHandler.slice(leading) };
}

/** The checks a non-public route runs first: its own leading guards, else its access's guard. */
function guardsFor(access: RouteAccess, own: unknown[], where: string): unknown[] {
  const guards = own.length > 0 ? own : [access === 'admin' ? requireAdmin : requireApiKey];
  if (access === 'admin' && !guards.includes(requireAdmin)) {
    throw new Error(`Route ${where} declares admin access but checks only for a key.`);
  }
  if (access !== 'admin' && guards.includes(requireAdmin)) {
    throw new Error(`Route ${where} declares ${access} access but requires the admin key.`);
  }
  return guards;
}

function checkDeclaration(route: RouteOptions, access: RouteAccess | undefined, where: string): RouteAccess {
  if (!access) {
    throw new Error(`Route ${where} declares no access. Add config: { access } (lib/route-access.ts).`);
  }
  if (access === 'public') {
    const unlisted = routeMethods(route).filter((m) => !PUBLIC_SET.has(routeKey(m, route.url)));
    if (unlisted.length > 0) throw new Error(`Route ${where} declares public access but is not on PUBLIC_ROUTES.`);
  }
  return access;
}

/**
 * onRoute hook body: enforce the declaration and move the key check to
 * onRequest. Creates new hook arrays (Fastify copies a GET route's options to
 * its HEAD route) and never adds a guard twice.
 */
export function applyRouteAccess(route: RouteOptions): void {
  const where = `${routeMethods(route).join('|')} ${route.url}`;
  const access = checkDeclaration(route, accessOf(route), where);
  route.config = { ...route.config, access };

  const { own, rest } = splitGuards(route);
  if (rest.some((hook) => AUTH_GUARDS.has(hook))) {
    throw new Error(`Route ${where} runs a key check after other preHandlers; put it first.`);
  }
  if (access === 'public') {
    if (own.length > 0) throw new Error(`Route ${where} declares public access but runs a key check.`);
    return;
  }

  const guards = guardsFor(access, own, where);
  const onRequest = asList<unknown>(route.onRequest as onRequestHookHandler | onRequestHookHandler[] | undefined);
  const missing = guards.filter((guard) => !onRequest.includes(guard));
  route.onRequest = [...missing, ...onRequest] as onRequestHookHandler[];
  route.preHandler = rest as preHandlerHookHandler[];
}
