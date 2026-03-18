import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FaultlineExtConfig {
  scanOnSave: boolean;
  provider: string;
  minConfidence: number;
  rules: string[];
  /** Base URL of the Faultline API server (for file upload support). */
  apiUrl?: string;
  /** API key for the Faultline API server. */
  serverApiKey?: string;
}

/**
 * Load extension configuration from VS Code settings,
 * with .faultlinerc.json from workspace as fallback for provider/rules.
 */
export function loadExtensionConfig(
  getConfig: () => { get<T>(key: string): T | undefined },
  workspacePath?: string,
): FaultlineExtConfig {
  const vsConfig = getConfig();

  // Defaults
  const defaults: FaultlineExtConfig = {
    scanOnSave: true,
    provider: 'mock',
    minConfidence: 0,
    rules: [],
  };

  // Try loading .faultlinerc.json from workspace
  let fileConfig: Record<string, unknown> = {};
  if (workspacePath) {
    const rcPath = join(workspacePath, '.faultlinerc.json');
    if (existsSync(rcPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(rcPath, 'utf-8'));
      } catch {
        // Invalid JSON — skip
      }
    }
  }

  return {
    scanOnSave: vsConfig.get<boolean>('scanOnSave') ?? defaults.scanOnSave,
    provider: vsConfig.get<string>('provider') ?? (typeof fileConfig.provider === 'string' ? fileConfig.provider : defaults.provider),
    minConfidence: vsConfig.get<number>('minConfidence') ?? (typeof fileConfig['min-confidence'] === 'number' ? fileConfig['min-confidence'] : defaults.minConfidence),
    rules: vsConfig.get<string[]>('rules') ?? (Array.isArray(fileConfig.rules) ? fileConfig.rules as string[] : defaults.rules),
    apiUrl: vsConfig.get<string>('apiUrl'),
    serverApiKey: vsConfig.get<string>('serverApiKey'),
  };
}

/**
 * Build CLI args from extension config.
 */
export function buildScanArgs(filePath: string, config: FaultlineExtConfig): string[] {
  const args = ['scan', '--input', filePath, '--provider', config.provider, '--output-format', 'sarif'];

  if (config.minConfidence > 0) {
    args.push('--min-confidence', config.minConfidence.toString());
  }

  if (config.rules.length > 0) {
    args.push('--rules', config.rules.join(','));
  }

  return args;
}
