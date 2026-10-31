import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isBillableVerdict, VERDICT_STATUSES, type VerdictStatus } from '@nxtg/faultline/lib/verdict-guard.js';
import { currentMonth } from './provider-spend.js';

/**
 * claim-meter.ts — the append-only usage record and the per-key monthly claim cap.
 *
 * The billable unit is one claim with a billable verdict, as the engine's
 * isBillableVerdict (packages/cli/lib/verdict-guard.ts) decides: `supported`,
 * `contradicted` or `mixed`, at least one source, a `provenance.retriever` the
 * engine set, and no API error. An `unverified` verdict, a verdict with no
 * source or with no engine retriever, a provider error, a timeout, a failed
 * extraction, a refunded retry and a claim about the document itself produce
 * no row.
 *
 * THE LEDGER IS THE AUTHORITY, memory is the index (the provider-spend.ts
 * pattern). The file starts with one header line carrying `ledgerId`, written
 * when the first row is committed. Each later line is one row: a `usage` row
 * per committed claim, or a `void` row cancelling one usage row. The file is
 * read once per process, so a deploy cannot reset a key's month or reuse a seq.
 *
 * SEQ. Every row gets the next integer, starting at 1. Assigning the seq,
 * writing the line and indexing the row happen in one synchronous section
 * (`appendRow`), so no other commit can run in between: rows reach the file and
 * the reader in seq order, and the reader never sees a gap. A row whose write
 * fails is not given a seq (it counts against the cap in this process only and
 * shows on admin GET /usage as a write failure).
 *
 * RESERVATIONS live in memory only. A route reserves the most claims it may
 * verify BEFORE any provider call; `reserve` is one synchronous
 * check-and-increment, so two concurrent requests cannot both pass a cap only
 * one fits. After the run the route commits the claims with a billable verdict and
 * releases the rest. A crash loses only reservations, which frees capacity.
 *
 * No claim text, evidence or key material is ever written.
 */

const DEFAULT_LEDGER_PATH = '/var/log/faultline/claim-meter.jsonl';

/** The version of the row shape served by GET /admin/usage-records. */
export const USAGE_RECORD_VERSION = 1;
/** Longest claimId a usage row accepts: a 36-character UUID, ':' and 58 keep `identifier` at 95. */
export const MAX_CLAIM_ID_LENGTH = 58;
/** Longest usage identifier. A void identifier adds the 5-character `void:` prefix. */
export const MAX_IDENTIFIER_LENGTH = 95;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The verdict statuses a usage row may carry: those isBillableVerdict accepts
 * for an otherwise billable verdict (one source, an engine retriever, no API
 * error). Derived from the predicate, so the record and the rule cannot drift.
 */
export const BILLED_VERDICTS: readonly VerdictStatus[] = Object.freeze(VERDICT_STATUSES.filter((status) =>
  isBillableVerdict({ status, sources: [{ uri: 'https://example.org/' }], provenance: { retriever: 'engine' } })));
const VERDICTS: ReadonlySet<string> = new Set(BILLED_VERDICTS);

/** One row of the usage record. Field order is the order written. */
export interface UsageRecord {
  seq: number;
  ts: string;
  period: string;
  kind: 'usage' | 'void';
  keyId: string;
  stripeCustomerId: string | null;
  scanId: string;
  claimId: string;
  verdict: VerdictStatus;
  provider: string;
  identifier: string;
  /** Void rows only: the usage identifier this row cancels. */
  voids?: string;
}

interface LedgerHeader {
  kind: 'header';
  ledgerId: string;
  version: number;
  createdAt: string;
}

