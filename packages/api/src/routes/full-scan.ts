import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractForFullScan, verifyFullScan, type FullScanResult } from '@nxtg/faultline/cli/scan.js';
import { partitionForFullScan } from '@nxtg/faultline/cli/full-scan.js';
import { captureUsage, type UsageLeg } from '@nxtg/faultline/lib/usage-sink.js';
import { requireApiKey } from '../plugins/auth.js';
import { isExtractionError } from '@nxtg/faultline/providers/extraction-error.js';
import { sendExtractionFailed } from '../lib/extraction-failure.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { enforceProviderSpendCap } from '../plugins/provider-spend-cap.js';
import { isServerKeyId, resolveEntitledTier } from '../plugins/consensus-entitlement.js';
import { recordProviderSpend } from '../store/provider-spend.js';
import { getUsageMeter } from '../store/usage.js';
import {
  getCostStore,
  emitScanCostEvent,
  appendScanCostLog,
  buildManagedCostEvent,
  type ManagedScanCostEvent,
} from '../store/costs.js';
import {
  getFullScanJobStore,
  describeJob,
  describeLedgerRow,
  type FullScanJob,
  type FullScanJobStore,
  type StartedJob,
} from '../store/full-scan-jobs.js';

/**
 * Full scan ("deep scan" in product copy): estimate, start, poll, stop.
 * GoPMO 1.18.11.3.12, contract docs/design/2026-10-13-full-scan-api.md §3.
 *
 * Nothing in a request body can set the scan mode, the verify cap, the
 * concurrency or the units: the schemas strip unknown fields, units come from the
 * estimate the server made, and the run uses FULL_SCAN_CONCURRENCY.
 */

/** Fact claims verified at the same time within one full-scan job (doc §7). */
export const FULL_SCAN_CONCURRENCY = 4;

const DEFAULT_ESTIMATES_PER_MIN = 10;
const PROVIDER_ENUM = ['gemini', 'openai', 'claude', 'perplexity', 'mock'] as const;
type ScanProvider = typeof PROVIDER_ENUM[number];

const USER_REF_HEADER = 'x-faultline-user-ref';
const USER_REF_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
// fw's own rule (faultline-web lib/entitlements.ts requestIdFrom): a plain token only, so
// the id written to the ledger can never carry a URL or free text (codex F12-2).
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const ESTIMATE_BODY = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: { type: 'string', enum: PROVIDER_ENUM },
  },
  additionalProperties: false,
} as const;

const START_BODY = {
  type: 'object',
  required: ['estimateId'],
  properties: { estimateId: { type: 'string', minLength: 1, maxLength: 128 } },
  additionalProperties: false,
} as const;

const JOB_PARAMS = {
  type: 'object',
  required: ['jobId'],
  properties: { jobId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

interface EstimateBody {
  text: string;
  provider?: ScanProvider;
}

interface StartBody {
  estimateId: string;
}

interface JobParams {
  jobId: string;
}

// ── Identity ────────────────────────────────────────────────────────────────

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Who the request is for, inside its key. All web traffic arrives on
 * faultline-web's one server key, so fw names the user with x-faultline-user-ref
 * (an HMAC of the Clerk id). The header is trusted only from the server's own key,
 * by the same check as x-user-tier (isServerKeyId); from any other key, or when
 * malformed, it is ignored and the key counts as one user.
 */
export function resolveUserRef(request: FastifyRequest): string {
  const keyId = request.keyId ?? 'unknown';
  if (!isServerKeyId(keyId)) return keyId;
  const header = firstHeader(request.headers[USER_REF_HEADER]);
  return header !== undefined && USER_REF_PATTERN.test(header) ? header : keyId;
}

// ── Estimate limiter ────────────────────────────────────────────────────────

/** Estimates per (key, user-ref) per minute. `FAULTLINE_FULL_ESTIMATE_PER_MIN`, default 10. */
export function estimatesPerMinute(): number {
  const n = Number((process.env.FAULTLINE_FULL_ESTIMATE_PER_MIN ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_ESTIMATES_PER_MIN;
}

const ESTIMATE_WINDOW_MS = 60_000;
const ESTIMATE_LIMITER_SWEEP_SIZE = 10_000;
const estimateWindows = new Map<string, { start: number; count: number }>();

/** Clear the estimate limiter's windows (tests). */
export function resetFullScanEstimateLimiter(): void {
  estimateWindows.clear();
}

function sweepEstimateWindows(now: number): void {
  if (estimateWindows.size < ESTIMATE_LIMITER_SWEEP_SIZE) return;
  for (const [key, window] of estimateWindows) {
    if (now - window.start >= ESTIMATE_WINDOW_MS) estimateWindows.delete(key);
  }
}

/**
 * Prehandler: each estimate is a paid extraction call, and the server key's
 * per-key limit is shared by every web user, so estimates are limited per user too.
 * Must run AFTER requireApiKey.
 */
export async function limitFullScanEstimates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const now = Date.now();
  sweepEstimateWindows(now);
  const key = `${request.keyId ?? 'unknown'}\u0000${resolveUserRef(request)}`;
  const current = estimateWindows.get(key);
  const window = current && now - current.start < ESTIMATE_WINDOW_MS ? current : { start: now, count: 0 };
  const limit = estimatesPerMinute();
  if (window.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((window.start + ESTIMATE_WINDOW_MS - now) / 1000));
    reply.header('Retry-After', String(retryAfter)).status(429).send({ error: 'estimate_rate_limited', limit });
    return;
  }
  window.count += 1;
  estimateWindows.set(key, window);
}

// ── Cost ────────────────────────────────────────────────────────────────────

interface FullScanCostInput {
  text: string;
  provider: string;
  /** Grounded verify calls made (0 for an estimate). */
  claimCount: number;
  tier: ManagedScanCostEvent['tier'];
  latencyMs: number;
}

/**
 * Log one full-scan step (an estimate's extraction or a job's verify run) the way
 * POST /scan logs a scan: managed cost store, telemetry, scan-cost log, provider-spend
 * ledger. `kind: 'full-scan'` keeps /costs/percentiles comparable (scans only).
 */
function logFullScanCost(legs: UsageLeg[], input: FullScanCostInput): void {
  const event = buildManagedCostEvent(legs, { ...input, kind: 'full-scan' });
  getCostStore().recordManaged(event);
  emitScanCostEvent(event);
  appendScanCostLog(event);
  recordProviderSpend(event);
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Run `fn` inside a usage scope and keep the legs even when it throws (a failed call can still have spent). */
async function captureOutcome<T>(fn: () => Promise<T>): Promise<{ outcome: Outcome<T>; legs: UsageLeg[] }> {
  const { result, legs } = await captureUsage(async (): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error };
    }
  });
  return { outcome: result, legs };
}

