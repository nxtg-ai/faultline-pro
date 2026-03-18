export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface ScanRecord {
  keyId: string;
  risk: RiskLevel;
  timestamp: string;
}

export interface RiskDistribution {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

export interface KeyUsageSummary {
  keyId: string;
  today: number;
}

export interface DashboardPayload {
  scans: { today: number; week: number; month: number };
  riskDistribution: RiskDistribution;
  keyUsage: KeyUsageSummary[];
}

const DAY_MS = 86_400_000;

class ScanAnalyticsStore {
  private records: ScanRecord[] = [];

  record(keyId: string, risk: RiskLevel): void {
    this.records.push({ keyId, risk, timestamp: new Date().toISOString() });
  }

  getDashboard(): DashboardPayload {
    const now = Date.now();
    const todayKey = new Date().toISOString().split('T')[0];

    let today = 0;
    let week = 0;
    let month = 0;
    const dist: RiskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
    const keyTodayMap = new Map<string, number>();

    for (const r of this.records) {
      const age = now - new Date(r.timestamp).getTime();
      if (r.timestamp.startsWith(todayKey)) {
        today++;
        keyTodayMap.set(r.keyId, (keyTodayMap.get(r.keyId) ?? 0) + 1);
      }
      if (age <= 7 * DAY_MS) week++;
      if (age <= 30 * DAY_MS) month++;
      dist[r.risk]++;
    }

    const keyUsage: KeyUsageSummary[] = [];
    for (const [keyId, count] of keyTodayMap.entries()) {
      keyUsage.push({ keyId, today: count });
    }

    return { scans: { today, week, month }, riskDistribution: dist, keyUsage };
  }

  reset(): void {
    this.records = [];
  }
}

let instance: ScanAnalyticsStore | null = null;

export function getAnalyticsStore(): ScanAnalyticsStore {
  if (!instance) instance = new ScanAnalyticsStore();
  return instance;
}

export function resetAnalytics(): void {
  instance = new ScanAnalyticsStore();
}
