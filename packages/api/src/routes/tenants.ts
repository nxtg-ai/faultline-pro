import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getTenantStore } from '../store/tenants.js';
import { getUsageMeter } from '../store/usage.js';
import { getScanHistory } from '../store/scan-history.js';
import { getAuditLogger } from '../store/audit.js';
import { getNotificationStore } from '../store/notifications.js';
import { getWebhookStore } from '../store/webhooks.js';
import { getCostStore } from '../store/costs.js';
import { getScheduleStore } from '../store/schedules.js';

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    keyIds: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
} as const;

const ADD_KEY_BODY_SCHEMA = {
  type: 'object',
  required: ['keyId'],
  properties: {
    keyId: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

interface CreateTenantBody {
  name: string;
  keyIds?: string[];
}

interface AddKeyBody {
  keyId: string;
}

export async function tenantsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /tenants — create a tenant
  fastify.post<{ Body: CreateTenantBody }>(
    '/tenants',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Create a new tenant', body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { name, keyIds } = request.body;
      const store = getTenantStore();
      const tenant = store.create(name, keyIds);
      return reply.status(201).send(tenant);
    },
  );

  // GET /tenants — list all tenants
  fastify.get('/tenants', { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'List all tenants' } }, async (_request, reply) => {
    const store = getTenantStore();
    return reply.status(200).send(store.list());
  });

  // GET /tenants/:id — get tenant by id
  fastify.get<{ Params: { id: string } }>(
    '/tenants/:id',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Get a tenant by ID' } },
    async (request, reply) => {
      const store = getTenantStore();
      const tenant = store.get(request.params.id);
      if (!tenant) {
        return reply.status(404).send({ error: 'Tenant not found.' });
      }
      return reply.status(200).send(tenant);
    },
  );

  // DELETE /tenants/:id — delete tenant
  fastify.delete<{ Params: { id: string } }>(
    '/tenants/:id',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Delete a tenant by ID' } },
    async (request, reply) => {
      const store = getTenantStore();
      const deleted = store.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Tenant not found.' });
      }
      return reply.status(200).send({ ok: true });
    },
  );

  // POST /tenants/:id/keys — add a key to tenant
  fastify.post<{ Params: { id: string }; Body: AddKeyBody }>(
    '/tenants/:id/keys',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Add an API key to a tenant', body: ADD_KEY_BODY_SCHEMA } },
    async (request, reply) => {
      const store = getTenantStore();
      const added = store.addKey(request.params.id, request.body.keyId);
      if (!added) {
        return reply.status(404).send({ error: 'Tenant not found.' });
      }
      return reply.status(200).send(store.get(request.params.id));
    },
  );

  // DELETE /tenants/:id/keys/:keyId — remove a key from tenant
  fastify.delete<{ Params: { id: string; keyId: string } }>(
    '/tenants/:id/keys/:keyId',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Remove an API key from a tenant' } },
    async (request, reply) => {
      const store = getTenantStore();
      const tenant = store.get(request.params.id);
      if (!tenant) {
        return reply.status(404).send({ error: 'Tenant not found.' });
      }
      store.removeKey(request.params.id, request.params.keyId);
      return reply.status(200).send(store.get(request.params.id));
    },
  );

  // GET /tenants/:id/usage — aggregate usage across all tenant keyIds
  fastify.get<{ Params: { id: string } }>(
    '/tenants/:id/usage',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Aggregate usage across all keys in a tenant' } },
    async (request, reply) => {
      const store = getTenantStore();
      const tenant = store.get(request.params.id);
      if (!tenant) {
        return reply.status(404).send({ error: 'Tenant not found.' });
      }

      const meter = getUsageMeter();
      const aggregated: Record<string, number> = {};

      for (const keyId of tenant.keyIds) {
        const keyUsage = meter.getUsage(keyId);
        for (const [date, count] of Object.entries(keyUsage)) {
          aggregated[date] = (aggregated[date] ?? 0) + count;
        }
      }

      return reply.status(200).send({
        tenantId: tenant.id,
        name: tenant.name,
        keyIds: tenant.keyIds,
        usage: aggregated,
      });
    },
  );

  // ── GDPR Article 17 — Right to Erasure ────────────────────────────────────

  fastify.delete(
    '/tenants/:id/data',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Tenants'],
        summary: 'GDPR erasure — delete all data held for a tenant (Article 17)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id: tenantId } = request.params as { id: string };

      const tenant = getTenantStore().get(tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const meter = getUsageMeter();
      let usageKeysDeleted = 0;
      for (const keyId of tenant.keyIds ?? []) {
        if (meter.deleteKey(keyId)) usageKeysDeleted++;
      }

      const notifStore = getNotificationStore();
      const deleted = {
        scanEntries:       getScanHistory().deleteTenantEntries(tenantId),
        auditEntries:      getAuditLogger().deleteTenantEntries(tenantId),
        notifications:     notifStore.deleteTenantHistory(tenantId),
        notificationPrefs: notifStore.deletePrefsForKeys(tenant.keyIds ?? []),
        webhooks:          getWebhookStore().deleteTenant(tenantId),
        costs:             getCostStore().deleteTenantCosts(tenantId),
        schedules:         getScheduleStore().deleteForKeys(tenant.keyIds ?? []),
        usageKeys:         usageKeysDeleted,
      };

      return reply.code(200).send({ tenantId, deleted });
    },
  );
}
