/**
 * Per-tier default monthly caps equal the live plan limits.
 *
 * Source: https://faultline.nxtg.ai/pricing, read 2026-11-01 22:18 UTC (page footer
 * "v 0.2.0 · Alpha"). Quoted lines:
 *   Pro card:  "500 scans/month"
 *   Free (FAQ "Is there a free plan?"): "The Free plan gives you 5 scans per month
 *     with JSON and SARIF export and no card required."
 * The `admin` and `measurement` code tiers have no plan on the page; their defaults
 * stay unlimited (null). Personal (100 scans/month) and Enterprise (contract) have
 * no code tier, so nothing here maps to them.
 *
 * Validates: N-228 (per-tier monthly usage cap, defaults = ruled plan limits)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMonthlyCap, isUsageCapEnabled } from '../src/store/entitlements.js';

const CAP_ENV_KEYS = [
  'FAULTLINE_USAGE_CAP',
  'FAULTLINE_CAP_PRO',
  'FAULTLINE_CAP_FREE',
  'FAULTLINE_CAP_ADMIN',
  'FAULTLINE_CAP_MEASUREMENT',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of CAP_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of CAP_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('DEFAULT_MONTHLY_CAPS match the live pricing page (read 2026-11-01)', () => {
  it('pro default is 500 — Pro card: "500 scans/month"', () => {
    expect(getMonthlyCap('pro')).toBe(500);
  });

  it('free default is 5 — FAQ: "The Free plan gives you 5 scans per month"', () => {
    expect(getMonthlyCap('free')).toBe(5);
  });

  it('admin and measurement have no plan on the page and stay unlimited', () => {
    expect(getMonthlyCap('admin')).toBeNull();
    expect(getMonthlyCap('measurement')).toBeNull();
  });

  it('a garbage env value falls back to the plan-limit default', () => {
    process.env.FAULTLINE_CAP_PRO = 'banana';
    process.env.FAULTLINE_CAP_FREE = '-1';
    expect(getMonthlyCap('pro')).toBe(500);
    expect(getMonthlyCap('free')).toBe(5);
  });

  it('the cap stays dormant by default (FAULTLINE_USAGE_CAP unset)', () => {
    expect(isUsageCapEnabled()).toBe(false);
  });
});
