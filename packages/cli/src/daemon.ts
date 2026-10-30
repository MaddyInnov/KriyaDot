// SPDX-License-Identifier: Apache-2.0
// Daemon mode (#102 / #109, CLI side).
//
// `kriyadot daemon start <name> --bot <id>` runs a long-lived CLI process
// that HOLDS a named session: it records the session in the named-session
// store, registers itself in the local daemon registry
// (<configDir>/daemons.json — pidfile-style: name → pid + heartbeat) and
// with the API's daemon surface (POST /daemon/sessions, heartbeat every
// ~20s, DELETE on exit), and drains an inject inbox
// (<configDir>/daemon-inbox/<name>.jsonl): each line is one message to
// run as a turn on the held session.
//
// `kriyadot send <name> "…"` delivers into the LIVE daemon when one is
// registered and alive: first via the API inject endpoint
// (POST /daemon/sessions/<name>/inject — the message lands as a steer in
// the live session), falling back to appending to the daemon's local
// inbox when the API has no live registration. With no live daemon it
// keeps the historical behaviour (a fresh turn on the recorded session).
//
// Tests drive the registry + inbox + one daemon pass with temp dirs and
// injected process-liveness / turn runners — no real daemons are left
// running.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.js';

export interface DaemonRecord {
  name: string;
  sessionId: string;
  botId: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

/** A registration is stale when its heartbeat is older than this (API uses 60s too). */
export const DAEMON_STALE_MS = 60_000;

export function daemonRegistryPath(dir: string = configDir()): string {
  return join(dir, 'daemons.json');
}

export function daemonInboxPath(name: string, dir: string = configDir()): string {
  return join(dir, 'daemon-inbox', `${name.replace(/[^\w.-]+/g, '_')}.jsonl`);
}

export function loadDaemonRegistry(dir: string = configDir()): Record<string, DaemonRecord> {
  try {
    const raw = JSON.parse(readFileSync(daemonRegistryPath(dir), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, DaemonRecord> = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as Partial<DaemonRecord>;
      if (typeof r?.sessionId === 'string' && typeof r?.botId === 'string' && typeof r?.pid === 'number') {
        out[name] = {
          name,
          sessionId: r.sessionId,
          botId: r.botId,
          pid: r.pid,
          startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
          heartbeatAt: typeof r.heartbeatAt === 'number' ? r.heartbeatAt : 0,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveDaemonRegistry(dir: string, reg: Record<string, DaemonRecord>): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${daemonRegistryPath(dir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, daemonRegistryPath(dir));
}

export function registerDaemon(dir: string, rec: DaemonRecord): void {
  const reg = loadDaemonRegistry(dir);
  reg[rec.name] = rec;
  saveDaemonRegistry(dir, reg);
}

export function heartbeatDaemon(dir: string, name: string, now: number = Date.now()): boolean {
  const reg = loadDaemonRegistry(dir);
  const rec = reg[name];
  if (!rec) return false;
  rec.heartbeatAt = now;
  saveDaemonRegistry(dir, reg);
  return true;
}

export function unregisterDaemon(dir: string, name: string): boolean {
  const reg = loadDaemonRegistry(dir);
  if (!(name in reg)) return false;
  delete reg[name];
  saveDaemonRegistry(dir, reg);
  return true;
}

export function getDaemon(dir: string, name: string): DaemonRecord | null {
  return loadDaemonRegistry(dir)[name] ?? null;
}

export function listDaemons(dir: string = configDir()): DaemonRecord[] {
  return Object.values(loadDaemonRegistry(dir)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Default liveness probe: signal 0 (never actually signals the process). */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A daemon counts as live only when its process exists AND its heartbeat is fresh. */
export function isDaemonAlive(
  rec: DaemonRecord | null,
  opts: { now?: number; isProcessAlive?: (pid: number) => boolean } = {},
): boolean {
  if (!rec) return false;
  const now = opts.now ?? Date.now();
  if (now - rec.heartbeatAt > DAEMON_STALE_MS) return false;
  return (opts.isProcessAlive ?? defaultIsProcessAlive)(rec.pid);
}

/** Append one message to a daemon's inject inbox (created on demand). */
export function enqueueInboxMessage(dir: string, name: string, message: string): void {
  const path = daemonInboxPath(name, dir);
  mkdirSync(join(dir, 'daemon-inbox'), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ message, at: Date.now() })}\n`, { mode: 0o600 });
}

/** Drain (read + clear) a daemon's inject inbox. Returns the queued messages in order. */
export function drainInbox(dir: string, name: string): string[] {
  const path = daemonInboxPath(name, dir);
  if (!existsSync(path)) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    writeFileSync(path, '', { mode: 0o600 });
  } catch {
    // best effort — a failed clear may redeliver, never lose silently worse
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message) out.push(parsed.message);
    } catch {
      out.push(t); // tolerate hand-written plain-text lines
    }
  }
  return out;
}

export interface DaemonLoopDeps {
  dir: string;
  record: DaemonRecord;
  /** Run one turn for an injected message on the held session. */
  runTurn: (message: string) => Promise<void>;
  /** Optional API registration hooks (register / heartbeat / unregister). */
  apiRegister?: () => Promise<void>;
  apiHeartbeat?: () => Promise<void>;
  apiUnregister?: () => Promise<void>;
  log: (msg: string) => void;
  /** Poll interval for the inbox + heartbeat cadence. */
  pollMs?: number;
  /** Test seam: stop after this many poll iterations (default: run until aborted). */
  maxIterations?: number;
  signal?: AbortSignal;
}

/**
 * One daemon pass iteration: heartbeat (local + API) and drain the inbox,
 * running one turn per queued message. Exported for tests.
 */
export async function daemonPass(deps: DaemonLoopDeps): Promise<number> {
  heartbeatDaemon(deps.dir, deps.record.name);
  if (deps.apiHeartbeat) {
    try {
      await deps.apiHeartbeat();
    } catch {
      deps.log(`[daemon] API heartbeat failed for "${deps.record.name}" (continuing locally)`);
    }
  }
  const messages = drainInbox(deps.dir, deps.record.name);
  for (const message of messages) {
    deps.log(`[daemon] injected message for "${deps.record.name}": running turn`);
    await deps.runTurn(message);
  }
  return messages.length;
}

/** The long-running daemon loop: register, poll the inbox, unregister on exit. */
export async function runDaemonLoop(deps: DaemonLoopDeps): Promise<void> {
  registerDaemon(deps.dir, { ...deps.record, heartbeatAt: Date.now() });
  if (deps.apiRegister) {
    try {
      await deps.apiRegister();
    } catch {
      deps.log(`[daemon] API registration failed for "${deps.record.name}" (local registry still active)`);
    }
  }
  deps.log(
    `[daemon] "${deps.record.name}" holding session ${deps.record.sessionId} (bot ${deps.record.botId}, pid ${deps.record.pid}) — send with: kriyadot send ${deps.record.name} "…"`,
  );
  const pollMs = deps.pollMs ?? 1000;
  let iterations = 0;
  try {
    for (;;) {
      if (deps.signal?.aborted) break;
      await daemonPass(deps);
      iterations += 1;
      if (deps.maxIterations !== undefined && iterations >= deps.maxIterations) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    unregisterDaemon(deps.dir, deps.record.name);
    if (deps.apiUnregister) {
      try {
        await deps.apiUnregister();
      } catch {
        // shutting down — nothing useful to do with a failed unregister
      }
    }
  }
}
