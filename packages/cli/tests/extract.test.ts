/**
 * Extract Module Tests (N-145) — EX1–EX15
 *
 * Validates: N-11 (Multimodal Upload — PDF/OCR text extraction)
 *
 * Covers all 3 exported functions in cli/extract.ts:
 *   EX1–EX7  : mimeFromExtension — all 5 supported extensions + unknown + empty
 *   EX8–EX13 : extractTextFromBuffer — PDF (text, empty, over-limit), image
 *              (text, empty), unsupported mime → throw
 *   EX14–EX15: extractTextFromFile — .pdf delegates correctly, unsupported
 *              extension throws before reading file
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mock pdf-parse (default export) and tesseract.js (named createWorker)
// before the module under test is imported.
// ---------------------------------------------------------------------------

vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(),
}));

import {
  mimeFromExtension,
  extractTextFromBuffer,
  extractTextFromFile,
  SUPPORTED_EXTENSIONS,
} from '../cli/extract.js';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';

const mockPdf = vi.mocked(pdfParse as unknown as (buf: Buffer) => Promise<{ text: string }>);
const mockCreateWorker = vi.mocked(createWorker);

/** Build a mock Tesseract worker that returns the given OCR text. */
function makeMockWorker(text: string) {
  return {
    recognize: vi.fn().mockResolvedValue({ data: { text } }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// EX1–EX7 — mimeFromExtension (pure, no mocks needed)
// ---------------------------------------------------------------------------

describe('mimeFromExtension', () => {
  it('EX1: .pdf returns application/pdf', () => {
    expect(mimeFromExtension('.pdf')).toBe('application/pdf');
  });

  it('EX2: .PNG returns image/png (case-insensitive lookup)', () => {
    expect(mimeFromExtension('.PNG')).toBe('image/png');
  });

  it('EX3: .jpg returns image/jpeg', () => {
    expect(mimeFromExtension('.jpg')).toBe('image/jpeg');
  });

  it('EX4: .jpeg returns image/jpeg', () => {
    expect(mimeFromExtension('.jpeg')).toBe('image/jpeg');
  });

  it('EX5: .webp returns image/webp', () => {
    expect(mimeFromExtension('.webp')).toBe('image/webp');
  });

  it('EX6: unknown extension returns empty string (?? branch)', () => {
    expect(mimeFromExtension('.docx')).toBe('');
  });

  it('EX7: empty string returns empty string', () => {
    expect(mimeFromExtension('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// EX8–EX13 — extractTextFromBuffer
// ---------------------------------------------------------------------------

describe('extractTextFromBuffer', () => {
  const buf = Buffer.from('dummy-bytes');

  beforeEach(() => {
    mockPdf.mockReset();
    mockCreateWorker.mockReset();
  });

  it('EX8: PDF with text returns trimmed text', async () => {
    mockPdf.mockResolvedValue({ text: '  Hello PDF world.  ' });
    const result = await extractTextFromBuffer(buf, 'application/pdf');
    expect(result).toBe('Hello PDF world.');
  });

  it('EX9: PDF with empty text throws (empty-PDF guard branch)', async () => {
    mockPdf.mockResolvedValue({ text: '   ' });
    await expect(extractTextFromBuffer(buf, 'application/pdf'))
      .rejects.toThrow('PDF contains no extractable text.');
  });

  it('EX10: PDF text over 50000 chars is sliced to TEXT_LIMIT', async () => {
    mockPdf.mockResolvedValue({ text: 'A'.repeat(60000) });
    const result = await extractTextFromBuffer(buf, 'application/pdf');
    expect(result.length).toBe(50000);
  });

  it('EX11: PNG with OCR text returns recognised text', async () => {
    mockCreateWorker.mockResolvedValue(makeMockWorker('detected text') as never);
    const result = await extractTextFromBuffer(buf, 'image/png');
    expect(result).toBe('detected text');
    // worker.terminate() must always be called (finally block)
    const worker = await mockCreateWorker.mock.results[0].value;
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('EX12: PNG with no OCR text throws (empty-image guard branch)', async () => {
    mockCreateWorker.mockResolvedValue(makeMockWorker('') as never);
    await expect(extractTextFromBuffer(buf, 'image/png'))
      .rejects.toThrow('No text detected in image.');
  });

  it('EX13: unsupported mimetype throws with supported-list message', async () => {
    await expect(extractTextFromBuffer(buf, 'video/mp4'))
      .rejects.toThrow('Unsupported file type: video/mp4');
  });
});

// ---------------------------------------------------------------------------
// EX14–EX15 — extractTextFromFile
// ---------------------------------------------------------------------------

describe('extractTextFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-extract-'));
    mockPdf.mockReset();
    mockCreateWorker.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('EX14: .pdf path reads file and delegates to extractTextFromBuffer', async () => {
    const filePath = join(tmpDir, 'test.pdf');
    writeFileSync(filePath, 'PDF bytes');
    mockPdf.mockResolvedValue({ text: 'extracted from file' });

    const result = await extractTextFromFile(filePath);

    expect(result).toBe('extracted from file');
    expect(mockPdf).toHaveBeenCalledOnce();
  });

  it('EX15: unsupported extension throws before reading file', async () => {
    const filePath = join(tmpDir, 'test.docx');
    writeFileSync(filePath, 'some content');

    await expect(extractTextFromFile(filePath))
      .rejects.toThrow('Unsupported file type: .docx');
    expect(mockPdf).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_EXTENSIONS set sanity check
// ---------------------------------------------------------------------------

describe('SUPPORTED_EXTENSIONS', () => {
  it('EX16: contains exactly the 5 expected extensions', () => {
    expect(SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.png', '.jpg', '.jpeg', '.webp']);
  });
});
