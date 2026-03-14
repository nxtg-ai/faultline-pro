import type { Rule, Finding } from './base_rule.js';

const BIAS_PATTERNS: Array<{ category: string; patterns: RegExp[]; severity: Finding['severity'] }> = [
  {
    category: 'gender',
    patterns: [
      /\b(?:women|girls?) (?:can't|cannot|shouldn't|are unable to|aren't capable)\b/gi,
      /\b(?:men|boys?) (?:can't|cannot|shouldn't|are unable to|aren't capable)\b/gi,
      /\b(?:typical|natural) (?:for (?:a )?(?:woman|man|girl|boy))\b/gi,
      /\b(?:real (?:men|women))\b/gi,
    ],
    severity: 'high',
  },
  {
    category: 'racial',
    patterns: [
      /\b(?:all|every|most) (?:black|white|asian|hispanic|latino|arab) (?:people|persons?|men|women)\b/gi,
      /\b(?:those|these|the) (?:people|folks) (?:from|in)\b/gi,
    ],
    severity: 'high',
  },
  {
    category: 'age',
    patterns: [
      /\b(?:old people|elderly) (?:can't|cannot|shouldn't|are unable to|don't understand)\b/gi,
      /\b(?:young people|kids|millennials|boomers) (?:always|never|can't|don't)\b/gi,
    ],
    severity: 'medium',
  },
  {
    category: 'ability',
    patterns: [
      /\b(?:suffers? from|afflicted with|confined to|wheelchair-?bound)\b/gi,
      /\b(?:crazy|insane|psycho|retarded|lame|dumb)\b/gi,
    ],
    severity: 'medium',
  },
];

export function createBiasRule(): Rule {
  return {
    id: 'bias',
    name: 'Bias Language Detection',
    description: 'Detects potentially biased language related to gender, race, age, and ability.',

    check(content: string): Finding[] {
      const findings: Finding[] = [];

      for (const { category, patterns, severity } of BIAS_PATTERNS) {
        for (const pattern of patterns) {
          const regex = new RegExp(pattern.source, pattern.flags);
          let match: RegExpExecArray | null;
          while ((match = regex.exec(content)) !== null) {
            findings.push({
              ruleId: `bias-${category}`,
              severity,
              message: `Potentially biased language (${category}): "${match[0]}"`,
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
