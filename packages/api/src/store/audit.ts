import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface AuditEntry {
  timestamp: string;
  keyId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  inputHash?: string;
}

export function hashInput(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

class AuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: AuditEntry): void {
    this.entries.push(entry);
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
