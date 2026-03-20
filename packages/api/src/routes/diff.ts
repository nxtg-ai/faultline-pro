import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

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

interface ScanResult {
  input: string;
  provider: string;
  claims: Claim[];
  verifications: Record<string, Verification>;
  overallRisk: string;
  [key: string]: unknown;
}

interface DiffBody {
  before: string;
  after: string;
  provider?: Provider;
}

interface InlineDiffEntry {
  type: 'added' | 'removed' | 'changed' | 'unchanged';
  claim: string;
  before?: string;
  after?: string;
}

const RISK_SCORE: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['before', 'after'],
  properties: {
    before: { type: 'string', minLength: 1, maxLength: 50000 },
    after:  { type: 'string', minLength: 1, maxLength: 50000 },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
  },
  additionalProperties: false,
} as const;

export async function diffRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: DiffBody }>(
    '/scan/diff',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: { tags: ['Scan'], summary: 'Diff two texts — new/removed/changed claims with inline view', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { before, after, provider } = request.body;
      const effectiveProvider: Provider = provider ?? 'mock';

      const [scanBefore, scanAfter] = await Promise.all([
        scan(before, effectiveProvider),
        scan(after, effectiveProvider),
      ]) as [ScanResult, ScanResult];

      const beforeByText = new Map(scanBefore.claims.map(c => [normalize(c.text), c]));
      const afterByText  = new Map(scanAfter.claims.map(c => [normalize(c.text), c]));

      const newClaims     = scanAfter.claims.filter(c => !beforeByText.has(normalize(c.text)));
      const removedClaims = scanBefore.claims.filter(c => !afterByText.has(normalize(c.text)));

      const changedVerdicts: Array<{ claim: Claim; before: string; after: string }> = [];
      for (const [text, claimAfter] of afterByText) {
        const claimBefore = beforeByText.get(text);
        if (!claimBefore) continue;
        const verBefore = scanBefore.verifications[claimBefore.id]?.status;
        const verAfter  = scanAfter.verifications[claimAfter.id]?.status;
        if (verBefore && verAfter && verBefore !== verAfter) {
          changedVerdicts.push({ claim: claimAfter, before: verBefore, after: verAfter });
        }
      }

      const scoreBefore = RISK_SCORE[scanBefore.overallRisk] ?? 0;
      const scoreAfter  = RISK_SCORE[scanAfter.overallRisk]  ?? 0;
      const trustScoreDelta = scoreAfter - scoreBefore;

      const summary = trustScoreDelta < 0 ? 'Risk improved'
                    : trustScoreDelta > 0 ? 'Risk worsened'
                    : 'No change';

      // Build union of all normalized claim texts for inline diff
      const allTexts = new Set<string>([
        ...Array.from(beforeByText.keys()),
        ...Array.from(afterByText.keys()),
      ]);

      const inlineDiff: InlineDiffEntry[] = [];
      for (const normText of allTexts) {
        const inBefore = beforeByText.has(normText);
        const inAfter  = afterByText.has(normText);
        const displayText = inAfter
          ? afterByText.get(normText)!.text
          : beforeByText.get(normText)!.text;

        if (inBefore && inAfter) {
          const claimBefore = beforeByText.get(normText)!;
          const claimAfter  = afterByText.get(normText)!;
          const verBefore = scanBefore.verifications[claimBefore.id]?.status;
          const verAfter  = scanAfter.verifications[claimAfter.id]?.status;
          if (verBefore && verAfter && verBefore !== verAfter) {
            inlineDiff.push({ type: 'changed', claim: displayText, before: verBefore, after: verAfter });
          } else {
            inlineDiff.push({ type: 'unchanged', claim: displayText });
          }
        } else if (inAfter) {
          inlineDiff.push({ type: 'added', claim: displayText });
        } else {
          inlineDiff.push({ type: 'removed', claim: displayText });
        }
      }

      return reply.status(200).send({
        before: scanBefore,
        after: scanAfter,
        newClaims,
        removedClaims,
        changedVerdicts,
        trustScoreDelta,
        summary,
        inlineDiff,
      });
    },
  );
}