const isMissingProviderKey = (error: unknown): error is Error =>
  error instanceof Error && error.message.startsWith('No API key found for');

// ── Job runner ──────────────────────────────────────────────────────────────

/**
 * Run one job to a terminal status. It verifies the estimate's claims (never a
 * second extraction) at FULL_SCAN_CONCURRENCY, records each verdict as it lands,
 * then logs the cost and finishes the job:
 *
 * - `done`: every fact claim was attempted.
 * - `stopped`: the caller stopped it; claims never started are unserved (not_attempted).
 * - `failed`: the run threw outright (e.g. the provider has no key), so no result
 *   reached the caller: served 0, refund = charged. A per-claim provider error is
 *   NOT this; it is an unserved claim inside a `done` job.
 */
async function runFullScanJob(store: FullScanJobStore, job: FullScanJob): Promise<void> {
  const startedAt = Date.now();
  const text = job.text;
  const { outcome, legs } = await captureOutcome<FullScanResult>(() => verifyFullScan(job.claims, {
    providerName: job.provider,
    text,
    concurrency: FULL_SCAN_CONCURRENCY,
    signal: job.controller.signal,
    onClaim: (_claim, verdict, index) => store.recordVerdict(job, index, verdict),
  }));
  logFullScanCost(legs, {
    text,
    provider: job.provider,
    claimCount: outcome.ok ? outcome.value.verification.verifiedClaims : job.verdicts.filter(Boolean).length,
    tier: job.tier,
    latencyMs: Date.now() - startedAt,
  });
  if (outcome.ok === false) {
    store.finish(job, 'failed');
    return;
  }
  store.finish(job, job.controller.signal.aborted ? 'stopped' : 'done', outcome.value);
}

// ── Routes ──────────────────────────────────────────────────────────────────

const accepted = (job: StartedJob) => ({ jobId: job.jobId, units: job.units, factClaims: job.factClaims });

/** undefined = header absent; null = present but not a usable key. */
function readIdempotencyKey(request: FastifyRequest): string | null | undefined {
  const raw = firstHeader(request.headers['idempotency-key']);
  if (raw === undefined || raw === '') return undefined;
  return IDEMPOTENCY_KEY_PATTERN.test(raw) ? raw : null;
}

function sendLookup(reply: FastifyReply, jobId: string, keyId: string, stop: boolean): FastifyReply {
  const store = getFullScanJobStore();
  const found = store.lookup(jobId, keyId);
  if (found.kind === 'error') return reply.status(found.statusCode).send({ error: found.error });
  if (found.kind === 'row') return reply.status(200).send(describeLedgerRow(found.row));
  if (stop) store.stop(found.job);
  return reply.status(200).send(describeJob(found.job));
}

