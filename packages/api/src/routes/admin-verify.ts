import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { enforceProviderSpendCap } from '../plugins/provider-spend-cap.js';
import {
  appendScanCostLog,
  buildManagedCostEvent,
  getCostStore,
  resolveTier,
} from '../store/costs.js';
import { recordProviderSpend } from '../store/provider-spend.js';
import { summarizeScanUsage } from '../store/consensus-cost.js';
import { getProvider } from '@nxtg/faultline/providers/registry.js';
import { billableVerdictCount } from '@nxtg/faultline/lib/verdict-guard.js';
import type { LLMProvider } from '@nxtg/faultline/providers/base_provider.js';
import { DEFAULT_SCAN_PROVIDER, resolveApiKey } from '@nxtg/faultline/cli/provider-keys.js';
import type { UsageLeg } from '@nxtg/faultline/lib/usage-sink.js';
import { captureOutcome } from '../lib/scan-spend.js';
import type { Claim, ClaimStatus } from '@nxtg/faultline/types.js';

/**
 * POST /admin/verify-claims — the verify step alone, for the pre-registered
 * verdict-accuracy run (docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md §6).
 *
 * `POST /scan` re-extracts its input and can split or reword a claim, so a
 * labelled claim cannot be scored through it. This route sends each claim, as
 * given, to the same `verificationProvider.verifyClaim` that `scan()` calls, with
 * the provider resolved the way a non-consensus scan resolves it.
 *
 * Gates and ledgers match a scan: admin key only, the per-minute burst limiter,
 * the fleet provider-spend cap; usage captured per claim and priced by
 * `buildManagedCostEvent` into the same cost store, scan-cost log and append-only
 * provider-spend ledger, tagged kind 'admin-verify' so per-scan percentiles leave it out. Grounded Gemini prompts reach the daily grounding
 * allowance through the process-wide usage observer, as every scan's do.
 *
 * ONE call per claim, no retry. Retries belong to the runner, which checks the
 * grounding allowance before each batch; retrying here would spend prompts the
 * runner's guard cannot see.
 *
 * Each result also carries `usage`: that claim's own token counts, grounding
 * calls and USD cost, priced by `summarizeScanUsage`, the same function
 * `buildManagedCostEvent` prices the batch with. Pricing is a sum over legs, so
 * the per-claim costs add up to the batch event's cost whenever the batch
 * captured any priced usage. When it captured none (mock, every call failed),
 * the batch event falls back to a text-length estimate while every claim here
 * reports `costUsd: 0` with `priced: false`.
 *
 * Google grounding terms: the response carries our own status label, flags and
 * cost figures only. No explanation, source or other grounded text ever leaves
 * this route.
 */

export const MAX_VERIFY_CLAIMS = 25;
export const MAX_VERIFY_CLAIM_CHARS = 2000;
/** Upper bound on claims in flight at once (prereg §6: concurrency 4). */
export const VERIFY_CLAIMS_CONCURRENCY = 4;

export const PROVIDER_ENUM = ['gemini', 'openai', 'claude', 'perplexity', 'mock'] as const;
type VerifyProviderName = (typeof PROVIDER_ENUM)[number];

const BODY_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_VERIFY_CLAIMS,
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          text: { type: 'string', minLength: 1, maxLength: MAX_VERIFY_CLAIM_CHARS },
        },
        additionalProperties: false,
      },
    },
    provider: { type: 'string', enum: PROVIDER_ENUM },
  },
  additionalProperties: false,
} as const;

/**
 * The serializer drops any field not listed here, so even if a provider result
 * grew a grounded field it could not reach the wire through this route.
 */
