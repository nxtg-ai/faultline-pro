import type { FastifyRequest } from 'fastify';
import { resolveEntitledTier } from './consensus-entitlement.js';

/**
 * Provider choice is an Enterprise feature (emma-soul ruling Dx3 d41fa0c1,
 * GoPMO 1.18.15.1.11, option A).
 *
 * The privacy page names Google Gemini as the model provider for a scan, and
 * OpenAI and Anthropic only on Enterprise multi-model consensus scans. So for
 * every plan below Enterprise a caller-named provider is replaced by Gemini
 * before any route reads it: on the body, on the query string, and on the
 * per-stage `pipelineConfig.extractionProvider` / `verificationProvider`.
 * Consensus itself is refused below Enterprise by consensus-entitlement.ts.
 *
 * `mock` is kept: it is the test double and sends text nowhere.
 *
 * The tier comes from resolveEntitledTier, so `x-user-tier` is honoured only
 * from the server key faultline-web holds. A keystore key is never Enterprise
 * today. The measurement key is internal and keeps its provider.
 */

export const DEFAULT_SCAN_PROVIDER = 'gemini';

const KEEPS_PROVIDER_CHOICE = new Set(['enterprise', 'measurement']);
const ALWAYS_ALLOWED = new Set([DEFAULT_SCAN_PROVIDER, 'mock']);

/** True when a caller with this key and forwarded tier may name a provider other than Gemini. */
export function tierMayChooseProvider(keyId: string, headerTier?: string | string[]): boolean {
  return KEEPS_PROVIDER_CHOICE.has(resolveEntitledTier(keyId, headerTier));
}

/** True when this request's plan may name a provider other than Gemini. */
export function mayChooseProvider(request: FastifyRequest): boolean {
  return tierMayChooseProvider(request.keyId ?? 'unknown', request.headers['x-user-tier']);
}

/** The provider a caller may use, given the one it named and whether its plan allows a choice. */
export function providerForPlan<T extends string | undefined>(named: T, mayChoose: boolean): T | typeof DEFAULT_SCAN_PROVIDER {
  if (named === undefined || ALWAYS_ALLOWED.has(named)) return named;
  return mayChoose ? named : DEFAULT_SCAN_PROVIDER;
}

/**
 * The provider a request may use, given the one it named (or a template or a
 * saved schedule named). Returns the name unchanged when the plan allows it, or
 * when it is Gemini, mock or absent; otherwise Gemini.
 */
export function entitledProvider<T extends string | undefined>(request: FastifyRequest, named: T): T | typeof DEFAULT_SCAN_PROVIDER {
  return providerForPlan(named, mayChooseProvider(request));
}

/**
 * Routes whose `provider` field is not a scan provider: a filter over stored
 * rows, or a label inside a result the caller hands back. The hook leaves them.
 */
export const NON_SELECTOR_ROUTES = new Set(['/costs', '/scans/search', '/scan/report/pdf']);

function rewrite(holder: unknown, field: string, request: FastifyRequest): void {
  if (holder === null || typeof holder !== 'object') return;
  const record = holder as Record<string, unknown>;
  const value = record[field];
  if (typeof value !== 'string') return;
  record[field] = entitledProvider(request, value);
}

/**
 * Global preHandler: runs after the key check (route-access.ts moves it to
 * onRequest) and before any route's own preHandlers and handler.
 */
export async function enforceProviderEntitlement(request: FastifyRequest): Promise<void> {
  if (!request.keyId) return;
  if (NON_SELECTOR_ROUTES.has(request.routeOptions.url ?? '')) return;
  const body = request.body;
  rewrite(body, 'provider', request);
  if (body !== null && typeof body === 'object') {
    const pipelineConfig = (body as { pipelineConfig?: unknown }).pipelineConfig;
    rewrite(pipelineConfig, 'extractionProvider', request);
    rewrite(pipelineConfig, 'verificationProvider', request);
  }
  rewrite(request.query, 'provider', request);
}
