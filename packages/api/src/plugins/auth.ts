import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getKeyStore } from '../store/keys.js';
import { getTenantStore } from '../store/tenants.js';

/** Constant-time string comparison to prevent timing attacks on key validation. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The keyId of FAULTLINE_MEASUREMENT_KEY: the key internal measurement runs use
 * (the accuracy benchmark, cost per claim), so their spend is labelled apart from
 * production web traffic. It is not the server key and not an admin key: it may
 * call only the routes in MEASUREMENT_ROUTES.
 */
export const MEASUREMENT_KEY_ID = 'measurement';

/**
 * The only routes the measurement key may call, as `METHOD /route-pattern`.
 * Every other route, admin and non-admin alike, refuses it with 403.
 */
export const MEASUREMENT_ROUTES: readonly string[] = Object.freeze([
  'POST /admin/verify-claims',
  'GET /usage',
]);
const MEASUREMENT_ROUTE_SET = new Set(MEASUREMENT_ROUTES);

const MEASUREMENT_KEY_COLLIDES =
  'FAULTLINE_MEASUREMENT_KEY equals FAULTLINE_API_KEY, so it is not used as a measurement key. Set a different value.';

/**
 * The configured measurement key, or undefined. An empty or unset value never
 * matches, and a value equal to FAULTLINE_API_KEY is refused, so the two keys
 * can never collapse into one.
 */
function measurementKey(): string | undefined {
  const key = process.env.FAULTLINE_MEASUREMENT_KEY;
  if (!key) return undefined;
  const serverKey = process.env.FAULTLINE_API_KEY;
  if (serverKey && safeEqual(key, serverKey)) return undefined;
  return key;
}

/** True when the provided key is the measurement key (constant-time). */
function isMeasurementKey(providedKey: string): boolean {
  const key = measurementKey();
  return key !== undefined && safeEqual(providedKey, key);
}

/**
 * Startup check: when FAULTLINE_MEASUREMENT_KEY equals FAULTLINE_API_KEY, log
 * one fixed warning (never the value) and return true. The key is then ignored
 * as a measurement key, and matches as the server key only.
 */
export function warnIfMeasurementKeyCollides(warn: (message: string) => void = console.warn): boolean {
  const key = process.env.FAULTLINE_MEASUREMENT_KEY;
  const serverKey = process.env.FAULTLINE_API_KEY;
  if (!key || !serverKey || !safeEqual(key, serverKey)) return false;
  warn(MEASUREMENT_KEY_COLLIDES);
  return true;
}

/** The request's route as `METHOD /route-pattern`, or undefined when no route matched. */
function routeKeyOf(request: FastifyRequest): string | undefined {
  const url = request.routeOptions?.url;
  if (!url) return undefined;
  return `${request.method.toUpperCase()} ${url}`;
}

/** True when the measurement key may call this request's route (MEASUREMENT_ROUTES). */
export function measurementMayCall(request: FastifyRequest): boolean {
  const route = routeKeyOf(request);
  return route !== undefined && MEASUREMENT_ROUTE_SET.has(route);
}

function refuseMeasurement(reply: FastifyReply): void {
  reply.status(403).send({ error: 'Forbidden. The measurement key may call only POST /admin/verify-claims and GET /usage.' });
}

/**
 * onRequest hook for every route, public ones and unmatched URLs included: a
 * request carrying the measurement key outside MEASUREMENT_ROUTES gets 403.
 * requireApiKey and requireAdmin check the same allowlist.
 */
export async function refuseMeasurementOutsideAllowlist(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const providedKey = request.headers['x-api-key'];
  if (typeof providedKey !== 'string' || providedKey === '') return;
  if (!isMeasurementKey(providedKey)) return;
  if (measurementMayCall(request)) return;
  refuseMeasurement(reply);
}

declare module 'fastify' {
  interface FastifyRequest {
    keyId?: string;
    lang?: import('@nxtg/faultline/lib/i18n.js').Lang;
  }
}

