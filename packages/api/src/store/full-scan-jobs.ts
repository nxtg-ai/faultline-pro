import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApiErrorReason, Claim, VerificationResult } from '@nxtg/faultline/types.js';
import {
  partitionForFullScan,
  unitAccounting,
  type FullScanResult,
  type UnitAccounting,
} from '@nxtg/faultline/cli/scan.js';
import type { ManagedScanCostEvent } from './costs.js';

/**
 * full-scan-jobs.ts — estimates, jobs, the run queue and the terminal-job ledger
 * behind `/scan/full/*` ("deep scan" in product copy, GoPMO 1.18.11.3.12).
 *
 * Contract: docs/design/2026-10-13-full-scan-api.md §3–§5.
 *
 * ESTIMATES live in memory for 30 minutes. They hold the extracted claims, so a
 * job verifies exactly what the user was priced for (no second extraction).
 *
 * JOBS live in memory while the process lives (24 h for a finished one). At most
 * FAULTLINE_FULL_MAX_RUNNING run at once; the rest wait FIFO as `queued`.
 *
 * THE LEDGER (append-only JSONL on the faultline_ledgers volume, like
 * provider-spend.ts) receives one row per terminal job, so a deploy between a job
 * finishing and faultline-web settling it does not turn a served job into
 * `job_lost`. A row carries counts, units, unserved claim ids and fw's request
 * ids (Idempotency-Key, estimate id, so a replayed start after a restart still
 * returns its job): NO scan
 * result, claim text, input text or source URL is ever written (user content, and
 * Google's grounding terms forbid caching grounded output), and NO user-ref (it
 * lives in memory only while a job is active, to enforce one job per user).
 *
 * Units: a fact claim is SERVED when its check ran and returned a verdict
 * (including 'unverified'); it is unserved when the provider failed after the
 * engine's retries (apiError) or it never started. served = ceil(served / 8);
 * refund = charged - served (emma-soul ruling al:c747e63f2fc26683).
 */

type Tier = ManagedScanCostEvent['tier'];

/** How long an estimate (and its extracted claims) is held. */
export const ESTIMATE_TTL_MS = 30 * 60_000;
/** How long a job id is answerable; older ids read as `410 job_expired`. */
export const JOB_RETENTION_MS = 24 * 3_600_000;
/** The window of ledger rows kept in memory for the admin refund-rate report. */
export const REFUND_WINDOW_DAYS = 7;
/** A refund rate above this raises `fullScanRefunds.alert` (emma-soul condition 4). */
export const REFUND_ALERT_RATE = 0.10;

/**
 * Memory bound on held estimates. Each holds up to 50,000 characters of input plus
 * the claims extracted from it, on a 512 MB Fly machine, so both the count and the
 * held characters are capped; the oldest estimate is evicted first.
 */
export const MAX_ESTIMATES = 1_000;
export const MAX_ESTIMATE_CHARS = 10_000_000;

const DEFAULT_MAX_RUNNING = 4;
const DEFAULT_LEDGER_PATH = '/var/log/faultline/full-scan-jobs.jsonl';
const PRUNE_INTERVAL_MS = 10 * 60_000;
const PRUNE_ON_ACCESS_MS = 60_000;
/** A job id stamped this far in the future is not one we issued. */
const CLOCK_SKEW_MS = 60_000;

const JOB_ID_PATTERN = /^fsj_([0-9a-z]{1,11})_[0-9a-f]{32}$/;

export type FullScanJobStatus = 'queued' | 'running' | 'done' | 'stopped' | 'failed';
export type TerminalStatus = 'done' | 'stopped' | 'failed';

/** Why a fact claim got no verdict. The engine's reasons plus 'not_attempted'. */
export type UnservedReason = ApiErrorReason | 'not_attempted';
export const UNSERVED_REASONS: readonly UnservedReason[] = [
  'rate_limited', 'provider_unavailable', 'timeout', 'provider_error', 'not_attempted',
];

export interface UnservedClaim {
  claimId: string;
  reason: UnservedReason;
}

