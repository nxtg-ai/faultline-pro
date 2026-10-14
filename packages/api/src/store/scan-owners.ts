/**
 * Owner of every scan id the REST API hands back (POST /scan, /scan/deep,
 * /scan/batch, /scan/upload, /scan/template). Those results are not kept in
 * ScanStore, so without this the owner of a returned scanId could not approve
 * it (codex seat on f509bb6, F1). In memory, bounded: the oldest ids drop first.
 */
class ScanOwnerStore {
  private owners = new Map<string, string>();
  private readonly MAX = 50_000;

  record(scanId: string, keyId: string): void {
    this.owners.delete(scanId);
    this.owners.set(scanId, keyId);
    if (this.owners.size > this.MAX) this.owners.delete(this.owners.keys().next().value as string);
  }

  ownerOf(scanId: string): string | undefined {
    return this.owners.get(scanId);
  }

  reset(): void {
    this.owners.clear();
  }
}

let store: ScanOwnerStore | null = null;

export function getScanOwnerStore(): ScanOwnerStore {
  if (!store) store = new ScanOwnerStore();
  return store;
}

export function resetScanOwnerStore(): void {
  getScanOwnerStore().reset();
}
