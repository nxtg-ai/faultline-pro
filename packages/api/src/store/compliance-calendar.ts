// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegulatoryDeadline {
  id: string;
  name: string;
  regulation: string;       // e.g. 'EU AI Act', 'GDPR', 'HIPAA'
  description: string;
  deadline: string;         // ISO date string 'YYYY-MM-DD'
  url: string;              // reference URL
  keywords: string[];       // claim text keywords that trigger an alert
  severity: 'critical' | 'high' | 'medium';
}

export interface DeadlineAlert {
  deadline: RegulatoryDeadline;
  daysUntil: number;
  matchedKeywords: string[];
  message: string;
}

// ─── Built-in deadlines ───────────────────────────────────────────────────────

const DEADLINES: RegulatoryDeadline[] = [
  {
    id: 'eu-ai-act-high-risk',
    name: 'EU AI Act — High-Risk AI Systems Compliance',
    regulation: 'EU AI Act',
    description: 'High-risk AI systems must comply with Articles 9-15 requirements (risk management, data governance, transparency).',
    deadline: '2026-08-02',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689',
    keywords: ['high-risk', 'ai system', 'recruitment', 'medical', 'credit', 'law enforcement', 'biometric'],
    severity: 'critical',
  },
  {
    id: 'eu-ai-act-prohibited',
    name: 'EU AI Act — Prohibited AI Practices Ban',
    regulation: 'EU AI Act',
    description: 'Prohibited AI practices (social scoring, real-time biometric surveillance in public spaces) become illegal.',
    deadline: '2026-02-02',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689',
    keywords: ['social scoring', 'biometric surveillance', 'emotion recognition', 'subliminal'],
    severity: 'critical',
  },
  {
    id: 'eu-ai-act-gpai',
    name: 'EU AI Act — GPAI Model Obligations',
    regulation: 'EU AI Act',
    description: 'General Purpose AI model providers must comply with transparency and copyright obligations.',
    deadline: '2025-08-02',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689',
    keywords: ['general purpose ai', 'foundation model', 'llm', 'gpt', 'language model'],
    severity: 'high',
  },
  {
    id: 'gdpr-review-2025',
    name: 'GDPR — Automated Decision-Making Review',
    regulation: 'GDPR',
    description: 'Article 22 automated decision-making review; DPAs may issue new guidance on AI profiling.',
    deadline: '2025-12-31',
    url: 'https://gdpr-info.eu/art-22-gdpr/',
    keywords: ['automated decision', 'profiling', 'personal data', 'gdpr', 'data subject'],
    severity: 'high',
  },
  {
    id: 'nist-ai-rmf-2025',
    name: 'NIST AI Risk Management Framework — Agency Adoption',
    regulation: 'NIST AI RMF',
    description: 'US federal agencies required to adopt NIST AI RMF practices.',
    deadline: '2025-09-30',
    url: 'https://www.nist.gov/artificial-intelligence',
    keywords: ['nist', 'risk management framework', 'federal ai', 'government ai'],
    severity: 'medium',
  },
];

// ─── Store ────────────────────────────────────────────────────────────────────

class ComplianceCalendar {
  /** Returns all deadlines sorted by deadline date ascending. */
  getAll(): RegulatoryDeadline[] {
    return [...DEADLINES].sort((a, b) => a.deadline.localeCompare(b.deadline));
  }

  /** Returns deadlines whose deadline date falls within the next `daysAhead` days from today. */
  getUpcoming(daysAhead = 365): RegulatoryDeadline[] {
    const now = Date.now();
    const cutoff = now + daysAhead * 24 * 60 * 60 * 1000;
    return this.getAll().filter((d) => {
      const ms = new Date(d.deadline).getTime();
      return ms >= now && ms <= cutoff;
    });
  }

  /** Returns the number of days until the deadline (negative if already past). */
  getDaysUntil(deadline: RegulatoryDeadline): number {
    const nowMs = Date.now();
    const deadlineMs = new Date(deadline.deadline).getTime();
    return Math.ceil((deadlineMs - nowMs) / (24 * 60 * 60 * 1000));
  }

  /**
   * For each deadline, checks if any of the provided claim texts contains any of its
   * keywords (case-insensitive). Returns one alert per matching deadline, sorted by
   * daysUntil ascending.
   */
  checkClaims(claimTexts: string[]): DeadlineAlert[] {
    const alerts: DeadlineAlert[] = [];
    const lowerTexts = claimTexts.map((t) => t.toLowerCase());

    for (const deadline of DEADLINES) {
      const matchedKeywords: string[] = [];

      for (const keyword of deadline.keywords) {
        const lower = keyword.toLowerCase();
        if (lowerTexts.some((t) => t.includes(lower))) {
          matchedKeywords.push(keyword);
        }
      }

      if (matchedKeywords.length > 0) {
        const daysUntil = this.getDaysUntil(deadline);
        alerts.push({
          deadline,
          daysUntil,
          matchedKeywords,
          message: `Claim text matches ${deadline.regulation} keywords. Deadline: ${deadline.deadline} (${daysUntil > 0 ? `${daysUntil} days` : 'past'}).`,
        });
      }
    }

    return alerts.sort((a, b) => a.daysUntil - b.daysUntil);
  }

  /**
   * Returns alerts for deadlines whose daysUntil falls within ±1 day of one of the
   * provided thresholds. Used to trigger scheduled notifications.
   */
  getApproaching(thresholds = [30, 14, 7]): DeadlineAlert[] {
    const alerts: DeadlineAlert[] = [];

    for (const deadline of DEADLINES) {
      const daysUntil = this.getDaysUntil(deadline);
      const matched = thresholds.some((t) => Math.abs(daysUntil - t) <= 1);

      if (matched) {
        const threshold = thresholds.find((t) => Math.abs(daysUntil - t) <= 1)!;
        alerts.push({
          deadline,
          daysUntil,
          matchedKeywords: [],
          message: `${deadline.name} deadline approaches in approximately ${threshold} days (${deadline.deadline}).`,
        });
      }
    }

    return alerts.sort((a, b) => a.daysUntil - b.daysUntil);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: ComplianceCalendar | null = null;

export function getComplianceCalendar(): ComplianceCalendar {
  if (!instance) instance = new ComplianceCalendar();
  return instance;
}

export function resetComplianceCalendar(): void {
  instance = new ComplianceCalendar();
}
