/**
 * Organization Store (D-162)
 *
 * Multi-tenant organization management layer:
 *   - Create/update/delete orgs
 *   - Invite members with role assignment (admin | analyst | viewer)
 *   - Scoped API key registry per org (keys issued via getKeyStore())
 *   - Token-based invitation flow (7-day expiry)
 *   - Org-scoped usage aggregation over getUsageMeter()
 *
 * Role capabilities:
 *   admin    — full org management, invite/remove members, create keys
 *   analyst  — run scans, view results, generate reports
 *   viewer   — read-only access to scan results
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { getKeyStore } from './keys.js';
import { getUsageMeter } from './usage.js';
import type { ApiKey, Permission } from './keys.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrgRole    = 'admin' | 'analyst' | 'viewer';
export type OrgPlan    = 'free' | 'pro' | 'enterprise';
export type OrgStatus  = 'active' | 'suspended';

export interface OrgMember {
  keyId:     string;    // references ApiKey.id
  email?:    string;
  role:      OrgRole;
  joinedAt:  string;
}

export interface OrgInvite {
  token:       string;
  orgId:       string;
  email:       string;
  role:        OrgRole;
  invitedBy:   string;  // keyId of inviter
  createdAt:   string;
  expiresAt:   string;  // +7 days
  acceptedAt?: string;
}

export interface OrgKey {
  keyId:     string;    // references ApiKey.id
  keyName:   string;
  addedAt:   string;
  addedBy:   string;    // keyId of creator
}

export interface Org {
  id:          string;
  name:        string;
  slug:        string;
  description: string;
  ownerId:     string;    // keyId of creator
  plan:        OrgPlan;
  status:      OrgStatus;
  members:     OrgMember[];
  keys:        OrgKey[];  // scoped API keys
  createdAt:   string;
  updatedAt:   string;
}

export interface CreateOrgInput {
  name:         string;
  slug?:        string;
  description?: string;
  plan?:        OrgPlan;
}

export interface OrgUsageSummary {
  orgId:       string;
  orgName:     string;
  period:      string;  // YYYY-MM
  totalScans:  number;
  byKey:       Array<{ keyId: string; keyName: string; scans: number }>;
  byDay:       Record<string, number>;
}

const MAX_ORGS         = 1_000;
const MAX_MEMBERS      = 500;
const MAX_ORG_KEYS     = 100;
const INVITE_TTL_MS    = 7 * 24 * 60 * 60 * 1_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

// ── OrgStore ──────────────────────────────────────────────────────────────────

class OrgStore {
  private orgs    = new Map<string, Org>();
  private invites = new Map<string, OrgInvite>();

  // ── Org CRUD ──

  create(input: CreateOrgInput, ownerKeyId: string): Org {
    if (this.orgs.size >= MAX_ORGS) {
      throw new Error(`Organization limit reached (max ${MAX_ORGS}).`);
    }
    const name = input.name.trim();
    if (!name) throw new Error('Organization name is required.');

    const baseSlug = input.slug?.trim() ? toSlug(input.slug.trim()) : toSlug(name);
    const slug = this.uniqueSlug(baseSlug);

    const now = new Date().toISOString();
    const org: Org = {
      id:          randomUUID(),
      name,
      slug,
      description: input.description?.trim() ?? '',
      ownerId:     ownerKeyId,
      plan:        input.plan ?? 'free',
      status:      'active',
      members:     [{ keyId: ownerKeyId, role: 'admin', joinedAt: now }],
      keys:        [],
      createdAt:   now,
      updatedAt:   now,
    };
    this.orgs.set(org.id, org);
    return org;
  }

  get(id: string): Org | undefined {
    return this.orgs.get(id);
  }

  getBySlug(slug: string): Org | undefined {
    for (const org of this.orgs.values()) {
      if (org.slug === slug) return org;
    }
    return undefined;
  }

  /** List all orgs the given keyId belongs to (as member or owner). */
  listForKey(keyId: string): Org[] {
    return Array.from(this.orgs.values()).filter(
      o => o.members.some(m => m.keyId === keyId),
    );
  }

  listAll(): Org[] {
    return Array.from(this.orgs.values());
  }

  update(id: string, patch: Partial<Pick<Org, 'name' | 'description' | 'plan' | 'status'>>): Org | null {
    const org = this.orgs.get(id);
    if (!org) return null;
    if (patch.name        !== undefined) org.name        = patch.name.trim();
    if (patch.description !== undefined) org.description = patch.description.trim();
    if (patch.plan        !== undefined) org.plan        = patch.plan;
    if (patch.status      !== undefined) org.status      = patch.status;
    org.updatedAt = new Date().toISOString();
    return org;
  }

  delete(id: string): boolean {
    return this.orgs.delete(id);
  }

  // ── Membership ──

  getMemberRole(orgId: string, keyId: string): OrgRole | null {
    const org = this.orgs.get(orgId);
    if (!org) return null;
    return org.members.find(m => m.keyId === keyId)?.role ?? null;
  }

  addMember(orgId: string, keyId: string, role: OrgRole, email?: string): OrgMember {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error('Organization not found.');
    if (org.members.length >= MAX_MEMBERS) {
      throw new Error(`Member limit reached (max ${MAX_MEMBERS}).`);
    }
    if (org.members.some(m => m.keyId === keyId)) {
      throw new Error('Member already belongs to this organization.');
    }
    const member: OrgMember = { keyId, role, email, joinedAt: new Date().toISOString() };
    org.members.push(member);
    org.updatedAt = new Date().toISOString();
    return member;
  }

  updateMemberRole(orgId: string, keyId: string, role: OrgRole): OrgMember | null {
    const org = this.orgs.get(orgId);
    if (!org) return null;
    const member = org.members.find(m => m.keyId === keyId);
    if (!member) return null;
    // Prevent removing the last admin
    if (member.role === 'admin' && role !== 'admin') {
      const adminCount = org.members.filter(m => m.role === 'admin').length;
      if (adminCount <= 1) throw new Error('Cannot demote the last admin.');
    }
    member.role = role;
    org.updatedAt = new Date().toISOString();
    return member;
  }

  removeMember(orgId: string, keyId: string): boolean {
    const org = this.orgs.get(orgId);
    if (!org) return false;
    // Prevent removing the last admin
    const member = org.members.find(m => m.keyId === keyId);
    if (member?.role === 'admin') {
      const adminCount = org.members.filter(m => m.role === 'admin').length;
      if (adminCount <= 1) throw new Error('Cannot remove the last admin.');
    }
    const before = org.members.length;
    org.members = org.members.filter(m => m.keyId !== keyId);
    // Also remove any org keys created under this keyId (keep keys — just remove member)
    if (org.members.length < before) {
      org.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  // ── Invitations ──

  createInvite(orgId: string, email: string, role: OrgRole, inviterKeyId: string): OrgInvite {
    if (!this.orgs.has(orgId)) throw new Error('Organization not found.');
    const now   = new Date();
    const invite: OrgInvite = {
      token:     randomBytes(24).toString('hex'),
      orgId,
      email:     email.trim().toLowerCase(),
      role,
      invitedBy: inviterKeyId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    };
    this.invites.set(invite.token, invite);
    return invite;
  }

  getInvite(token: string): OrgInvite | undefined {
    return this.invites.get(token);
  }

  acceptInvite(token: string, acceptorKeyId: string): OrgMember {
    const invite = this.invites.get(token);
    if (!invite) throw new Error('Invitation not found.');
    if (invite.acceptedAt) throw new Error('Invitation already accepted.');
    if (new Date(invite.expiresAt) < new Date()) throw new Error('Invitation has expired.');
    const member = this.addMember(invite.orgId, acceptorKeyId, invite.role, invite.email);
    invite.acceptedAt = new Date().toISOString();
    return member;
  }

  listInvites(orgId: string): OrgInvite[] {
    return Array.from(this.invites.values()).filter(i => i.orgId === orgId);
  }

  // ── Scoped API Keys ──

  /** Create a new API key scoped to the org via the global key store. */
  createOrgKey(orgId: string, keyName: string, permissions: Permission[], creatorKeyId: string): { orgKey: OrgKey; apiKey: ApiKey } {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error('Organization not found.');
    if (org.keys.length >= MAX_ORG_KEYS) {
      throw new Error(`Org key limit reached (max ${MAX_ORG_KEYS}).`);
    }
    const apiKey = getKeyStore().create(`[${org.slug}] ${keyName}`, permissions);
    const orgKey: OrgKey = {
      keyId:   apiKey.id,
      keyName,
      addedAt: new Date().toISOString(),
      addedBy: creatorKeyId,
    };
    org.keys.push(orgKey);
    org.updatedAt = new Date().toISOString();
    return { orgKey, apiKey };
  }

  revokeOrgKey(orgId: string, keyId: string): boolean {
    const org = this.orgs.get(orgId);
    if (!org) return false;
    const before = org.keys.length;
    org.keys = org.keys.filter(k => k.keyId !== keyId);
    if (org.keys.length < before) {
      getKeyStore().delete(keyId);
      org.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  // ── Usage Aggregation ──

  getUsage(orgId: string, month?: string): OrgUsageSummary {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error('Organization not found.');

    const targetMonth = month ?? new Date().toISOString().slice(0, 7); // YYYY-MM
    const meter = getUsageMeter();

    const byDay: Record<string, number>   = {};
    const byKey: OrgUsageSummary['byKey'] = [];

    // Aggregate across all member keyIds + org-scoped keyIds
    const allKeyIds = new Set([
      ...org.members.map(m => m.keyId),
      ...org.keys.map(k => k.keyId),
    ]);

    for (const keyId of allKeyIds) {
      const usage = meter.getUsage(keyId);
      let keyTotal = 0;
      for (const [day, count] of Object.entries(usage)) {
        if (!day.startsWith(targetMonth)) continue;
        byDay[day] = (byDay[day] ?? 0) + count;
        keyTotal  += count;
      }
      if (keyTotal > 0) {
        const orgKeyEntry = org.keys.find(k => k.keyId === keyId);
        byKey.push({ keyId, keyName: orgKeyEntry?.keyName ?? keyId, scans: keyTotal });
      }
    }

    return {
      orgId,
      orgName:    org.name,
      period:     targetMonth,
      totalScans: Object.values(byDay).reduce((a, b) => a + b, 0),
      byKey,
      byDay,
    };
  }

  reset(): void {
    this.orgs.clear();
    this.invites.clear();
  }

  // ── Internal ──

  private uniqueSlug(base: string): string {
    if (!this.getBySlug(base)) return base;
    let i = 2;
    while (this.getBySlug(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }
}

let instance: OrgStore | null = null;

export function getOrgStore(): OrgStore {
  if (!instance) instance = new OrgStore();
  return instance;
}

export function resetOrgStore(): void {
  instance = new OrgStore();
}