const RESPONSE_SCHEMA = {
  200: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            apiError: { type: 'boolean' },
            parseFallback: { type: 'boolean' },
            noSourceAbstain: { type: 'boolean' },
            apiErrorReason: { type: ['string', 'null'] },
            model: { type: ['string', 'null'] },
            usage: {
              type: 'object',
              properties: {
                inputTokens: { type: 'number' },
                outputTokens: { type: 'number' },
                groundingCalls: { type: 'number' },
                costUsd: { type: 'number' },
                priced: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

interface VerifyClaimInput {
  id: string;
  text: string;
}

interface VerifyClaimsBody {
  claims: VerifyClaimInput[];
  provider?: VerifyProviderName;
}

/** What the route returns per claim. Nothing grounded: no explanation, no sources. */
export interface VerifyClaimOutcome {
  id: string;
  status: ClaimStatus;
  apiError: boolean;
  parseFallback: boolean;
  /** A grounded 'contradicted' with no source, reported as 'unverified' (VerificationResult.noSourceAbstain). */
  noSourceAbstain: boolean;
  /** Why an unchecked claim went unchecked (a label such as output_truncated); null on a verdict. */
  apiErrorReason: string | null;
  model: string | null;
  /** This claim's own captured usage and cost. Cost figures only. */
  usage?: ClaimUsage;
}

/** One claim's usage, priced with the batch ledger's pricing code. */
export interface ClaimUsage {
  inputTokens: number;
  outputTokens: number;
  groundingCalls: number;
  costUsd: number;
  /** False when the claim captured no priced usage (mock, a failed call); costUsd is then 0. */
  priced: boolean;
}

interface ClaimRun {
  outcome: VerifyClaimOutcome;
  legs: UsageLeg[];
}

/** The model the engine logged for this call, else the provider's configured model. */
function modelOf(legs: UsageLeg[], provider: LLMProvider): string | null {
  const logged = legs.find((leg) => typeof leg.model === 'string' && leg.model !== '')?.model;
  return logged ?? provider.modelId ?? null;
}

/**
 * Verify one claim with one provider call. A thrown error is reported as
 * `apiError` (the call did not produce a verdict), never as a verdict.
 */
async function verifyOne(provider: LLMProvider, input: VerifyClaimInput): Promise<ClaimRun> {
  const claim: Claim = { id: input.id, text: input.text, type: 'fact', importance: 3 };
  // The legs are kept when the call throws: a call that failed after reaching the
  // provider still spent, and the batch's spend row must count it.
  const { outcome, legs } = await captureOutcome(() => provider.verifyClaim(claim));
  if (outcome.ok === false) {
    return {
      legs,
      outcome: { id: input.id, status: 'unverified', apiError: true, parseFallback: false, noSourceAbstain: false, apiErrorReason: 'provider_error', model: null },
    };
  }
  const result = outcome.value;
  return {
    legs,
    outcome: {
      id: input.id,
      status: result.status,
      apiError: result.apiError === true,
      parseFallback: result.parseFallback === true,
      noSourceAbstain: result.noSourceAbstain === true,
      apiErrorReason: result.apiError === true ? (result.apiErrorReason ?? 'provider_error') : null,
      // A failed call produced no verdict and no engine model record.
      model: result.apiError === true ? null : modelOf(legs, provider),
    },
  };
}

/** Run `worker` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const slot = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, slot));
  return results;
}

/** Price the batch's captured usage and write it to the ledgers a scan writes. */
function recordBatchSpend(runs: ClaimRun[], claims: VerifyClaimInput[], providerName: string, keyId: string, startMs: number): void {
  const legs = runs.flatMap((run) => run.legs);
  const costEvent = buildManagedCostEvent(legs, {
    text: claims.map((claim) => claim.text).join('\n'),
    provider: providerName,
    claimCount: runs.filter((run) => !run.outcome.apiError).length,
    claims: { extracted: claims.length, verified: billableVerdictCount(runs.map((run) => run.outcome)) },
    tier: resolveTier(keyId),
    latencyMs: Date.now() - startMs,
    // A benchmark batch, not a scan: kept out of per-scan percentiles, still counted as spend below.
    kind: 'admin-verify',
  });
  getCostStore().recordManaged(costEvent);
  // Not sent to the telemetry Worker: its /api/scan-costs/stats is per-scan and cannot tell a batch from a scan.
  appendScanCostLog(costEvent);
  recordProviderSpend(costEvent);
}

/** Price one claim's captured legs, the same way the batch event prices all of them. */
export function claimUsage(legs: UsageLeg[]): ClaimUsage {
  const usage = summarizeScanUsage(legs);
  // The same gate as the batch event's hasRealUsage: priced means real composed cost.
  const priced = usage.costUsd > 0;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    groundingCalls: usage.groundingCalls,
    costUsd: priced ? usage.costUsd : 0,
    priced,
  };
}

function hasDuplicateIds(claims: VerifyClaimInput[]): boolean {
  return new Set(claims.map((claim) => claim.id)).size !== claims.length;
}

export async function adminVerifyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: VerifyClaimsBody }>(
    '/admin/verify-claims',
    {
      config: { access: 'admin' },
      preHandler: [requireAdmin, rateLimitScan, enforceProviderSpendCap],
      schema: {
        tags: ['Admin'],
        summary: 'Verify up to 25 claims as given (admin only; status labels only)',
        body: BODY_SCHEMA,
        response: RESPONSE_SCHEMA,
      },
    },
    async (request, reply) => {
      const { claims } = request.body;
      if (hasDuplicateIds(claims)) {
        return reply.status(400).send({ error: 'duplicate_claim_id' });
      }

      const providerName = request.body.provider ?? DEFAULT_SCAN_PROVIDER;
      let provider: LLMProvider;
      try {
        provider = getProvider(resolveApiKey(providerName), providerName);
      } catch {
        return reply.status(503).send({ error: 'provider_not_configured', provider: providerName });
      }

      const startMs = Date.now();
      const runs = await mapWithConcurrency(claims, VERIFY_CLAIMS_CONCURRENCY, (claim) => verifyOne(provider, claim));
      recordBatchSpend(runs, claims, providerName, request.keyId ?? 'unknown', startMs);

      return reply.status(200).send({
        provider: providerName,
        results: runs.map((run) => ({ ...run.outcome, usage: claimUsage(run.legs) })),
      });
    },
  );
}
