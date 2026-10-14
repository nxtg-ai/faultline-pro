/**
 * A stored scan, only for the key that ran it (an admin key: any). Unknown
 * and not-yours read the same, so a caller cannot probe for other keys' scan
 * ids. Any valid key could read another key's stored scan text through the
 * PDF and compliance-gate routes (post-deploy Opus seat on 0ae37a0).
 */
import { keyOwnsOrAdmin } from './ownership.js';
import { getScanStore, type StoredScan } from '../store/scans.js';

export function ownedScan(id: string, keyId: string | undefined): StoredScan | undefined {
  const stored = getScanStore().getById(id);
  if (!stored) return undefined;
  return keyOwnsOrAdmin(keyId, stored.keyId) ? stored : undefined;
}
