/**
 * N-124 — GDPR schedule erasure tests (SS1–SS15)
 *
 * ScheduleStore holds PII (notifyEmail) and sensitive content (text, webhookUrl)
 * associated with API keys. N-124 adds:
 *   - ScheduleStore.deleteForKeys(keyIds[]) → count
 *   - ScheduleStore.listForKeys(keyIds[]) → Schedule[]
 *   - GDPR export ZIP includes schedules.json
 *   - manifest.counts.schedules reflects actual count
 *   - GDPR erasure includes schedules in deleted counts
 *
 * Tests validate:
 *   - deleteForKeys() accuracy and isolation
 *   - listForKeys() returns correct entries
 *   - schedules.json present in GDPR export ZIP
 *   - manifest.counts.schedules matches count
 *   - Export tenant isolation (other tenant schedules excluded)
 *   - Erasure deleted.schedules count accurate
 *   - Erasure isolation (other tenant schedules untouched)
 *   - Idempotency of deleteForKeys
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { buildServer } from '../src/server.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetScanHistory } from '../src/store/scan-history.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCostStore } from '../src/store/costs.js';
import { resetScheduleStore, getScheduleStore } from '../src/store/schedules.js';
import type { FastifyInstance } from 'fastify';

function adminHeaders() {
  return { 'x-api-key': 'admin-test-key' };
}

function zipEntry(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`ZIP entry not found: ${name}`);
  return entry.getData().toString('utf-8');
}

const CRON = '0 9 * * 1'; // every Monday at 09:00

describe('GDPR schedule erasure (SS1–SS15)', () => {
  let server: FastifyInstance;
  let tenantId: string;
  let keyId: string;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'admin-test-key';
    resetTenantStore();
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetNotificationStore();
    resetWebhookStore();
    resetUsageMeter();
    resetCostStore();
    resetScheduleStore();

    const key = getKeyStore().create('sched-key', ['scan'], 'sched-key');
    keyId = key.id;
    const tenant = getTenantStore().create('Schedule Corp', [keyId]);
    tenantId = tenant.id;

    // Seed two schedules for this tenant's key
    getScheduleStore().create(
      { name: 'Schedule A', cron: CRON, text: 'AI text A', notifyEmail: 'a@example.com' },
      keyId,
    );
    getScheduleStore().create(
      { name: 'Schedule B', cron: CRON, text: 'AI text B', notifyEmail: 'b@example.com' },
      keyId,
    );

    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── SS1: listForKeys returns seeded schedules ──────────────────────────────

  it('SS1: listForKeys returns both schedules for the tenant keys', () => {
    const result = getScheduleStore().listForKeys([keyId]);
    expect(result).toHaveLength(2);
    expect(result.every(s => s.keyId === keyId)).toBe(true);
  });

  // ── SS2: listForKeys returns empty for unknown keyId ───────────────────────

  it('SS2: listForKeys returns empty for unknown keyId', () => {
    expect(getScheduleStore().listForKeys(['no-such-key'])).toHaveLength(0);
  });

  // ── SS3: deleteForKeys returns correct count ───────────────────────────────

  it('SS3: deleteForKeys returns 2 for two seeded schedules', () => {
    expect(getScheduleStore().deleteForKeys([keyId])).toBe(2);
  });

  // ── SS4: deleteForKeys actually removes entries ────────────────────────────

  it('SS4: listForKeys after deleteForKeys returns empty', () => {
    getScheduleStore().deleteForKeys([keyId]);
    expect(getScheduleStore().listForKeys([keyId])).toHaveLength(0);
  });

  // ── SS5: deleteForKeys is idempotent ──────────────────────────────────────

  it('SS5: second deleteForKeys call returns 0', () => {
    getScheduleStore().deleteForKeys([keyId]);
    expect(getScheduleStore().deleteForKeys([keyId])).toBe(0);
  });

  // ── SS6: deleteForKeys isolation — other key untouched ────────────────────

  it('SS6: deleteForKeys does not affect schedules from other keys', () => {
    const key2 = getKeyStore().create('other-key', ['scan'], 'other-key');
    getScheduleStore().create({ name: 'Other Sched', cron: CRON, text: 'other' }, key2.id);

    getScheduleStore().deleteForKeys([keyId]);
    expect(getScheduleStore().listForKeys([key2.id])).toHaveLength(1);
  });

  // ── SS7: deleteForKeys with multiple keyIds ────────────────────────────────

  it('SS7: deleteForKeys accepts multiple keyIds and removes all matching', () => {
    const key2 = getKeyStore().create('key2', ['scan'], 'key2');
    getScheduleStore().create({ name: 'Sched C', cron: CRON, text: 'c' }, key2.id);

    const count = getScheduleStore().deleteForKeys([keyId, key2.id]);
    expect(count).toBe(3); // 2 from key1 + 1 from key2
  });

  // ── SS8: GDPR export ZIP contains schedules.json ──────────────────────────

  it('SS8: GDPR export ZIP contains schedules.json', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    expect(zip.getEntry('schedules.json')).not.toBeNull();
  });

  // ── SS9: schedules.json contains seeded entries ───────────────────────────

  it('SS9: schedules.json in export contains 2 seeded schedules', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const schedules = JSON.parse(zipEntry(zip, 'schedules.json'));
    expect(Array.isArray(schedules)).toBe(true);
    expect(schedules).toHaveLength(2);
  });

  // ── SS10: manifest.counts.schedules is 2 ─────────────────────────────────

  it('SS10: manifest.counts.schedules is 2', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const manifest = JSON.parse(zipEntry(zip, 'manifest.json'));
    expect(manifest.counts.schedules).toBe(2);
  });

  // ── SS11: schedules.json export isolation ─────────────────────────────────

  it('SS11: schedules.json only contains entries for the requested tenant keys', async () => {
    const key2 = getKeyStore().create('iso-key', ['scan'], 'iso-key');
    getScheduleStore().create({ name: 'Iso Sched', cron: CRON, text: 'iso' }, key2.id);

    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const schedules = JSON.parse(zipEntry(zip, 'schedules.json')) as Array<{ keyId: string }>;
    expect(schedules).toHaveLength(2);
    expect(schedules.every(s => s.keyId === keyId)).toBe(true);
  });

  // ── SS12: erasure response includes schedules field ───────────────────────

  it('SS12: DELETE /tenants/:id/data response includes deleted.schedules', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const body = JSON.parse(res.body);
    expect(body.deleted).toHaveProperty('schedules');
  });

  // ── SS13: erasure deleted.schedules is 2 ─────────────────────────────────

  it('SS13: deleted.schedules is 2 after erasing tenant with 2 schedules', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(JSON.parse(res.body).deleted.schedules).toBe(2);
  });

  // ── SS14: erasure isolation — other tenant schedules untouched ─────────────

  it('SS14: erasing tenant A does not delete tenant B schedules', async () => {
    const key2 = getKeyStore().create('b-sched-key', ['scan'], 'b-sched-key');
    const tenant2 = getTenantStore().create('Tenant B', [key2.id]);
    getScheduleStore().create({ name: 'B Sched', cron: CRON, text: 'b text' }, key2.id);

    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(getScheduleStore().listForKeys([key2.id])).toHaveLength(1);
    void tenant2; // referenced via store
  });

  // ── SS15: export after erasure returns empty schedules.json ───────────────

  it('SS15: schedules.json is empty after erasure', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const schedules = JSON.parse(zipEntry(zip, 'schedules.json'));
    expect(schedules).toHaveLength(0);
  });
});