/** One fact claim's state in a job, in extraction order. */
export interface ClaimProgress {
  claimId: string;
  status: 'pending' | 'served' | 'unserved';
  reason?: UnservedReason;
  /** The VerificationResult as it landed (also on an apiError claim, which carries apiError). */
  verdict?: VerificationResult;
}

export interface FullScanEstimate {
  estimateId: string;
  keyId: string;
  userRef: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
  factClaims: number;
  notCheckable: number;
  units: number;
  /** The extracted claims and input; released to the job that starts from this estimate. */
  claims?: Claim[];
  text?: string;
  /** Set once a job started from this estimate. */
  startedBy?: { idempotencyKey: string; jobId: string };
}

export interface FullScanJob {
  jobId: string;
  keyId: string;
  /** In memory only, and only while the job is queued or running. */
  userRef: string | null;
  estimateId: string;
  idempotencyKey: string;
  createdAt: number;
  provider: string;
  tier: Tier;
  factClaims: number;
  /** Units charged at the estimate. Never recomputed. */
  charged: number;
  /** Every extracted claim (the engine re-partitions them); released when the job ends. */
  claims: Claim[];
  text: string;
  /** Fact claim ids in extraction order, aligned with `verdicts`. */
  factIds: string[];
  /** Verdict per fact position; undefined until it lands. */
  verdicts: Array<VerificationResult | undefined>;
  status: FullScanJobStatus;
  controller: AbortController;
  result?: FullScanResult;
  finishedAt?: string;
  /** Set at finish: whether the terminal row reached the ledger, so a restart keeps it. */
  durable?: boolean;
}

/** One terminal job on disk. Counts and ids only (see the header). */
export interface FullScanLedgerRow {
  jobId: string;
  keyId: string;
  /** fw's request ids: rebuild the replay map on boot. Absent on rows written before 2026-10-13's fix. */
  idempotencyKey?: string;
  estimateId?: string;
  status: TerminalStatus;
  finishedAt: string;
  factClaims: number;
  units: UnitAccounting;
  servedClaims: number;
  /** Served claims by verdict status (supported, contradicted, unverified, mixed). */
  verdicts: Record<string, number>;
  /** Unserved claims by reason. */
  reasons: Partial<Record<UnservedReason, number>>;
  unserved: UnservedClaim[];
}

/** A started job as a replayed POST /scan/full answers it (in memory or reloaded from the ledger). */
export interface StartedJob {
  jobId: string;
  estimateId: string;
  units: number;
  factClaims: number;
}

/** What GET /scan/full/:jobId returns. */
export interface FullScanJobView {
  jobId: string;
  status: FullScanJobStatus;
  factClaims: number;
  /** Fact claims with a verdict (served). */
  checked: number;
  /** Fact claims whose check ran and failed (apiError); never-started claims are not counted. */
  failed: number;
  progress: ClaimProgress[];
  unserved: UnservedClaim[];
  units: UnitAccounting;
  /** False for a job reloaded from the ledger after a restart (and for a failed job): no result to serve. */
  resultAvailable: boolean;
  /**
   * True once the job is terminal AND its row is on the ledger, so a restart keeps
   * it. False while queued or running, and for a terminal job whose ledger write
   * failed: a restart would then answer job_lost, so fw must settle on this terminal
   * answer, not wait (codex F12-1).
   */
  durable: boolean;
  result?: FullScanResult;
}

/** The admin refund-rate report (GET /usage, `fullScanRefunds`). */
export interface FullScanRefundSummary {
  days: number;
  jobs: number;
  unitsCharged: number;
  unitsRefunded: number;
  /** unitsRefunded / unitsCharged; 0 when nothing was charged. */
  refundRate: number;
  alert: boolean;
  reasons: Record<UnservedReason, number>;
  ledgerWriteFailures: number;
  /** True while new full-scan jobs are refused after a failed ledger write (the breaker). */
  admissionClosed: boolean;
}

