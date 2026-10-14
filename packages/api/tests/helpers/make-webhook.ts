import type { Webhook } from '../../src/store/webhooks.js';
import { getWebhookStore } from '../../src/store/webhooks.js';

/**
 * Shared test factory for Webhooks.
 * Centralises defaults so that changes to the Webhook interface only require
 * a single update here, rather than in every test file.
 *
 * The webhook is registered in the store (dispatch stops a retry once its
 * webhook is no longer registered), then given the requested id.
 */
export function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  const wh = getWebhookStore().create(
    overrides.url ?? 'https://example.com/hook',
    overrides.events ?? ['scan.complete'],
    overrides.secret ?? 'test-secret',
    overrides.tenantId,
    overrides.maxAttempts ?? 3,
    overrides.retryDelayMs ?? 500,
  );
  wh.id = overrides.id ?? 'wh-test-id';
  if (overrides.createdAt) wh.createdAt = overrides.createdAt;
  return wh;
}
