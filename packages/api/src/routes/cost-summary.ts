import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { summarizeSpendByKeyClass, type SpendByKeyClass } from '../store/provider-spend.js';
import { getClaimMeter } from '../store/claim-meter.js';

/**
 * GET /admin/cost-summary — provider cost and claim counts by key class over a
 * time window, so cost per billed customer claim can be reported each week.
 *
 * Read only. It reads the provider-spend ledger (cost, calls and claim counts
 * per key class) and the claim meter's usage record (the billing authority, for
 * the claims customers were billed for). It changes nothing: no row is written,
 * no reservation is made, the spend cap and billing are untouched.
 *
 * Admin only (requireAdmin). The measurement key is refused: this route is not
 * in MEASUREMENT_ROUTES.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Fixed caveats served with every summary. */
export const COST_SUMMARY_NOTES: readonly string[] = Object.freeze([
  'Extraction-only calls (a full-scan estimate) are in costUsd and calls but not in any claim count: their claims are counted once, by the call that verifies them.',
  'Costs are provider list prices computed from reported usage (or a text-length estimate when a provider reported none), not invoiced amounts.',
  'Rows written before spend rows carried a key class have no keyClass and are counted as "unlabelled".',
  'customerBilledClaims counts usage rows in the claim meter usage record, the billing authority, with voided rows excluded. Only metered keys write usage rows, and none are written while the claim meter is off.',
]);

/**
 * The last complete week, Monday 00:00Z to Monday 00:00Z, before `now`. At
 * exactly Monday 00:00Z the week that just ended is the one returned.
 */
export function lastCompleteWeek(now: Date = new Date()): { from: Date; to: Date } {
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const toMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - sinceMonday * DAY_MS;
  return { from: new Date(toMs - WEEK_MS), to: new Date(toMs) };
}

/** Strict-enough ISO-8601 timestamp: a date, optionally a time and zone. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function parseIso(raw: string): Date | null {
  if (!ISO_PATTERN.test(raw)) return null;
  // Date.parse rolls an impossible date forward (2026-02-30 reads as March 2),
  // so the calendar parts are checked themselves first.
  const [y, m, d] = raw.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  const time = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59)) return null;
  const zone = /([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (zone && raw.includes('T') && (Number(zone[2]) > 23 || Number(zone[3]) > 59)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export type WindowResult = { ok: true; from: Date; to: Date } | { ok: false; error: string };

/**
 * The window from the query. Neither given: the last complete Monday-to-Monday
 * week. Only `from`: one week from it. Only `to`: the week before it. The window
 * is half-open, [from, to).
 */
export function resolveWindow(query: { from?: string; to?: string }, now: Date = new Date()): WindowResult {
  const from = query.from === undefined ? undefined : parseIso(query.from);
  const to = query.to === undefined ? undefined : parseIso(query.to);
  if (from === null) return { ok: false, error: 'from must be an ISO-8601 timestamp' };
  if (to === null) return { ok: false, error: 'to must be an ISO-8601 timestamp' };
  if (from === undefined && to === undefined) return { ok: true, ...lastCompleteWeek(now) };
  const start = from ?? new Date((to as Date).getTime() - WEEK_MS);
  const end = to ?? new Date(start.getTime() + WEEK_MS);
  if (start.getTime() >= end.getTime()) return { ok: false, error: 'from must be before to' };
  return { ok: true, from: start, to: end };
}

export interface CostSummary {
  from: string;
  to: string;
  generatedAt: string;
  classes: SpendByKeyClass;
  customerBilledClaims: number;
  customerUnbilledClaims: number;
  notes: readonly string[];
}

/** Build the summary for [from, to). */
export async function buildCostSummary(from: Date, to: Date, now: Date = new Date()): Promise<CostSummary> {
  const classes = await summarizeSpendByKeyClass(from, to);
  const customerBilledClaims = getClaimMeter().billedUsageBetween(from, to);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    generatedAt: now.toISOString(),
    classes,
    customerBilledClaims,
    customerUnbilledClaims: Math.max(0, classes.customer.claimsHandled - customerBilledClaims),
    notes: COST_SUMMARY_NOTES,
  };
}

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string', maxLength: 40 },
    to: { type: 'string', maxLength: 40 },
  },
  additionalProperties: false,
} as const;

export async function costSummaryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/admin/cost-summary',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Analytics'],
        summary: 'Provider cost and claim counts by key class over a window (admin only)',
        querystring: QUERY_SCHEMA,
      },
    },
    async (request, reply) => {
      const window = resolveWindow(request.query);
      if (window.ok === false) return reply.status(400).send({ error: window.error });
      try {
        return reply.status(200).send(await buildCostSummary(window.from, window.to));
      } catch {
        // A ledger that fails part way through is never summed as if complete.
        return reply.status(500).send({ error: 'ledger_unreadable' });
      }
    },
  );
}
