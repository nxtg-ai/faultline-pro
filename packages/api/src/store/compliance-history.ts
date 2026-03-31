import { randomUUID } from 'node:crypto';

export interface ComplianceHistoryEntry {
  id: string;
  projectName: string;
  scanId: string;
  complianceScore: number;
  pass: boolean;
  overallRisk: string;
  nonCompliantCount: number;
  totalArticles: number;
  threshold: number;
  recordedAt: string;
}

class ComplianceHistoryStore {
  private entries: ComplianceHistoryEntry[] = [];
  private readonly MAX = 5000;

  record(data: Omit<ComplianceHistoryEntry, 'id' | 'recordedAt'>): ComplianceHistoryEntry {
    const entry: ComplianceHistoryEntry = {
      ...data,
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > this.MAX) this.entries.shift();
    return entry;
  }

  query(opts: { projectName?: string; limit?: number; since?: string } = {}): ComplianceHistoryEntry[] {
    let filtered = this.entries;

    if (opts.projectName) {
      filtered = filtered.filter(e => e.projectName === opts.projectName);
    }
    if (opts.since) {
      filtered = filtered.filter(e => e.recordedAt >= opts.since!);
    }

    const limit = opts.limit ?? 100;
    return filtered.slice(-limit);
  }

  trend(projectName: string): { current: number | null; previous: number | null; direction: 'up' | 'down' | 'stable' | 'none' } {
    const entries = this.entries.filter(e => e.projectName === projectName);
    if (entries.length === 0) return { current: null, previous: null, direction: 'none' };
    if (entries.length === 1) return { current: entries[0].complianceScore, previous: null, direction: 'none' };

    const current = entries[entries.length - 1].complianceScore;
    const previous = entries[entries.length - 2].complianceScore;

    return {
      current,
      previous,
      direction: current > previous ? 'up' : current < previous ? 'down' : 'stable',
    };
  }

  reset(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

let instance: ComplianceHistoryStore | null = null;

export function getComplianceHistoryStore(): ComplianceHistoryStore {
  if (!instance) instance = new ComplianceHistoryStore();
  return instance;
}

export function resetComplianceHistoryStore(): void {
  instance = new ComplianceHistoryStore();
}
