import { randomUUID } from 'node:crypto';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { fireWebhookEvent, webhookSafeData, keyIsLive } from './webhooks.js';
import type { WebhookEventOwner } from './webhooks.js';
import { getAuditLogger } from './audit.js';
import { fetchOutbound } from '../lib/outbound-url.js';
import { ENGINE_VERIFY_CAP, meteredScan } from '../lib/claim-meter.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
export type JobStatus = 'active' | 'paused';

export interface Job {
  id: string;
  text: string;
  provider?: Provider;
  schedule: string;
  intervalMs: number;
  webhookUrl?: string;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string;
  status: JobStatus;
  runCount: number;
}

// ─── Schedule parsing ──────────────────────────────────────────────────────

export function parseIntervalMs(schedule: string): number {
  const m = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(schedule.trim());
  if (m) return parseInt(m[1], 10) * 60_000;
  if (schedule.trim() === '* * * * *') return 60_000;
  return 60 * 60_000; // default: 1 hour for unrecognised
}

// ─── JobStore ──────────────────────────────────────────────────────────────

class JobStore {
  private jobs = new Map<string, Job>();
  /** Who created each job, kept off the Job so listings never show it. */
  private owners = new Map<string, { keyId: string; caller: string | null }>();

  create(options: {
    text: string;
    provider?: Provider;
    schedule: string;
    webhookUrl?: string;
    owner?: { keyId: string; caller: string | null };
  }): Job {
    const { text, provider, schedule, webhookUrl, owner } = options;
    const intervalMs = parseIntervalMs(schedule);
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      text,
      provider,
      schedule,
      intervalMs,
      webhookUrl,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
      status: 'active',
      runCount: 0,
    };
    this.jobs.set(job.id, job);
    if (owner) this.owners.set(job.id, owner);
    return job;
  }

  list(): Job[] {
    return Array.from(this.jobs.values());
  }

  /** The jobs created by `keyId`. */
  listOwnedBy(keyId: string): Job[] {
    return this.list().filter((j) => this.owners.get(j.id)?.keyId === keyId);
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  /** The job's owner for webhook delivery; null (delivered to no one) when unknown. */
  ownerOf(id: string): WebhookEventOwner {
    return this.owners.get(id) ?? null;
  }

  delete(id: string): boolean {
    this.owners.delete(id);
    return this.jobs.delete(id);
  }

  get size(): number {
    return this.jobs.size;
  }

  update(id: string, patch: Partial<Job>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
  }

  reset(): void {
    this.jobs.clear();
  }
}

// ─── JobScheduler ──────────────────────────────────────────────────────────

class JobScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _setIntervalFn: typeof setInterval = setInterval;
  private _clearIntervalFn: typeof clearInterval = clearInterval;

  setIntervalFn(fn: typeof setInterval): void {
    this._setIntervalFn = fn;
  }

  setClearIntervalFn(fn: typeof clearInterval): void {
    this._clearIntervalFn = fn;
  }

  start(tickMs = 60_000): void {
    if (this.timer) return; // already running
    this.timer = this._setIntervalFn(() => {
      void this.tick();
    }, tickMs);
  }

  stop(): void {
    if (this.timer) {
      this._clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const now = Date.now();
    for (const job of getJobStore().list()) {
      if (job.status !== 'active') continue;
      if (new Date(job.nextRunAt).getTime() > now) continue;
      await this.runJob(job);
    }
  }

  async triggerJob(id: string): Promise<void> {
    const job = getJobStore().get(id);
    if (job) await this.runJob(job);
  }

  private async runJob(job: Job): Promise<void> {
    const now = new Date().toISOString();
    try {
      // Each run is metered against the creator's key; over its cap the run fails unscanned.
      const owner = getJobStore().ownerOf(job.id);
      const ownerKeyId = owner !== null && owner !== 'public' ? owner.keyId : undefined;
      const result = await meteredScan(ownerKeyId, ENGINE_VERIFY_CAP, `job-${job.id}-${randomUUID()}`, job.provider, () => scan(job.text, job.provider));
      const nextRunAt = new Date(Date.now() + job.intervalMs).toISOString();
      getJobStore().update(job.id, {
        lastRunAt: now,
        nextRunAt,
        runCount: job.runCount + 1,
      });
      if (job.webhookUrl) {
        // Sent only while the creator's key is live, checked after the scan ran
        // (codex seat, 84cf8c8). A job with no recorded owner sends nothing.
        const ownerLive = owner !== null && owner !== 'public' && keyIsLive(owner.keyId);
        // Guarded at send time too: the host's DNS may have changed since the job was created.
        if (ownerLive) void fetchOutbound(job.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // A grounded result reaches no webhook, this one included (Google's terms).
          body: JSON.stringify({ event: 'job.complete', ...(webhookSafeData('job.complete', { jobId: job.id, result }) as object) }),
        }).catch(() => { /* non-fatal, including a blocked target */ });
      } else {
        fireWebhookEvent('job.complete', { jobId: job.id, result }, getJobStore().ownerOf(job.id));
      }
      getAuditLogger().log({
        timestamp: now,
        keyId: 'scheduler',
        endpoint: '/jobs/run',
        method: 'SCHEDULER',
        statusCode: 200,
        latencyMs: 0,
      });
    } catch (err) {
      const nextRunAt = new Date(Date.now() + job.intervalMs).toISOString();
      getJobStore().update(job.id, { lastRunAt: now, nextRunAt, runCount: job.runCount + 1 });
      fireWebhookEvent('job.failed', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      }, getJobStore().ownerOf(job.id));
    }
  }
}

// ─── Singletons ────────────────────────────────────────────────────────────

let storeInstance: JobStore | null = null;

export function getJobStore(): JobStore {
  if (!storeInstance) storeInstance = new JobStore();
  return storeInstance;
}

export function resetJobStore(): void {
  storeInstance = new JobStore();
}

let schedulerInstance: JobScheduler | null = null;

export function getJobScheduler(): JobScheduler {
  if (!schedulerInstance) schedulerInstance = new JobScheduler();
  return schedulerInstance;
}

export function resetJobScheduler(): void {
  schedulerInstance = new JobScheduler();
}
