import type { FastifyRequest, FastifyReply } from 'fastify';
import { getKeyStore } from '../store/keys.js';

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

  if (configuredKey && providedKey === configuredKey) {
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

  if (configuredKey && providedKey === configuredKey) {
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
