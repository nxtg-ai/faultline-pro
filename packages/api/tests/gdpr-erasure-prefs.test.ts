/**
 * N-122 — GDPR erasure prefs completeness tests (EP1–EP15)
 *
 * N-121 deleted notification history but left notification prefs (webhook URL,
 * email) intact — a GDPR gap since prefs can contain personal data (email addrs).
 *
 * N-122 adds deletePrefsForKeys() to NotificationStore and calls it in
 * DELETE /tenants/:id/data, extending the deleted response with notificationPrefs.
 *
 * These tests validate:
 *   - deleted.notificationPrefs count is reported
 *   - Prefs are actually removed after erasure
 *   - Multiple keys' prefs all erased in one call
 *   - Idempotency (second call returns 0 prefs)
 *   - Prefs for other tenants' keys are not touched
 *   - Empty tenant (no keys) returns 0 notificationPrefs
 *   - deletePrefsForKeys() unit behaviour
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetScanHistory } from '../src/store/scan-history.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetNotificationStore, getNotificationStore } from '../src/store/notifications.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

function adminHeaders() {
  return { 'x-api-key': 'admin-test-key' };
}

describe('GDPR erasure — notification prefs completeness (EP1–EP15)', () => {
  let server: FastifyInstance;
  let tenantId: string;
  let keyId: string;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-test-key';
    resetTenantStore();
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetNotificationStore();
    resetWebhookStore();
    resetUsageMeter();

    const key = getKeyStore().create('prefs-key', ['scan'], 'prefs-key');
    keyId = key.id;
    const tenant = getTenantStore().create('Prefs Test Corp', [keyId]);
    tenantId = tenant.id;

    // Set notification prefs for the key
    getNotificationStore().setPrefs(keyId, ['scan.failed'], 'https://hook.example.com/notify', 'user@example.com');
    // Also dispatch to create a history record
    await getNotificationStore().dispatch('scan.failed', { error: 'oops' }, keyId);

    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── EP1: response includes notificationPrefs count ────────────────────────

  it('EP1: deleted response includes notificationPrefs field', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const body = JSON.parse(res.body);
    expect(body.deleted).toHaveProperty('notificationPrefs');
  });

  // ── EP2: notificationPrefs count is 1 ────────────────────────────────────

  it('EP2: deleted.notificationPrefs is 1 when one key has prefs', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.notificationPrefs).toBe(1);
  });

  // ── EP3: prefs are actually removed after erasure ─────────────────────────

  it('EP3: notification prefs are gone after erasure', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(getNotificationStore().getPrefs(keyId)).toBeUndefined();
  });

  // ── EP4: history is also removed (existing N-121 behaviour preserved) ─────

  it('EP4: notification history is also erased (N-121 behaviour preserved)', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(getNotificationStore().getHistory(keyId, 10)).toHaveLength(0);
  });

  // ── EP5: multiple keys — all prefs erased ────────────────────────────────

  it('EP5: erases prefs for all keys when tenant has multiple keys', async () => {
    const key2 = getKeyStore().create('prefs-key-2', ['scan'], 'prefs-key-2');
    getTenantStore().addKey(tenantId, key2.id);
    getNotificationStore().setPrefs(key2.id, ['scan.failed'], null, 'other@example.com');

    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.notificationPrefs).toBe(2);
    expect(getNotificationStore().getPrefs(keyId)).toBeUndefined();
    expect(getNotificationStore().getPrefs(key2.id)).toBeUndefined();
  });

  // ── EP6: idempotent — second call reports 0 notificationPrefs ─────────────

  it('EP6: second erasure reports 0 notificationPrefs (idempotent)', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const res2 = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res2.body);
    expect(deleted.notificationPrefs).toBe(0);
  });

  // ── EP7: other tenant's prefs untouched ──────────────────────────────────

  it('EP7: erasing tenant A does not delete tenant B notification prefs', async () => {
    const key2 = getKeyStore().create('other-prefs-key', ['scan'], 'other-prefs-key');
    getTenantStore().create('Other Corp B', [key2.id]);
    getNotificationStore().setPrefs(key2.id, ['scan.failed'], 'https://b.example.com', null);

    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });

    // Tenant B's prefs should still exist
    expect(getNotificationStore().getPrefs(key2.id)!.keyId).toBe(key2.id);
  });

  // ── EP8: empty tenant (no keys) returns 0 notificationPrefs ──────────────

  it('EP8: tenant with no keys returns 0 notificationPrefs', async () => {
    const emptyTenant = getTenantStore().create('Empty Corp');
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${emptyTenant.id}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.notificationPrefs).toBe(0);
  });

  // ── EP9: key with no prefs counts as 0 ───────────────────────────────────

  it('EP9: key with no prefs set counts as 0 notificationPrefs deleted', async () => {
    getNotificationStore().deletePrefs(keyId); // remove prefs before erasure
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.notificationPrefs).toBe(0);
  });

  // ── EP10: deletePrefsForKeys() unit — returns correct count ──────────────

  it('EP10: deletePrefsForKeys([k1, k2]) returns 2 when both have prefs', () => {
    const k1 = getKeyStore().create('k1', ['scan']).id;
    const k2 = getKeyStore().create('k2', ['scan']).id;
    getNotificationStore().setPrefs(k1, ['scan.failed'], null, null);
    getNotificationStore().setPrefs(k2, ['scan.failed'], null, null);
    expect(getNotificationStore().deletePrefsForKeys([k1, k2])).toBe(2);
  });

  // ── EP11: deletePrefsForKeys([]) returns 0 ───────────────────────────────

  it('EP11: deletePrefsForKeys([]) returns 0', () => {
    expect(getNotificationStore().deletePrefsForKeys([])).toBe(0);
  });

  // ── EP12: deletePrefsForKeys() skips keys with no prefs ──────────────────

  it('EP12: deletePrefsForKeys skips keys with no prefs without error', () => {
    expect(() => getNotificationStore().deletePrefsForKeys(['no-such-key'])).not.toThrow();
    expect(getNotificationStore().deletePrefsForKeys(['no-such-key'])).toBe(0);
  });

  // ── EP13: after erasure, dispatch for that key delivers to no one ─────────

  it('EP13: after erasure, dispatching scan.failed for erased key sends to no recipients', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    // Dispatch should not throw, but no new history should be created for this key
    await getNotificationStore().dispatch('scan.failed', { error: 'test' }, keyId);
    expect(getNotificationStore().getHistory(keyId, 10)).toHaveLength(0);
  });

  // ── EP14: response contains all six deleted-data fields ──────────────────

  it('EP14: response contains all six deleted-data fields', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    for (const field of ['scanEntries', 'auditEntries', 'notifications', 'notificationPrefs', 'webhooks', 'usageKeys']) {
      expect(deleted, `missing field: ${field}`).toHaveProperty(field);
    }
  });

  // ── EP15: 404 still works after adding prefs erasure ─────────────────────

  it('EP15: 404 for unknown tenant is still returned correctly', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/tenants/no-such/data', headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
  });
});
