/**
 * Faultline VS Code Extension — entry point.
 *
 * Activates on .md, .txt, .json, .ts, .js files.
 * Commands:
 *   faultline.scan     — Scan current file
 * Config:
 *   faultline.scanOnSave     (boolean, default true)
 *   faultline.provider       (string, default 'mock')
 *   faultline.minConfidence  (number, default 0)
 *   faultline.rules          (string[], default [])
 */

import { loadExtensionConfig, buildScanArgs } from './config.js';
import { parseSarifToDiagnostics } from './diagnostics.js';
import { runScan, findCliPath } from './scanner.js';

export interface VscodeApi {
  window: {
    showInformationMessage(msg: string): void;
    showErrorMessage(msg: string): void;
    showWarningMessage(msg: string): void;
    activeTextEditor?: { document: { uri: { fsPath: string }; fileName: string } };
    withProgress<T>(
      options: { location: number; title: string; cancellable?: boolean },
      task: () => Promise<T>,
    ): Promise<T>;
  };
  workspace: {
    getConfiguration(section: string): { get<T>(key: string): T | undefined };
    workspaceFolders?: Array<{ uri: { fsPath: string } }>;
    onDidSaveTextDocument(
      handler: (doc: { uri: { fsPath: string }; fileName: string }) => void,
    ): { dispose(): void };
  };
  languages: {
    createDiagnosticCollection(name: string): {
      set(uri: unknown, diagnostics: unknown[]): void;
      clear(): void;
      dispose(): void;
    };
  };
  Uri: { file(path: string): unknown };
  Diagnostic: new (range: unknown, message: string, severity: number) => unknown;
  DiagnosticSeverity: { Error: number; Warning: number; Information: number; Hint: number };
  Range: new (
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ) => unknown;
  ProgressLocation: { Notification: number };
  commands: {
    registerCommand(id: string, handler: () => void): { dispose(): void };
  };
  ExtensionContext: unknown;
}

export interface ActivationContext {
  extensionPath: string;
  subscriptions: Array<{ dispose(): void }>;
}

/**
 * Activate the extension. Called by VS Code on startup.
 * The `vscode` parameter is injected so this can be unit-tested
 * without the VS Code runtime.
 */
export function activate(context: ActivationContext, vscode: VscodeApi): void {
  const cliPath = findCliPath(context.extensionPath);
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('faultline');
  context.subscriptions.push(diagnosticCollection);

  async function scanFile(filePath: string): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const config = loadExtensionConfig(
      () => vscode.workspace.getConfiguration('faultline'),
      workspacePath,
    );
    const args = buildScanArgs(filePath, config);

    const output = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Faultline: Scanning...',
        cancellable: false,
      },
      async () => runScan({ filePath, args, cliPath, cwd: workspacePath }),
    );

    if (!output.success) {
      vscode.window.showErrorMessage(
        `Faultline scan failed: ${output.stderr.slice(0, 200)}`,
      );
      return;
    }

    try {
      const items = parseSarifToDiagnostics(output.stdout);
      const uri = vscode.Uri.file(filePath);

      const diagnostics = items.map((item) => {
        const range = new vscode.Range(
          item.range.startLine,
          item.range.startCharacter,
          item.range.endLine,
          item.range.endCharacter,
        );
        const severity =
          item.severity === 0
            ? vscode.DiagnosticSeverity.Error
            : item.severity === 1
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;
        return new vscode.Diagnostic(range, item.message, severity);
      });

      diagnosticCollection.set(uri, diagnostics);

      const count = diagnostics.length;
      if (count === 0) {
        vscode.window.showInformationMessage('Faultline: No issues found.');
      } else {
        vscode.window.showWarningMessage(
          `Faultline: ${count} claim issue${count > 1 ? 's' : ''} found.`,
        );
      }
    } catch {
      vscode.window.showErrorMessage('Faultline: Failed to parse scan output.');
    }
  }

  // Command: faultline.scan — scan current file
  const scanCmd = vscode.commands.registerCommand('faultline.scan', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Faultline: No active file to scan.');
      return;
    }
    void scanFile(editor.document.uri.fsPath);
  });
  context.subscriptions.push(scanCmd);

  // Scan on save — auto-scan supported file types
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    const config = loadExtensionConfig(
      () => vscode.workspace.getConfiguration('faultline'),
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    );
    if (!config.scanOnSave) return;
    const ext = doc.fileName.split('.').pop() ?? '';
    if (['md', 'txt', 'json', 'ts', 'js'].includes(ext)) {
      void scanFile(doc.uri.fsPath);
    }
  });
  context.subscriptions.push(saveListener);
}
