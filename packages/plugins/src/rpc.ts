// SPDX-License-Identifier: Apache-2.0
// Stdio JSON-RPC transport for executable plugins.
//
// Protocol: newline-delimited JSON-RPC 2.0 over the child process's
// stdin/stdout. The host writes ONE request line, the plugin answers with
// one response line carrying the same `id`:
//
//   → {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{...}}\n
//   ← {"jsonrpc":"2.0","id":1,"result":{...}}\n
//   ← {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"..."}}\n
//
// Lifecycle: a FRESH child process is spawned per invocation and killed
// once the response arrives (or the timeout fires). Plugins are therefore
// stateless between calls — a plugin that needs memory across calls can
// use files inside its own plugin directory (its cwd, and the only place
// it is expected to write).
//
// Isolation (deliberately honest scope):
//   - cwd is pinned to the plugin directory; the entry path must resolve
//     inside it.
//   - The child environment is scrubbed: only PATH (plus the platform
//     minimum) and the variables named in manifest permissions.env are
//     inherited, plus PLUGIN_ID / PLUGIN_DIR markers.
//   - A hard timeout kills the child (SIGKILL).
//   - `.js` / `.mjs` / `.cjs` entries run under the host's Node binary;
//     any other entry is executed directly (it must be executable).
// Network access is NOT blocked at this layer (no portable socket sandbox
// in-process) — permissions.network is a declaration surfaced at install
// approval time, not an enforcement mechanism. See manifest.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { PluginManifest } from './manifest.js';

export const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 64 * 1024;

export class PluginRpcError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'PluginRpcError';
    this.code = code;
  }
}

export class PluginRpcTimeoutError extends PluginRpcError {
  constructor(method: string, timeoutMs: number) {
    super(`plugin RPC "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'PluginRpcTimeoutError';
  }
}

export interface PluginProcessTarget {
  /** Absolute plugin directory (also the child cwd). */
  dir: string;
  manifest: PluginManifest;
}

export interface InvokeOptions {
  timeoutMs?: number;
  /** Host environment to scrub from (defaults to process.env). */
  hostEnv?: NodeJS.ProcessEnv;
}

/** Build the scrubbed child environment for a plugin invocation. */
export function buildPluginEnv(manifest: PluginManifest, dir: string, hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Platform minimum: PATH so shebang-less spawns and child tooling work;
  // SystemRoot on Windows is required by Node itself.
  if (hostEnv.PATH) env.PATH = hostEnv.PATH;
  if (process.platform === 'win32' && hostEnv.SystemRoot) env.SystemRoot = hostEnv.SystemRoot;
  for (const name of manifest.permissions?.env ?? []) {
    if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
  }
  env.PLUGIN_ID = manifest.id;
  env.PLUGIN_DIR = dir;
  return env;
}

/** Resolve the manifest entry inside the plugin dir, or throw. */
export function resolveEntry(target: PluginProcessTarget): string {
  const entry = target.manifest.entry;
  if (!entry) throw new PluginRpcError(`plugin "${target.manifest.id}" has no entry (not an executable kind)`);
  const abs = resolve(target.dir, entry);
  const root = resolve(target.dir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new PluginRpcError(`plugin "${target.manifest.id}" entry escapes the plugin directory: ${entry}`);
  }
  if (!existsSync(abs)) throw new PluginRpcError(`plugin "${target.manifest.id}" entry not found: ${entry}`);
  return abs;
}

function spawnTarget(target: PluginProcessTarget, opts: InvokeOptions): ChildProcess {
  const entryAbs = resolveEntry(target);
  const isScript = /\.(mjs|cjs|js)$/.test(entryAbs);
  const command = isScript ? process.execPath : entryAbs;
  const args = isScript ? [entryAbs] : [];
  return spawn(command, args, {
    cwd: target.dir,
    env: buildPluginEnv(target.manifest, target.dir, opts.hostEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

let nextId = 1;

/**
 * Invoke one JSON-RPC method on a plugin: spawn, send, await the matching
 * response, kill. Resolves with the response `result`; rejects with
 * PluginRpcError (plugin error / spawn failure / protocol break) or
 * PluginRpcTimeoutError.
 */
export function invokePluginRpc<T = unknown>(
  target: PluginProcessTarget,
  method: string,
  params?: unknown,
  opts: InvokeOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const id = nextId++;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnTarget(target, opts);
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new PluginRpcError(String(err)));
      return;
    }
    let settled = false;
    let stdoutBuf = '';
    let stderr = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => rejectPromise(new PluginRpcTimeoutError(method, timeoutMs)));
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish(() => rejectPromise(new PluginRpcError(`plugin "${target.manifest.id}" failed to start: ${err.message}`)));
    });
    child.on('exit', (code) => {
      if (!settled) {
        finish(() =>
          rejectPromise(
            new PluginRpcError(
              `plugin "${target.manifest.id}" exited (code ${code ?? 'unknown'}) before answering "${method}"` +
                (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''),
            ),
          ),
        );
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // non-JSON stdout noise is ignored, never fatal
        }
        if (msg.id !== id) continue;
        if (msg.error) {
          const e = msg.error;
          finish(() =>
            rejectPromise(new PluginRpcError(e.message ?? `plugin error on "${method}"`, typeof e.code === 'number' ? e.code : undefined)),
          );
        } else {
          finish(() => resolvePromise(msg.result as T));
        }
        return;
      }
    });
    child.stdin?.end(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
  });
}
