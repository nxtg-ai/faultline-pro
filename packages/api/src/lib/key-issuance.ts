/**
 * Customer API keys are not issued until tenancy is fixed (emma-soul
 * al:837ec6cea3437a7d, ruling 1). A route-table audit on 647bc10 found that
 * one non-admin key could reach another's stored data on several routes, so
 * every path that issues a key refuses a non-admin key unless
 * FAULTLINE_CUSTOMER_KEYS=on. The flag flips only after the tenancy change
 * (every stored object owned, one ownership guard, a route-table test) passes
 * two reviews. Admin (operator) keys stay issuable.
 */
import type { KeyBillingFields, Permission } from '../store/keys.js';

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

/**
 * Claim caps for issued non-admin keys. The price is 0.10 USD per billable
 * claim, so a cap of 100 to 10,000 claims is 10 to 1,000 USD a month and the
 * default of 1,000 claims is 100 USD a month. Admin keys are not bound by
 * these numbers and are never metered by default.
 */
export const DEFAULT_CLAIM_CAP = 1000;
export const MIN_CLAIM_CAP = 100;
export const MAX_CLAIM_CAP = 10_000;

/** True when these permissions make an admin key. */
export function isAdminPermissions(permissions: Permission[] | undefined): boolean {
  return (permissions ?? ['scan']).includes('admin');
}

/**
 * The billing fields an issued key starts with. A non-admin key is metered
 * with claimCap DEFAULT_CLAIM_CAP unless the request says otherwise; an admin
 * key keeps exactly what was asked (never metered by default).
 */
export function issuedKeyBilling<T extends KeyBillingFields>(permissions: Permission[] | undefined, billing: T = {} as T): T {
  if (isAdminPermissions(permissions)) return billing;
  const metered = billing.metered ?? true;
  const claimCap = billing.claimCap ?? (metered ? DEFAULT_CLAIM_CAP : undefined);
  return { ...billing, metered, ...(claimCap !== undefined ? { claimCap } : {}) };
}

export const CLAIM_CAP_OUT_OF_RANGE = {
  error: 'claim_cap_out_of_range',
  message: `claimCap for a non-admin key must be an integer from ${MIN_CLAIM_CAP} to ${MAX_CLAIM_CAP}.`,
  min: MIN_CLAIM_CAP,
  max: MAX_CLAIM_CAP,
} as const;

/**
 * True when `claimCap` is allowed on a key with these permissions. A non-admin
 * key takes only an integer from MIN_CLAIM_CAP to MAX_CLAIM_CAP, so a string,
 * a fraction, a negative or a very large number is out of range.
 */
export function claimCapInBounds(permissions: Permission[] | undefined, claimCap: unknown): boolean {
  if (isAdminPermissions(permissions)) return true;
  return typeof claimCap === 'number' && Number.isInteger(claimCap) && claimCap >= MIN_CLAIM_CAP && claimCap <= MAX_CLAIM_CAP;
}