export async function fullScanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: EstimateBody }>(
    '/scan/full/estimate',
    {
      preHandler: [requireApiKey, rateLimitScan, limitFullScanEstimates, enforceProviderSpendCap],
      schema: { tags: ['Scan'], summary: 'Price a full scan: extract claims, count fact claims and units', body: ESTIMATE_BODY },
    },
    async (request, reply) => {
      const { text } = request.body;
      const provider = request.body.provider ?? 'gemini';
      const keyId = request.keyId ?? 'unknown';
      const startedAt = Date.now();
      const { outcome, legs } = await captureOutcome(() => extractForFullScan(text, provider));
      logFullScanCost(legs, {
        text,
        provider,
        claimCount: 0,
        tier: resolveEntitledTier(keyId, request.headers['x-user-tier']),
        latencyMs: Date.now() - startedAt,
      });
      if (outcome.ok === false) {
        if (isMissingProviderKey(outcome.error)) {
          const missing = outcome.error.message.match(/"([^"]+)"/)?.[1] ?? 'unknown';
          return reply.status(503).send({ error: 'provider_not_configured', provider: missing });
        }
        // Never echo a raw provider error (it can carry quota blobs and model ids).
        if (isExtractionError(outcome.error)) return sendExtractionFailed(reply, outcome.error);
        return reply.status(502).send({ error: 'extraction_failed' });
      }
      const estimate = getFullScanJobStore().createEstimate({
        keyId,
        userRef: resolveUserRef(request),
        provider,
        claims: outcome.value.claims,
        text,
        factClaims: outcome.value.factClaims,
        notCheckable: outcome.value.notCheckable,
        units: outcome.value.units,
      });
      return reply.status(200).send({
        estimateId: estimate.estimateId,
        factClaims: estimate.factClaims,
        notCheckable: estimate.notCheckable,
        units: estimate.units,
        expiresAt: new Date(estimate.expiresAt).toISOString(),
        // The fact claims being priced, so fw shows the user what they pay to check and
        // keeps the text for the unchecked list even after a restart drops the result.
        // Extraction of the user's own input, no grounded output.
        claims: partitionForFullScan(outcome.value.claims).facts.map((c) => ({ claimId: c.id, text: c.text })),
      });
    },
  );

  fastify.post<{ Body: StartBody }>(
    '/scan/full',
    {
      preHandler: [requireApiKey, rateLimitScan, enforceProviderSpendCap],
      schema: { tags: ['Scan'], summary: 'Start a full scan from an estimate (Idempotency-Key required)', body: START_BODY },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      const idempotencyKey = readIdempotencyKey(request);
      if (idempotencyKey === undefined) return reply.status(400).send({ error: 'idempotency_key_required' });
      if (idempotencyKey === null) return reply.status(400).send({ error: 'idempotency_key_invalid' });

      // No await from here to enqueue: the checks and the job creation are one
      // synchronous step, so two concurrent starts cannot both pass a check.
      const store = getFullScanJobStore();
      const { estimateId } = request.body;
      const replayed = store.jobForIdempotencyKey(keyId, idempotencyKey);
      if (replayed) {
        return replayed.estimateId === estimateId
          ? reply.status(202).send(accepted(replayed))
          : reply.status(409).send({ error: 'idempotency_conflict' });
      }

      const userRef = resolveUserRef(request);
      const estimate = store.getEstimate(estimateId);
      // Another key's (or another user's) estimate answers like an unknown one.
      if (!estimate || estimate.keyId !== keyId || estimate.userRef !== userRef) {
        return reply.status(410).send({ error: 'estimate_expired' });
      }
      if (estimate.startedBy) return reply.status(409).send({ error: 'estimate_used' });
      if (store.activeJobFor(keyId, userRef)) return reply.status(409).send({ error: 'job_running' });
      // A job whose terminal row cannot reach the disk would read as job_lost after a
      // restart and be refunded in full although served: refuse it before any spend.
      if (!store.ledgerWritable()) return reply.status(503).send({ error: 'ledger_unavailable' });

      const job = store.startJob(estimate, {
        idempotencyKey,
        tier: resolveEntitledTier(keyId, request.headers['x-user-tier']),
      });
      // Counted here, once per job: the server.ts onResponse hook counts only /scan and /scan/upload.
      getUsageMeter().increment(keyId);
      store.enqueue(job, (queued) => runFullScanJob(store, queued));
      return reply.status(202).send(accepted({ jobId: job.jobId, estimateId, units: job.charged, factClaims: job.factClaims }));
    },
  );

  fastify.get<{ Params: JobParams }>(
    '/scan/full/:jobId',
    {
      preHandler: requireApiKey,
      schema: { tags: ['Scan'], summary: 'Poll a full scan: status, per-claim progress, units', params: JOB_PARAMS },
    },
    async (request, reply) => sendLookup(reply, request.params.jobId, request.keyId ?? 'unknown', false),
  );

  fastify.post<{ Params: JobParams }>(
    '/scan/full/:jobId/stop',
    {
      preHandler: requireApiKey,
      schema: { tags: ['Scan'], summary: 'Stop a full scan; claims never started are unserved', params: JOB_PARAMS },
    },
    async (request, reply) => sendLookup(reply, request.params.jobId, request.keyId ?? 'unknown', true),
  );
}
