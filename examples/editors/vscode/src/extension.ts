// SPDX-License-Identifier: Apache-2.0
// CA-29: KriyaDot VS Code extension (sideload build).
//
// Features, all over the ACP stdio client (acp-client.ts):
//   - kriyadot.ask            — selection-as-context: the current
//                               selection (or file) is embedded as ACP
//                               context in a session/prompt.
//   - kriyadot.reviewDiff     — the agent's proposed file content is
//                               opened in VS Code's NATIVE diff editor
//                               (`vscode.diff`) against the original.
//   - kriyadot.pushDiagnostics— the editor's current diagnostics are
//                               pushed to the agent as a prompt.
// Approvals: ACP `session/request_permission` requests are answered
// with VS Code modal prompts (allow_once / reject_once) — KriyaDot's
// governance, surfaced natively.
import * as vscode from 'vscode';
import { AcpClient } from './acp-client';

let client: AcpClient | undefined;
let sessionId: string | undefined;

async function ensureSession(): Promise<{ client: AcpClient; sessionId: string }> {
  if (client && sessionId) return { client, sessionId };
  const cfg = vscode.workspace.getConfiguration('kriyadot');
  const command = cfg.get<string>('serverCommand') ?? 'mvp-server';
  const bot = cfg.get<string>('bot') ?? 'coder';
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  client = new AcpClient(command, ['acp', '--bot', bot], cwd);
  client.onPermissionRequest = async () => {
    const pick = await vscode.window.showWarningMessage(
      'KriyaDot agent requests permission to run a tool.',
      { modal: true },
      'Allow once',
      'Reject',
    );
    return { outcome: pick === 'Allow once' ? 'allow_once' : 'reject_once' };
  };
  await client.initialize();
  sessionId = await client.newSession(cwd);
  return { client, sessionId };
}

/** The editor selection (or whole file) formatted as ACP prompt context. */
export function selectionAsContext(editor: vscode.TextEditor): string {
  const sel = editor.selection;
  const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  const lang = editor.document.languageId;
  const file = vscode.workspace.asRelativePath(editor.document.uri);
  const range = sel.isEmpty ? 'whole file' : `lines ${sel.start.line + 1}-${sel.end.line + 1}`;
  return `Context from ${file} (${range}):\n\n\`\`\`${lang}\n${text}\n\`\`\``;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kriyadot.ask', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { void vscode.window.showInformationMessage('KriyaDot: open a file first.'); return; }
      const question = await vscode.window.showInputBox({ prompt: 'Ask KriyaDot about the selection' });
      if (!question) return;
      const { client: c, sessionId: s } = await ensureSession();
      await c.prompt(s, `${question}\n\n${selectionAsContext(editor)}`);
      void vscode.window.showInformationMessage('KriyaDot: answer streamed in the agent session (see Output → KriyaDot in a full build).');
    }),

    vscode.commands.registerCommand('kriyadot.reviewDiff', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const proposed = await vscode.window.showInputBox({ prompt: 'Paste the proposed file content to diff (a full build takes it from the agent reply)' });
      if (proposed === undefined) return;
      const proposedUri = editor.document.uri.with({ scheme: 'kriyadot-proposal', path: editor.document.uri.path + '.proposal' });
      const provider: vscode.TextDocumentContentProvider = { provideTextDocumentContent: () => proposed };
      context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('kriyadot-proposal', provider));
      await vscode.commands.executeCommand('vscode.diff', editor.document.uri, proposedUri, `KriyaDot proposal ↔ ${editor.document.fileName}`);
    }),

    vscode.commands.registerCommand('kriyadot.pushDiagnostics', async () => {
      const all = vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, diags] of all) {
        for (const d of diags) {
          lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1} ${vscode.DiagnosticSeverity[d.severity]} ${d.message} (${d.source ?? 'editor'})`);
        }
      }
      if (!lines.length) { void vscode.window.showInformationMessage('KriyaDot: no diagnostics to send.'); return; }
      const { client: c, sessionId: s } = await ensureSession();
      await c.prompt(s, `Please help fix these diagnostics from my editor:\n\n${lines.join('\n')}`);
    }),
  );
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
  sessionId = undefined;
}
