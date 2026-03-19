import { randomUUID } from 'node:crypto';

export interface StoredScan {
  id: string;
  keyId: string;
  text: string;
  result: Record<string, unknown>;
  scannedAt: string;
}

class ScanStore {
  private scans: StoredScan[] = [];
  private readonly MAX = 1000;

  record(keyId: string, text: string, result: Record<string, unknown>): StoredScan {
    const entry: StoredScan = {
      id: randomUUID(),
      keyId,
      text,
      result,
      scannedAt: new Date().toISOString(),
    };
    this.scans.push(entry);
    if (this.scans.length > this.MAX) this.scans.shift();
    return entry;
  }

  list(keyId?: string, limit = 50): StoredScan[] {
    const filtered = keyId ? this.scans.filter((s) => s.keyId === keyId) : this.scans;
    return filtered.slice(-limit);
  }

  getById(id: string): StoredScan | undefined {
    return this.scans.find((s) => s.id === id);
  }

  reset(): void {
    this.scans = [];
  }

  get size(): number {
    return this.scans.length;
  }
}

let instance: ScanStore | null = null;

export function getScanStore(): ScanStore {
  if (!instance) instance = new ScanStore();
  return instance;
}

export function resetScanStore(): void {
  instance = new ScanStore();
}
