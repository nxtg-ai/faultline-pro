/**
 * Who a cached scan belongs to (EP4 Amendment 2 item 7). A cached result is
 * served back only to the same caller: the same API key and, behind
 * faultline-web's one server key, the same user (x-faultline-user-ref,
 * trusted from that key alone; see resolveUserRef).
 *
 * Null means "no cache for this request": the server key without a valid
 * user ref could be any of faultline-web's users, so caching under it would
 * share results between them (Fable seat, item 7: fail closed).
 */
import type { FastifyRequest } from 'fastify';
import { resolveUserRef } from '../routes/full-scan.js';
import { isServerKeyId } from '../plugins/consensus-entitlement.js';

export function cacheCaller(request: FastifyRequest): string | null {
  const keyId = request.keyId ?? 'unknown';
  const ref = resolveUserRef(request);
  if (isServerKeyId(keyId) && ref === keyId) return null;
  return `${keyId}\u0000${ref}`;
}
