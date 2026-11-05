/**
 * A stored scan, only for the key that ran it (an admin key: any). Unknown
 * and not-yours read the same, so a caller cannot probe for other keys' scan
 * ids. Any valid key could read another key's stored scan text through the
 * PDF and compliance-gate routes (post-deploy Opus seat on 0ae37a0).
 */
import { keyOwnsOrAdmin } from './ownership.js';
import { getScanStore, type StoredScan } from '../store/scans.js';
import { getScanOwnerStore } from '../store/scan-owners.js';
import { withScanId } from '../store/webhooks.js';

export function ownedScan(id: string, keyId: string | undefined): StoredScan | undefined {
  const stored = getScanStore().getById(id);
  if (!stored) return undefined;
  return keyOwnsOrAdmin(keyId, stored.keyId) ? stored : undefined;
}

/**
 * Stamp a scan result with its scanId and record the key that owns that id.
 * Every REST route that returns a scanId goes through here, so the id the
 * caller receives can later be approved by that caller (and by admin).
 */
export function issueScanId<T extends object>(result: T, keyId: string | undefined, scanId?: string): T & { scanId: string } {
  const delivered = withScanId(result, scanId);
  if (keyId) getScanOwnerStore().record(delivered.scanId, keyId);
  return delivered;
}

/**
 * True when `keyId` may act on scan `id`: a stored scan or a scanId the REST
 * API returned, owned by `keyId` (an admin key: any). Unknown ids are false.
 */
export function ownsScanId(id: string, keyId: string | undefined): boolean {
  const stored = getScanStore().getById(id);
  if (stored) return keyOwnsOrAdmin(keyId, stored.keyId);
  const owner = getScanOwnerStore().ownerOf(id);
  return owner !== undefined && keyOwnsOrAdmin(keyId, owner);
}
