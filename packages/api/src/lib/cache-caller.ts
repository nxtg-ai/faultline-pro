/**
 * Who a cached scan belongs to (EP4 Amendment 2 item 7). A cached result is
 * served back only to the same caller: the same API key and, behind
 * faultline-web's one server key, the same user (x-faultline-user-ref,
 * trusted from that key alone; see resolveUserRef). A server-key request with
 * no user ref is the operator's own caller, the one the cache warmer fills.
 */
import type { FastifyRequest } from 'fastify';
import { resolveUserRef } from '../routes/full-scan.js';

export function cacheCaller(request: FastifyRequest): string {
  const keyId = request.keyId ?? 'unknown';
  return `${keyId}\u0000${resolveUserRef(request)}`;
}

/** The caller the admin cache warmer writes for: the server key with no user ref. */
export const OPERATOR_CACHE_CALLER = 'admin\u0000admin';
