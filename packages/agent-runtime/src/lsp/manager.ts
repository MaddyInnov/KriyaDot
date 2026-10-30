// SPDX-License-Identifier: Apache-2.0
// LspManager (CA-9): owns the language-server fleet for one host.
//
// Lifecycle:
//   - LAZY: a server process starts on the first request for a file it
//     serves, keyed by (workspace root, server id) — one process per
//     root per language, REUSED across requests and tool calls.
//   - DOCUMENT SYNC: files are opened (didOpen) on first use and kept in
//     sync with full-text didChange when their on-disk content changes;
//     the manager tracks versions per document.
//   - IDLE SHUTDOWN: a server with no requests for `idleTimeoutMs`
//     (default 5 min) is shut down gracefully; `dispose()` shuts the
//     whole fleet down (also clearing timers).
//   - AVAILABILITY: a server that cannot start is remembered as
//     unavailable (with the reason) for `unavailableRetryMs`, and every
//     API degrades to a clear "unavailable" result — NOTHING in this
//     module throws for a missing/failing server, so a tool turn never
//     dies because LSP is absent. When `autoInstall` is enabled, a
//     failed direct launch gets ONE fetch attempt: the definition's
//     `installCommand` (pip/go install/rustup) or its npx launch
//     (`npx -y --package=…`), then a retry.
//
// Diagnostics: servers publish them asynchronously after didOpen /
// didChange; getDiagnostics() waits briefly (bounded by
// `diagnosticsWaitMs`) for a fresh publish before answering.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient, type LspDiagnostic, type LspSpawnFn } from './client.js';
import {
  languageIdForPath,
  parseServerDefinition,
  serversForFile,
  type LanguageServerDefinition,
} from './servers.js';

export interface LspManagerOptions {
  /** Injectable process spawner (tests inject a fake-server spawn). */
  spawnFn?: LspSpawnFn;
  /** Injectable one-shot command runner for install attempts (tests fake it). */
  installRunner?: (command: string, args: string[]) => { status: number | null; error?: string };
  /** Attempt the ecosystem fetch (npx / installCommand) when a launch fails. Default false. */
  autoInstall?: boolean;
  /** Idle lifetime before a server is shut down. Default 5 minutes. */
  idleTimeoutMs?: number;
  /** How long getDiagnostics waits for a fresh publish. Default 1000ms. */
  diagnosticsWaitMs?: number;
  /** How long a failed server stays marked unavailable. Default 60s. */
  unavailableRetryMs?: number;
  /** Extra server definitions (win over workspace config, after built-ins). */
  servers?: LanguageServerDefinition[];
  /** Disable the whole subsystem (all APIs degrade to unavailable). */
  disabled?: boolean;
}

export interface DiagnosticsSummary {
  file: string;
  errors: number;
  warnings: number;
  infos: number;
  items: Array<{
    line: number;
    character: number;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    source?: string;
  }>;
  /** Total diagnostics before capping `items`. */
  total: number;
}

export type LspResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: string };

interface ManagedServer {
  key: string;
  def: LanguageServerDefinition;
  root: string;
  client: LspClient;
  /** uri → { version, text } for opened documents. */
  documents: Map<string, { version: number; text: string }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
}

const SEVERITY_NAMES = ['error', 'warning', 'info', 'hint'] as const;

export function summarizeDiagnostics(file: string, diags: LspDiagnostic[], cap = 10): DiagnosticsSummary {
  const items = diags.slice(0, cap).map((d) => ({
    line: d.range.start.line,
    character: d.range.start.character,
    severity: SEVERITY_NAMES[(d.severity ?? 3) - 1] ?? 'info',
    message: d.message.slice(0, 300),
    ...(d.source ? { source: d.source } : {}),
  }));
  return {
    file,
    errors: diags.filter((d) => d.severity === 1).length,
    warnings: diags.filter((d) => d.severity === 2).length,
    infos: diags.filter((d) => (d.severity ?? 3) >= 3).length,
    items,
    total: diags.length,
  };
}

export class LspManager {
  private opts: Required<Omit<LspManagerOptions, 'spawnFn' | 'installRunner' | 'servers'>> & {
    spawnFn?: LspSpawnFn;
    installRunner?: LspManagerOptions['installRunner'];
    servers: LanguageServerDefinition[];
  };
  private serversByKey = new Map<string, ManagedServer>();
  private startingByKey = new Map<string, Promise<ManagedServer | null>>();
  private unavailableByKey = new Map<string, { reason: string; at: number }>();
  private installAttempted = new Set<string>();
  private workspaceServersCache = new Map<string, LanguageServerDefinition[]>();
  private disposed = false;

