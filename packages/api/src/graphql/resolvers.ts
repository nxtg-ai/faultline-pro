import { scan } from '@nxtg/faultline/cli/scan.js';
import { scanWithSpend } from '../lib/scan-spend.js';
import { getKeyStore } from '../store/keys.js';
import { getUsageMeter } from '../store/usage.js';
import { getAuditLogger } from '../store/audit.js';
import { getScanStore } from '../store/scans.js';
import { isAdminKeyId } from '../plugins/auth.js';
import { mayIssueKey, CUSTOMER_KEYS_CLOSED } from '../lib/key-issuance.js';
import { GraphQLError } from 'graphql';

/**
 * GraphQL had no authorization beyond the key check at the door: any key could
 * mint an admin key, read every key's scans and the audit log, and run paid
 * scans outside the REST rate limit and spend cap (codex seat on 4d3070e).
 * Key management, audit and scans are now admin only; reads are the caller's own.
 */
function requireAdmin(ctx: GqlContext): void {
  if (!isAdminKeyId(ctx.keyId)) throw new GraphQLError('Forbidden. Admin access required.', { extensions: { code: 'FORBIDDEN' } });
}

/** A `limit` argument: a positive integer, capped at `max`; anything else is refused. */
function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new GraphQLError('limit must be a positive integer.', { extensions: { code: 'BAD_USER_INPUT' } });
  return Math.min(value, max);
}

/** The key whose data a non-admin caller may read: always its own. */
function ownKeyScope(ctx: GqlContext, requested: string | undefined): string | undefined {
  if (isAdminKeyId(ctx.keyId)) return requested;
  if (requested !== undefined && requested !== ctx.keyId) {
    throw new GraphQLError("Forbidden. A key can read only its own data.", { extensions: { code: 'FORBIDDEN' } });
  }
  return ctx.keyId;
}

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

interface GqlContext {
  keyId: string;
}

function toScanResult(id: string, result: Record<string, unknown>, scannedAt: string) {
  const claims = Array.isArray(result.claims) ? result.claims : [];
  const comp = (result.complianceReport as Record<string, unknown>) ?? {};
  return {
    id,
    input: (result.input as string) ?? '',
    provider: (result.provider as string) ?? 'unknown',
    claims: claims.map((c: Record<string, unknown>) => ({
      id: (c.id as string) ?? '',
      text: (c.text as string) ?? '',
      type: (c.type as string) ?? '',
      importance: typeof c.importance === 'number' ? c.importance : 0,
    })),
    overallRisk: (result.overallRisk as string) ?? 'unknown',
    complianceReport: { riskTier: (comp.riskTier as string) ?? 'unknown' },
    scannedAt,
  };
}

export const resolvers = {
  Query: {
    scan: async (_: unknown, args: { text: string; provider?: string }, ctx: GqlContext) => {
      requireAdmin(ctx);
      const provider = (args.provider ?? 'mock') as Provider;
      const result = await scanWithSpend({ text: args.text, provider, keyId: ctx.keyId }, () => scan(args.text, provider));
      const stored = getScanStore().record(ctx.keyId, args.text, result as unknown as Record<string, unknown>);
      return toScanResult(stored.id, result as unknown as Record<string, unknown>, stored.scannedAt);
    },

    scans: (_: unknown, args: { keyId?: string; limit?: number }, ctx: GqlContext) => {
      const limit = boundedLimit(args.limit, 50, 200);
      const items = getScanStore().list(ownKeyScope(ctx, args.keyId), limit);
      return items.map((s) => toScanResult(s.id, s.result, s.scannedAt));
    },

    keys: (_: unknown, _args: unknown, ctx: GqlContext) => {
      requireAdmin(ctx);
      return getKeyStore().list().map((k) => ({
        id: k.id,
        name: k.name,
        permissions: k.permissions,
        createdAt: k.createdAt,
      }));
    },

    usage: (_: unknown, args: { keyId: string }, ctx: GqlContext) => {
      const usageRecord = getUsageMeter().getUsage(ownKeyScope(ctx, args.keyId) ?? ctx.keyId);
      return Object.entries(usageRecord).map(([date, count]) => ({ date, count }));
    },

    audit: (_: unknown, args: { limit?: number }, ctx: GqlContext) => {
      requireAdmin(ctx);
      const entries = getAuditLogger().getEntries();
      const max = boundedLimit(args.limit, 100, 500);
      const limited = entries.slice(-max);
      return limited.map((e) => ({
        timestamp: e.timestamp,
        keyId: e.keyId,
        endpoint: e.endpoint,
        method: e.method,
        statusCode: e.statusCode,
        latencyMs: e.latencyMs,
      }));
    },
  },

  Mutation: {
    createKey: (_: unknown, args: { name: string; permissions?: string[] }, ctx: GqlContext) => {
      requireAdmin(ctx);
      const permissions = (args.permissions ?? ['scan']) as import('../store/keys.js').Permission[];
      if (!mayIssueKey(permissions)) throw new GraphQLError(CUSTOMER_KEYS_CLOSED.message, { extensions: { code: 'FORBIDDEN' } });
      const key = getKeyStore().create(args.name, permissions);
      return { id: key.id, name: key.name, permissions: key.permissions, createdAt: key.createdAt };
    },

    deleteKey: (_: unknown, args: { id: string }, ctx: GqlContext) => {
      requireAdmin(ctx);
      return getKeyStore().delete(args.id);
    },

    scanBatch: async (_: unknown, args: { texts: string[]; provider?: string }, ctx: GqlContext) => {
      requireAdmin(ctx);
      const provider = (args.provider ?? 'mock') as Provider;
      const texts = args.texts.slice(0, 20);
      const results = await Promise.all(
        texts.map(async (text) => {
          const result = await scanWithSpend({ text, provider, keyId: ctx.keyId }, () => scan(text, provider));
          const stored = getScanStore().record(ctx.keyId, text, result as unknown as Record<string, unknown>);
          return toScanResult(stored.id, result as unknown as Record<string, unknown>, stored.scannedAt);
        }),
      );
      return results;
    },
  },
};
