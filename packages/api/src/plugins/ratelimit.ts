import type { FastifyRequest, FastifyReply } from 'fastify';
import { getRateLimiter } from '../store/ratelimit.js';
import { getKeyStore } from '../store/keys.js';
import type { Tier } from '../store/ratelimit.js';

function resolveTier(keyId: string): Tier {
  if (keyId === 'admin') return 'admin';
  const key = getKeyStore().validateById(keyId);
  if (key && key.permissions.includes('admin')) return 'admin';
  if (key && key.permissions.includes('pro')) return 'pro';
  return 'free';
}

/**
 * Prehandler: rate-limit scan endpoints per key/tier.
 * Must run AFTER requireApiKey (reads request.keyId).
 * Sets X-RateLimit-* headers on allowed requests; returns 429 when exceeded.
 */
export async function rateLimitScan(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const keyId = request.keyId ?? 'unknown';
  const tier = resolveTier(keyId);
  const limiter = getRateLimiter();
  const { allowed, info } = limiter.check(keyId, tier);

  if (!allowed) {
    reply
      .header('X-RateLimit-Limit', String(info.limit))
      .header('X-RateLimit-Remaining', '0')
      .header('X-RateLimit-Reset', String(info.resetEpoch))
      .status(429)
      .send({ error: 'Rate limit exceeded.', limit: info.limit, remaining: 0, resetEpoch: info.resetEpoch });
    return;
  }

  limiter.increment(keyId);
  const afterInfo = limiter.getInfo(keyId, tier);
  reply
    .header('X-RateLimit-Limit', String(afterInfo.limit))
    .header('X-RateLimit-Remaining', String(afterInfo.remaining))
    .header('X-RateLimit-Reset', String(afterInfo.resetEpoch));
}