export type JobLookup =
  | { kind: 'job'; job: FullScanJob }
  | { kind: 'row'; row: FullScanLedgerRow }
  | { kind: 'error'; statusCode: 404 | 410; error: 'job_not_found' | 'job_lost' | 'job_expired' };

const JOB_NOT_FOUND: JobLookup = { kind: 'error', statusCode: 404, error: 'job_not_found' };
const JOB_LOST: JobLookup = { kind: 'error', statusCode: 404, error: 'job_lost' };
const JOB_EXPIRED: JobLookup = { kind: 'error', statusCode: 410, error: 'job_expired' };

// ── Config ──────────────────────────────────────────────────────────────────

function positiveIntegerEnv(name: string, fallback: number): number {
  const n = Number((process.env[name] ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** Process-wide ceiling on running jobs. `FAULTLINE_FULL_MAX_RUNNING`, default 4. */
export function maxRunningJobs(): number {
  return positiveIntegerEnv('FAULTLINE_FULL_MAX_RUNNING', DEFAULT_MAX_RUNNING);
}

/** Where the terminal-job ledger lives. `FAULTLINE_FULL_JOBS_LEDGER` overrides. */
export function fullScanLedgerPath(): string {
  const raw = (process.env.FAULTLINE_FULL_JOBS_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_LEDGER_PATH : raw;
}

// ── Ids ─────────────────────────────────────────────────────────────────────

const hex32 = (): string => randomUUID().replace(/-/g, '');

/** `fsj_<base36 createdAt ms>_<32 hex>`: the age of any id we issued is derivable from the id. */
export function newJobId(now: number = Date.now()): string {
  return `fsj_${now.toString(36)}_${hex32()}`;
}

/** The creation time encoded in a job id, or null when it is not an id this API issued. */
export function jobIdCreatedAt(jobId: string, now: number = Date.now()): number | null {
  const match = JOB_ID_PATTERN.exec(jobId);
  if (!match) return null;
  const createdAt = parseInt(match[1], 36);
  return Number.isSafeInteger(createdAt) && createdAt <= now + CLOCK_SKEW_MS ? createdAt : null;
}

// ── Views (pure) ────────────────────────────────────────────────────────────

const isTerminal = (status: FullScanJobStatus): status is TerminalStatus =>
  status === 'done' || status === 'stopped' || status === 'failed';

const reasonOf = (verdict: VerificationResult): UnservedReason => verdict.apiErrorReason ?? 'provider_error';

/**
 * A failed job served nothing (no result reached the caller), so every fact claim
 * is unserved: its own provider reason, `provider_error` when a verdict had landed
 * before the run threw, `not_attempted` when it never started.
 */
function failedClaim(claimId: string, verdict: VerificationResult | undefined): ClaimProgress {
  if (verdict === undefined) return { claimId, status: 'unserved', reason: 'not_attempted' };
  const reason = verdict.apiError === true ? reasonOf(verdict) : 'provider_error';
  return { claimId, status: 'unserved', reason, verdict };
}

function claimProgress(job: FullScanJob): ClaimProgress[] {
  return job.factIds.map((claimId, i): ClaimProgress => {
    const verdict = job.verdicts[i];
    if (job.status === 'failed') return failedClaim(claimId, verdict);
    if (verdict === undefined) {
      return isTerminal(job.status) ? { claimId, status: 'unserved', reason: 'not_attempted' } : { claimId, status: 'pending' };
    }
    if (verdict.apiError === true) return { claimId, status: 'unserved', reason: reasonOf(verdict), verdict };
    return { claimId, status: 'served', verdict };
  });
}

const unservedOf = (progress: ClaimProgress[]): UnservedClaim[] =>
  progress.flatMap((p) => (p.status === 'unserved' && p.reason ? [{ claimId: p.claimId, reason: p.reason }] : []));

const ranAndFailed = (unserved: UnservedClaim[]): number =>
  unserved.filter((u) => u.reason !== 'not_attempted').length;

/** The GET view of a job held in memory. */
export function describeJob(job: FullScanJob): FullScanJobView {
  const progress = claimProgress(job);
  const served = progress.filter((p) => p.status === 'served').length;
  const unserved = unservedOf(progress);
  const withResult = job.result !== undefined && (job.status === 'done' || job.status === 'stopped');
  return {
    jobId: job.jobId,
    status: job.status,
    factClaims: job.factClaims,
    checked: served,
    failed: ranAndFailed(unserved),
    progress,
    unserved,
    units: unitAccounting(job.charged, served),
    resultAvailable: job.status !== 'failed',
    durable: job.durable === true,
    ...(withResult ? { result: job.result } : {}),
  };
}

/** The GET view of a job reloaded from the ledger: no result, no per-claim verdicts. */
export function describeLedgerRow(row: FullScanLedgerRow): FullScanJobView {
  return {
    jobId: row.jobId,
    status: row.status,
    factClaims: row.factClaims,
    checked: row.servedClaims,
    failed: ranAndFailed(row.unserved),
    progress: [],
    unserved: row.unserved,
    units: row.units,
    resultAvailable: false,
    durable: true,
  };
}

function tally<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}

/** The ledger row for a terminal job. Built from the view, so disk and GET cannot disagree. */
export function ledgerRowFor(job: FullScanJob & { status: TerminalStatus; finishedAt: string }): FullScanLedgerRow {
  const view = describeJob(job);
  const servedVerdicts = view.progress.filter((p) => p.status === 'served' && p.verdict);
  return {
    jobId: job.jobId,
    keyId: job.keyId,
    idempotencyKey: job.idempotencyKey,
    estimateId: job.estimateId,
    status: job.status,
    finishedAt: job.finishedAt,
    factClaims: job.factClaims,
    units: view.units,
    servedClaims: view.checked,
    verdicts: tally(servedVerdicts, (p) => p.verdict!.status),
    reasons: tally(view.unserved, (u) => u.reason) as Partial<Record<UnservedReason, number>>,
    unserved: view.unserved,
  };
}

function parseLedgerRow(line: string): FullScanLedgerRow | null {
  try {
    const row = JSON.parse(line) as Partial<FullScanLedgerRow>;
    const valid = typeof row.jobId === 'string' && typeof row.keyId === 'string'
      && (row.status === 'done' || row.status === 'stopped' || row.status === 'failed')
      && typeof row.finishedAt === 'string' && Array.isArray(row.unserved)
      && typeof row.units === 'object' && row.units !== null;
    return valid ? (row as FullScanLedgerRow) : null;
  } catch {
    return null;
  }
}

// ── Run queue ───────────────────────────────────────────────────────────────

/** Runs one job to a terminal status. Must not reject; a rejection fails the job. */
export type FullScanJobRunner = (job: FullScanJob) => Promise<void>;

/** FIFO queue with a process-wide ceiling on running jobs. */
class FullScanRunQueue {
  private waiting: Array<{ job: FullScanJob; run: FullScanJobRunner }> = [];
  private running = 0;

  constructor(
    private readonly onCrash: (job: FullScanJob) => void,
    /** Asked before a queued job starts; false finishes it unrun (see FullScanJobStore.refuseUnrun). */
    private readonly canStart: () => boolean = () => true,
    private readonly onRefused: (job: FullScanJob) => void = () => {},
  ) {}

  enqueue(job: FullScanJob, run: FullScanJobRunner): void {
    this.waiting.push({ job, run });
    this.pump();
  }

  runningCount(): number {
    return this.running;
  }

  private pump(): void {
    while (this.running < maxRunningJobs() && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (next.job.status !== 'queued') continue; // stopped while waiting
      if (!this.canStart()) {
        this.onRefused(next.job);
        continue;
      }
      this.start(next.job, next.run);
    }
  }

  private start(job: FullScanJob, run: FullScanJobRunner): void {
    job.status = 'running';
    this.running += 1;
    run(job)
      .catch(() => this.onCrash(job))
      .finally(() => {
        this.running -= 1;
        this.pump();
      });
  }
}

/** How the ledger is appended. Tests swap it to model a nearly full disk. */
type LedgerAppend = (path: string, data: string) => void;
const fsAppend: LedgerAppend = (path, data) => appendFileSync(path, data);
let appendLedger: LedgerAppend = fsAppend;

/**
 * Tests only: replace the ledger append (null restores the filesystem one). Used
 * to model a nearly full disk, where a one-byte write fits and a row does not,
 * which no real path in a test sandbox reproduces (/dev/full refuses both).
 */
export function setFullScanLedgerAppendForTests(fn: LedgerAppend | null): void {
  appendLedger = fn ?? fsAppend;
}

/** Size of the probe row that must reach the disk before admission reopens. */
const LEDGER_PROBE_BYTES = 8192;

function probeRow(): string {
  const head = JSON.stringify({ probe: 'ledger-writable', ts: new Date().toISOString(), pad: '' });
  return head.replace('"pad":""', `"pad":"${'0'.repeat(Math.max(0, LEDGER_PROBE_BYTES - head.length - 1))}"`) + '\n';
}

// ── Store ───────────────────────────────────────────────────────────────────

const scopeKey = (keyId: string, value: string): string => `${keyId}\u0000${value}`;

const estimateChars = (estimate: FullScanEstimate): number =>
  (estimate.text?.length ?? 0) + (estimate.claims ?? []).reduce((sum, c) => sum + c.text.length, 0);

function emptyReasons(): Record<UnservedReason, number> {
  return Object.fromEntries(UNSERVED_REASONS.map((r) => [r, 0])) as Record<UnservedReason, number>;
}

export interface NewEstimate {
  keyId: string;
  userRef: string;
  provider: string;
  claims: Claim[];
  text: string;
  factClaims: number;
  notCheckable: number;
  units: number;
}

class FullScanJobStore {
  private estimates = new Map<string, FullScanEstimate>();
  private heldEstimateChars = 0;
  private jobs = new Map<string, FullScanJob>();
  /** (keyId, Idempotency-Key) → jobId, for jobs in memory and ledger rows issued under JOB_RETENTION_MS. */
  private idempotency = new Map<string, string>();
  /** (keyId, userRef) → jobId of the user's queued or running job. Memory only. */
  private activeByUser = new Map<string, string>();
  /** Terminal rows from the ledger (last REFUND_WINDOW_DAYS) plus this process's. */
  private ledgerRows = new Map<string, FullScanLedgerRow>();
  private writeFailures = 0;
  private lastPrune = 0;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly queue = new FullScanRunQueue(
    (job) => this.finish(job, 'failed'),
    () => this.ledgerWritable(),
    (job) => this.finish(job, 'failed'),
  );
  /**
   * Open after any failed ledger write (codex F12-3, emma-soul al:d65d2e44c95f00d0):
   * new jobs get 503 and queued jobs finish unrun until a real non-empty probe
   * row reaches the disk. So the jobs exposed to a write failure are only those
   * already running when the first write failed (at most FAULTLINE_FULL_MAX_RUNNING).
   */
  private breakerOpen = false;

  constructor(now: number = Date.now()) {
    this.hydrate(now);
    this.ensurePruneTimer();
  }

  // Estimates

  createEstimate(input: NewEstimate, now: number = Date.now()): FullScanEstimate {
    this.pruneIfDue(now);
    const estimate: FullScanEstimate = {
      ...input,
      estimateId: `fse_${hex32()}`,
      createdAt: now,
      expiresAt: now + ESTIMATE_TTL_MS,
    };
    this.estimates.set(estimate.estimateId, estimate);
    this.heldEstimateChars += estimateChars(estimate);
    this.evictEstimatesOverBudget();
    return estimate;
  }

  /** The estimate, or undefined when unknown or past its 30 minutes. */
  getEstimate(estimateId: string, now: number = Date.now()): FullScanEstimate | undefined {
    const estimate = this.estimates.get(estimateId);
    if (estimate && estimate.expiresAt <= now) {
      this.dropEstimate(estimate);
      return undefined;
    }
    return estimate;
  }

  private dropEstimate(estimate: FullScanEstimate): void {
    this.heldEstimateChars -= estimateChars(estimate);
    this.estimates.delete(estimate.estimateId);
  }

  private evictEstimatesOverBudget(): void {
    while (this.estimates.size > MAX_ESTIMATES || this.heldEstimateChars > MAX_ESTIMATE_CHARS) {
      const oldest = this.estimates.values().next().value;
      if (!oldest) return;
      this.dropEstimate(oldest);
    }
  }

  // Jobs

  /**
   * The job a (key, Idempotency-Key) already started, from memory or, after a
   * restart, from its ledger row. A job that was running at a restart has no row,
   * so its replay finds nothing (and GET on its id answers job_lost).
   */
  jobForIdempotencyKey(keyId: string, idempotencyKey: string): StartedJob | undefined {
    const jobId = this.idempotency.get(scopeKey(keyId, idempotencyKey));
    if (jobId === undefined) return undefined;
    const job = this.jobs.get(jobId);
    if (job) return { jobId, estimateId: job.estimateId, units: job.charged, factClaims: job.factClaims };
    const row = this.ledgerRows.get(jobId);
    if (!row || row.estimateId === undefined) return undefined;
    return { jobId, estimateId: row.estimateId, units: row.units.charged, factClaims: row.factClaims };
  }

  activeJobFor(keyId: string, userRef: string): FullScanJob | undefined {
    const jobId = this.activeByUser.get(scopeKey(keyId, userRef));
    return jobId === undefined ? undefined : this.jobs.get(jobId);
  }

  /**
   * Create a queued job from an estimate. The estimate's claims and text move to
   * the job (no second extraction), and the estimate is marked used.
   */
  startJob(
    estimate: FullScanEstimate,
    opts: { idempotencyKey: string; tier: Tier },
    now: number = Date.now(),
  ): FullScanJob {
    const claims = estimate.claims ?? [];
    const factIds = partitionForFullScan(claims).facts.map((c) => c.id);
    const job: FullScanJob = {
      jobId: newJobId(now),
      keyId: estimate.keyId,
      userRef: estimate.userRef,
      estimateId: estimate.estimateId,
      idempotencyKey: opts.idempotencyKey,
      createdAt: now,
      provider: estimate.provider,
      tier: opts.tier,
      factClaims: estimate.factClaims,
      charged: estimate.units,
      claims,
      text: estimate.text ?? '',
      factIds,
      verdicts: new Array(factIds.length).fill(undefined),
      status: 'queued',
      controller: new AbortController(),
    };
    this.heldEstimateChars -= estimateChars(estimate);
    estimate.claims = undefined;
    estimate.text = undefined;
    estimate.startedBy = { idempotencyKey: opts.idempotencyKey, jobId: job.jobId };
    this.jobs.set(job.jobId, job);
    this.idempotency.set(scopeKey(job.keyId, job.idempotencyKey), job.jobId);
    this.activeByUser.set(scopeKey(job.keyId, estimate.userRef), job.jobId);
    return job;
  }

  enqueue(job: FullScanJob, run: FullScanJobRunner): void {
    this.queue.enqueue(job, run);
  }

  runningCount(): number {
    return this.queue.runningCount();
  }

  /** Record a verdict as it lands (index = position among the job's fact claims). */
  recordVerdict(job: FullScanJob, index: number, verdict: VerificationResult): void {
    if (isTerminal(job.status)) return;
    job.verdicts[index] = verdict;
  }

  /**
   * Stop a job. A queued job is stopped at once; a running one starts no new claim
   * and is finished as 'stopped' by its runner when the claims in flight return.
   * A terminal job is left unchanged.
   */
  stop(job: FullScanJob): void {
    if (isTerminal(job.status)) return;
    job.controller.abort();
    if (job.status === 'queued') this.finish(job, 'stopped');
  }

  /** Move a job to a terminal status once, release its inputs and user-ref, and ledger it. */
  finish(job: FullScanJob, status: TerminalStatus, result?: FullScanResult): void {
    if (isTerminal(job.status)) return;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (result && status !== 'failed') job.result = result;
    if (job.userRef !== null) {
      const key = scopeKey(job.keyId, job.userRef);
      if (this.activeByUser.get(key) === job.jobId) this.activeByUser.delete(key);
      job.userRef = null;
    }
    job.claims = [];
    job.text = '';
    job.durable = this.persist(ledgerRowFor(job as FullScanJob & { status: TerminalStatus; finishedAt: string }));
  }

  /**
   * Find a job for its owner. Another key's job answers exactly like an id we
   * never issued, so a job id never leaks across keys.
   */
  lookup(jobId: string, keyId: string, now: number = Date.now()): JobLookup {
    this.pruneIfDue(now);
    const job = this.jobs.get(jobId);
    if (job && !(isTerminal(job.status) && now - job.createdAt > JOB_RETENTION_MS)) {
      return job.keyId === keyId ? { kind: 'job', job } : JOB_NOT_FOUND;
    }
    const createdAt = jobIdCreatedAt(jobId, now);
    const row = this.ledgerRows.get(jobId);
    if (row && row.keyId !== keyId) return JOB_NOT_FOUND;
    if (createdAt === null) return JOB_NOT_FOUND;
    if (now - createdAt > JOB_RETENTION_MS) return JOB_EXPIRED;
    return row ? { kind: 'row', row } : JOB_LOST;
  }

  // Ledger

  /**
   * Append a terminal row, retrying once. A failed write never fails the job: the
   * row still answers GET and the refund report in this process, GET says
   * `durable: false`, and the count surfaces on admin GET /usage (the hourly check
   * alerts on it). Returns whether the row reached the disk.
   */
  private persist(row: FullScanLedgerRow): boolean {
    this.ledgerRows.set(row.jobId, row);
    const path = fullScanLedgerPath();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendLedger(path, JSON.stringify(row) + '\n');
        return true;
      } catch {
        // retry once, then count it
      }
    }
    this.writeFailures += 1;
    this.breakerOpen = true;
    return false;
  }

  /**
   * Reload terminal rows from the last REFUND_WINDOW_DAYS. GET answers only those
   * under JOB_RETENTION_MS (older ids read as job_expired); the rest feed the
   * refund-rate report. Unparseable rows are skipped.
   */
  private hydrate(now: number): void {
    const path = fullScanLedgerPath();
    let raw: string;
    try {
      // A regular file only: a device such as /dev/full reads forever.
      if (!existsSync(path) || !statSync(path).isFile()) return;
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    const horizon = now - REFUND_WINDOW_DAYS * 86_400_000;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const row = parseLedgerRow(line);
      if (!row || Date.parse(row.finishedAt) < horizon) continue;
      this.ledgerRows.set(row.jobId, row);
      this.indexReplay(row, now);
    }
  }

  /** Map a reloaded row's (key, Idempotency-Key) to its job while the job id is answerable. */
  private indexReplay(row: FullScanLedgerRow, now: number): void {
    const createdAt = jobIdCreatedAt(row.jobId, now);
    if (typeof row.idempotencyKey !== 'string' || typeof row.estimateId !== 'string') return;
    if (createdAt === null || now - createdAt > JOB_RETENTION_MS) return;
    this.idempotency.set(scopeKey(row.keyId, row.idempotencyKey), row.jobId);
  }

  getWriteFailures(): number {
    return this.writeFailures;
  }

  /**
   * May a job start now? Asked by POST /scan/full (503 ledger_unavailable when
   * false) and before a queued job runs. Every answer is a real, non-empty write
   * to the ledger itself (codex F12-3: a zero-byte append succeeds on a full disk):
   *
   * - breaker closed: append one newline (skipped by hydrate). A failure opens it.
   * - breaker open: append a probe row padded to LEDGER_PROBE_BYTES, larger than a
   *   typical terminal row, so a nearly full disk does not reopen admission for one
   *   more job that cannot be recorded. Only that write closes the breaker. The
   *   probe row has no job id, so hydrate skips it.
   */
  ledgerWritable(): boolean {
    const path = fullScanLedgerPath();
    const payload = this.breakerOpen ? probeRow() : '\n';
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendLedger(path, payload);
      this.breakerOpen = false;
      return true;
    } catch {
      this.breakerOpen = true;
      return false;
    }
  }

  /** True while new jobs are refused after a failed ledger write. */
  admissionClosed(): boolean {
    return this.breakerOpen;
  }

  /** Refunded units against charged units over the trailing `days`, from the ledger rows. */
  refundSummary(days: number = REFUND_WINDOW_DAYS, now: number = Date.now()): FullScanRefundSummary {
    const since = now - days * 86_400_000;
    const rows = [...this.ledgerRows.values()].filter((r) => Date.parse(r.finishedAt) >= since);
    const unitsCharged = rows.reduce((sum, r) => sum + r.units.charged, 0);
    const unitsRefunded = rows.reduce((sum, r) => sum + r.units.refund, 0);
    const reasons = emptyReasons();
    for (const row of rows) {
      for (const reason of UNSERVED_REASONS) reasons[reason] += row.reasons[reason] ?? 0;
    }
    const refundRate = unitsCharged > 0 ? unitsRefunded / unitsCharged : 0;
    return {
      days,
      jobs: rows.length,
      unitsCharged,
      unitsRefunded,
      refundRate,
      alert: refundRate > REFUND_ALERT_RATE,
      reasons,
      ledgerWriteFailures: this.writeFailures,
      admissionClosed: this.breakerOpen,
    };
  }

  // Memory bounds

  private pruneIfDue(now: number): void {
    if (now - this.lastPrune >= PRUNE_ON_ACCESS_MS) this.prune(now);
  }

  /** Drop expired estimates, terminal jobs and replay entries past retention, and ledger rows past the report window. */
  prune(now: number = Date.now()): void {
    this.lastPrune = now;
    for (const estimate of [...this.estimates.values()]) {
      if (estimate.expiresAt <= now) this.dropEstimate(estimate);
    }
    for (const job of [...this.jobs.values()]) {
      if (!isTerminal(job.status) || now - job.createdAt <= JOB_RETENTION_MS) continue;
      this.jobs.delete(job.jobId);
    }
    for (const [key, jobId] of [...this.idempotency]) {
      const createdAt = jobIdCreatedAt(jobId, now);
      if (createdAt === null || now - createdAt > JOB_RETENTION_MS) this.idempotency.delete(key);
    }
    const horizon = now - REFUND_WINDOW_DAYS * 86_400_000;
    for (const row of [...this.ledgerRows.values()]) {
      if (Date.parse(row.finishedAt) < horizon) this.ledgerRows.delete(row.jobId);
    }
  }

  ensurePruneTimer(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  stopPruneTimer(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  /** Abort every active job (tests). Their runners still finish them on this instance. */
  abortActive(): void {
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.status)) job.controller.abort();
    }
  }
}

let store: FullScanJobStore | null = null;

/** The process store. Built on first use, which reloads the ledger. */
export function getFullScanJobStore(): FullScanJobStore {
  if (!store) store = new FullScanJobStore();
  store.ensurePruneTimer();
  return store;
}

/** Stop the prune timer (server onClose). The next getFullScanJobStore() restarts it. */
export function stopFullScanJobPruning(): void {
  store?.stopPruneTimer();
}

/**
 * Drop the in-memory store (tests; or after changing the ledger path). Active
 * jobs are aborted. The ledger file is untouched, so the next getFullScanJobStore()
 * reloads its rows exactly as a restarted process would.
 */
export function resetFullScanJobStore(): void {
  store?.abortActive();
  store?.stopPruneTimer();
  store = null;
}

export type { FullScanJobStore };
