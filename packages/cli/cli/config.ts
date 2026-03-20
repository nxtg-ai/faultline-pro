import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { OutputFormat } from './report.js';

export interface LocalScanTemplate {
  provider?: string;
  rules?: string[];
  'fail-on'?: string;
  'min-confidence'?: number;
  description?: string;
}

export interface FaultlineConfig {
  provider?: string;
  'min-confidence'?: number;
  'output-format'?: OutputFormat;
  rules?: string[];
  templates?: Record<string, LocalScanTemplate>;
  /**
   * npm package names or relative paths to Faultline plugins.
   * Loaded automatically before every scan.
   * @example ["@my/faultline-rules", "./local-plugin.js"]
   */
  plugins?: string[];
}

const CONFIG_FILENAME = '.faultlinerc.json';

const SAMPLE_CONFIG: FaultlineConfig & { $schema?: string; $comment?: string } = {
  $comment: 'Faultline configuration — CLI flags override these values. See: faultline --help',
  provider: 'mock',
  'min-confidence': 0.5,
  'output-format': 'json',
  rules: ['pii', 'bias', 'toxicity'],
  templates: {
    'compliance-check': {
      provider: 'gemini',
      rules: ['pii', 'bias'],
      'fail-on': 'high',
      description: 'Standard compliance verification template',
    },
  },
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

  if (Array.isArray(raw['plugins'])) {
    const plugins = raw['plugins'].filter((p): p is string => typeof p === 'string');
    if (plugins.length > 0) {
      config.plugins = plugins;
    }
  }

  if (raw['templates'] && typeof raw['templates'] === 'object' && !Array.isArray(raw['templates'])) {
    const tpls: Record<string, LocalScanTemplate> = {};
    for (const [k, v] of Object.entries(raw['templates'] as Record<string, unknown>)) {
      if (typeof v === 'object' && v !== null) {
        const t: LocalScanTemplate = {};
        const tv = v as Record<string, unknown>;
        if (typeof tv['provider'] === 'string') t.provider = tv['provider'];
        if (Array.isArray(tv['rules'])) t.rules = tv['rules'].filter((r): r is string => typeof r === 'string');
        if (typeof tv['fail-on'] === 'string') t['fail-on'] = tv['fail-on'];
        if (typeof tv['min-confidence'] === 'number') t['min-confidence'] = tv['min-confidence'];
        if (typeof tv['description'] === 'string') t.description = tv['description'];
        tpls[k] = t;
      }
    }
    if (Object.keys(tpls).length > 0) config.templates = tpls;
  }

  return config;
}

/**
 * Look up a named local template from the config.
 * Returns undefined if the template does not exist.
 */
export function getLocalTemplate(config: FaultlineConfig, name: string): LocalScanTemplate | undefined {
  return config.templates?.[name];
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

/**
 * Write (or overwrite) a .faultlinerc.json file at targetDir.
 */
export function saveConfig(targetDir: string, config: FaultlineConfig): string {
  const filePath = resolve(targetDir, CONFIG_FILENAME);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return filePath;
}

/**
 * Add a plugin entry to an existing (or new) .faultlinerc.json.
 * Idempotent — does nothing if the plugin is already listed.
 * Returns the path to the config file.
 */
export function addPluginToConfig(projectDir: string, packageName: string): string {
  const configPath = findConfigFile(projectDir) || resolve(projectDir, CONFIG_FILENAME);

  let config: FaultlineConfig = {};
  if (existsSync(configPath)) {
    try {
      config = validateConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
    } catch { /* start fresh */ }
  }

  const plugins = config.plugins ?? [];
  if (!plugins.includes(packageName)) {
    config.plugins = [...plugins, packageName];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  return configPath;
}

/**
 * Remove a plugin entry from .faultlinerc.json.
 * Returns the config file path, or null if no config was found.
 */
export function removePluginFromConfig(projectDir: string, packageName: string): string | null {
  const configPath = findConfigFile(projectDir);
  if (!configPath) return null;

  try {
    const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
    config.plugins = (config.plugins ?? []).filter((p) => p !== packageName);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return configPath;
  } catch {
    return null;
  }
}
