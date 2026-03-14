/**
 * Convert SARIF 2.1.0 results into VS Code-compatible diagnostic objects.
 *
 * This module is decoupled from the `vscode` module so it can be unit-tested
 * without the VS Code runtime. It produces plain objects that the extension
 * layer maps to real `vscode.Diagnostic` instances.
 */

export interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level: 'error' | 'warning' | 'note' | 'none';
  message: { text: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: {
        startLine?: number;
        startColumn?: number;
        endLine?: number;
        endColumn?: number;
        charOffset?: number;
        charLength?: number;
      };
    };
  }>;
  properties?: Record<string, unknown>;
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      rules?: Array<{
        id: string;
        shortDescription?: { text: string };
      }>;
    };
  };
  results: SarifResult[];
}

export interface SarifLog {
  $schema?: string;
  version: string;
  runs: SarifRun[];
}

/** Severity levels matching VS Code DiagnosticSeverity enum values. */
export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export interface FaultlineDiagnostic {
  severity: number;
  message: string;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  source: string;
  code: string;
}

/**
 * Map SARIF level to VS Code DiagnosticSeverity value.
 */
export function sarifLevelToSeverity(level: string): number {
  switch (level) {
    case 'error': return DiagnosticSeverity.Error;
    case 'warning': return DiagnosticSeverity.Warning;
    case 'note': return DiagnosticSeverity.Information;
    case 'none': return DiagnosticSeverity.Hint;
    default: return DiagnosticSeverity.Warning;
  }
}

/**
 * Parse a SARIF JSON string and extract diagnostics.
 * Returns an array of diagnostics suitable for display in VS Code.
 */
export function parseSarifToDiagnostics(sarifJson: string): FaultlineDiagnostic[] {
  let log: SarifLog;
  try {
    log = JSON.parse(sarifJson);
  } catch {
    return [];
  }

  if (!log.runs || log.runs.length === 0) return [];

  const diagnostics: FaultlineDiagnostic[] = [];

  for (const run of log.runs) {
    const rules = run.tool.driver.rules || [];

    for (const result of run.results) {
      const loc = result.locations?.[0]?.physicalLocation;
      const region = loc?.region;

      // Determine range
      let startLine = 0;
      let startChar = 0;
      let endLine = 0;
      let endChar = 0;

      if (region) {
        if (region.startLine !== undefined) {
          // SARIF lines are 1-based, VS Code is 0-based
          startLine = Math.max(0, region.startLine - 1);
          startChar = region.startColumn !== undefined ? Math.max(0, region.startColumn - 1) : 0;
          endLine = region.endLine !== undefined ? Math.max(0, region.endLine - 1) : startLine;
          endChar = region.endColumn !== undefined ? Math.max(0, region.endColumn - 1) : startChar;
        }
        // If only charOffset is available, place on line 0 with character range
        if (region.charOffset !== undefined && region.startLine === undefined) {
          startLine = 0;
          startChar = region.charOffset;
          endLine = 0;
          endChar = region.charOffset + (region.charLength || 1);
        }
      }

      // Build message with rule description if available
      let message = result.message.text;
      if (result.ruleIndex !== undefined && result.ruleIndex >= 0 && result.ruleIndex < rules.length) {
        const rule = rules[result.ruleIndex];
        if (rule.shortDescription?.text && !message.includes(rule.shortDescription.text)) {
          message = `${message} [${rule.shortDescription.text}]`;
        }
      }

      diagnostics.push({
        severity: sarifLevelToSeverity(result.level),
        message,
        range: {
          startLine,
          startCharacter: startChar,
          endLine,
          endCharacter: endChar,
        },
        source: 'Faultline',
        code: result.ruleId,
      });
    }
  }

  return diagnostics;
}
