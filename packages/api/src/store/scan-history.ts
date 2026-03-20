import { randomUUID } from 'node:crypto';

export interface ScanEntry {
  id: string;
  textPreview: string;   // first 100 chars of input text, anonymized (no full content)
  provider: string;
  overallRisk: string;
  claimCount: number;
  latencyMs: number;
  timestamp: string;     // ISO string
  keyId: string;
}

const MAX_HISTORY = 1000;

class ScanHistoryStore {
  private entries: ScanEntry[] = [];

  record(entry: Omit<ScanEntry, 'id'>): ScanEntry {
    const stored: ScanEntry = { id: randomUUID(), ...entry };
    this.entries.unshift(stored);   // newest first
    if (this.entries.length > MAX_HISTORY) this.entries.length = MAX_HISTORY;
    return stored;
  }

  getRecent(limit = 10): ScanEntry[] {
    return this.entries.slice(0, limit);
  }

  search(params: {
    q?: string;
    from?: string;
    to?: string;
    provider?: string;
    risk?: string;
    cursor?: string;
    limit?: number;
  }): { entries: ScanEntry[]; nextCursor: string | null } {
    const limit = Math.min(params.limit ?? 20, 100);
    let results = this.entries; // already newest-first

    // Apply cursor (skip entries up to and including the cursor id)
    if (params.cursor) {
      const cursorIdx = results.findIndex((e) => e.id === params.cursor);
      if (cursorIdx !== -1) results = results.slice(cursorIdx + 1);
    }

    if (params.q) {
      const q = params.q.toLowerCase();
      results = results.filter((e) => e.textPreview.toLowerCase().includes(q));
    }
    if (params.from) results = results.filter((e) => e.timestamp >= params.from!);
    if (params.to)   results = results.filter((e) => e.timestamp <= params.to!);
    if (params.provider) results = results.filter((e) => e.provider === params.provider);
    if (params.risk) results = results.filter((e) => e.overallRisk === params.risk);

    const page = results.slice(0, limit);
    const nextCursor = page.length === limit && results.length > limit ? page[page.length - 1].id : null;
    return { entries: page, nextCursor };
  }

  get size(): number {
    return this.entries.length;
  }

  reset(): void {
    this.entries = [];
  }
}

let instance: ScanHistoryStore | null = null;

export function getScanHistory(): ScanHistoryStore {
  if (!instance) instance = new ScanHistoryStore();
  return instance;
}

export function resetScanHistory(): void {
  instance = new ScanHistoryStore();
}
