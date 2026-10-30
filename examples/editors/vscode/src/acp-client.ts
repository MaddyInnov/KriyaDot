// SPDX-License-Identifier: Apache-2.0
// Minimal ACP (Agent Client Protocol) client over stdio JSON-RPC 2.0 —
// the same protocol KriyaDot's ACP server speaks (initialize,
// session/new, session/prompt, session/request_permission). Written
// from the protocol shape documented in docs/editor-integrations.md.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class AcpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Host callback for ACP permission requests (governance approvals). */
  onPermissionRequest: (params: unknown) => Promise<{ outcome: string }> = async () => ({ outcome: 'reject_once' });

  constructor(command: string, args: string[], cwd: string) {
    this.proc = spawn(command, args, { cwd });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.on('data', () => { /* diagnostics go to the editor log in a full build */ });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith('{')) continue; // tolerate seed log lines on some installs
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'session/request_permission' && typeof msg.id === 'number') {
        void this.onPermissionRequest(msg.params).then((result) => this.send({ jsonrpc: '2.0', id: msg.id, result }));
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'ACP error'));
        else p.resolve(msg.result);
      }
    }
  }

  private send(obj: unknown): void {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kriyadot-vscode', version: '0.1.0' },
    });
  }

  async newSession(cwd: string): Promise<string> {
    const res = await this.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] });
    return res.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<unknown> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  dispose(): void {
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}
