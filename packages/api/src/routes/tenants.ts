import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getTenantStore } from '../store/tenants.js';
import { getUsageMeter } from '../store/usage.js';

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
    { preHandler: requireAdmin, schema: { body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { name, keyIds } = request.body;
      const store = getTenantStore();
      const tenant = store.create(name, keyIds);
      return reply.status(201).send(tenant);
    },
  );

  // GET /tenants — list all tenants
  fastify.get('/tenants', { preHandler: requireAdmin }, async (_request, reply) => {
    const store = getTenantStore();
    return reply.status(200).send(store.list());
  });

  // GET /tenants/:id — get tenant by id
  fastify.get<{ Params: { id: string } }>(
    '/tenants/:id',
    { preHandler: requireAdmin },
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
    { preHandler: requireAdmin },
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
    { preHandler: requireAdmin, schema: { body: ADD_KEY_BODY_SCHEMA } },
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
    { preHandler: requireAdmin },
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
    { preHandler: requireAdmin },
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
}
