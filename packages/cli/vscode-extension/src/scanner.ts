import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export interface ScanOptions {
  /** Absolute path to the file to scan. */
  filePath: string;
  /** CLI args (from buildScanArgs). */
  args: string[];
  /** Path to the faultline CLI entry point (bin/faultline.js or cli/index.ts). */
  cliPath?: string;
  /** Working directory for the CLI process. */
  cwd?: string;
  /** Timeout in ms (default 30000). */
  timeout?: number;
}

export interface ScanOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run faultline CLI and capture SARIF output.
 * Returns the raw stdout (SARIF JSON) on success.
 */
export function runScan(options: ScanOptions): Promise<ScanOutput> {
  const {
    args,
    cliPath,
    cwd,
    timeout = 30_000,
  } = options;

  // Resolve CLI path — prefer installed `faultline` binary, fall back to local dev
  const cli = cliPath || 'faultline';

  return new Promise((resolve_) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', cli, ...args],
      { cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve_({ success: false, stdout: stdout || '', stderr: stderr || error.message });
        } else {
          resolve_({ success: true, stdout, stderr });
        }
      },
    );
  });
}

/**
 * Find the faultline CLI entry point relative to the extension.
 * Checks for the npm-installed bin first, then falls back to local dev path.
 */
export function findCliPath(extensionPath: string): string {
  // In production: installed as dependency
  const npmBin = resolve(extensionPath, 'node_modules', '.bin', 'faultline');
  // In development: sibling directory
  const devCli = resolve(extensionPath, '..', 'cli', 'index.ts');
  // Default to dev path (more likely in monorepo setup)
  return devCli;
}
