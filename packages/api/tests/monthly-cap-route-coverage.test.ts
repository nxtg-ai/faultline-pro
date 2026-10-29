// Validates: monthly scan quota, every scan route checks the cap before provider work
/**
 * Every route that can run a scan on Faultline's providers must check the
 * per-key monthly cap before any provider work. This test finds those routes
 * itself, so a scan route added later without the check fails here:
 *
 * 1. A route file can call a provider when it, or any module it imports inside
 *    src/ (other route files aside), imports the scan engine, a provider
 *    module, the critique engine or the consensus engine.
 * 2. Each such file's route plugin is registered on a bare Fastify instance, and
 *    onRoute records every route it defines with its prehandlers.
 * 3. Each of those routes must carry a monthly-cap gate (isMonthlyCapGate), or be
 *    named in ALLOWED below with a one-line reason.
 *
 * The real server is also enumerated at startup, so every route reasoned about
 * here is really served, every allowlist entry names a real route, and a route
 * defined outside the route files must be named in SERVER_LEVEL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildServer } from '../src/server.js';
import { isMonthlyCapGate } from '../src/plugins/usage-cap.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ROUTES_DIR = join(SRC, 'routes');

const READS = 'reads or manages stored data; calls no provider';
const RECURRING = 'creates a recurring scan that a background runner runs later; that runner has no monthly-cap check or count yet';

/** Routes in provider-reaching files that run without the monthly-cap gate, and why. */
const ALLOWED: Record<string, string> = {
  'POST /admin/verify-claims': 'admin only (requireAdmin); the admin tier has no monthly cap',
  'POST /critique': 'a critique is not a scan; it is behind the burst limiter and the provider spend cap',
  'GET /scan/full/:jobId': 'polls a job; calls no provider',
  'POST /scan/full/:jobId/stop': 'stops a job; calls no provider',
  'POST /scan/compliance-diff': 'compares two stored scans; calls no provider',
  'POST /jobs': RECURRING,
  'POST /schedules': RECURRING,
  'GET /jobs/:id/progress': READS,
  'GET /scan/:id/compliance': READS,
  'GET /scan/:id/compliance/badge': READS,
  'GET /compliance/history': READS,
  'GET /compliance/trend': READS,
  'GET /compliance/export': READS,
  'GET /compliance/dashboard': READS,
  'GET /templates/compliance': READS,
  'POST /templates/compliance': READS,
  'DELETE /templates/compliance/:id': READS,
  'GET /tenants/:id/export': READS,
  'GET /jobs': READS,
  'DELETE /jobs/:id': READS,
  'GET /mission-control/status': READS,
  'GET /mission-control': READS,
  'GET /queue/scans/:id': READS,
  'GET /queue/scans': READS,
  'DELETE /queue/scans/:id': READS,
  'GET /queue/status': READS,
  'GET /queue': READS,
  'GET /schedules': READS,
  'GET /schedules/view': READS,
  'GET /schedules/:id': READS,
  'PATCH /schedules/:id': READS,
  'DELETE /schedules/:id': READS,
  'GET /schedules/:id/history': READS,
  'POST /tenants': READS,
  'GET /tenants': READS,
  'GET /tenants/:id': READS,
  'DELETE /tenants/:id': READS,
  'POST /tenants/:id/keys': READS,
  'DELETE /tenants/:id/keys/:keyId': READS,
  'GET /tenants/:id/usage': READS,
  'DELETE /tenants/:id/data': READS,
  'GET /usage': READS,
};

/** Routes defined outside src/routes (server.ts and its plugins), and why they need no gate. */
const SERVER_LEVEL: Array<[RegExp, string]> = [
  [/^(GET|POST) \/graphql$/, 'off unless FAULTLINE_GRAPHQL=on; its scan resolver has no monthly-cap check yet'],
  [/^GET \/docs(\/.*)?$/, 'API docs; calls no provider'],
  [/^OPTIONS \*$/, 'CORS preflight; calls no provider'],
];

const IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/gm;
const PROVIDER_MODULE = /^@nxtg\/faultline\/(cli\/scan\.js|cli\/critique|providers\/|consensus\/)/;

/** The provider import this file reaches, or null. Other route files are not followed. */
function providerReach(file: string, seen: Set<string> = new Set()): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const spec = match[1] ?? match[2];
    if (PROVIDER_MODULE.test(spec)) return spec;
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
    if (!existsSync(target) || dirname(target) === ROUTES_DIR) continue;
    const reached = providerReach(target, seen);
    if (reached) return reached;
  }
  return null;
}

interface SeenRoute {
  key: string;
  file: string;
  preHandler: unknown[];
}

const routeKey = (method: string, url: string) => `${method === 'HEAD' ? 'GET' : method} ${url}`;

function collect(app: FastifyInstance, onRoute: (route: RouteOptions) => void): void {
  app.addHook('onRoute', onRoute);
}

const toArray = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

let scanRoutes: SeenRoute[] = [];
let flaggedFiles: string[] = [];
const served = new Set<string>();

