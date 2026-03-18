import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
// @ts-ignore -- pdf-parse ships no TypeScript types
import pdf from 'pdf-parse';
import { createWorker } from 'tesseract.js';

export const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

const MIME_FROM_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const TEXT_LIMIT = 50000;

export function mimeFromExtension(ext: string): string {
  return MIME_FROM_EXT[ext.toLowerCase()] ?? '';
}

/**
 * Extract plain text from a Buffer given its MIME type.
 * Throws on unsupported types or empty results.
 */
export async function extractTextFromBuffer(buffer: Buffer, mimetype: string): Promise<string> {
  if (mimetype === 'application/pdf') {
    const data = await (pdf as (buf: Buffer) => Promise<{ text: string }>)(buffer);
    const text = data.text.trim();
    if (!text) throw new Error('PDF contains no extractable text.');
    return text.slice(0, TEXT_LIMIT);
  }

  if (['image/png', 'image/jpeg', 'image/webp'].includes(mimetype)) {
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer);
      const text = data.text.trim();
      if (!text) throw new Error('No text detected in image.');
      return text.slice(0, TEXT_LIMIT);
    } finally {
      await worker.terminate();
    }
  }

  throw new Error(
    `Unsupported file type: ${mimetype}. Supported: ${SUPPORTED_MIMES.join(', ')}`,
  );
}

/**
 * Extract plain text from a file path, detecting type from extension.
 * Throws on unsupported extensions or empty results.
 */
export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const mime = mimeFromExtension(ext);
  if (!mime) {
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    );
  }
  const buffer = readFileSync(filePath);
  return extractTextFromBuffer(buffer, mime);
}
