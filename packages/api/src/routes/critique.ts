import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getProvider } from '@nxtg/faultline/providers/registry.js';
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
    provider: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export async function critiqueRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CritiqueRequestBody }>(
    '/critique',
    {
      preHandler: [requireApiKey],
      schema: { tags: ['Analysis'], summary: 'Generate critique and improved prompt for failed claims', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { claims, verifications, text } = request.body;
      const providerName = request.body.provider ?? 'openai';
      const envKey = KEY_ENV_MAP[providerName] ?? '';
      const apiKey = envKey ? (process.env[envKey] ?? '') : '';
      const provider = getProvider(apiKey, providerName);

      const failedClaims = extractFailedClaims(claims, verifications);
      const critiqueResult: CritiqueResult = failedClaims.length === 0
        ? { critique: '', improvedPrompt: '' }
        : await provider.generateCritiqueAndPrompt(text, failedClaims);

      return reply.status(200).send(buildCritiqueAnalysis(claims, verifications, critiqueResult));
    },
  );
}
