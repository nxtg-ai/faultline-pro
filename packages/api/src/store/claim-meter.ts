import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isVerdictStatus } from '@nxtg/faultline/lib/verdict-guard.js';
import type { VerificationResult } from '@nxtg/faultline/types.js';
import { currentMonth } from './provider-spend.js';

/**
 * claim-meter.ts — append-only CLAIM ledger + per-key monthly claim cap
 * (node 1.18.11.7.6).
 *
 * The billable unit is one claim that received a provider verdict
 * (`supported`, `contradicted`, `mixed` or `unverified`). A claim whose check
 * never ran (`apiError`), a failed extraction, a timeout or a retried provider
 * call that threw produces no verdict and no row.
 *
 * THE LEDGER IS THE AUTHORITY, memory is the index (the provider-spend.ts
 * pattern). One row per committed claim; usage is hydrated by reading the file
 * once per process, so a deploy cannot reset a key's month. A row's
 * `identifier` (`scanId:claimId`) is unique: a duplicate is never counted or
 * written twice.
 *
 * RESERVATIONS live in memory only. A route reserves the most claims it may
 * verify BEFORE any provider call; `reserve` is one synchronous
 * check-and-increment, so two concurrent requests from one key cannot both pass
 * a cap only one fits (one process, one Fly machine). After the run the route
 * commits the claims that got a verdict and releases the rest. A crash loses
 * only reservations, which frees capacity; it never loses a committed row.
 *
 * SYNC STATE (which rows reached Stripe) is a second append-only file of
 * `{identifier, sentAt}` markers, so the claim ledger itself stays one row per
 * claim and a restart does not resend what Stripe already has.
 */

const DEFAULT_LEDGER_PATH = '/var/log/faultline/claim-meter.jsonl';
const DEFAULT_SYNC_LEDGER_PATH = '/var/log/faultline/claim-meter-sync.jsonl';

/** One committed claim. Append-only; no claim text, no input text. */
export interface ClaimMeterRow {
  ts: string;         // ISO-8601, when the claim was committed
  period: string;     // YYYY-MM (UTC), the cap period the claim counts against
  keyId: string;
  scanId: string;
  claimId: string;
  verdict: string;
  provider: string;
  identifier: string; // `${scanId}:${claimId}`, unique across the ledger
}

/** A marker that one ledger row reached the billing sink. */
export interface ClaimMeterSyncRow {
  identifier: string;
  sentAt: string;
}

