// Validates: monthly scan quota, every scan route checks the cap before provider work
/**
 * Every route that can run a scan on Faultline's providers must check the
 * per-key monthly cap before any provider work. This test finds those routes
 * itself, so a scan route added later without the check fails here:
 *
 * 1. A route file can call a provider when it, or any module it imports inside
 *    src/ (other route files aside), imports the scan engine, a provider
 *    module, the critique engine or the consensus engine. Imports, re-exports
 *    and dynamic imports are read with the TypeScript parser.
 * 2. Each such file's route plugin is registered on a bare Fastify instance, and
 *    onRoute records every route it defines with its hooks and prehandlers.
 * 3. Each of those routes must carry the real enforceMonthlyCap prehandler, or the
 *    route's own named admission function (ROUTE_ADMISSION), compared by
 *    identity. Every hook and prehandler that runs before it must be one known
 *    not to reach a provider (SAFE_BEFORE_GATE); the handler always runs after.
 *    A route without a gate must be named in ALLOWED with a one-line reason.
 * 4. A gated route must count what it serves (its file calls the usage meter), or
 *    be named in CHECKED_NOT_COUNTED with a reason.
 *
 * The real server is also enumerated at startup, so every route reasoned about
 * here is really served, every allowlist entry names a real route, and a route
 * defined outside the route files must be named in SERVER_LEVEL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildServer } from '../src/server.js';
import { enforceMonthlyCap } from '../src/plugins/usage-cap.js';
import { requireApiKey } from '../src/plugins/auth.js';
import { rateLimitScan } from '../src/plugins/ratelimit.js';
import { enforceConsensusEntitlement } from '../src/plugins/consensus-entitlement.js';
import { validateConsensusVoters } from '../src/plugins/consensus-voters.js';
import { limitFullScanEstimates } from '../src/routes/full-scan.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ROUTES_DIR = join(SRC, 'routes');

const READS = 'reads or manages stored data; calls no provider';
const RECURRING = 'creates a recurring scan that a background runner runs later; that runner has no monthly-cap check or count yet';
const BACKGROUND = 'work runs in a background runner; admission is checked; counting lands with the reservation build';

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

/** Gated routes that do not count toward the quota, and why. */
const CHECKED_NOT_COUNTED: Record<string, string> = {
  'POST /scan/bulk': BACKGROUND,
  'POST /queue/scans': BACKGROUND,
  'POST /schedules/:id/trigger': BACKGROUND,
  'POST /scan/full/estimate': 'prices a full scan (one extraction); the job is counted when POST /scan/full admits it',
};

/** A route whose admission check is its own function, by the name its module exports. */
const ROUTE_ADMISSION: Record<string, string> = {
  'POST /scan/batch': 'enforceMonthlyCapForBatch',
  'POST /scan/full': 'enforceMonthlyCapForNewJob',
};

/**
 * Hooks and prehandlers that may run before the gate: none of them calls a
 * provider. validateConsensusVoters imports the consensus engine only for its
 * fixed voter list and failure reasons; it makes no provider call. Anything else
 * placed before the gate fails the coverage test.
 */
const SAFE_BEFORE_GATE = new Map<unknown, string>([
  [requireApiKey, 'checks the API key'],
  [rateLimitScan, 'per-minute burst limiter'],
  [enforceConsensusEntitlement, 'plan check for consensus'],
  [validateConsensusVoters, 'checks the requested voters against a fixed list'],
  [limitFullScanEstimates, 'per-key estimate throttle'],
]);

