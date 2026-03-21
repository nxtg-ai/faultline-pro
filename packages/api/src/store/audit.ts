import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getTenantStore } from './tenants.js';

export interface AuditEntry {
  timestamp: string;
  keyId: string;
  tenantId?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  inputHash?: string;
  note?: string;
}

export function hashInput(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

class AuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: Omit<AuditEntry, 'tenantId'> & { tenantId?: string }): void {
    const tenantId = entry.tenantId ?? getTenantStore().findByKeyId(entry.keyId)?.id;
    this.entries.push({ ...entry, tenantId });
    const path = process.env.FAULTLINE_AUDIT_PATH;
    if (path) {
      try {
        appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        // non-fatal
      }
    }
  }

  getEntries(): AuditEntry[] {
    return this.entries.slice();
  }

  /** Deletes all audit entries for a specific tenant. Returns count of deleted entries. */
  deleteTenantEntries(tenantId: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.tenantId !== tenantId);
    return before - this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

let instance: AuditLogger | null = null;

export function getAuditLogger(): AuditLogger {
  if (!instance) instance = new AuditLogger();
  return instance;
}

export function resetAuditLogger(): void {
  instance = new AuditLogger();
}