/** Where the ledger lives. `FAULTLINE_CLAIM_METER_LEDGER` overrides. */
export function claimMeterLedgerPath(): string {
  const raw = (process.env.FAULTLINE_CLAIM_METER_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_LEDGER_PATH : raw;
}

/** True when `FAULTLINE_CLAIM_METER` switches the meter on. Off by default. */
export function isClaimMeterEnabled(): boolean {
  const raw = (process.env.FAULTLINE_CLAIM_METER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true';
}

/** The usage identifier: unique per delivered claim verdict. */
export function claimIdentifier(scanId: string, claimId: string): string {
  return `${scanId}:${claimId}`;
}

/** The void identifier that cancels a usage identifier. */
export function voidIdentifier(usageIdentifier: string): string {
  return `void:${usageIdentifier}`;
}

/** The first instant of the UTC month after `now`, when a period's cap resets. */
export function periodResetsAt(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** A claim a route is committing: its id, the verdict and who produced it. */
export interface CommittedClaim {
  claimId: string;
  verdict: string;
  provider: string;
}

/** One key's committed claims in one period, voids subtracted. */
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
  period: string;
  resetsAt: string;
}

export type ReserveOutcome = { ok: true; reservation: ClaimReservation } | ClaimCapRefusal;

/**
 * Claims held for one request or job. `commit` turns held claims into usage
 * rows; `release` frees whatever is still held. Both are safe to call more than
 * once, and a commit after release still records the verdicts it was given
 * (they were delivered).
 */
export class ClaimReservation {
  constructor(
    private readonly meter: ClaimMeter,
    readonly keyId: string,
    private holding: number,
    /** The key's Stripe customer, read when a row is committed (never at reservation). */
    private readonly customerAtCommit: () => string | null,
  ) {}

  /** Claims still held. */
  get held(): number {
    return this.holding;
  }

  /** Record the given claims under `scanId`. Returns how many rows were new. */
  commit(scanId: string, claims: CommittedClaim[], now: Date = new Date()): number {
    const added = this.meter.commitUsage(this.keyId, scanId, claims, this.customerAtCommit(), now);
    this.free(Math.min(this.holding, added));
    return added;
  }

  /** Free every claim still held. */
  release(): void {
    this.free(this.holding);
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
  /** Claims not recorded because their claimId or scanId was out of shape. */
  refusedIdentifiers: number;
}

/** The usage record's position (admin GET /usage `usageRecords`). */
export interface UsageRecordsStatus {
  ledgerId: string | null;
  lastSeq: number;
  rowsThisPeriod: number;
}

/** One page of GET /admin/usage-records. */
export interface UsageRecordPage {
  ledgerId: string | null;
  records: UsageRecord[];
  nextAfter: number;
  hasMore: boolean;
}

/** How a line is appended. Tests swap it to model a failing disk. */
type LineAppend = (path: string, data: string) => void;
const fsAppend: LineAppend = (path, data) => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, data);
};
let appendToLedger: LineAppend = fsAppend;

/** Tests only: replace the ledger append (null restores the filesystem one). */
export function setClaimMeterAppendForTests(fn: LineAppend | null): void {
  appendToLedger = fn ?? fsAppend;
}

const usageKey = (period: string, keyId: string): string => `${period}\u0000${keyId}`;

function readLines(path: string): string[] {
  try {
    // A regular file only: a device such as /dev/full reads forever.
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';

function parseRow(value: Record<string, unknown>): UsageRecord | null {
  const { seq, ts, period, kind, keyId, stripeCustomerId, scanId, claimId, verdict, provider, identifier, voids } = value;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return null;
  if (kind !== 'usage' && kind !== 'void') return null;
  if (![ts, period, keyId, scanId, claimId, provider, identifier].every(isString)) return null;
  if (!isString(verdict) || !VERDICTS.has(verdict)) return null;
  if (stripeCustomerId !== null && !isString(stripeCustomerId)) return null;
  if (kind === 'void' && !isString(voids)) return null;
  return value as unknown as UsageRecord;
}

/** Log a count of refused claims. Never the ids themselves. */
function warnRefused(count: number): void {
  console.warn(`claim meter: ${count} claim(s) not recorded, claimId or scanId out of shape`);
}

export class ClaimMeter {
  private records: UsageRecord[] = [];
  private byIdentifier = new Map<string, UsageRecord>();
  /** Usage identifiers per (keyId, scanId), for voids. */
  private usageByScan = new Map<string, string[]>();
  private usage = new Map<string, ClaimUsage>();
  /** Identifiers that counted in memory but could not be written. */
  private unwritten = new Set<string>();
  private reserved = new Map<string, number>();
  private ledgerId: string | null = null;
  private lastSeq = 0;
  private hydrated = false;
  private writeFailures = 0;
  private refused = 0;
  /** Set after a failed write, so the next line starts on a fresh line. */
  private lineBroken = false;

  /**
   * Read the file once per process, before the first read or write. Rows are
   * taken in file order (a void always follows its usage row), and a row whose
   * seq does not exceed the last one taken is skipped, so seq stays monotonic.
   */
  private ensureHydrated(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    for (const line of readLines(claimMeterLedgerPath())) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (value.kind === 'header') {
        if (this.ledgerId === null && isString(value.ledgerId)) this.ledgerId = value.ledgerId;
        continue;
      }
      const row = parseRow(value);
      if (!row || row.seq <= this.lastSeq || this.byIdentifier.has(row.identifier)) continue;
      this.index(row);
    }
  }

  /** Count a row into memory. */
  private index(row: UsageRecord): void {
    this.records.push(row);
    this.byIdentifier.set(row.identifier, row);
    this.lastSeq = row.seq;
    if (row.kind === 'usage') {
      this.count(row.period, row.keyId, row.verdict, 1);
      const scanKey = usageKey(row.keyId, row.scanId);
      const list = this.usageByScan.get(scanKey) ?? [];
      list.push(row.identifier);
      this.usageByScan.set(scanKey, list);
      return;
    }
    // A void subtracts from the period of the row it cancels.
    const cancelled = this.byIdentifier.get(row.voids ?? '');
    if (cancelled && cancelled.kind === 'usage') this.count(cancelled.period, cancelled.keyId, cancelled.verdict, -1);
  }

  private count(period: string, keyId: string, verdict: string, delta: number): void {
    const key = usageKey(period, keyId);
    const usage = this.usage.get(key) ?? { used: 0, byVerdict: {} };
    usage.used = Math.max(0, usage.used + delta);
    usage.byVerdict[verdict] = Math.max(0, (usage.byVerdict[verdict] ?? 0) + delta);
    this.usage.set(key, usage);
  }

  /** Write one line. False when it did not reach the file. */
  private writeLine(line: string): boolean {
    try {
      appendToLedger(claimMeterLedgerPath(), (this.lineBroken ? '\n' : '') + line + '\n');
      this.lineBroken = false;
      return true;
    } catch {
      this.lineBroken = true;
      this.writeFailures += 1;
      return false;
    }
  }

  /** Write the header when the ledger has none yet. False when it could not be written. */
  private ensureHeader(now: Date): boolean {
    if (this.ledgerId !== null) return true;
    const header: LedgerHeader = { kind: 'header', ledgerId: randomUUID(), version: USAGE_RECORD_VERSION, createdAt: now.toISOString() };
    if (!this.writeLine(JSON.stringify(header))) return false;
    this.ledgerId = header.ledgerId;
    return true;
  }

  /**
   * THE CRITICAL SECTION. Assign the next seq, write the row and index it, with
   * no await anywhere in between: no other commit can interleave, so seq is
   * never reused and the file and the reader see rows in seq order. Returns
   * false when the row could not be written (it then holds no seq).
   */
  private appendRow(fields: Omit<UsageRecord, 'seq'>, now: Date): boolean {
    if (!this.ensureHeader(now)) return false;
    const row: UsageRecord = { seq: this.lastSeq + 1, ...fields };
    if (!this.writeLine(JSON.stringify(row))) return false;
    this.index(row);
    return true;
  }

  /** Claims held by open reservations for a key. */
  reservedFor(keyId: string): number {
    return this.reserved.get(keyId) ?? 0;
  }

  /** A key's committed claims in a period, voids subtracted. */
  usageFor(keyId: string, period: string = currentMonth()): ClaimUsage {
    this.ensureHydrated();
    const usage = this.usage.get(usageKey(period, keyId));
    return { used: usage?.used ?? 0, byVerdict: { ...(usage?.byVerdict ?? {}) } };
  }

  /**
   * Hold `claims` for `keyId` against `cap` in the current period, or refuse.
   * Synchronous on purpose: the check and the increment cannot interleave with
   * another request. Refused when used + reserved + claims > cap; a request
   * larger than what remains is refused whole.
   */
  reserve(
    keyId: string,
    claims: number,
    cap: number,
    customerAtCommit: () => string | null,
    now: Date = new Date(),
  ): ReserveOutcome {
    this.ensureHydrated();
    const period = currentMonth(now);
    const used = this.usage.get(usageKey(period, keyId))?.used ?? 0;
    const reserved = this.reservedFor(keyId);
    const want = Math.max(0, Math.ceil(claims));
    if (used + reserved + want > cap) {
      return { ok: false, cap, used, remaining: Math.max(0, cap - used - reserved), period, resetsAt: periodResetsAt(now) };
    }
    this.reserved.set(keyId, reserved + want);
    return { ok: true, reservation: new ClaimReservation(this, keyId, want, customerAtCommit) };
  }

  /** Give back held claims (called by ClaimReservation). */
  unreserve(keyId: string, n: number): void {
    const left = this.reservedFor(keyId) - n;
    if (left > 0) this.reserved.set(keyId, left);
    else this.reserved.delete(keyId);
  }

  /**
   * Record usage rows for one scan. Skipped: a duplicate identifier (already
   * recorded, or repeated in `claims`), a non-verdict status, and a claim whose
   * claimId is longer than MAX_CLAIM_ID_LENGTH or whose scanId is not a UUID
   * (counted and logged as a count). A failed write never fails the scan: the
   * claim still counts against the cap in this process. Returns how many claims
   * counted.
   */
  commitUsage(
    keyId: string,
    scanId: string,
    claims: CommittedClaim[],
    stripeCustomerId: string | null,
    now: Date = new Date(),
  ): number {
    this.ensureHydrated();
    const period = currentMonth(now);
    let added = 0;
    let refused = 0;
    for (const claim of claims) {
      if (!VERDICTS.has(claim.verdict)) continue;
      if (!UUID_PATTERN.test(scanId) || claim.claimId.length === 0 || claim.claimId.length > MAX_CLAIM_ID_LENGTH) {
        refused += 1;
        continue;
      }
      const identifier = claimIdentifier(scanId, claim.claimId);
      if (this.byIdentifier.has(identifier) || this.unwritten.has(identifier)) continue;
      const written = this.appendRow({
        ts: now.toISOString(),
        period,
        kind: 'usage',
        keyId,
        stripeCustomerId,
        scanId,
        claimId: claim.claimId,
        verdict: claim.verdict as VerdictStatus,
        provider: claim.provider,
        identifier,
      }, now);
      if (!written) {
        this.unwritten.add(identifier);
        this.count(period, keyId, claim.verdict, 1);
      }
      added += 1;
    }
    if (refused > 0) {
      this.refused += refused;
      warnRefused(refused);
    }
    return added;
  }

  /**
   * Cancel every usage row `keyId` committed under `scanId`, once: a void
   * identifier already recorded is skipped. Each void row copies the usage
   * row's customer, claim, verdict and provider. Returns how many voids were written.
   */
  voidScan(keyId: string, scanId: string, now: Date = new Date()): number {
    this.ensureHydrated();
    let written = 0;
    for (const usageId of this.usageByScan.get(usageKey(keyId, scanId)) ?? []) {
      const usage = this.byIdentifier.get(usageId);
      const identifier = voidIdentifier(usageId);
      if (!usage || this.byIdentifier.has(identifier)) continue;
      const ok = this.appendRow({
        ts: now.toISOString(),
        period: currentMonth(now),
        kind: 'void',
        keyId: usage.keyId,
        stripeCustomerId: usage.stripeCustomerId,
        scanId: usage.scanId,
        claimId: usage.claimId,
        verdict: usage.verdict,
        provider: usage.provider,
        identifier,
        voids: usageId,
      }, now);
      if (ok) written += 1;
    }
    return written;
  }

  /** Usage identifiers `keyId` committed under `scanId`. */
  committedIdentifiers(keyId: string, scanId: string): string[] {
    this.ensureHydrated();
    return [...(this.usageByScan.get(usageKey(keyId, scanId)) ?? [])];
  }

  /**
   * Rows with seq > `after`, in seq order, at most `limit`. Read only: it
   * changes nothing in memory or on disk (hydration reads the file once).
   */
  page(after: number, limit: number): UsageRecordPage {
    this.ensureHydrated();
    // Rows are in seq order; find the first with seq > after.
    let lo = 0;
    let hi = this.records.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.records[mid].seq <= after) lo = mid + 1;
      else hi = mid;
    }
    const records = this.records.slice(lo, lo + limit).map((r) => ({ ...r }));
    const nextAfter = records.length > 0 ? records[records.length - 1].seq : after;
    return { ledgerId: this.ledgerId, records, nextAfter, hasMore: lo + records.length < this.records.length };
  }

  /** The record's id, last seq and how many rows fall in `period`. */
  status(period: string = currentMonth()): UsageRecordsStatus {
    this.ensureHydrated();
    return {
      ledgerId: this.ledgerId,
      lastSeq: this.lastSeq,
      rowsThisPeriod: this.records.filter((r) => r.period === period).length,
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
      if (!key.startsWith(prefix) || usage.used === 0) continue;
      keys += 1;
      used += usage.used;
      for (const [verdict, n] of Object.entries(usage.byVerdict)) byVerdict[verdict] = (byVerdict[verdict] ?? 0) + n;
    }
    let reserved = 0;
    for (const n of this.reserved.values()) reserved += n;
    return { period, used, reserved, keys, byVerdict, ledgerWriteFailures: this.writeFailures, refusedIdentifiers: this.refused };
  }

  /** Rows this process could not write. 0 = healthy. */
  getWriteFailures(): number {
    return this.writeFailures;
  }
}

let meter: ClaimMeter | null = null;

export function getClaimMeter(): ClaimMeter {
  if (!meter) meter = new ClaimMeter();
  return meter;
}

/** Drop the in-process meter (tests, ledger-path changes). Does not touch the file. */
export function resetClaimMeter(): void {
  meter = null;
}
