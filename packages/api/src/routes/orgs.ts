/**
 * Organization routes (D-162)
 *
 * POST   /orgs                          — create org
 * GET    /orgs                          — list orgs for current key
 * GET    /orgs/:id                      — get org (member only)
 * PATCH  /orgs/:id                      — update org (admin only)
 * DELETE /orgs/:id                      — delete org (owner only)
 *
 * GET    /orgs/:id/members              — list members
 * POST   /orgs/:id/members/invite       — create invitation
 * POST   /orgs/invites/:token/accept    — accept invitation
 * PATCH  /orgs/:id/members/:keyId/role  — update member role (admin)
 * DELETE /orgs/:id/members/:keyId       — remove member (admin)
 *
 * POST   /orgs/:id/keys                 — create scoped API key
 * GET    /orgs/:id/keys                 — list org keys
 * DELETE /orgs/:id/keys/:keyId          — revoke org key
 *
 * GET    /orgs/:id/usage                — org-scoped usage summary
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getOrgStore, type OrgRole, type OrgPlan } from '../store/orgs.js';
import type { Permission } from '../store/keys.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMember(orgId: string, keyId: string): boolean {
  return getOrgStore().getMemberRole(orgId, keyId) !== null;
}

function isAdmin(orgId: string, keyId: string): boolean {
  return getOrgStore().getMemberRole(orgId, keyId) === 'admin';
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function orgRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Org CRUD ──────────────────────────────────────────────────────────────

  fastify.post<{
    Body: { name: string; slug?: string; description?: string; plan?: OrgPlan };
  }>(
    '/orgs',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Create an organization',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name:        { type: 'string', minLength: 1, maxLength: 128 },
            slug:        { type: 'string', minLength: 1, maxLength: 48, pattern: '^[a-z0-9-]+$' },
            description: { type: 'string', maxLength: 512 },
            plan:        { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      try {
        const org = getOrgStore().create(request.body, keyId);
        return reply.status(201).send(org);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.get(
    '/orgs',
    {
      preHandler: [requireApiKey],
      schema: { tags: ['Organizations'], summary: 'List organizations for the current key' },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      const orgs = getOrgStore().listForKey(keyId);
      return reply.send({ orgs, total: orgs.length });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/orgs/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Get an organization',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isMember(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      return reply.send(org);
    },
  );

  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; plan?: OrgPlan; status?: 'active' | 'suspended' };
  }>(
    '/orgs/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Update an organization (admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            name:        { type: 'string', minLength: 1, maxLength: 128 },
            description: { type: 'string', maxLength: 512 },
            plan:        { type: 'string', enum: ['free', 'pro', 'enterprise'] },
            status:      { type: 'string', enum: ['active', 'suspended'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      const updated = getOrgStore().update(request.params.id, request.body);
      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/orgs/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Delete an organization (owner only)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (org.ownerId !== (request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Only the org owner can delete it.' });
      }
      getOrgStore().delete(request.params.id);
      return reply.status(204).send();
    },
  );

  // ── Members ───────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    '/orgs/:id/members',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'List org members',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isMember(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      return reply.send({ members: org.members, total: org.members.length });
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { email: string; role?: OrgRole };
  }>(
    '/orgs/:id/members/invite',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Invite a new member (admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            role:  { type: 'string', enum: ['admin', 'analyst', 'viewer'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      try {
        const invite = getOrgStore().createInvite(
          request.params.id,
          request.body.email,
          request.body.role ?? 'analyst',
          request.keyId ?? 'unknown',
        );
        // Return full token to caller — caller is responsible for delivering it
        return reply.status(201).send({
          token:     invite.token,
          email:     invite.email,
          role:      invite.role,
          expiresAt: invite.expiresAt,
        });
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.post<{
    Params: { token: string };
    Body: { keyId?: string };
  }>(
    '/orgs/invites/:token/accept',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Accept an org invitation',
        params: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
        body: {
          type: 'object',
          properties: { keyId: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const acceptorKeyId = request.keyId ?? 'unknown';
      try {
        const member = getOrgStore().acceptInvite(request.params.token, acceptorKeyId);
        return reply.status(200).send({ member, message: 'Invitation accepted.' });
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.patch<{
    Params: { id: string; memberId: string };
    Body: { role: OrgRole };
  }>(
    '/orgs/:id/members/:memberId/role',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Update a member\'s role (admin only)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, memberId: { type: 'string' } },
          required: ['id', 'memberId'],
        },
        body: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: ['admin', 'analyst', 'viewer'] } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      try {
        const member = getOrgStore().updateMemberRole(
          request.params.id, request.params.memberId, request.body.role,
        );
        if (!member) return reply.status(404).send({ error: 'Member not found.' });
        return reply.send(member);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.delete<{ Params: { id: string; memberId: string } }>(
    '/orgs/:id/members/:memberId',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Remove a member (admin only)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, memberId: { type: 'string' } },
          required: ['id', 'memberId'],
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      const callerKeyId = request.keyId ?? 'unknown';
      if (!isAdmin(org.id, callerKeyId)) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      try {
        const removed = getOrgStore().removeMember(request.params.id, request.params.memberId);
        if (!removed) return reply.status(404).send({ error: 'Member not found.' });
        return reply.status(204).send();
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── Scoped API Keys ───────────────────────────────────────────────────────

  fastify.post<{
    Params: { id: string };
    Body: { name: string; permissions?: Permission[] };
  }>(
    '/orgs/:id/keys',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Create a scoped API key for the org (admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name:        { type: 'string', minLength: 1, maxLength: 128 },
            permissions: {
              type: 'array',
              items: { type: 'string', enum: ['scan', 'report', 'upload', 'admin', 'pro'] },
              maxItems: 5,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      try {
        const { orgKey, apiKey } = getOrgStore().createOrgKey(
          request.params.id,
          request.body.name,
          request.body.permissions ?? ['scan'],
          request.keyId ?? 'unknown',
        );
        return reply.status(201).send({
          orgKey,
          key: apiKey.key,   // raw key shown only at creation
          keyId: apiKey.id,
          name: apiKey.name,
          permissions: apiKey.permissions,
          createdAt: apiKey.createdAt,
        });
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/orgs/:id/keys',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'List org scoped API keys (admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      return reply.send({ keys: org.keys, total: org.keys.length });
    },
  );

  fastify.delete<{ Params: { id: string; keyId: string } }>(
    '/orgs/:id/keys/:keyId',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Revoke an org-scoped API key (admin only)',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, keyId: { type: 'string' } },
          required: ['id', 'keyId'],
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      const revoked = getOrgStore().revokeOrgKey(request.params.id, request.params.keyId);
      if (!revoked) return reply.status(404).send({ error: 'Key not found in this org.' });
      return reply.status(204).send();
    },
  );

  // ── Usage ─────────────────────────────────────────────────────────────────

  fastify.get<{
    Params: { id: string };
    Querystring: { month?: string };
  }>(
    '/orgs/:id/usage',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'Get org-scoped usage summary',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isMember(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      try {
        const summary = getOrgStore().getUsage(request.params.id, request.query.month);
        return reply.send(summary);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── Invites list (admin) ──────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    '/orgs/:id/invites',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Organizations'],
        summary: 'List pending invitations (admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const org = getOrgStore().get(request.params.id);
      if (!org) return reply.status(404).send({ error: 'Organization not found.' });
      if (!isAdmin(org.id, request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Admin role required.' });
      }
      const invites = getOrgStore().listInvites(request.params.id);
      return reply.send({ invites, total: invites.length });
    },
  );
}
