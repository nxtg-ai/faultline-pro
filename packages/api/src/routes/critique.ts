import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { enforceProviderSpendCap } from '../plugins/provider-spend-cap.js';
import { buildManagedCostEvent, resolveTier } from '../store/costs.js';
import { recordProviderSpend } from '../store/provider-spend.js';
import { getProvider } from '@nxtg/faultline/providers/registry.js';
import type { LLMProvider } from '@nxtg/faultline/providers/base_provider.js';
import { captureUsage } from '@nxtg/faultline/lib/usage-sink.js';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';

interface CritiqueRequestBody {
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  text: string;
  provider?: string;
}

interface CritiqueResult {
  critique: string;
  improvedPrompt: string;
}

interface CritiqueAnalysis {
  failedClaims: Claim[];
  totalClaims: number;
  totalVerified: number;
  failedCount: number;
  hasCritique: boolean;
  critique: string;
  improvedPrompt: string;
}

// Verbatim port of FW lib/critique.ts

export const FAILED_STATUSES: ReadonlySet<string> = new Set(['contradicted', 'mixed', 'unverified']);

export function extractFailedClaims(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
): Claim[] {
  return claims.filter((claim) => {
    const verification = verifications[claim.id];
    return verification !== undefined && FAILED_STATUSES.has(verification.status);
  });
}

export function buildCritiqueAnalysis(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
  critiqueResult: CritiqueResult,
): CritiqueAnalysis {
  const failedClaims = extractFailedClaims(claims, verifications);
  return {
    failedClaims,
    totalClaims: claims.length,
    totalVerified: Object.keys(verifications).length,
    failedCount: failedClaims.length,
    hasCritique: critiqueResult.critique.trim().length > 0,
    critique: critiqueResult.critique,
    improvedPrompt: critiqueResult.improvedPrompt,
  };
}

const KEY_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  mock: '',
};

const BODY_SCHEMA = {
  type: 'object',
  required: ['claims', 'verifications', 'text'],
  properties: {
    claims: { type: 'array' },
    verifications: { type: 'object' },
    text: { type: 'string' },
    // Same allowlist as /scan: an unknown name is a 400, not a 500 from getProvider.
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
  },
  additionalProperties: false,
} as const;

/**
 * Run the critique LLM call and ledger what it cost (N-230).
 *
 * The call is wrapped in `captureUsage` so the provider's real reported tokens
 * are priced by the same `buildManagedCostEvent` path /scan and /scan/stream use.
 * A provider that reports no usage (perplexity) falls back to that helper's
 * text-length estimate, which over-counts here because the prompt sends only the
 * first 500 chars of `text`. Over-counting is the safe direction for a cap.
 * `claimCount: 0` because critique makes no grounding (web search) calls.
 */
async function runCritiqueWithSpend(
  provider: LLMProvider,
  providerName: string,
  keyId: string,
  text: string,
  failedClaims: Claim[],
): Promise<CritiqueResult> {
  const startTime = Date.now();
  const { result, legs } = await captureUsage(() => provider.generateCritiqueAndPrompt(text, failedClaims));
  const costEvent = buildManagedCostEvent(legs, {
    text,
    provider: providerName,
    claimCount: 0,
    tier: resolveTier(keyId),
    latencyMs: Date.now() - startTime,
  });
  recordProviderSpend(costEvent); // A-110 item 1: the fleet cap must see critique spend
  return result;
}

export async function critiqueRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CritiqueRequestBody }>(
    '/critique',
    {
      // Critique is a paid LLM call on our env keys, so it sits behind the same
      // per-minute burst limiter and fleet spend cap as a scan. It shares the
      // key's burst bucket with scans. The per-key monthly SCAN quota
      // (enforceMonthlyCap) is deliberately absent: a critique is not a scan.
      preHandler: [requireApiKey, rateLimitScan, enforceProviderSpendCap],
      schema: { tags: ['Analysis'], summary: 'Generate critique and improved prompt for failed claims', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { claims, verifications, text } = request.body;
      const providerName = request.body.provider ?? 'openai';
      const envKey = KEY_ENV_MAP[providerName] ?? '';
      const apiKey = envKey ? (process.env[envKey] ?? '') : '';
      const provider = getProvider(apiKey, providerName);

      const failedClaims = extractFailedClaims(claims, verifications);
      // No failed claims means no LLM call, so there is no spend to ledger.
      const critiqueResult: CritiqueResult = failedClaims.length === 0
        ? { critique: '', improvedPrompt: '' }
        : await runCritiqueWithSpend(provider, providerName, request.keyId ?? 'unknown', text, failedClaims);

      return reply.status(200).send(buildCritiqueAnalysis(claims, verifications, critiqueResult));
    },
  );
}
