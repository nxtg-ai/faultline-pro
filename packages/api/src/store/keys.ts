import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';

export type Permission = 'scan' | 'report' | 'upload' | 'admin';

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  permissions: Permission[];
  createdAt: string;
}

class KeyStore {
  private keys: ApiKey[] = [];

  create(name: string, permissions: Permission[] = ['scan']): ApiKey {
    const entry: ApiKey = {
      id: randomUUID(),
      key: randomBytes(32).toString('hex'),
      name,
      permissions,
      createdAt: new Date().toISOString(),
    };
    this.keys.push(entry);
    return entry;
  }

  list(): ApiKey[] {
    return this.keys.slice();
  }

  delete(id: string): boolean {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx === -1) return false;
    this.keys.splice(idx, 1);
    return true;
  }

  validateKey(key: string): ApiKey | null {
    return this.keys.find((k) => k.key === key) ?? null;
  }

  get size(): number {
    return this.keys.length;
  }
}

let instance: KeyStore | null = null;

export function getKeyStore(): KeyStore {
  if (!instance) instance = new KeyStore();
  return instance;
}

export function resetKeyStore(): void {
  instance = new KeyStore();
}