/**
 * Prehandler: validate x-api-key header against FAULTLINE_API_KEY env var or keystore.
 * The measurement key (FAULTLINE_MEASUREMENT_KEY) passes only on MEASUREMENT_ROUTES
 * and gets 403 elsewhere. Returns 503 if no key is configured, 401 if key is missing/wrong.
 */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configuredKey = process.env.FAULTLINE_API_KEY;
  const store = getKeyStore();

  if (!configuredKey && !measurementKey() && store.size === 0) {
    reply.status(503).send({ error: 'API key not configured on server.' });
    return;
  }

  const providedKey = request.headers['x-api-key'] as string | undefined;

  if (!providedKey) {
    reply.status(401).send({ error: 'Unauthorized. Provide a valid x-api-key header.' });
    return;
  }

  if (configuredKey && safeEqual(providedKey, configuredKey)) {
    request.keyId = 'admin';
    return;
  }

  if (isMeasurementKey(providedKey)) {
    if (!measurementMayCall(request)) return refuseMeasurement(reply);
    request.keyId = MEASUREMENT_KEY_ID;
    return;
  }

  const keystoreKey = store.validateKey(providedKey);
  if (keystoreKey) {
    request.keyId = keystoreKey.id;
    return;
  }

  reply.status(401).send({ error: 'Unauthorized. Provide a valid x-api-key header.' });
}

/**
 * Prehandler: only allows FAULTLINE_API_KEY or a keystore key with 'admin' permission.
 * The measurement key passes only on MEASUREMENT_ROUTES (POST /admin/verify-claims). Returns 503 if no keys configured, 401 if missing, 403 if insufficient permissions.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configuredKey = process.env.FAULTLINE_API_KEY;
  const store = getKeyStore();

  if (!configuredKey && !measurementKey() && store.size === 0) {
    reply.status(503).send({ error: 'API key not configured on server.' });
    return;
  }

  const providedKey = request.headers['x-api-key'] as string | undefined;

  if (!providedKey) {
    reply.status(403).send({ error: 'Forbidden. Admin access required.' });
    return;
  }

  if (configuredKey && safeEqual(providedKey, configuredKey)) {
    request.keyId = 'admin';
    return;
  }

  if (isMeasurementKey(providedKey)) {
    if (!measurementMayCall(request)) return refuseMeasurement(reply);
    request.keyId = MEASUREMENT_KEY_ID;
    return;
  }

  const keystoreKey = store.validateKey(providedKey);
  if (keystoreKey) {
    if (keystoreKey.permissions.includes('admin')) {
      request.keyId = keystoreKey.id;
      return;
    }
    reply.status(403).send({ error: 'Forbidden. Admin access required.' });
    return;
  }

  reply.status(403).send({ error: 'Forbidden. Admin access required.' });
}

/**
 * True when a request on a public route carries an admin key (the server's
 * FAULTLINE_API_KEY or a keystore key with 'admin'). Public routes run no key
 * check, so this reads the header itself. Used to keep fleet counters (key
 * count, scan volume, queue and notification sizes) for admin only: a customer
 * must not see fleet size (emma-soul ruling Dx3 e2909e46, item 4). The
 * measurement key is not an admin key here.
 */
export function isAdminRequest(request: FastifyRequest): boolean {
  const providedKey = request.headers['x-api-key'];
  if (typeof providedKey !== 'string' || providedKey === '') return false;
  const configuredKey = process.env.FAULTLINE_API_KEY;
  if (configuredKey && safeEqual(providedKey, configuredKey)) return true;
  return getKeyStore().validateKey(providedKey)?.permissions.includes('admin') ?? false;
}

/**
 * Resolves the tenantId for a request's keyId.
 * Returns undefined for admin keys ('admin'), missing keyIds, or keys not
 * associated with any tenant.
 */
export function resolveRequestTenantId(keyId: string | undefined): string | undefined {
  if (!keyId || keyId === 'admin') return undefined;
  return getTenantStore().findByKeyId(keyId)?.id;
}

/** Scope value that cannot equal any recorded keyId (keystore ids are UUIDs; env key is 'admin'). */
const NO_KEY_SCOPE = '\u0000no-key';

/**
 * True when the request was authenticated with admin rights: the server's own
 * FAULTLINE_API_KEY (keyId 'admin') or a keystore key holding the 'admin'
 * permission. Mirrors what `requireAdmin` accepts, so a key that can already
 * read fleet-wide on admin routes reads fleet-wide on shared routes too.
 */
export function isAdminKeyId(keyId: string | undefined): boolean {
  if (!keyId) return false;
  if (keyId === 'admin') return true;
  return getKeyStore().validateById(keyId)?.permissions.includes('admin') ?? false;
}

/**
 * The scan-history key scope for a request: `undefined` (fleet-wide) for admin
 * callers, otherwise the caller's own keyId. Pass the result as the `keyId`
 * argument of every ScanHistoryStore read, so a non-admin key only ever sees the
 * scans it submitted. Fails closed: a request with no keyId gets a scope that
 * matches no entry rather than the whole fleet.
 */
export function scanHistoryKeyScope(request: FastifyRequest): string | undefined {
  if (isAdminKeyId(request.keyId)) return undefined;
  return request.keyId ?? NO_KEY_SCOPE;
}
