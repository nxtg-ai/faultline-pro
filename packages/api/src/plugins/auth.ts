import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getKeyStore } from '../store/keys.js';
import { getTenantStore } from '../store/tenants.js';

/** Constant-time string comparison to prevent timing attacks on key validation. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

declare module 'fastify' {
  interface FastifyRequest {
    keyId?: string;
    lang?: import('@nxtg/faultline/lib/i18n.js').Lang;
  }
}

/**
 * Prehandler: validate x-api-key header against FAULTLINE_API_KEY env var or keystore.
 * Returns 503 if neither env var nor keystore contains any key, 401 if key is missing/wrong.
 */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configuredKey = process.env.FAULTLINE_API_KEY;
  const store = getKeyStore();

  if (!configuredKey && store.size === 0) {
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

  const keystoreKey = store.validateKey(providedKey);
  if (keystoreKey) {
    request.keyId = keystoreKey.id;
    return;
  }

  reply.status(401).send({ error: 'Unauthorized. Provide a valid x-api-key header.' });
}

/**
 * Prehandler: only allows FAULTLINE_API_KEY or a keystore key with 'admin' permission.
 * Returns 503 if no keys configured, 401 if missing, 403 if insufficient permissions.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configuredKey = process.env.FAULTLINE_API_KEY;
  const store = getKeyStore();

  if (!configuredKey && store.size === 0) {
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
