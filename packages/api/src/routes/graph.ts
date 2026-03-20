import type { FastifyInstance } from 'fastify';
import { getScanStore } from '../store/scans.js';

interface ClaimNode {
  id: string;
  text: string;
  type: string;
  importance: number;
}

/**
 * Build a Mermaid graph TD diagram from claims.
 * Edges are inferred from type hierarchy: fact → interpretation → opinion.
 * Within each tier, claims are ordered by importance (descending).
 */
function buildMermaid(claims: ClaimNode[]): string {
  if (claims.length === 0) return 'graph TD\n  empty["No claims"]';

  const lines: string[] = ['graph TD'];

  // Define nodes — escape special chars in labels
  for (const c of claims) {
    const label = c.text.replace(/"/g, "'").slice(0, 60) + (c.text.length > 60 ? '...' : '');
    lines.push(`  ${c.id}["${label} [${c.type}, ★${c.importance}]"]`);
  }

  // Derive edges: facts → interpretations → opinions
  const facts = claims.filter((c) => c.type === 'fact');
  const interpretations = claims.filter((c) => c.type === 'interpretation');
  const opinions = claims.filter((c) => c.type === 'opinion');

  // Connect highest-importance fact to each interpretation
  if (facts.length > 0 && interpretations.length > 0) {
    const rootFact = facts.sort((a, b) => b.importance - a.importance)[0];
    for (const interp of interpretations) {
      lines.push(`  ${rootFact.id} --> ${interp.id}`);
    }
  }

  // Connect highest-importance interpretation to each opinion
  if (interpretations.length > 0 && opinions.length > 0) {
    const rootInterp = interpretations.sort((a, b) => b.importance - a.importance)[0];
    for (const opinion of opinions) {
      lines.push(`  ${rootInterp.id} --> ${opinion.id}`);
    }
  }

  // If only facts and opinions (no interpretations), connect fact → opinion
  if (facts.length > 0 && opinions.length > 0 && interpretations.length === 0) {
    const rootFact = facts.sort((a, b) => b.importance - a.importance)[0];
    for (const opinion of opinions) {
      lines.push(`  ${rootFact.id} --> ${opinion.id}`);
    }
  }

  return lines.join('\n');
}

export async function graphRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/scan/:id/graph',
    {
      schema: {
        tags: ['Claims'],
        summary: 'Claim dependency graph in Mermaid or DOT format',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const stored = getScanStore().getById(request.params.id);
      if (!stored) {
        return reply.status(404).send({ error: 'Scan not found.' });
      }

      const claims = Array.isArray(stored.result.claims)
        ? (stored.result.claims as ClaimNode[])
        : [];

      const mermaid = buildMermaid(claims);

      return reply.status(200).send({
        id: stored.id,
        scannedAt: stored.scannedAt,
        claimCount: claims.length,
        mermaid,
      });
    },
  );
}
