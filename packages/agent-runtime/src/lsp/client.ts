// SPDX-License-Identifier: Apache-2.0
// Persistent JSON-RPC client for one language-server process (CA-9).
//
// Unlike the previous hand-rolled client in tools/coding.ts — which
// spawned `typescript-language-server` fresh for every single request —
// this client owns ONE long-lived process: it frames Content-Length
// messages over stdio, matches responses to requests, tracks
// `textDocument/publishDiagnostics` notifications per document, and
// answers server→client requests with sane defaults (null / empty) so
// servers that ask for workspace configuration or registrations do not
// stall. Process exit rejects every pending request.

import { spawn, type ChildProcess } from 'node:child_process';

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1=Error 2=Warning 3=Information 4=Hint
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export type LspSpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string },
) => ChildProcess;

export const defaultSpawnFn: LspSpawnFn = (command, args, opts) =>
  spawn(command, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class LspClient {
  readonly command: string;
  private child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private diagnosticsVersion = new Map<string, number>();
  private waiters: Array<() => void> = [];
  private exited = false;
  private exitError: Error | null = null;
  stderrTail = '';

  constructor(command: string, args: string[], cwd: string, spawnFn: LspSpawnFn = defaultSpawnFn) {
    this.command = command;
    this.child = spawnFn(command, args, { cwd });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    this.child.on('error', (err) => this.onExit(err instanceof Error ? err : new Error(String(err))));
    this.child.on('exit', (code) => {
      if (!this.exited) {
        this.onExit(new Error(`language server "${command}" exited (code ${code ?? 'unknown'})`));
      }
    });
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  private onExit(err: Error): void {
    this.exited = true;
    this.exitError = err;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.flushWaiters();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed frame — drop the header and resync.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const total = headerEnd + 4 + len;
      if (this.buffer.length < total) break;
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (method === undefined && typeof id === 'number') {
      // Response to one of our requests.
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const error = msg.error as { message?: string } | undefined;
      if (error) p.reject(new Error(`language server error: ${error.message ?? 'unknown'}`));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) {
        this.diagnosticsByUri.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
        this.diagnosticsVersion.set(params.uri, (this.diagnosticsVersion.get(params.uri) ?? 0) + 1);
        this.flushWaiters();
      }
      return;
    }
    if (method !== undefined && typeof id === 'number') {
      // Server → client request: answer with a benign default so the
      // server never blocks waiting on us.
      let result: unknown = null;
      if (method === 'workspace/configuration') result = [null];
      if (method === 'window/workDoneProgress/create') result = null;
      this.send({ jsonrpc: '2.0', id, result });
    }
    // Other notifications (logMessage, progress, …) are ignored.
  }

  private flushWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.exited) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    try {
      this.child.stdin?.write(Buffer.concat([header, body]));
    } catch {
      // Broken pipe — the exit handler will reject pending requests.
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new Error('language server is not running'));
    }
    const id = ++this.seq;
    return new Promise<T>((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`language server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolveReq(v as T),
        reject: rejectReq,
        timer,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Latest published diagnostics for a document URI (may be empty). */
  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  /** How many publishDiagnostics notifications a URI has received. */
  diagnosticsPublishCount(uri: string): number {
    return this.diagnosticsVersion.get(uri) ?? 0;
  }

  /**
   * Wait until diagnostics for `uri` have been published at least
   * `minCount` times, or `timeoutMs` elapses. Resolves either way —
   * callers read whatever diagnostics are current afterwards.
   */
  async waitForDiagnostics(uri: string, minCount: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.diagnosticsPublishCount(uri) < minCount && !this.exited) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.min(remaining, 250));
        timer.unref?.();
        this.waiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }

  /** Graceful shutdown: shutdown request → exit notification → kill fallback. */
  async shutdown(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request('shutdown', null, 2_000).catch(() => undefined);
      this.notify('exit', null);
    } catch {
      /* fall through to kill */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    // Give the process a brief moment, then force it.
    await new Promise((r) => setTimeout(r, 50));
    if (!this.exited) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this.onExit(new Error('language server shut down'));
    }
  }
}

/** Parse `publishDiagnostics` params defensively (exported for tests). */
export function parseDiagnostics(params: unknown): LspDiagnostic[] {
  if (typeof params !== 'object' || params === null) return [];
  const diags = (params as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diags)) return [];
  const out: LspDiagnostic[] = [];
  for (const d of diags) {
    if (typeof d !== 'object' || d === null) continue;
    const diag = d as Record<string, unknown>;
    const range = diag.range as LspDiagnostic['range'] | undefined;
    if (!range?.start || typeof diag.message !== 'string') continue;
    out.push({
      range,
      ...(typeof diag.severity === 'number' ? { severity: diag.severity } : {}),
      message: diag.message,
      ...(typeof diag.source === 'string' ? { source: diag.source } : {}),
      ...(typeof diag.code === 'string' || typeof diag.code === 'number' ? { code: diag.code } : {}),
    });
  }
  return out;
}