/** Where the claim ledger lives. `FAULTLINE_CLAIM_METER_LEDGER` overrides. */
export function claimMeterLedgerPath(): string {
  const raw = (process.env.FAULTLINE_CLAIM_METER_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_LEDGER_PATH : raw;
}

/** Where the sync markers live. `FAULTLINE_CLAIM_METER_SYNC_LEDGER` overrides. */
export function claimMeterSyncLedgerPath(): string {
  const raw = (process.env.FAULTLINE_CLAIM_METER_SYNC_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_SYNC_LEDGER_PATH : raw;
}

/**
 * The claim cap for a key that has none of its own: `FAULTLINE_DEFAULT_CLAIM_CAP`
 * (a non-negative integer). `null` when unset or invalid, which means such a key
 * is refused (fail closed).
 */
export function defaultClaimCap(): number | null {
  const raw = (process.env.FAULTLINE_DEFAULT_CLAIM_CAP ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** True when a verification is a delivered verdict, so it bills. */
export function isBillableVerdict(verification: Partial<VerificationResult> | undefined): boolean {
  if (!verification || verification.apiError === true) return false;
  return isVerdictStatus(verification.status);
}

/** The row identifier: unique per delivered claim verdict. */
export function claimIdentifier(scanId: string, claimId: string): string {
  return `${scanId}:${claimId}`;
}

/** One key's committed claims in one period. */
export interface ClaimUsage {
  used: number;
  byVerdict: Record<string, number>;
}

/** Why a reservation was refused: the 402 body's numbers. */
export interface ClaimCapRefusal {
  ok: false;
  cap: number;
  used: number;
  remaining: number;
}

export type ReserveOutcome = { ok: true; reservation: ClaimReservation } | ClaimCapRefusal;

/** A claim a route is committing: its id, the verdict and who produced it. */
export interface CommittedClaim {
  claimId: string;
  verdict: string;
  provider: string;
}

/**
 * Claims held for one request or job. `commit` turns held claims into ledger
 * rows; `release` frees whatever is still held. Both are safe to call more than
 * once, and a commit after release still records the verdicts it was given
 * (they were delivered).
 */
export class ClaimReservation {
  private open = true;

  constructor(
    private readonly meter: ClaimMeter,
    readonly keyId: string,
    readonly period: string,
    private holding: number,
  ) {}

  /** Claims still held. */
  get held(): number {
    return this.holding;
  }

  /** Ledger the given claims under `scanId`. Returns how many rows were new. */
  commit(scanId: string, claims: CommittedClaim[]): number {
    const added = this.meter.append(this.keyId, this.period, scanId, claims);
    this.free(Math.min(this.holding, added));
    return added;
  }

  /** Free every claim still held. */
  release(): void {
    this.free(this.holding);
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

  private free(n: number): void {
    if (n <= 0) return;
    this.holding -= n;
    this.meter.unreserve(this.keyId, n);
  }
}

/** Fleet totals for one period (admin GET /usage). */
export interface ClaimMeterTotals {
  period: string;
  used: number;
  reserved: number;
  keys: number;
  byVerdict: Record<string, number>;
  ledgerWriteFailures: number;
}

/** What the sync sink has not sent yet. */
export interface ClaimMeterLag {
  meterSyncLagRows: number;
  oldestUnsentAt: string | null;
  oldestUnsentAgeSeconds: number | null;
  syncWriteFailures: number;
}

const usageKey = (period: string, keyId: string): string => `${period}\u0000${keyId}`;

/** Read a JSONL file line by line; a missing or unreadable file reads as empty. */
function readLines(path: string): string[] {
  try {
    // A regular file only: a device such as /dev/full reads forever.
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function appendLine(path: string, line: string): boolean {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, line + '\n');
    return true;
  } catch {
    return false;
  }
}

function parseRow(line: string): ClaimMeterRow | null {
  try {
    const row = JSON.parse(line) as Partial<ClaimMeterRow>;
    const fields = [row.ts, row.period, row.keyId, row.scanId, row.claimId, row.verdict, row.provider, row.identifier];
    return fields.every((f) => typeof f === 'string') ? (row as ClaimMeterRow) : null;
  } catch {
    return null;
  }
}

export class ClaimMeter {
  private usage = new Map<string, ClaimUsage>();
  private identifiers = new Set<string>();
  /** Rows not yet marked sent, in ledger order. */
  private unsent = new Map<string, ClaimMeterRow>();
  private sent = new Set<string>();
  private reserved = new Map<string, number>();
  private hydrated = false;
  private writeFailures = 0;
  private syncWriteFailures = 0;

  /**
   * Read both files once per process, before the first read or write, so an
   * in-process row can never be counted twice. Unparseable rows are skipped.
   */
  private ensureHydrated(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    for (const line of readLines(claimMeterSyncLedgerPath())) {
      if (line.trim() === '') continue;
      try {
        const marker = JSON.parse(line) as Partial<ClaimMeterSyncRow>;
        if (typeof marker.identifier === 'string') this.sent.add(marker.identifier);
      } catch {
        continue;
      }
    }
    for (const line of readLines(claimMeterLedgerPath())) {
      if (line.trim() === '') continue;
      const row = parseRow(line.trim());
      if (row) this.index(row);
    }
  }

  /** Count one row into memory. False when its identifier was already counted. */
  private index(row: ClaimMeterRow): boolean {
    if (this.identifiers.has(row.identifier)) return false;
    this.identifiers.add(row.identifier);
    const key = usageKey(row.period, row.keyId);
    const usage = this.usage.get(key) ?? { used: 0, byVerdict: {} };
    usage.used += 1;
    usage.byVerdict[row.verdict] = (usage.byVerdict[row.verdict] ?? 0) + 1;
    this.usage.set(key, usage);
    if (!this.sent.has(row.identifier)) this.unsent.set(row.identifier, row);
    return true;
  }

  /** Claims held by open reservations for a key. */
  reservedFor(keyId: string): number {
    return this.reserved.get(keyId) ?? 0;
  }

  /** A key's committed claims in a period (ledger-hydrated, then live). */
  usageFor(keyId: string, period: string = currentMonth()): ClaimUsage {
    this.ensureHydrated();
    const usage = this.usage.get(usageKey(period, keyId));
    return { used: usage?.used ?? 0, byVerdict: { ...(usage?.byVerdict ?? {}) } };
  }

  /**
   * Hold `claims` for `keyId` against `cap` in the current period, or refuse.
   * Synchronous on purpose: the check and the increment cannot interleave with
   * another request. Refused when used + reserved + claims > cap.
   */
  reserve(keyId: string, claims: number, cap: number, now: Date = new Date()): ReserveOutcome {
    this.ensureHydrated();
    const period = currentMonth(now);
    const used = this.usage.get(usageKey(period, keyId))?.used ?? 0;
    const reserved = this.reservedFor(keyId);
    const want = Math.max(0, Math.ceil(claims));
    if (used + reserved + want > cap) {
      return { ok: false, cap, used, remaining: Math.max(0, cap - used - reserved) };
    }
    this.reserved.set(keyId, reserved + want);
    return { ok: true, reservation: new ClaimReservation(this, keyId, period, want) };
  }

  /** Give back held claims (called by ClaimReservation). */
  unreserve(keyId: string, n: number): void {
    const left = this.reservedFor(keyId) - n;
    if (left > 0) this.reserved.set(keyId, left);
    else this.reserved.delete(keyId);
  }

  /**
   * Ledger claims for one scan. Duplicate identifiers (already in the ledger, or
   * repeated in `claims`) are skipped. A failed write never fails the scan: the
   * row still counts in memory and waits for sync, and the count surfaces on
   * admin GET /usage. Returns how many rows were new.
   */
  append(keyId: string, period: string, scanId: string, claims: CommittedClaim[], now: Date = new Date()): number {
    this.ensureHydrated();
    let added = 0;
    for (const claim of claims) {
      const row: ClaimMeterRow = {
        ts: now.toISOString(),
        period,
        keyId,
        scanId,
        claimId: claim.claimId,
        verdict: claim.verdict,
        provider: claim.provider,
        identifier: claimIdentifier(scanId, claim.claimId),
      };
      if (!this.index(row)) continue;
      added += 1;
      if (!appendLine(claimMeterLedgerPath(), JSON.stringify(row))) this.writeFailures += 1;
    }
    return added;
  }

  /** Rows the sink has not sent, oldest first. */
  unsentRows(limit = Infinity): ClaimMeterRow[] {
    this.ensureHydrated();
    const rows: ClaimMeterRow[] = [];
    for (const row of this.unsent.values()) {
      if (rows.length >= limit) break;
      rows.push(row);
    }
    return rows;
  }

  /** Record that a row reached the sink, durably. */
  markSent(identifier: string, now: Date = new Date()): void {
    this.ensureHydrated();
    if (this.sent.has(identifier)) return;
    this.sent.add(identifier);
    this.unsent.delete(identifier);
    const marker: ClaimMeterSyncRow = { identifier, sentAt: now.toISOString() };
    if (!appendLine(claimMeterSyncLedgerPath(), JSON.stringify(marker))) this.syncWriteFailures += 1;
  }

  /** How far the sink is behind the ledger. */
  lag(now: Date = new Date()): ClaimMeterLag {
    this.ensureHydrated();
    const oldest = this.unsent.values().next().value as ClaimMeterRow | undefined;
    const oldestMs = oldest ? Date.parse(oldest.ts) : NaN;
    return {
      meterSyncLagRows: this.unsent.size,
      oldestUnsentAt: oldest?.ts ?? null,
      oldestUnsentAgeSeconds: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000)) : null,
      syncWriteFailures: this.syncWriteFailures,
    };
  }

  /** Fleet totals for a period. */
  totals(period: string = currentMonth()): ClaimMeterTotals {
    this.ensureHydrated();
    const prefix = `${period}\u0000`;
    const byVerdict: Record<string, number> = {};
    let used = 0;
    let keys = 0;
    for (const [key, usage] of this.usage) {
      if (!key.startsWith(prefix)) continue;
      keys += 1;
      used += usage.used;
      for (const [verdict, n] of Object.entries(usage.byVerdict)) byVerdict[verdict] = (byVerdict[verdict] ?? 0) + n;
    }
    let reserved = 0;
    for (const n of this.reserved.values()) reserved += n;
    return { period, used, reserved, keys, byVerdict, ledgerWriteFailures: this.writeFailures };
  }

  /** Rows this process could not persist. 0 = healthy. */
  getWriteFailures(): number {
    return this.writeFailures;
  }
}

let meter: ClaimMeter | null = null;

export function getClaimMeter(): ClaimMeter {
  if (!meter) meter = new ClaimMeter();
  return meter;
}

/** Drop the in-process meter (tests, ledger-path changes). Does not touch the files. */
export function resetClaimMeter(): void {
  meter = null;
}
