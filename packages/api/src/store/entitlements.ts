import type { Tier } from './ratelimit.js';

/**
 * Per-tier monthly scan entitlements — the margin-protecting usage cap.
 *
 * WHY: measured unit economics (docs/unit-economics-MEASURED-2026-07-04.md) put a
 * consensus scan at $0.20–0.71, ~88–91% of which is web-search retrieval. A flat
 * $19/mo tier goes gross-margin-NEGATIVE above ~27–95 scans/mo. This cap bounds a
 * paid user's monthly scans so the tier stays margin-positive.
 *
 * THE MECHANISM IS REVERSIBLE (this code); ACTIVATION + THE CAP NUMBER ARE NOT
 * (they set what a paying customer can do). Per ASIF autonomy canon, the number
 * and the go-live are Asif's pricing call — so this ships DORMANT by default
 * (FAULTLINE_USAGE_CAP=off) and every cap is env-overridable. Flipping it on with
 * a confirmed number is a one-env-var change, no code change.
 *
 * Default numbers below are CONSERVATIVE, MARGIN-SAFE PLACEHOLDERS derived from the
 * measured economics (paid tier priced to stay positive even at the $0.71 worst
 * case: 19 / 0.71 ≈ 26 break-even → cap 25 keeps margin). They are NOT a pricing
 * decision — they are a safe default until Asif sets the real numbers.
 */

/** null = unlimited (no monthly cap for this tier). */
export type MonthlyCap = number | null;

/** Conservative margin-safe placeholder caps. Overridden per-tier by env. */
const DEFAULT_MONTHLY_CAPS: Record<Tier, MonthlyCap> = {
  admin: null, // internal / unlimited
  pro: 25, // placeholder: $19-tier break-even at worst-case $0.71/scan ≈ 26; 25 keeps margin
  free: 10, // free acquisition tier — generous enough to prove value, bounded for abuse/COGS
};

/** Parse an env cap value: 'unlimited'/'null'/'' → null; a non-negative int → number. */
function parseCapEnv(raw: string | undefined, fallback: MonthlyCap): MonthlyCap {
  if (raw === undefined || raw === '') return fallback;
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'unlimited' || lowered === 'null' || lowered === 'off') return null;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return n;
}

/**
 * The monthly scan cap for a tier. Env overrides (per-tier):
 *   FAULTLINE_CAP_PRO, FAULTLINE_CAP_FREE, FAULTLINE_CAP_ADMIN
 * Value is an integer, or 'unlimited' for no cap.
 */
export function getMonthlyCap(tier: Tier): MonthlyCap {
  const envKey = `FAULTLINE_CAP_${tier.toUpperCase()}`;
  return parseCapEnv(process.env[envKey], DEFAULT_MONTHLY_CAPS[tier]);
}

/**
 * Whether the usage-cap gate is ACTIVE. Dormant by default — the gate is a no-op
 * until Asif confirms the numbers and sets FAULTLINE_USAGE_CAP=on (the go-live is
 * the irreversible pricing decision, not the mechanism). Accepts on/1/true/enabled.
 */
export function isUsageCapEnabled(): boolean {
  const raw = (process.env.FAULTLINE_USAGE_CAP ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'enabled';
}
