import type { Webhook } from '../../src/store/webhooks.js';

/**
 * Shared test factory for Webhook literals.
 * Centralises defaults so that changes to the Webhook interface only require
 * a single update here, rather than in every test file.
 */
export function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id:           overrides.id           ?? 'wh-test-id',
    url:          overrides.url          ?? 'https://example.com/hook',
    events:       overrides.events       ?? ['scan.complete'],
    secret:       overrides.secret       ?? 'test-secret',
    tenantId:     overrides.tenantId,
    maxAttempts:  overrides.maxAttempts  ?? 3,
    retryDelayMs: overrides.retryDelayMs ?? 500,
    createdAt:    overrides.createdAt    ?? new Date().toISOString(),
  };
}
