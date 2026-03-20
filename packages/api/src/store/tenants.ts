import { randomUUID } from 'node:crypto';

export interface Tenant {
  id: string;
  name: string;
  keyIds: string[];  // API key IDs belonging to this tenant
  createdAt: string;
}

class TenantStore {
  private tenants: Map<string, Tenant> = new Map();

  create(name: string, keyIds: string[] = []): Tenant {
    const tenant: Tenant = {
      id: randomUUID(),
      name,
      keyIds,
      createdAt: new Date().toISOString(),
    };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  list(): Tenant[] {
    return [...this.tenants.values()];
  }

  get(id: string): Tenant | undefined {
    return this.tenants.get(id);
  }

  delete(id: string): boolean {
    return this.tenants.delete(id);
  }

  addKey(tenantId: string, keyId: string): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;
    if (!tenant.keyIds.includes(keyId)) tenant.keyIds.push(keyId);
    return true;
  }

  removeKey(tenantId: string, keyId: string): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;
    tenant.keyIds = tenant.keyIds.filter((k) => k !== keyId);
    return true;
  }

  findByKeyId(keyId: string): Tenant | undefined {
    return [...this.tenants.values()].find((t) => t.keyIds.includes(keyId));
  }

  get size(): number {
    return this.tenants.size;
  }

  reset(): void {
    this.tenants = new Map();
  }
}

let instance: TenantStore | null = null;

export function getTenantStore(): TenantStore {
  if (!instance) instance = new TenantStore();
  return instance;
}

export function resetTenantStore(): void {
  instance = new TenantStore();
}
