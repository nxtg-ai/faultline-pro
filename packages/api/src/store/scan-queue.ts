/**
 * Scan Queue Store — async priority queue for scan operations.
 *
 * Priority tiers (lower = higher priority, processed first):
 *   0 — admin keys
 *   1 — pro keys
 *   2 — free keys
 *
 * Within the same priority level, items are processed FIFO (by createdAt).
 *
 * Max pending queue size: 10,000 items.
 * Completed/failed items are retained for 1,000 most-recent (for result retrieval).
 * Max concurrency: FAULTLINE_QUEUE_CONCURRENCY env var (default: 3).
 */

import { randomUUID } from 'node:crypto';
import { scan } from '@nxtg/faultline/cli/scan.js';

export type QueueItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type QueuePriority = 0 | 1 | 2;

export interface ScanQueueItem {
  id:           string;
  keyId:        string;
  priority:     QueuePriority;
  text:         string;
  provider:     string;
  status:       QueueItemStatus;
  createdAt:    string;
  startedAt?:   string;
  completedAt?: string;
  result?:      unknown;
  error?:       string;
}

export interface QueueStats {
  pending:    number;
  processing: number;
  completed:  number;
  failed:     number;
  cancelled:  number;
  total:      number;
}

const MAX_PENDING   = 10_000;
const MAX_COMPLETED = 1_000;

export function tierToPriority(tier: 'admin' | 'pro' | 'free'): QueuePriority {
  if (tier === 'admin') return 0;
  if (tier === 'pro')   return 1;
  return 2;
}

class ScanQueue {
  /** All items — pending, processing, completed, failed, cancelled */
  private items: Map<string, ScanQueueItem> = new Map();
  /** IDs of pending items in insertion order — sorted by priority on dequeue */
  private pendingIds: string[] = [];

  private processingCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  get maxConcurrency(): number {
    return Math.max(1, Number(process.env.FAULTLINE_QUEUE_CONCURRENCY ?? 3));
  }

  enqueue(keyId: string, priority: QueuePriority, text: string, provider: string): ScanQueueItem {
    if (this.pendingIds.length >= MAX_PENDING) {
      throw new Error(`Queue is full (max ${MAX_PENDING} pending items).`);
    }
    const item: ScanQueueItem = {
      id:        randomUUID(),
      keyId,
      priority,
      text,
      provider,
      status:    'pending',
      createdAt: new Date().toISOString(),
    };
    this.items.set(item.id, item);
    this.pendingIds.push(item.id);
    return item;
  }

  cancel(id: string): boolean {
    const item = this.items.get(id);
    if (!item || item.status !== 'pending') return false;
    item.status = 'cancelled';
    this.pendingIds = this.pendingIds.filter(pid => pid !== id);
    return true;
  }

  get(id: string): ScanQueueItem | undefined {
    return this.items.get(id);
  }

  list(keyId?: string, limit = 50): ScanQueueItem[] {
    let all = Array.from(this.items.values());
    if (keyId) all = all.filter(i => i.keyId === keyId);
    return all
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  getStats(): QueueStats {
    const counts: QueueStats = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
    for (const item of this.items.values()) {
      counts[item.status]++;
      counts.total++;
    }
    return counts;
  }

  /** Return position in queue (1-based) for a pending item. -1 if not pending. */
  getPosition(id: string): number {
    // Sort pending by priority then createdAt
    const sorted = this.pendingIds
      .map(pid => this.items.get(pid)!)
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const idx = sorted.findIndex(i => i.id === id);
    return idx === -1 ? -1 : idx + 1;
  }

  private dequeueNext(): ScanQueueItem | null {
    if (this.pendingIds.length === 0) return null;
    // Sort by priority ASC then createdAt ASC
    const sorted = this.pendingIds
      .map(pid => this.items.get(pid)!)
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const next = sorted[0];
    if (!next) return null;
    this.pendingIds = this.pendingIds.filter(id => id !== next.id);
    next.status = 'processing';
    next.startedAt = new Date().toISOString();
    return next;
  }

  private async processItem(item: ScanQueueItem): Promise<void> {
    this.processingCount++;
    try {
      const result = await scan(item.text, item.provider as Parameters<typeof scan>[1]);
      item.status = 'completed';
      item.result = result;
    } catch (err) {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
    } finally {
      item.completedAt = new Date().toISOString();
      this.processingCount--;
      this.pruneCompleted();
    }
  }

  private pruneCompleted(): void {
    const terminal = Array.from(this.items.values())
      .filter(i => i.status === 'completed' || i.status === 'failed' || i.status === 'cancelled')
      .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime());
    if (terminal.length > MAX_COMPLETED) {
      terminal.slice(MAX_COMPLETED).forEach(i => this.items.delete(i.id));
    }
  }

  tick(): void {
    while (this.processingCount < this.maxConcurrency) {
      const item = this.dequeueNext();
      if (!item) break;
      void this.processItem(item);
    }
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.stop();
    this.items = new Map();
    this.pendingIds = [];
    this.processingCount = 0;
  }
}

let instance: ScanQueue | null = null;

export function getScanQueue(): ScanQueue {
  if (!instance) instance = new ScanQueue();
  return instance;
}

export function resetScanQueue(): void {
  if (instance) instance.reset();
  instance = new ScanQueue();
}
