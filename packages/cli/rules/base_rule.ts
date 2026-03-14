export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  ruleId: string;
  severity: FindingSeverity;
  message: string;
  /** The matched text or pattern that triggered the finding. */
  match: string;
  /** Character offset in the original content where the match starts. */
  offset: number;
}

export interface Rule {
  /** Unique rule identifier (e.g. 'pii-email', 'bias-gender'). */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Brief description of what the rule detects. */
  description: string;
  /** Check content and return findings. */
  check(content: string): Finding[];
}

export type RuleFactory = () => Rule;
