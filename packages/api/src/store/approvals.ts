import { randomUUID } from 'node:crypto';

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalEntry {
  id: string;
  scanId: string;
  approver: string;       // keyId of the approving user
  tenantId?: string;
  timestamp: string;      // ISO string
  decision: ApprovalDecision;
  note?: string;
}

class ApprovalStore {
  private entries: ApprovalEntry[] = [];

  record(entry: Omit<ApprovalEntry, 'id'>): ApprovalEntry {
    const stored: ApprovalEntry = { id: randomUUID(), ...entry };
    this.entries.push(stored);
    return stored;
  }

  getByScanId(scanId: string): ApprovalEntry[] {
    return this.entries.filter(e => e.scanId === scanId);
  }

  getAll(): ApprovalEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries = [];
  }
}

let instance: ApprovalStore | null = null;

export function getApprovalStore(): ApprovalStore {
  if (!instance) instance = new ApprovalStore();
  return instance;
}

export function resetApprovalStore(): void {
  instance = new ApprovalStore();
}