beforeAll(async () => {
  flaggedFiles = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => providerReach(join(ROUTES_DIR, f)) !== null)
    .sort();

  for (const file of flaggedFiles) {
    const mod = await import(pathToFileURL(join(ROUTES_DIR, file)).href) as Record<string, unknown>;
    const plugins = Object.entries(mod).filter(([name, value]) => /Routes$/.test(name) && typeof value === 'function');
    expect(plugins.length, `${file} exports a *Routes plugin`).toBeGreaterThan(0);
    const app = Fastify();
    collect(app, (route) => {
      for (const method of toArray(route.method) as string[]) {
        if (method === 'HEAD') continue;
        scanRoutes.push({ key: routeKey(method, route.url), file, preHandler: toArray(route.preHandler) });
      }
    });
    for (const [, plugin] of plugins) await app.register(plugin as Parameters<FastifyInstance['register']>[0]);
    await app.ready();
    await app.close();
  }
  scanRoutes = scanRoutes.filter((r, i, all) => all.findIndex((o) => o.key === r.key) === i);

  const saved = process.env.FAULTLINE_GRAPHQL;
  process.env.FAULTLINE_GRAPHQL = 'on';
  try {
    const server = buildServer();
    collect(server, (route) => {
      for (const method of toArray(route.method) as string[]) served.add(routeKey(method, route.url));
    });
    await server.ready();
    await server.close();
  } finally {
    if (saved === undefined) delete process.env.FAULTLINE_GRAPHQL;
    else process.env.FAULTLINE_GRAPHQL = saved;
  }
}, 60_000);

afterAll(() => {
  scanRoutes = [];
  served.clear();
});

describe('monthly-cap coverage of every route that can run a scan', () => {
  it('finds the route files that reach a provider, including those that reach one through a store', () => {
    expect(flaggedFiles).toEqual(expect.arrayContaining([
      'batch.ts', 'deep.ts', 'full-scan.ts', 'scan.ts', 'stream.ts', 'upload.ts', 'queue.ts', 'schedules.ts',
    ]));
    expect(scanRoutes.length).toBeGreaterThan(0);
  });

  it('every such route has a monthly-cap gate or a reason in the allowlist', () => {
    const ungated = scanRoutes
      .filter((r) => !r.preHandler.some(isMonthlyCapGate))
      .filter((r) => ALLOWED[r.key] === undefined)
      .map((r) => `${r.key} (routes/${r.file})`);
    expect(ungated).toEqual([]);
  });

  it('the scan routes named in the rule carry the gate', () => {
    const gated = new Set(scanRoutes.filter((r) => r.preHandler.some(isMonthlyCapGate)).map((r) => r.key));
    for (const key of [
      'POST /scan', 'POST /scan/template/:id', 'POST /scan/upload', 'GET /scan/stream', 'POST /scan/stream',
      'POST /scan/batch', 'POST /scan/deep', 'POST /scan/full', 'POST /scan/full/estimate', 'POST /scan/diff',
      'POST /scan/report', 'POST /scan/eu-report', 'POST /scan/compliance/:template', 'POST /scan/compliance-gate',
      'POST /scan/bulk', 'POST /queue/scans', 'POST /schedules/:id/trigger',
    ]) {
      expect(gated.has(key), key).toBe(true);
    }
  });

  it('no allowlisted route also carries the gate, and every allowlist entry names a real route', () => {
    const byKey = new Map(scanRoutes.map((r) => [r.key, r]));
    for (const key of Object.keys(ALLOWED)) {
      const route = byKey.get(key);
      expect(route, `${key} is a route in a provider-reaching file`).toBeDefined();
      expect(route!.preHandler.some(isMonthlyCapGate), `${key} is gated, so drop it from the allowlist`).toBe(false);
      expect(ALLOWED[key].length).toBeGreaterThan(0);
    }
  });

  it('every route found is really served by the server', () => {
    const missing = scanRoutes.map((r) => r.key).filter((key) => !served.has(key));
    expect(missing).toEqual([]);
  });

  it('a route served outside the route files is named, with a reason', async () => {
    const fromFiles = new Set<string>();
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
      const mod = await import(pathToFileURL(join(ROUTES_DIR, file)).href) as Record<string, unknown>;
      const app = Fastify();
      collect(app, (route) => {
        for (const method of toArray(route.method) as string[]) fromFiles.add(routeKey(method, route.url));
      });
      for (const [name, plugin] of Object.entries(mod)) {
        if (/Routes$/.test(name) && typeof plugin === 'function') {
          await app.register(plugin as Parameters<FastifyInstance['register']>[0]);
        }
      }
      await app.ready();
      await app.close();
    }
    const unnamed = [...served]
      .filter((key) => !fromFiles.has(key))
      .filter((key) => !SERVER_LEVEL.some(([pattern]) => pattern.test(key)));
    expect(unnamed).toEqual([]);
  }, 60_000);
});
