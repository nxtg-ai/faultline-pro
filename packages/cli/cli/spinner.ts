/**
 * CLI spinner wrapper — provides progress feedback during long-running scans.
 *
 * Only activates when stderr is a TTY. When piped or when the output format
 * is machine-readable (json, sarif), the spinner is a silent no-op so it
 * never corrupts stdout.
 */
import type { ScanProgressCallback } from './scan.js';

/** Formats that are machine-readable and must never have spinner output. */
const MACHINE_FORMATS = new Set(['json', 'sarif']);

export interface ScanSpinner {
  /** Wire this into scan()'s onProgress parameter. */
  onProgress: ScanProgressCallback;
  /** Call after scan completes successfully. */
  succeed: (message: string) => void;
  /** Call if scan fails. */
  fail: (message: string) => void;
}

/**
 * Create a scan spinner that writes to stderr.
 *
 * Returns a no-op spinner when:
 * - stderr is not a TTY (piped, CI, tests)
 * - outputFormat is a machine-readable format (json, sarif)
 */
export async function createScanSpinner(outputFormat?: string): Promise<ScanSpinner> {
  const shouldShow = process.stderr.isTTY && !MACHINE_FORMATS.has(outputFormat ?? '');

  if (!shouldShow) {
    return {
      onProgress: () => {},
      succeed: () => {},
      fail: () => {},
    };
  }

  const { default: ora } = await import('ora');
  const spinner = ora({
    stream: process.stderr,
    color: 'cyan',
  });
  spinner.start('Initializing scan...');

  return {
    onProgress: (message: string) => {
      spinner.text = message;
    },
    succeed: (message: string) => {
      spinner.succeed(message);
    },
    fail: (message: string) => {
      spinner.fail(message);
    },
  };
}
