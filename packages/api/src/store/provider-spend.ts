import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ManagedScanCostEvent } from './costs.js';

/**
 * provider-spend.ts — append-only PROVIDER-SPEND ledger + monthly budget cap.
 *
 * A-110 item 1 (founder REC adopted 2026-07-19): "$100/mo provider-spend cap,
 * ledgered" — the geo-grader pattern from deterministic-grounded-autonomy §Spend:
 * *provision/spend freely UP TO the cap, log every transaction; only crossing the
 * cap escalates.* The ledger is what makes the autonomy deterministic — an agent
 * may run consensus scans without a per-scan ask precisely because every dollar
 * lands in an append-only record and the cap is mechanical.
 *
 * NOT the same thing as `usage.ts` / `entitlements.ts` (N-228). That is a
 * per-CUSTOMER monthly SCAN QUOTA (protects the $19 tier's gross margin). This is
 * the FLEET-WIDE monthly USD budget on what Faultline spends at its providers
 * (protects the runway). Both can be active; they answer different questions:
 *
 *   usage cap      → "has THIS KEY used more scans than its tier includes?"  → 402
 *   provider-spend → "has FAULTLINE spent more than $100 at providers this month?" → 503
 *
 * EVERY API-PATH SCAN IS OUR SPEND. There is no BYOK path through this API:
 * provider credentials come only from server env (`GEMINI_API_KEY`,
 * `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), never from a request. So nothing a
 * caller can say exempts a scan from the ledger or the cap.
 *
 * In particular the `userkey` tier label does NOT exempt spend. `x-user-tier` is
 * a caller-supplied header (FW forwards it for telemetry classification) — an
 * authenticated caller can set it to anything in `VALID_TIERS`. Keying a money
 * decision off it would let a request opt out of the budget by spoofing a label,
 * and would leave real spend UNLEDGERED, which is precisely what the A-110
 * ruling forbids. `tier` is recorded as a LABEL for analytics and is never read
 * as a spend decision.
 *
 * THE LEDGER IS THE AUTHORITY, memory is the index. The in-process month total is
 * lazily HYDRATED by summing the ledger file, so a restart/redeploy does not
 * silently reset the budget to $0 (the known in-memory limitation that
 * `docs/usage-cap.md` flags for `UsageMeter`). Writes are synchronous+guarded:
 * a spend row is money, so read-after-write must be true within a process, and a
 * failed write must never fail a scan.
 *
 * ENFORCEMENT IS DORMANT BY DEFAULT. Ledgering is reversible and always on;
 * *blocking production scans* is new outward behavior, so it ships behind
 * `FAULTLINE_PROVIDER_SPEND_CAP=on` — a one-env-var flip, Asif's call.
 */

/** The cap Asif ruled on 2026-07-19 (A-110 item 1). Env-overridable, not env-derived. */
export const RULED_MONTHLY_CAP_USD = 100;

const DEFAULT_LEDGER_PATH = '/var/log/faultline/provider-spend.jsonl';

/** One provider-spend transaction. Append-only; no PII (no keyId, no text). */
export interface ProviderSpendEvent {
  ts: string;        // ISO-8601
  scanId: string;
  month: string;     // YYYY-MM (UTC) — the budget period this row belongs to
  tier: string;
  provider: string;
  modelId?: string;
  costUsd: number;
}

