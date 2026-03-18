import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock @google/genai so provider imports don't blow up
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: vi.fn() };
  },
}));

// Mock fetch for Claude provider
vi.stubGlobal('fetch', vi.fn());

import {
  parseSarifToDiagnostics,
  sarifLevelToSeverity,
  DiagnosticSeverity,
  type FaultlineDiagnostic,
  type SarifLog,
} from '../vscode-extension/src/diagnostics';

import {
  loadExtensionConfig,
  buildScanArgs,
} from '../vscode-extension/src/config';

// ---------- sarifLevelToSeverity ----------

describe('VS Code Extension: sarifLevelToSeverity', () => {
  it('should map error to Error', () => {
    expect(sarifLevelToSeverity('error')).toBe(DiagnosticSeverity.Error);
  });

  it('should map warning to Warning', () => {
    expect(sarifLevelToSeverity('warning')).toBe(DiagnosticSeverity.Warning);
  });

  it('should map note to Information', () => {
    expect(sarifLevelToSeverity('note')).toBe(DiagnosticSeverity.Information);
  });

  it('should map none to Hint', () => {
    expect(sarifLevelToSeverity('none')).toBe(DiagnosticSeverity.Hint);
  });

  it('should default unknown to Warning', () => {
    expect(sarifLevelToSeverity('unknown')).toBe(DiagnosticSeverity.Warning);
  });
});

// ---------- parseSarifToDiagnostics ----------

describe('VS Code Extension: parseSarifToDiagnostics', () => {
  function makeSarif(results: SarifLog['runs'][0]['results'], rules?: SarifLog['runs'][0]['tool']['driver']['rules']): string {
    const sarif: SarifLog = {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'Faultline',
            version: '0.1.0',
            rules: rules || [],
          },
        },
        results,
      }],
    };
    return JSON.stringify(sarif);
  }

  it('should return empty array for invalid JSON', () => {
    expect(parseSarifToDiagnostics('not json')).toEqual([]);
  });

  it('should return empty array for empty runs', () => {
    expect(parseSarifToDiagnostics(JSON.stringify({ version: '2.1.0', runs: [] }))).toEqual([]);
  });

  it('should return empty array for no results', () => {
    const diags = parseSarifToDiagnostics(makeSarif([]));
    expect(diags).toEqual([]);
  });

  it('should convert a basic result to a diagnostic', () => {
    const diags = parseSarifToDiagnostics(makeSarif([{
      ruleId: 'faultline/verification/contradicted',
      level: 'error',
      message: { text: 'Claim contradicted.' },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'input' },
          region: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 40 },
        },
      }],
    }]));

    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe(DiagnosticSeverity.Error);
    expect(diags[0].message).toContain('Claim contradicted');
    expect(diags[0].source).toBe('Faultline');
    expect(diags[0].code).toBe('faultline/verification/contradicted');
    // SARIF is 1-based, VS Code is 0-based
    expect(diags[0].range.startLine).toBe(4);
    expect(diags[0].range.startCharacter).toBe(0);
    expect(diags[0].range.endLine).toBe(4);
    expect(diags[0].range.endCharacter).toBe(39);
  });

  it('should handle charOffset/charLength locations', () => {
    const diags = parseSarifToDiagnostics(makeSarif([{
      ruleId: 'faultline/rule/pii-email',
      level: 'error',
      message: { text: 'PII: Email found.' },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'input' },
          region: { charOffset: 42, charLength: 16 },
        },
      }],
    }]));

    expect(diags).toHaveLength(1);
    expect(diags[0].range.startLine).toBe(0);
    expect(diags[0].range.startCharacter).toBe(42);
    expect(diags[0].range.endCharacter).toBe(58);
  });

  it('should default to line 0 when no location is provided', () => {
    const diags = parseSarifToDiagnostics(makeSarif([{
      ruleId: 'test',
      level: 'warning',
      message: { text: 'No location.' },
    }]));

    expect(diags).toHaveLength(1);
    expect(diags[0].range.startLine).toBe(0);
    expect(diags[0].range.startCharacter).toBe(0);
  });

  it('should append rule description to message when ruleIndex is valid', () => {
    const rules = [
      { id: 'faultline/verification/contradicted', shortDescription: { text: 'Claim contradicted by evidence' } },
    ];
    const diags = parseSarifToDiagnostics(makeSarif([{
      ruleId: 'faultline/verification/contradicted',
      ruleIndex: 0,
      level: 'error',
      message: { text: 'c1: Wrong.' },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'input' },
          region: { startLine: 1 },
        },
      }],
    }], rules));

    expect(diags[0].message).toContain('c1: Wrong.');
    expect(diags[0].message).toContain('Claim contradicted by evidence');
  });

  it('should not duplicate description if already in message', () => {
    const rules = [
      { id: 'test', shortDescription: { text: 'Already here' } },
    ];
    const diags = parseSarifToDiagnostics(makeSarif([{
      ruleId: 'test',
      ruleIndex: 0,
      level: 'warning',
      message: { text: 'Already here in the message.' },
    }], rules));

    // Should NOT have [Already here] appended since it's already in message
    expect(diags[0].message).toBe('Already here in the message.');
  });

  it('should handle multiple results', () => {
    const diags = parseSarifToDiagnostics(makeSarif([
      { ruleId: 'r1', level: 'error', message: { text: 'Error 1.' } },
      { ruleId: 'r2', level: 'warning', message: { text: 'Warning 1.' } },
      { ruleId: 'r3', level: 'note', message: { text: 'Note 1.' } },
    ]));

    expect(diags).toHaveLength(3);
    expect(diags[0].severity).toBe(DiagnosticSeverity.Error);
    expect(diags[1].severity).toBe(DiagnosticSeverity.Warning);
    expect(diags[2].severity).toBe(DiagnosticSeverity.Information);
  });

  it('should handle missing region gracefully', () => {
    const diags = parseSarifToDiagnostics(makeSarif([{
      ruleId: 'test',
      level: 'note',
      message: { text: 'Has location but no region.' },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'input' },
        },
      }],
    }]));

    expect(diags).toHaveLength(1);
    expect(diags[0].range.startLine).toBe(0);
  });

  it('should handle real faultline SARIF output end-to-end', async () => {
    // Use the actual scan pipeline to generate SARIF, then parse it
    const { scan } = await import('../cli/scan');
    const { renderReportAs } = await import('../cli/report');

    const result = await scan('AI recruitment tools use social scoring to evaluate candidates.', 'mock');
    const sarifOutput = renderReportAs(result, 'sarif');
    const diags = parseSarifToDiagnostics(sarifOutput);

    // Should produce at least some diagnostics (EU AI Act findings and/or rule findings)
    expect(Array.isArray(diags)).toBe(true);
    for (const d of diags) {
      expect(d.source).toBe('Faultline');
      expect(d.code).toBeDefined();
      expect(d.message.length).toBeGreaterThan(0);
      expect(typeof d.severity).toBe('number');
    }
  });
});

