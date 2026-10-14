/**
 * One ownership guard for every stored per-key object (emma-soul
 * al:837ec6cea3437a7d, rule 2). An object belongs to the key that created it;
 * an admin key reads and changes any. An object stored before owners were
 * recorded has no owner and is admin-only, so an old record never falls open
 * to every key. A request with no keyId owns nothing.
 *
 * Routes answer "not yours" exactly like "not found" (404, or absent from a
 * list), so a key cannot probe for other keys' ids.
 */
import type { FastifyRequest } from 'fastify';
import { isAdminKeyId } from '../plugins/auth.js';

/** True when `callerKeyId` may read or change an object owned by `ownerKeyId`. */
export function keyOwnsOrAdmin(callerKeyId: string | undefined, ownerKeyId: string | undefined): boolean {
  if (!callerKeyId) return false;
  if (isAdminKeyId(callerKeyId)) return true;
  return ownerKeyId !== undefined && ownerKeyId === callerKeyId;
}

/** True when the request's key may read or change an object owned by `ownerKeyId`. */
export function ownsOrAdmin(request: FastifyRequest, ownerKeyId: string | undefined): boolean {
  return keyOwnsOrAdmin(request.keyId, ownerKeyId);
}

/** The items the request's key may see: all of them for an admin key, otherwise its own. */
export function ownedOnly<T>(request: FastifyRequest, items: T[], ownerOf: (item: T) => string | undefined): T[] {
  if (isAdminKeyId(request.keyId)) return items;
  return items.filter((item) => ownsOrAdmin(request, ownerOf(item)));
}
