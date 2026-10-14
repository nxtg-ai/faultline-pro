/**
 * Customer API keys are not issued until tenancy is fixed (emma-soul
 * al:837ec6cea3437a7d, ruling 1). A route-table audit on 647bc10 found that
 * one non-admin key could reach another's stored data on several routes, so
 * every path that issues a key refuses a non-admin key unless
 * FAULTLINE_CUSTOMER_KEYS=on. The flag flips only after the tenancy change
 * (every stored object owned, one ownership guard, a route-table test) passes
 * two reviews. Admin (operator) keys stay issuable.
 */
import type { Permission } from '../store/keys.js';

export const CUSTOMER_KEYS_FLAG = 'FAULTLINE_CUSTOMER_KEYS';

export const CUSTOMER_KEYS_CLOSED = {
  error: 'customer_keys_closed',
  message: 'Customer API keys are not being issued yet. Only admin keys can be created.',
} as const;

/** True when a key with these permissions may be issued now. */
export function mayIssueKey(permissions: Permission[] | undefined): boolean {
  const perms = permissions ?? ['scan'];
  if (perms.includes('admin')) return true;
  return process.env[CUSTOMER_KEYS_FLAG] === 'on';
}
