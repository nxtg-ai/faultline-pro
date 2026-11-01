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
 * The `pro` and `free` defaults below are the live plan limits, read from
 * https://faultline.nxtg.ai/pricing on 2026-11-01:
 *   pro  500 — Pro card: "500 scans/month"
 *   free 5   — FAQ: "The Free plan gives you 5 scans per month with JSON and SARIF
 *              export and no card required."
 * `admin` and `measurement` have no plan on that page and stay unlimited. The
 * Personal plan (100 scans/month) and Enterprise (contract) have no code tier here.
 */

/** null = unlimited (no monthly cap for this tier). */
export type MonthlyCap = number | null;

/** Per-tier default caps (live plan limits where a plan exists). Overridden per-tier by env. */
const DEFAULT_MONTHLY_CAPS: Record<Tier, MonthlyCap> = {
  admin: null, // internal / unlimited; no plan on the pricing page
  pro: 500, // Pro plan: "500 scans/month" (faultline.nxtg.ai/pricing, read 2026-11-01)
  free: 5, // Free plan: "5 scans per month" (faultline.nxtg.ai/pricing FAQ, read 2026-11-01)
  measurement: null, // internal measurement key: it may not call a scan route at all
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
