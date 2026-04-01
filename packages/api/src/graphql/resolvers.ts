import { scan } from '@nxtg/faultline/cli/scan.js';
import { getKeyStore } from '../store/keys.js';
import { getUsageMeter } from '../store/usage.js';
import { getAuditLogger } from '../store/audit.js';
import { getScanStore } from '../store/scans.js';

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
      const provider = (args.provider ?? 'mock') as Provider;
      const result = await scan(args.text, provider);
      const stored = getScanStore().record(ctx.keyId, args.text, result as unknown as Record<string, unknown>);
      return toScanResult(stored.id, result as unknown as Record<string, unknown>, stored.scannedAt);
    },

    scans: (_: unknown, args: { keyId?: string; limit?: number }) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const items = getScanStore().list(args.keyId, limit);
      return items.map((s) => toScanResult(s.id, s.result, s.scannedAt));
    },

    keys: () => {
      return getKeyStore().list().map((k) => ({
        id: k.id,
        name: k.name,
        permissions: k.permissions,
        createdAt: k.createdAt,
      }));
    },

    usage: (_: unknown, args: { keyId: string }) => {
      const usageRecord = getUsageMeter().getUsage(args.keyId);
      return Object.entries(usageRecord).map(([date, count]) => ({ date, count }));
    },

    audit: (_: unknown, args: { limit?: number }) => {
      const entries = getAuditLogger().getEntries();
      const max = Math.min(args.limit ?? 100, 500);
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
    createKey: (_: unknown, args: { name: string; permissions?: string[] }) => {
      const key = getKeyStore().create(args.name, (args.permissions ?? ['scan']) as import('../store/keys.js').Permission[]);
      return { id: key.id, name: key.name, permissions: key.permissions, createdAt: key.createdAt };
    },

    deleteKey: (_: unknown, args: { id: string }) => {
      return getKeyStore().delete(args.id);
    },

    scanBatch: async (_: unknown, args: { texts: string[]; provider?: string }, ctx: GqlContext) => {
      const provider = (args.provider ?? 'mock') as Provider;
      const texts = args.texts.slice(0, 20);
      const results = await Promise.all(
        texts.map(async (text) => {
          const result = await scan(text, provider);
          const stored = getScanStore().record(ctx.keyId, text, result as unknown as Record<string, unknown>);
          return toScanResult(stored.id, result as unknown as Record<string, unknown>, stored.scannedAt);
        }),
      );
      return results;
    },
  },
};
