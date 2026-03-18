import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';

interface Claim {
  id: string;
  text: string;
  type: string;
  importance: number;
}

interface Verification {
  claimId: string;
  status: 'supported' | 'refuted' | 'unverified' | 'mixed';
  explanation: string;
  sources: Array<{ title: string; url?: string; uri?: string }>;
}

interface ScanResultInput {
  input: string;
  provider: string;
  claims: Claim[];
  verifications: Record<string, Verification>;
  overallRisk: string;
  [key: string]: unknown;
}

interface CompareResponse {
  newClaims: Claim[];
  removedClaims: Claim[];
  changedVerdicts: Array<{
    claim: Claim;
    before: string;
    after: string;
  }>;
  trustScoreDelta: number;
  summary: string;
}

const RISK_SCORE: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function computeCompare(before: ScanResultInput, after: ScanResultInput): CompareResponse {
  const beforeByText = new Map(before.claims.map(c => [normalize(c.text), c]));
  const afterByText  = new Map(after.claims.map(c => [normalize(c.text), c]));

  const newClaims     = after.claims.filter(c => !beforeByText.has(normalize(c.text)));
  const removedClaims = before.claims.filter(c => !afterByText.has(normalize(c.text)));

  const changedVerdicts: CompareResponse['changedVerdicts'] = [];
  for (const [text, claimAfter] of afterByText) {
    const claimBefore = beforeByText.get(text);
    if (!claimBefore) continue;
    const verBefore = before.verifications[claimBefore.id]?.status;
    const verAfter  = after.verifications[claimAfter.id]?.status;
    if (verBefore && verAfter && verBefore !== verAfter) {
      changedVerdicts.push({ claim: claimAfter, before: verBefore, after: verAfter });
    }
  }

  const scoreBefore = RISK_SCORE[before.overallRisk] ?? 0;
  const scoreAfter  = RISK_SCORE[after.overallRisk]  ?? 0;
  const trustScoreDelta = scoreAfter - scoreBefore;

  const summary = trustScoreDelta < 0 ? 'Risk improved'
                : trustScoreDelta > 0 ? 'Risk worsened'
                : 'No change';

  return { newClaims, removedClaims, changedVerdicts, trustScoreDelta, summary };
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['before', 'after'],
  properties: {
    before: { type: 'object' },
    after:  { type: 'object' },
  },
  additionalProperties: false,
} as const;

export async function compareRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: { before: ScanResultInput; after: ScanResultInput } }>(
    '/scan/compare',
    { preHandler: [requireApiKey], schema: { body: BODY_SCHEMA } },
    async (request, reply) => {
      const { before, after } = request.body;
      return reply.status(200).send(computeCompare(before, after));
    },
  );
}
