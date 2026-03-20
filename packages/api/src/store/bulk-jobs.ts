import { randomUUID } from 'node:crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export type BulkJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BulkFileResult {
  filename: string;
  status: 'done' | 'failed';
  overallRisk?: string;
  claimCount?: number;
  error?: string;
}

export interface BulkJob {
  id: string;
  status: BulkJobStatus;
  totalFiles: number;
  processedFiles: number;
  progressPercent: number; // 0–100
  results: BulkFileResult[];
  summary?: {
    overallTrustScore: number; // 0–100 (100 = all low risk)
    worstOffenders: Array<{ filename: string; risk: string }>;
    riskDistribution: Record<string, number>;
  };
  createdAt: string;
  completedAt?: string;
}

// ─── Risk severity helpers ─────────────────────────────────────────────────

const RISK_PENALTY: Record<string, number> = {
  critical: 25,
  high: 15,
  medium: 5,
  low: 0,
};

const RISK_SEVERITY_ORDER: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

// ─── BulkJobStore ──────────────────────────────────────────────────────────

class BulkJobStore {
  private jobs = new Map<string, BulkJob>();

  create(totalFiles: number): BulkJob {
    const job: BulkJob = {
      id: randomUUID(),
      status: 'pending',
      totalFiles,
      processedFiles: 0,
      progressPercent: 0,
      results: [],
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): BulkJob | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<BulkJob>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
  }

  recordFileResult(id: string, result: BulkFileResult): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.results.push(result);
    job.processedFiles += 1;
    job.progressPercent =
      job.totalFiles > 0
        ? Math.round((job.processedFiles / job.totalFiles) * 100)
        : 100;
  }

  complete(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    // Compute summary
    const riskDistribution: Record<string, number> = {};
    for (const r of job.results) {
      if (r.status === 'done' && r.overallRisk) {
        const key = r.overallRisk.toLowerCase();
        riskDistribution[key] = (riskDistribution[key] ?? 0) + 1;
      }
    }

    const totalFiles = job.totalFiles || 1; // avoid /0
    let penaltySum = 0;
    for (const [risk, count] of Object.entries(riskDistribution)) {
      penaltySum += (RISK_PENALTY[risk] ?? 0) * count;
    }
    const overallTrustScore = Math.max(0, Math.min(100, 100 - penaltySum / totalFiles));

    const worstOffenders = job.results
      .filter(
        (r) =>
          r.status === 'done' &&
          r.overallRisk &&
          (r.overallRisk.toLowerCase() === 'critical' || r.overallRisk.toLowerCase() === 'high'),
      )
      .sort((a, b) => {
        const aScore = RISK_SEVERITY_ORDER[a.overallRisk?.toLowerCase() ?? ''] ?? 0;
        const bScore = RISK_SEVERITY_ORDER[b.overallRisk?.toLowerCase() ?? ''] ?? 0;
        return bScore - aScore;
      })
      .slice(0, 10)
      .map((r) => ({ filename: r.filename, risk: r.overallRisk! }));

    job.status = 'done';
    job.completedAt = new Date().toISOString();
    job.summary = { overallTrustScore, worstOffenders, riskDistribution };
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    // Store error message in a generic way — attach to summary-adjacent field
    (job as BulkJob & { error?: string }).error = error;
  }

  reset(): void {
    this.jobs.clear();
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let storeInstance: BulkJobStore | null = null;

export function getBulkJobStore(): BulkJobStore {
  if (!storeInstance) storeInstance = new BulkJobStore();
  return storeInstance;
}

export function resetBulkJobStore(): void {
  storeInstance = new BulkJobStore();
}