// ---------- loadExtensionConfig ----------

describe('VS Code Extension: loadExtensionConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-ext-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockVsConfig(values: Record<string, unknown>) {
    return () => ({
      get<T>(key: string): T | undefined {
        return values[key] as T | undefined;
      },
    });
  }

  it('should return defaults when no config or settings', () => {
    const config = loadExtensionConfig(mockVsConfig({}));
    expect(config.scanOnSave).toBe(true);
    expect(config.provider).toBe('mock');
    expect(config.minConfidence).toBe(0);
    expect(config.rules).toEqual([]);
  });

  it('should read VS Code settings', () => {
    const config = loadExtensionConfig(mockVsConfig({
      scanOnSave: false,
      provider: 'gemini',
      minConfidence: 0.7,
      rules: ['pii', 'bias'],
    }));
    expect(config.scanOnSave).toBe(false);
    expect(config.provider).toBe('gemini');
    expect(config.minConfidence).toBe(0.7);
    expect(config.rules).toEqual(['pii', 'bias']);
  });

  it('should read .faultlinerc.json from workspace as fallback', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({
      provider: 'claude',
      'min-confidence': 0.5,
      rules: ['toxicity'],
    }));

    const config = loadExtensionConfig(mockVsConfig({}), tmpDir);
    expect(config.provider).toBe('claude');
    expect(config.minConfidence).toBe(0.5);
    expect(config.rules).toEqual(['toxicity']);
  });

  it('should prefer VS Code settings over .faultlinerc.json', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({
      provider: 'claude',
      rules: ['toxicity'],
    }));

    const config = loadExtensionConfig(mockVsConfig({
      provider: 'gemini',
    }), tmpDir);
    expect(config.provider).toBe('gemini');
  });

  it('should handle invalid .faultlinerc.json gracefully', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), 'not json');

    const config = loadExtensionConfig(mockVsConfig({}), tmpDir);
    expect(config.provider).toBe('mock'); // falls back to default
  });

  it('should handle missing workspace path', () => {
    const config = loadExtensionConfig(mockVsConfig({}), undefined);
    expect(config.provider).toBe('mock');
  });
});