/** The UTC budget period (YYYY-MM) a timestamp falls in. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Where the append-only ledger lives. `FAULTLINE_PROVIDER_SPEND_LEDGER` overrides. */
export function ledgerPath(): string {
  const raw = (process.env.FAULTLINE_PROVIDER_SPEND_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_LEDGER_PATH : raw;
}

/**
 * The monthly provider-spend budget in USD. Defaults to the ruled $100;
 * `FAULTLINE_PROVIDER_SPEND_CAP_USD` overrides (a raised cap is Asif's call, and
 * per canon crossing the cap is the only thing that escalates).
 * A non-numeric or negative override falls back to the ruled default rather than
 * silently disabling the budget.
 */
export function getMonthlyCapUsd(): number {
  const raw = (process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD ?? '').trim();
  if (raw === '') return RULED_MONTHLY_CAP_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : RULED_MONTHLY_CAP_USD;
}

/**
 * Whether the cap GATE is active. Dormant by default: the mechanism + the ledger
 * deploy safely, and turning enforcement on is a one-env-var change.
 * Accepts on/1/true/enabled.
 */
export function isProviderSpendCapEnabled(): boolean {
  const raw = (process.env.FAULTLINE_PROVIDER_SPEND_CAP ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'enabled';
}

class ProviderSpendLedger {
  /** month → USD spent, hydrated from the ledger then kept live in-process. */
  private totals = new Map<string, number>();
  /** months already summed off disk (so hydration happens once per month per process). */
  private hydrated = new Set<string>();
  /** rows the process failed to persist — surfaced so a broken ledger is not silent. */
  private writeFailures = 0;

  /**
   * Sum the ledger file for `month` exactly once per process. Called by BOTH
   * `record` and `monthTotalUsd` so an in-process row can never be counted twice
   * (hydration always precedes the first increment for a month).
   * Unparseable rows are skipped — a corrupt line must not zero the budget.
   */
  private ensureHydrated(month: string): void {
    if (this.hydrated.has(month)) return;
    this.hydrated.add(month);
    const path = ledgerPath();
    let raw: string;
    try {
      if (!existsSync(path)) return;
      raw = readFileSync(path, 'utf8');
    } catch {
      return; // unreadable ledger → start from 0 for this process; writes still append
    }
    let sum = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const row = JSON.parse(trimmed) as Partial<ProviderSpendEvent>;
        if (row.month !== month) continue;
        const cost = Number(row.costUsd);
        if (Number.isFinite(cost) && cost > 0) sum += cost;
      } catch {
        continue;
      }
    }
    if (sum > 0) this.totals.set(month, (this.totals.get(month) ?? 0) + sum);
  }

  /**
   * Append one spend transaction and advance the month total.
   * Returns the event that was ledgered, or `null` when there is no real cost to
   * record (cache hit, mock, $0 leg, or a non-finite/negative figure).
   * The `tier` label is NEVER a reason to skip — see the header note.
   */
  record(event: ProviderSpendEvent): ProviderSpendEvent | null {
    if (!Number.isFinite(event.costUsd) || event.costUsd <= 0) return null;

    this.ensureHydrated(event.month);
    this.totals.set(event.month, (this.totals.get(event.month) ?? 0) + event.costUsd);

    const path = ledgerPath();
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(path, JSON.stringify(event) + '\n');
    } catch {
      // A failed write must NEVER fail a scan. The in-memory total already moved,
      // so the cap still holds for this process; the count surfaces the drift.
      this.writeFailures += 1;
    }
    return event;
  }

  /** USD spent in `month` — ledger-hydrated, then live. */
  monthTotalUsd(month: string = currentMonth()): number {
    this.ensureHydrated(month);
    return this.totals.get(month) ?? 0;
  }

  /** Rows this process could not persist (ledger unwritable). 0 = healthy. */
  getWriteFailures(): number {
    return this.writeFailures;
  }

  /** Drop in-process state (tests / ledger-path changes). Does not touch the file. */
  reset(): void {
    this.totals.clear();
    this.hydrated.clear();
    this.writeFailures = 0;
  }
}

let ledger: ProviderSpendLedger | null = null;

export function getProviderSpendLedger(): ProviderSpendLedger {
  if (!ledger) ledger = new ProviderSpendLedger();
  return ledger;
}

/** Reset the singleton — required after changing the ledger path in tests. */
export function resetProviderSpendLedger(): void {
  ledger?.reset();
  ledger = null;
}

/**
 * Ledger a managed scan's real composed cost (the `ManagedScanCostEvent` the
 * BLG-005 cost path already builds — single source of cost truth, no second
 * estimate). Call it alongside `emitScanCostEvent` / `appendScanCostLog`.
 */
export function recordProviderSpend(event: ManagedScanCostEvent): ProviderSpendEvent | null {
  return getProviderSpendLedger().record({
    ts: event.ts,
    scanId: event.scanId,
    month: currentMonth(new Date(event.ts)),
    tier: event.tier,
    provider: event.provider,
    modelId: event.modelId,
    costUsd: event.costUsd,
  });
}

/** Current budget position — what the gate reads and what `GET /usage` can surface. */
export interface ProviderSpendStatus {
  month: string;
  enforced: boolean;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  exhausted: boolean;
}

export function getProviderSpendStatus(now: Date = new Date()): ProviderSpendStatus {
  const month = currentMonth(now);
  const capUsd = getMonthlyCapUsd();
  const spentUsd = getProviderSpendLedger().monthTotalUsd(month);
  return {
    month,
    enforced: isProviderSpendCapEnabled(),
    capUsd,
    spentUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
    exhausted: spentUsd >= capUsd,
  };
}
