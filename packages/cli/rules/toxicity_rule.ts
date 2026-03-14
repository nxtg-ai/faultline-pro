import type { Rule, Finding } from './base_rule.js';

const TOXICITY_PATTERNS: Array<{ category: string; patterns: RegExp[]; severity: Finding['severity'] }> = [
  {
    category: 'threat',
    patterns: [
      /\b(?:i(?:'ll| will) (?:kill|hurt|destroy|eliminate|end) (?:you|them|him|her))\b/gi,
      /\b(?:you(?:'re| are) (?:going to )?(?:die|dead|finished))\b/gi,
      /\b(?:death threat|bomb threat|shoot|murder)\b/gi,
    ],
    severity: 'critical',
  },
  {
    category: 'harassment',
    patterns: [
      /\b(?:shut up|go away|nobody (?:likes|wants|cares about) you)\b/gi,
      /\b(?:you(?:'re| are) (?:worthless|useless|pathetic|disgusting|stupid|an? idiot))\b/gi,
    ],
    severity: 'high',
  },
  {
    category: 'hate-speech',
    patterns: [
      /\b(?:(?:all|every) \w+ (?:should|must|need to) (?:die|leave|go back))\b/gi,
      /\b(?:(?:we|they) (?:don't )?(?:need|want) (?:those|these|more) \w+ (?:here|around))\b/gi,
    ],
    severity: 'critical',
  },
];

export function createToxicityRule(): Rule {
  return {
    id: 'toxicity',
    name: 'Toxicity Detection',
    description: 'Detects toxic content including threats, harassment, and hate speech.',

    check(content: string): Finding[] {
      const findings: Finding[] = [];

      for (const { category, patterns, severity } of TOXICITY_PATTERNS) {
        for (const pattern of patterns) {
          const regex = new RegExp(pattern.source, pattern.flags);
          let match: RegExpExecArray | null;
          while ((match = regex.exec(content)) !== null) {
            findings.push({
              ruleId: `toxicity-${category}`,
              severity,
              message: `Toxic content detected (${category}): "${match[0]}"`,
              match: match[0],
              offset: match.index,
            });
          }
        }
      }

      return findings;
    },
  };
}