// ---------- buildScanArgs ----------

describe('VS Code Extension: buildScanArgs', () => {
  it('should build basic args with defaults', () => {
    const args = buildScanArgs('/tmp/test.txt', {
      scanOnSave: true,
      provider: 'mock',
      minConfidence: 0,
      rules: [],
    });
    expect(args).toEqual([
      'scan', '--input', '/tmp/test.txt',
      '--provider', 'mock',
      '--output-format', 'sarif',
    ]);
  });

  it('should include --min-confidence when > 0', () => {
    const args = buildScanArgs('/tmp/test.txt', {
      scanOnSave: true,
      provider: 'mock',
      minConfidence: 0.7,
      rules: [],
    });
    expect(args).toContain('--min-confidence');
    expect(args).toContain('0.7');
  });

  it('should not include --min-confidence when 0', () => {
    const args = buildScanArgs('/tmp/test.txt', {
      scanOnSave: true,
      provider: 'mock',
      minConfidence: 0,
      rules: [],
    });
    expect(args).not.toContain('--min-confidence');
  });

  it('should include --rules when rules are specified', () => {
    const args = buildScanArgs('/tmp/test.txt', {
      scanOnSave: true,
      provider: 'mock',
      minConfidence: 0,
      rules: ['pii', 'bias'],
    });
    expect(args).toContain('--rules');
    expect(args).toContain('pii,bias');
  });

  it('should always use --output-format sarif', () => {
    const args = buildScanArgs('/tmp/test.txt', {
      scanOnSave: true,
      provider: 'gemini',
      minConfidence: 0,
      rules: [],
    });
    expect(args).toContain('--output-format');
    expect(args).toContain('sarif');
  });

  it('should use the specified provider', () => {
    const args = buildScanArgs('/tmp/test.txt', {
      scanOnSave: true,
      provider: 'claude',
      minConfidence: 0,
      rules: [],
    });
    expect(args).toContain('--provider');
    expect(args).toContain('claude');
  });
});

// ---------- upload support ----------

import {
  mimeFromExtension,
  uploadFileForScan,
} from '../vscode-extension/src/upload';

describe('VS Code Extension: upload support', () => {
  it('should map .pdf to application/pdf', () => {
    expect(mimeFromExtension('.pdf')).toBe('application/pdf');
  });

  it('should map .png to image/png', () => {
    expect(mimeFromExtension('.png')).toBe('image/png');
  });

  it('should map .jpg to image/jpeg', () => {
    expect(mimeFromExtension('.jpg')).toBe('image/jpeg');
  });

  it('should map .JPG to image/jpeg (case insensitive)', () => {
    expect(mimeFromExtension('.JPG')).toBe('image/jpeg');
  });

  it('should return null for unsupported extension .txt', () => {
    expect(mimeFromExtension('.txt')).toBeNull();
  });

  it('should call fetch with correct URL and x-api-key header', async () => {
    const fakeBuffer = Buffer.from('fake-file-content');
    const readFileFn = (_p: string) => fakeBuffer;

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await uploadFileForScan(
      {
        filePath: '/fake/report.pdf',
        mimeType: 'application/pdf',
        apiUrl: 'https://api.faultline.example',
        apiKey: 'test-key-123',
      },
      readFileFn,
      fetchFn as unknown as typeof fetch,
    );

    expect(capturedUrl).toBe('https://api.faultline.example/scan/upload');
    expect(capturedHeaders?.['x-api-key']).toBe('test-key-123');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('should return success:true with body on 200 response', async () => {
    const fakeBuffer = Buffer.from('pdf-bytes');
    const readFileFn = (_p: string) => fakeBuffer;
    const responseBody = { riskLevel: 'low', findings: [] };

    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    const result = await uploadFileForScan(
      {
        filePath: '/fake/doc.pdf',
        mimeType: 'application/pdf',
        apiUrl: 'https://api.faultline.example',
        apiKey: 'secret',
      },
      readFileFn,
      fetchFn as unknown as typeof fetch,
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(responseBody);
    expect(result.error).toBeUndefined();
  });

  it('should return success:false with error on 401 response', async () => {
    const fakeBuffer = Buffer.from('pdf-bytes');
    const readFileFn = (_p: string) => fakeBuffer;

    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );

    const result = await uploadFileForScan(
      {
        filePath: '/fake/doc.pdf',
        mimeType: 'application/pdf',
        apiUrl: 'https://api.faultline.example',
        apiKey: 'bad-key',
      },
      readFileFn,
      fetchFn as unknown as typeof fetch,
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe('Unauthorized');
  });
});
