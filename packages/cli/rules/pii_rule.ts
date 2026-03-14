import type { Rule, Finding } from './base_rule.js';

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; severity: Finding['severity'] }> = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, severity: 'high' },
  { name: 'phone', pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, severity: 'high' },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, severity: 'critical' },
  { name: 'credit-card', pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, severity: 'critical' },
  { name: 'ip-address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, severity: 'medium' },
];

export function createPiiRule(): Rule {
  return {
    id: 'pii',
    name: 'PII Detection',
    description: 'Detects personally identifiable information such as emails, phone numbers, SSNs, and credit card numbers.',

    check(content: string): Finding[] {
      const findings: Finding[] = [];

      for (const { name, pattern, severity } of PII_PATTERNS) {
        // Reset lastIndex for each call
        const regex = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          findings.push({
            ruleId: `pii-${name}`,
            severity,
            message: `Detected ${name}: ${mask(match[0])}`,
            match: match[0],
            offset: match.index,
          });
        }
      }

      return findings;
    },
  };
}

function mask(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}
