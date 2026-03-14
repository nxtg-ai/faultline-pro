/**
 * GitHub Action threshold logic — used by the composite action and tested independently.
 */

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_ORDER: SeverityLevel[] = ['critical', 'high', 'medium', 'low'];

export interface ActionInputs {
  provider: string;
  templates: string;
  input: string;
  dir: string;
  threshold: SeverityLevel;
  minConfidence: number;
  rules: string;
  outputFormat: string;
}

export interface ScanCounts {
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Parse and validate action inputs with defaults.
 */
export function parseActionInputs(raw: Record<string, string | undefined>): ActionInputs {
  const provider = raw['provider'] || 'mock';
  const templates = raw['templates'] || '';
  const input = raw['input'] || '';
  const dir = raw['dir'] || '';
  const threshold = (raw['threshold'] || 'critical') as SeverityLevel;
  const minConfidenceStr = raw['min-confidence'] || '0.0';
  const rules = raw['rules'] || '';
  const outputFormat = raw['output-format'] || 'sarif';

  // Validate threshold
  if (!SEVERITY_ORDER.includes(threshold)) {
    throw new Error(`Invalid threshold: "${threshold}". Must be one of: ${SEVERITY_ORDER.join(', ')}`);
  }

  // Validate min-confidence
  const minConfidence = parseFloat(minConfidenceStr);
  if (isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(`Invalid min-confidence: "${minConfidenceStr}". Must be a number between 0.0 and 1.0`);
  }

  // Validate output format
  const validFormats = ['json', 'markdown', 'html', 'sarif'];
  if (!validFormats.includes(outputFormat)) {
    throw new Error(`Invalid output-format: "${outputFormat}". Must be one of: ${validFormats.join(', ')}`);
  }

  // Validate at least one scan target
  if (!templates && !input && !dir) {
    throw new Error('One of "input", "dir", or "templates" must be specified');
  }

  return { provider, templates, input, dir, threshold, minConfidence, rules, outputFormat };
}

/**
 * Check whether scan results pass the severity threshold.
 *
 * Threshold semantics:
 *   - "critical": fail only if critical findings exist
 *   - "high":     fail if critical OR high findings exist
 *   - "medium":   fail if critical, high, or medium findings exist
 *   - "low":      fail if any findings exist
 */
export function checkThreshold(threshold: SeverityLevel, counts: ScanCounts): boolean {
  const thresholdIndex = SEVERITY_ORDER.indexOf(threshold);

  for (let i = 0; i <= thresholdIndex; i++) {
    const level = SEVERITY_ORDER[i];
    if (counts[level] > 0) {
      return false; // Failed — findings at or above threshold
    }
  }

  return true; // Passed
}

/**
 * Build CLI args from parsed action inputs.
 */
export function buildCliArgs(inputs: ActionInputs): string[] {
  const args: string[] = ['scan'];

  if (inputs.templates) {
    args.push('--templates', inputs.templates);
  } else if (inputs.dir) {
    args.push('--dir', inputs.dir);
  } else if (inputs.input) {
    args.push('--input', inputs.input);
  }

  args.push('--provider', inputs.provider);
  args.push('--output-format', inputs.outputFormat);

  if (inputs.minConfidence > 0) {
    args.push('--min-confidence', inputs.minConfidence.toString());
  }

  if (inputs.rules) {
    args.push('--rules', inputs.rules);
  }

  return args;
}

/**
 * Extract finding counts from a SARIF report object.
 */
export function countFromSarif(sarif: Record<string, unknown>): ScanCounts {
  const runs = sarif['runs'] as Array<{ results?: Array<{ level?: string; properties?: { severity?: string } }> }> | undefined;
  const results = runs?.[0]?.results ?? [];

  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const r of results) {
    const level = r.level;
    if (level === 'error') critical++;
    else if (level === 'warning') medium++;
    else if (level === 'note') low++;
  }

  return {
    findings: results.length,
    critical,
    high,
    medium,
    low,
  };
}

/**
 * Extract finding counts from a Faultline JSON scan result.
 */
export function countFromScanResult(data: Record<string, unknown>): ScanCounts {
  const ruleFindings = (data['ruleFindings'] ?? []) as Array<{ severity: string }>;
  const verifications = data['verifications'] as Record<string, { status: string }> | undefined;

  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const f of ruleFindings) {
    switch (f.severity) {
      case 'critical': critical++; break;
      case 'high': high++; break;
      case 'medium': medium++; break;
      case 'low': low++; break;
    }
  }

  // Count non-supported verifications
  if (verifications) {
    for (const v of Object.values(verifications)) {
      if (v.status === 'contradicted') high++;
      else if (v.status === 'mixed') medium++;
      else if (v.status === 'unverified') low++;
    }
  }

  return {
    findings: critical + high + medium + low,
    critical,
    high,
    medium,
    low,
  };
}