  constructor(opts: LspManagerOptions = {}) {
    this.opts = {
      autoInstall: opts.autoInstall ?? false,
      idleTimeoutMs: opts.idleTimeoutMs ?? 5 * 60_000,
      diagnosticsWaitMs: opts.diagnosticsWaitMs ?? 1_000,
      unavailableRetryMs: opts.unavailableRetryMs ?? 60_000,
      disabled: opts.disabled ?? false,
      spawnFn: opts.spawnFn,
      installRunner: opts.installRunner,
      servers: opts.servers ?? [],
    };
  }

  // -------------------------------------------------------------- config

  /** Server definitions from `<root>/.kriyadot/lsp.json` (cached per root). */
  private workspaceServers(root: string): LanguageServerDefinition[] {
    const cached = this.workspaceServersCache.get(root);
    if (cached) return cached;
    const defs: LanguageServerDefinition[] = [];
    const file = join(root, '.kriyadot', 'lsp.json');
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown[] };
        if (Array.isArray(parsed.servers)) {
          for (const raw of parsed.servers) {
            const def = parseServerDefinition(raw);
            if (def) defs.push(def);
          }
        }
      } catch {
        // A malformed lsp.json disables workspace servers, never the fleet.
      }
    }
    this.workspaceServersCache.set(root, defs);
    return defs;
  }

  /** Definitions that could serve this file, in try order. */
  definitionsFor(root: string, absPath: string): LanguageServerDefinition[] {
    return serversForFile(absPath, [...this.opts.servers, ...this.workspaceServers(root)]);
  }

  /** True when some definition exists for the file type. */
  supportsFile(root: string, absPath: string): boolean {
    return this.definitionsFor(root, absPath).length > 0;
  }

  // ----------------------------------------------------------- lifecycle

  private key(root: string, serverId: string): string {
    return `${root}::${serverId}`;
  }

  private touch(server: ManagedServer): void {
    server.lastUsedAt = Date.now();
    if (server.idleTimer) clearTimeout(server.idleTimer);
    if (this.opts.idleTimeoutMs > 0) {
      server.idleTimer = setTimeout(() => {
        void this.stopServer(server.key);
      }, this.opts.idleTimeoutMs);
      server.idleTimer.unref?.();
    }
  }

  private async stopServer(key: string): Promise<void> {
    const server = this.serversByKey.get(key);
    if (!server) return;
    this.serversByKey.delete(key);
    if (server.idleTimer) clearTimeout(server.idleTimer);
    await server.client.shutdown().catch(() => undefined);
  }

  /** Shut down every managed server. The manager stays unusable after. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const keys = [...this.serversByKey.keys()];
    await Promise.all(keys.map((k) => this.stopServer(k)));
  }

  /** Number of live server processes (diagnostics/tests). */
  get activeServerCount(): number {
    return this.serversByKey.size;
  }

  private runInstall(command: string, args: string[]): boolean {
    const runner =
      this.opts.installRunner ??
      ((cmd: string, a: string[]) => {
        const r = spawnSync(cmd, a, { timeout: 120_000, encoding: 'utf8' });
        return { status: r.status, ...(r.error ? { error: r.error.message } : {}) };
      });
    try {
      const res = runner(command, args);
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Start (or reuse) the server for one definition at one root.
   * Returns null — never throws — when the server cannot run.
   */
  private async ensureServer(
    root: string,
    def: LanguageServerDefinition,
  ): Promise<ManagedServer | null> {
    if (this.disposed || this.opts.disabled) return null;
    const key = this.key(root, def.id);
    const existing = this.serversByKey.get(key);
    if (existing) {
      if (existing.client.isAlive) {
        this.touch(existing);
        return existing;
      }
      this.serversByKey.delete(key);
    }
    const unavail = this.unavailableByKey.get(key);
    if (unavail && Date.now() - unavail.at < this.opts.unavailableRetryMs) return null;
    const starting = this.startingByKey.get(key);
    if (starting) return starting;
    const promise = this.startServer(root, def).finally(() => {
      this.startingByKey.delete(key);
    });
    this.startingByKey.set(key, promise);
    return promise;
  }

  private async startServer(
    root: string,
    def: LanguageServerDefinition,
    allowInstallRetry = true,
  ): Promise<ManagedServer | null> {
    const key = this.key(root, def.id);
    const attempts: Array<{ command: string; args: string[] }> = [{ command: def.command, args: def.args }];
    if (this.opts.autoInstall && def.npxPackage) {
      attempts.push({
        command: 'npx',
        args: ['-y', `--package=${def.npxPackage}`, def.npxBin ?? def.command, ...def.args],
      });
    }
    let lastError = 'unknown error';
    for (const attempt of attempts) {
      try {
        const client = new LspClient(attempt.command, attempt.args, root, this.opts.spawnFn);
        await client.request(
          'initialize',
          {
            processId: process.pid,
            rootUri: pathToFileURL(root).href,
            workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }],
            capabilities: {
              textDocument: {
                publishDiagnostics: { relatedInformation: false },
                synchronization: { didSave: false },
                definition: { dynamicRegistration: false },
                hover: { dynamicRegistration: false },
                references: { dynamicRegistration: false },
              },
            },
          },
          10_000,
        );
        client.notify('initialized', {});
        const server: ManagedServer = {
          key,
          def,
          root,
          client,
          documents: new Map(),
          idleTimer: null,
          lastUsedAt: Date.now(),
        };
        this.serversByKey.set(key, server);
        this.unavailableByKey.delete(key);
        this.touch(server);
        return server;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    // Auto-install: run the definition's install command ONCE, then retry
    // the direct launch a single time (allowInstallRetry guards recursion).
    if (allowInstallRetry && this.opts.autoInstall && def.installCommand && !this.installAttempted.has(key)) {
      this.installAttempted.add(key);
      const ok = this.runInstall(def.installCommand.command, def.installCommand.args);
      if (ok) {
        this.unavailableByKey.delete(key);
        return this.startServer(root, def, false);
      }
      lastError = `auto-install failed (${def.installCommand.command} ${def.installCommand.args.join(' ')})`;
    }
    this.unavailableByKey.set(key, { reason: lastError, at: Date.now() });
    return null;
  }

  /** Last recorded unavailability reason for a definition at a root. */
  unavailableReason(root: string, serverId: string): string | null {
    return this.unavailableByKey.get(this.key(root, serverId))?.reason ?? null;
  }

  // ------------------------------------------------------------ documents

  /**
   * Resolve the managed server for a file and sync its document state.
   * Returns the server plus the file URI, or an unavailable result.
   */
  private async serverForFile(
    root: string,
    absPath: string,
  ): Promise<LspResult<{ server: ManagedServer; uri: string }>> {
    if (this.opts.disabled) return { ok: false, unavailable: 'language server support is disabled' };
    const defs = this.definitionsFor(root, absPath);
    if (defs.length === 0) {
      return { ok: false, unavailable: `no language server is configured for this file type` };
    }
    let reason = 'language server not available';
    for (const def of defs) {
      const server = await this.ensureServer(root, def);
      if (!server) {
        reason = this.unavailableReason(root, def.id) ?? reason;
        continue;
      }
      const uri = pathToFileURL(absPath).href;
      let text: string;
      try {
        text = readFileSync(absPath, 'utf8');
      } catch (err) {
        return { ok: false, unavailable: `cannot read file: ${err instanceof Error ? err.message : String(err)}` };
      }
      const opened = server.documents.get(uri);
      if (!opened) {
        server.client.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: languageIdForPath(absPath), version: 1, text },
        });
        server.documents.set(uri, { version: 1, text });
      } else if (opened.text !== text) {
        opened.version += 1;
        opened.text = text;
        server.client.notify('textDocument/didChange', {
          textDocument: { uri, version: opened.version },
          contentChanges: [{ text }],
        });
      }
      this.touch(server);
      return { ok: true, value: { server, uri } };
    }
    return { ok: false, unavailable: `language server not available (${reason})` };
  }

  // -------------------------------------------------------------- queries

  /** Diagnostics for one file, waiting briefly for a fresh publish. */
  async getDiagnostics(root: string, absPath: string): Promise<LspResult<LspDiagnostic[]>> {
    const resolvedRoot = resolve(root);
    const found = await this.serverForFile(resolvedRoot, absPath);
    if (!found.ok) return found;
    const { server, uri } = found.value;
    const before = server.client.diagnosticsPublishCount(uri);
    await server.client.waitForDiagnostics(uri, before + 1, this.opts.diagnosticsWaitMs);
    return { ok: true, value: server.client.diagnosticsFor(uri) };
  }

  async definition(
    root: string,
    absPath: string,
    position: { line: number; character: number },
  ): Promise<LspResult<unknown>> {
    return this.positionRequest(root, absPath, 'textDocument/definition', position);
  }

  async hover(
    root: string,
    absPath: string,
    position: { line: number; character: number },
  ): Promise<LspResult<unknown>> {
    return this.positionRequest(root, absPath, 'textDocument/hover', position);
  }

  async references(
    root: string,
    absPath: string,
    position: { line: number; character: number },
  ): Promise<LspResult<unknown>> {
    return this.positionRequest(root, absPath, 'textDocument/references', position, {
      context: { includeDeclaration: true },
    });
  }

  private async positionRequest(
    root: string,
    absPath: string,
    method: string,
    position: { line: number; character: number },
    extra: Record<string, unknown> = {},
  ): Promise<LspResult<unknown>> {
    const resolvedRoot = resolve(root);
    const found = await this.serverForFile(resolvedRoot, absPath);
    if (!found.ok) return found;
    const { server, uri } = found.value;
    try {
      const result = await server.client.request(method, {
        textDocument: { uri },
        position,
        ...extra,
      });
      this.touch(server);
      return { ok: true, value: result };
    } catch (err) {
      return {
        ok: false,
        unavailable: `language server request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
