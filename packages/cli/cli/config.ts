import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { OutputFormat } from './report.js';

export interface FaultlineConfig {
  provider?: string;
  'min-confidence'?: number;
  'output-format'?: OutputFormat;
  rules?: string[];
}

const CONFIG_FILENAME = '.faultlinerc.json';

const SAMPLE_CONFIG: FaultlineConfig & { $schema?: string; $comment?: string } = {
  $comment: 'Faultline configuration — CLI flags override these values. See: faultline --help',
  provider: 'mock',
  'min-confidence': 0.5,
  'output-format': 'json',
  rules: ['pii', 'bias', 'toxicity'],
};

/**
 * Walk up from `startDir` looking for .faultlinerc.json.
 * Returns the parsed config, or an empty object if none found.
 */
export function loadConfig(startDir?: string): FaultlineConfig {
  const configPath = findConfigFile(startDir || process.cwd());
  if (!configPath) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
  } catch {
    return {};
  }
}

/**
 * Walk up directories looking for .faultlinerc.json.
 */
function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = dirname(dir) === dir ? dir : undefined; // filesystem root

  while (true) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return null;
}

/**
 * Validate and sanitize a parsed config object.
 * Strips unknown keys, coerces types.
 */
function validateConfig(raw: Record<string, unknown>): FaultlineConfig {
  const config: FaultlineConfig = {};

  if (typeof raw['provider'] === 'string') {
    config.provider = raw['provider'];
  }

  if (typeof raw['min-confidence'] === 'number') {
    const val = raw['min-confidence'];
    if (val >= 0 && val <= 1) {
      config['min-confidence'] = val;
    }
  }

  if (typeof raw['output-format'] === 'string') {
    if (['json', 'markdown', 'html', 'sarif'].includes(raw['output-format'])) {
      config['output-format'] = raw['output-format'] as OutputFormat;
    }
  }

  if (Array.isArray(raw['rules'])) {
    const rules = raw['rules'].filter((r): r is string => typeof r === 'string');
    if (rules.length > 0) {
      config.rules = rules;
    }
  }

  return config;
}

/**
 * Merge config with CLI flags. Flags take precedence.
 */
export function mergeFlags(
  config: FaultlineConfig,
  flags: Record<string, string>,
): { provider?: string; minConfidence?: number; outputFormat: OutputFormat; ruleNames?: string[] } {
  const provider = flags['provider'] || config.provider || undefined;

  let minConfidence: number | undefined;
  if (flags['min-confidence']) {
    minConfidence = parseFloat(flags['min-confidence']);
  } else if (config['min-confidence'] !== undefined) {
    minConfidence = config['min-confidence'];
  }

  const outputFormat: OutputFormat =
    (flags['output-format'] as OutputFormat) ||
    config['output-format'] ||
    'json';

  let ruleNames: string[] | undefined;
  if (flags['rules']) {
    ruleNames = flags['rules'].split(',').map((r) => r.trim()).filter(Boolean);
  } else if (config.rules) {
    ruleNames = config.rules;
  }

  return { provider, minConfidence, outputFormat, ruleNames };
}

/**
 * Generate a sample .faultlinerc.json file.
 */
export function generateSampleConfig(targetDir: string): string {
  const filePath = resolve(targetDir, CONFIG_FILENAME);
  writeFileSync(filePath, JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n', 'utf-8');
  return filePath;
}