/** Usage meter calls: a file that counts what it serves holds one of these. */
const METER_CALL = /\b(meterScan|recordDeliveredScan)\(|getUsageMeter\(\)\.increment\(/;

/** Routes defined outside src/routes (server.ts and its plugins), and why they need no gate. */
const SERVER_LEVEL: Array<[RegExp, string]> = [
  [/^(GET|POST) \/graphql$/, 'off unless FAULTLINE_GRAPHQL=on; its scan resolver has no monthly-cap check yet'],
  [/^GET \/docs(\/.*)?$/, 'API docs; calls no provider'],
  [/^OPTIONS \*$/, 'CORS preflight; calls no provider'],
];

const PROVIDER_MODULE = /^@nxtg\/faultline\/(cli\/scan\.js|cli\/critique|providers\/|consensus\/)/;

/**
 * Every module a source file loads at run time: imports, re-exports and dynamic
 * imports, in either quote style. Type-only imports and re-exports load nothing.
 */
export function runtimeImports(source: string, fileName = 'file.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr) && !node.isTypeOnly) found.push(expr.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) found.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The provider import this file reaches, or null. Other route files are not followed. */
function providerReach(file: string, seen: Set<string> = new Set()): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const spec of runtimeImports(readFileSync(file, 'utf8'), file)) {
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
  /** Route-level hooks that run before the prehandlers, in order. */
  early: unknown[];
  preHandler: unknown[];
}

const nameOf = (fn: unknown): string => (typeof fn === 'function' && fn.name ? fn.name : String(fn));

/**
 * Why a route fails the gate rule, or null when it passes: the real
 * enforceMonthlyCap (or the route's own admission function) must be a
 * prehandler, and everything before it must be in SAFE_BEFORE_GATE.
 */
function gateProblem(route: SeenRoute, admission?: unknown): string | null {
  const gates = admission === undefined ? [enforceMonthlyCap] : [enforceMonthlyCap, admission];
  const at = route.preHandler.findIndex((h) => gates.includes(h));
  if (at === -1) return 'no monthly-cap gate';
  const unsafe = [...route.early, ...route.preHandler.slice(0, at)].filter((h) => !SAFE_BEFORE_GATE.has(h));
  return unsafe.length === 0 ? null : `runs ${unsafe.map(nameOf).join(', ')} before the monthly-cap gate`;
}

const isGated = (route: SeenRoute, admission?: unknown) => gateProblem(route, admission) === null;

const routeKey = (method: string, url: string) => `${method === 'HEAD' ? 'GET' : method} ${url}`;

function collect(app: FastifyInstance, onRoute: (route: RouteOptions) => void): void {
  app.addHook('onRoute', onRoute);
}

const toArray = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function seen(route: RouteOptions, file: string): SeenRoute[] {
  const early = [...toArray(route.onRequest), ...toArray(route.preParsing), ...toArray(route.preValidation)];
  return (toArray(route.method) as string[])
    .filter((method) => method !== 'HEAD')
    .map((method) => ({ key: routeKey(method, route.url), file, early, preHandler: toArray(route.preHandler) }));
}

let scanRoutes: SeenRoute[] = [];
const modules = new Map<string, Record<string, unknown>>();

/** The route's own admission function, resolved from its module by name. */
const admissionFor = (route: SeenRoute): unknown => {
  const name = ROUTE_ADMISSION[route.key];
  return name === undefined ? undefined : modules.get(route.file)?.[name];
};
let flaggedFiles: string[] = [];
const served = new Set<string>();

beforeAll(async () => {
  flaggedFiles = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => providerReach(join(ROUTES_DIR, f)) !== null)
    .sort();

  for (const file of flaggedFiles) {
    const mod = await import(pathToFileURL(join(ROUTES_DIR, file)).href) as Record<string, unknown>;
    modules.set(file, mod);
    const plugins = Object.entries(mod).filter(([name, value]) => /Routes$/.test(name) && typeof value === 'function');
    expect(plugins.length, `${file} exports a *Routes plugin`).toBeGreaterThan(0);
    const app = Fastify();
    collect(app, (route) => { scanRoutes.push(...seen(route, file)); });
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
  modules.clear();
  served.clear();
});

describe('monthly-cap coverage of every route that can run a scan', () => {
  it('finds the route files that reach a provider, including those that reach one through a store', () => {
    expect(flaggedFiles).toEqual(expect.arrayContaining([
      'batch.ts', 'deep.ts', 'full-scan.ts', 'scan.ts', 'stream.ts', 'upload.ts', 'queue.ts', 'schedules.ts',
    ]));
    expect(scanRoutes.length).toBeGreaterThan(0);
  });

  it('every such route has the monthly-cap gate before any provider work, or a reason in the allowlist', () => {
    const failing = scanRoutes
      .filter((r) => ALLOWED[r.key] === undefined)
      .map((r) => ({ r, problem: gateProblem(r, admissionFor(r)) }))
      .filter(({ problem }) => problem !== null)
      .map(({ r, problem }) => `${r.key} (routes/${r.file}): ${problem}`);
    expect(failing).toEqual([]);
  });

  it('each named admission function is exported by its route file and is a prehandler of its route', () => {
    for (const [key, name] of Object.entries(ROUTE_ADMISSION)) {
      const route = scanRoutes.find((r) => r.key === key);
      expect(route, key).toBeDefined();
      const admission = admissionFor(route!);
      expect(typeof admission, `${name} is exported by routes/${route!.file}`).toBe('function');
      expect(route!.preHandler).toContain(admission);
    }
  });

  it('the scan routes named in the rule carry the gate', () => {
    const gated = new Set(scanRoutes.filter((r) => isGated(r, admissionFor(r))).map((r) => r.key));
    for (const key of [
      'POST /scan', 'POST /scan/template/:id', 'POST /scan/upload', 'GET /scan/stream', 'POST /scan/stream',
      'POST /scan/batch', 'POST /scan/deep', 'POST /scan/full', 'POST /scan/full/estimate', 'POST /scan/diff',
      'POST /scan/report', 'POST /scan/eu-report', 'POST /scan/compliance/:template', 'POST /scan/compliance-gate',
      'POST /scan/bulk', 'POST /queue/scans', 'POST /schedules/:id/trigger',
    ]) {
      expect(gated.has(key), key).toBe(true);
    }
  });

  it('every gated route counts what it serves, or is named in CHECKED_NOT_COUNTED with a reason', () => {
    const gated = scanRoutes.filter((r) => isGated(r, admissionFor(r)));
    expect(gated.length).toBeGreaterThan(0);
    const uncounted = gated
      .filter((r) => CHECKED_NOT_COUNTED[r.key] === undefined)
      .filter((r) => !METER_CALL.test(readFileSync(join(ROUTES_DIR, r.file), 'utf8')))
      .map((r) => `${r.key} (routes/${r.file})`);
    expect(uncounted).toEqual([]);
    for (const [key, reason] of Object.entries(CHECKED_NOT_COUNTED)) {
      const route = scanRoutes.find((r) => r.key === key);
      expect(route && isGated(route, admissionFor(route)), `${key} is checked at admission`).toBe(true);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('no allowlisted route also carries the gate, and every allowlist entry names a real route', () => {
    const byKey = new Map(scanRoutes.map((r) => [r.key, r]));
    for (const key of Object.keys(ALLOWED)) {
      const route = byKey.get(key);
      expect(route, `${key} is a route in a provider-reaching file`).toBeDefined();
      expect(route!.preHandler, `${key} is gated, so drop it from the allowlist`).not.toContain(enforceMonthlyCap);
      expect(CHECKED_NOT_COUNTED[key], `${key} is in both lists`).toBeUndefined();
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

describe('the coverage rule itself', () => {
  const noop = async (): Promise<void> => {};
  /** The transform may rename local functions, so a test function's name is set explicitly. */
  const named = <T extends object>(name: string, fn: T): T => Object.defineProperty(fn, 'name', { value: name });

  /** Register one route with the given prehandlers and read it back the way the coverage test does. */
  async function routeWith(preHandler: unknown[], early: { preValidation?: unknown[] } = {}): Promise<SeenRoute> {
    const app = Fastify();
    const found: SeenRoute[] = [];
    collect(app, (route) => { found.push(...seen(route, 'synthetic.ts')); });
    app.post('/synthetic', { preHandler: preHandler as never, ...(early as object) }, async () => ({ ok: true }));
    await app.ready();
    await app.close();
    expect(found).toHaveLength(1);
    return found[0];
  }

  it('the real gate after safe prehandlers passes', async () => {
    expect(gateProblem(await routeWith([requireApiKey, rateLimitScan, enforceMonthlyCap]))).toBeNull();
  });

  it('a no-op that looks like the gate (same name, even marked) fails', async () => {
    const lookalike = named(enforceMonthlyCap.name, async (): Promise<void> => {});
    Object.defineProperty(lookalike, 'isMonthlyCapGate', { value: true });
    expect(lookalike.name).toBe(enforceMonthlyCap.name);
    expect(gateProblem(await routeWith([requireApiKey, lookalike]))).toBe('no monthly-cap gate');
  });

  it('a gate placed after a provider-reaching prehandler fails', async () => {
    const callsProvider = named('callsProvider', async (): Promise<void> => {});
    expect(gateProblem(await routeWith([requireApiKey, callsProvider, enforceMonthlyCap])))
      .toBe('runs callsProvider before the monthly-cap gate');
  });

  it('a gate behind a route-level hook that runs earlier and is not known safe fails', async () => {
    const earlyWork = named('earlyWork', async (): Promise<void> => {});
    expect(gateProblem(await routeWith([enforceMonthlyCap], { preValidation: [earlyWork] })))
      .toBe('runs earlyWork before the monthly-cap gate');
  });

  it("a route's named admission function counts only for that route, by identity", async () => {
    const route = await routeWith([requireApiKey, noop]);
    expect(gateProblem(route)).toBe('no monthly-cap gate');
    expect(gateProblem(route, noop)).toBeNull();
  });

  it('import discovery reads double quotes, re-exports, dynamic imports and multi-line imports, and skips type-only ones', () => {
    const source = [
      'import { scan } from "@nxtg/faultline/cli/scan.js";',
      "import {\n  a,\n  b,\n} from './multi.js';",
      'export { x } from "./reexported.js";',
      "export * from './star.js';",
      'const m = await import("./dynamic.js");',
      "import type { T } from './type-only.js';",
      "export type { U } from './type-reexport.js';",
      "// import { fake } from './in-a-comment.js';",
      "const text = \"import { fake } from './in-a-string.js'\";",
    ].join('\n');
    expect(runtimeImports(source)).toEqual([
      '@nxtg/faultline/cli/scan.js', './multi.js', './reexported.js', './star.js', './dynamic.js',
    ]);
  });
});
