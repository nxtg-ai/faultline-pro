import type { FastifyInstance } from 'fastify';
import { requireApiKey, requireScope } from '../plugins/auth.js';
import { getClaimMeter, USAGE_RECORD_VERSION } from '../store/claim-meter.js';

/**
 * GET /admin/usage-records — the usage record, in seq order, for the billing
 * side to sync from. Needs scope `usage:read` (admin keys pass every scope), so
 * the route is declared `key` and the scope check does the gating: a non-admin
 * key that holds the scope must get through, which `admin` access would refuse.
 *
 * Read only: it never writes the ledger, reserves or commits, whether the meter
 * switch is on or off. A ledger that does not exist yet answers
 * `{ ledgerId: null, records: [], nextAfter: after, hasMore: false }`.
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    after: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
  additionalProperties: false,
} as const;

interface Query {
  after: number;
  limit: number;
}

export async function usageRecordsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: Query }>(
    '/admin/usage-records',
    {
      config: { access: 'key' },
      preHandler: [requireApiKey, requireScope('usage:read')],
      schema: {
        tags: ['Analytics'],
        summary: 'Usage record rows after a seq, for billing sync (scope usage:read)',
        querystring: QUERY_SCHEMA,
      },
    },
    async (request, reply) => {
      const page = getClaimMeter().page(request.query.after, request.query.limit);
      return reply
        .status(200)
        .header('X-Usage-Record-Version', String(USAGE_RECORD_VERSION))
        .send(page);
    },
  );
}
