/**
 * Upload a local file (PDF, PNG, JPEG, WEBP) to the Faultline API /scan/upload endpoint.
 * This is the API-based counterpart to the CLI-based runScan() for binary files.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface UploadScanOptions {
  /** Absolute file path to read and upload. */
  filePath: string;
  /** MIME type of the file. */
  mimeType: string;
  /** Base URL of the Faultline API server. */
  apiUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Optional AI provider. */
  provider?: string;
}

export interface UploadScanResult {
  success: boolean;
  /** Raw JSON response body on success. */
  body?: unknown;
  /** HTTP status code. */
  statusCode?: number;
  /** Error message on failure. */
  error?: string;
}

export const SUPPORTED_UPLOAD_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type SupportedMime = (typeof SUPPORTED_UPLOAD_MIMES)[number];

/**
 * Check if a file extension maps to a supported MIME type.
 * Returns the MIME type string, or null if unsupported.
 */
export function mimeFromExtension(ext: string): SupportedMime | null {
  const map: Record<string, SupportedMime> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  return map[ext.toLowerCase()] ?? null;
}

/**
 * Upload a file to the Faultline /scan/upload endpoint using multipart/form-data.
 * Returns the parsed scan result or an error.
 *
 * Designed to be testable without VS Code runtime — uses node:fs/node:path directly.
 */
export async function uploadFileForScan(
  options: UploadScanOptions,
  // Injected for testing — defaults to real fs.readFileSync
  readFileFn?: (path: string) => Buffer,
  // Injected for testing — defaults to global fetch
  fetchFn?: typeof fetch,
): Promise<UploadScanResult> {
  const { filePath, mimeType, apiUrl, apiKey, provider } = options;
  const readFile = readFileFn ?? ((p: string) => readFileSync(p));
  const doFetch = fetchFn ?? fetch;

  let buffer: Buffer;
  try {
    buffer = readFile(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }

  const filename = basename(filePath);
  const blob = new Blob([buffer], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename);

  if (provider) {
    form.append('provider', provider);
  }

  let response: Response;
  try {
    response = await doFetch(`${apiUrl}/scan/upload`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const errorBody = parsed as Record<string, unknown> | null;
    const errorMessage =
      typeof errorBody?.['error'] === 'string'
        ? errorBody['error']
        : 'Upload failed';
    return { success: false, statusCode: response.status, error: errorMessage };
  }

  return { success: true, statusCode: response.status, body: parsed };
}
