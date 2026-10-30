// SPDX-License-Identifier: Apache-2.0
/**
 * Background process toolset (closure CA-13, complements ADD-6).
 *
 * Claude Code-style background shell tasks + Monitor: a command starts
 * as a tracked, session-owned process and keeps running ACROSS turns
 * (dev servers, watchers, long builds). The agent polls incremental
 * output by offset instead of blocking, can list/kill processes, and
 * can subscribe to output lines. New output and process exits are also
 * queued as pending notes for the session: the runtime seam is
 * `drainProcessNotesIntoSteer()` below, which the host calls at a turn
 * boundary alongside the existing SteerQueue drain (runtime.ts drains
 * steerQueue at the top of each loop iteration — feeding these notes
 * through the same queue is the minimal, honest injection path; see
 * the Wave-3 WIRING note). A `poll_process_notes` tool exposes the
 * same queue directly to the model.
 *
 * Execution path: identical governance to run_command — these are
 * ordinary registry tools (policy evaluation happens before dispatch),
 * the handler enforces the same catastrophic-command denylist as
 * run_command (builtin.ts isCatastrophicCommand), and spawning goes
 * through the shared sandbox plan (spawn-shared.ts) built on the same
 * backend chain as executeSandboxedCommand.
 *
 * Lifecycle: processes are owned by (sessionId, botId). They survive
 * across turns of that session; `disposeSession()` (host calls it when
 * the session ends) and `disposeAll()` reap everything still running.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ToolContext, ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';
import { confineRealpath } from '../confine.js';
import { isCatastrophicCommand } from './builtin.js';
import { planSandboxedSpawn, type SpawnPlan } from './spawn-shared.js';

/** Per-process retained output cap; older bytes drop and offsets shift. */
export const PROCESS_OUTPUT_CAP_BYTES = 512 * 1024;

export type BackgroundProcessStatus = 'running' | 'exited' | 'killed' | 'failed';

export interface BackgroundProcessRecord {
  id: string;
  sessionId: string;
  botId: string;
  command: string;
  cwd: string;
  backend: string;
  sandboxed: boolean;
  warning?: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
  signal?: string;
  startedAt: number;
  finishedAt?: number;
  /** Absolute offset of the first retained output character. */
  baseOffset: number;
  /** Absolute offset one past the last output character. */
  endOffset: number;
}

interface LiveProcess {
  record: BackgroundProcessRecord;
  child: ChildProcess;
  /** Retained output (stdout+stderr interleaved in arrival order). */
  buffer: string;
  listeners: Set<(chunk: string) => void>;
  killTimer?: ReturnType<typeof setTimeout>;
  plan: SpawnPlan;
}

export interface ProcessStartInput {
  command: string;
  sessionId: string;
  botId: string;
  /** Absolute cwd (already confined by the caller / tool handler). */
  cwd: string;
  env?: Record<string, string>;
}

/** Minimal steer-queue shape (SteerQueue in steer.ts satisfies it). */
export interface SteerEnqueuer {
  enqueue(sessionId: string, text: string): unknown;
}

export class ProcessRegistry {
  private readonly processes = new Map<string, LiveProcess>();
  private readonly notes = new Map<string, string[]>();

  /** Inject a spawner for tests; default is child_process.spawn. */
  constructor(private readonly spawnFn: typeof spawn = spawn) {}

  start(input: ProcessStartInput): BackgroundProcessRecord {
    const command = input.command;
    if (isCatastrophicCommand(command)) {
      throw new Error(`Refused by command denylist: "${command.slice(0, 120)}"`);
    }
    const plan = planSandboxedSpawn(command, input.cwd);
    const id = `proc-${randomUUID().slice(0, 8)}`;
    const record: BackgroundProcessRecord = {
      id,
      sessionId: input.sessionId,
      botId: input.botId,
      command,
      cwd: resolve(input.cwd),
      backend: plan.backend,
      sandboxed: plan.sandboxed,
      ...(plan.warning ? { warning: plan.warning } : {}),
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      baseOffset: 0,
      endOffset: 0,
    };
    let child: ChildProcess;
    try {
      child = this.spawnFn(plan.file, plan.args, {
        cwd: resolve(input.cwd),
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      plan.cleanup?.();
      record.status = 'failed';
      record.finishedAt = Date.now();
      throw new Error(
        `Failed to start background process: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const live: LiveProcess = { record, child, buffer: '', listeners: new Set(), plan };
    this.processes.set(id, live);

    const onData = (d: Buffer): void => {
      const text = d.toString('utf8');
      live.buffer += text;
      record.endOffset += text.length;
      if (live.buffer.length > PROCESS_OUTPUT_CAP_BYTES) {
        const drop = live.buffer.length - PROCESS_OUTPUT_CAP_BYTES;
        live.buffer = live.buffer.slice(drop);
        record.baseOffset += drop;
      }
      for (const cb of [...live.listeners]) {
        try {
          cb(text);
        } catch {
          // A subscriber must never break output capture.
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      if (record.status === 'running') {
        record.status = 'failed';
        record.finishedAt = Date.now();
        this.pushNote(
          input.sessionId,
          `[process ${id}] failed to run: ${err.message} (command: ${command.slice(0, 120)})`,
        );
      }
    });
    child.on('close', (code, signal) => {
      if (live.killTimer) clearTimeout(live.killTimer);
      plan.cleanup?.();
      if (record.status === 'running') {
        record.status = signal ? 'killed' : 'exited';
      }
      record.exitCode = typeof code === 'number' ? code : null;
      if (signal) record.signal = signal;
      record.finishedAt = Date.now();
      this.pushNote(
        input.sessionId,
        `[process ${id}] ${record.status} (exit ${record.exitCode ?? '—'}${signal ? `, signal ${signal}` : ''}): ${command.slice(0, 120)}`,
      );
    });
    return { ...record };
  }

  get(id: string): BackgroundProcessRecord | undefined {
    const live = this.processes.get(id);
    return live ? { ...live.record } : undefined;
  }

  list(filter: { sessionId?: string; botId?: string } = {}): BackgroundProcessRecord[] {
    return [...this.processes.values()]
      .map((l) => l.record)
      .filter(
        (r) =>
          (filter.sessionId === undefined || r.sessionId === filter.sessionId) &&
          (filter.botId === undefined || r.botId === filter.botId),
      )
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => ({ ...r }));
  }

  /**
   * Incremental output read. `sinceOffset` is an absolute offset from a
   * previous read's nextOffset (0 = from the start of retained output).
   * Offsets older than the retained window clamp to baseOffset and the
   * result says so via `truncatedFrom`.
   */
  readOutput(
    id: string,
    sinceOffset = 0,
  ): {
    id: string;
    status: BackgroundProcessStatus;
    exitCode: number | null;
    chunk: string;
    nextOffset: number;
    truncatedFrom?: number;
  } | undefined {
    const live = this.processes.get(id);
    if (!live) return undefined;
    const { record } = live;
    let from = Math.max(0, Math.floor(sinceOffset) || 0);
    let truncatedFrom: number | undefined;
    if (from < record.baseOffset) {
      truncatedFrom = from;
      from = record.baseOffset;
    }
    if (from > record.endOffset) from = record.endOffset;
    const chunk = live.buffer.slice(from - record.baseOffset);
    return {
      id,
      status: record.status,
      exitCode: record.exitCode,
      chunk,
      nextOffset: record.endOffset,
      ...(truncatedFrom !== undefined ? { truncatedFrom } : {}),
    };
  }

  /** Monitor-style subscription: cb receives each new output chunk. */
  subscribeProcessOutput(id: string, cb: (chunk: string) => void): () => void {
    const live = this.processes.get(id);
    if (!live) return () => {};
    live.listeners.add(cb);
    return () => live.listeners.delete(cb);
  }

  /** Kill a running process (SIGTERM, SIGKILL after a grace period). */
  kill(id: string): boolean {
    const live = this.processes.get(id);
    if (!live || live.record.status !== 'running') return false;
    live.record.status = 'killed';
    try {
      live.child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    if (live.plan.containerName) {
      try {
        const killer = this.spawnFn('docker', ['kill', live.plan.containerName], {
          stdio: 'ignore',
          windowsHide: true,
        });
        (killer as { unref?: () => void }).unref?.();
      } catch {
        // Best-effort container reaping.
      }
    }
    live.killTimer = setTimeout(() => {
      try {
        live.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 1_500);
    live.killTimer.unref?.();
    return true;
  }

  // -- Pending notes (Monitor injection seam) --------------------------------

  private pushNote(sessionId: string, text: string): void {
    const arr = this.notes.get(sessionId) ?? [];
    arr.push(text);
    // Bound the queue: a chatty process exit storm must not grow memory.
    if (arr.length > 100) arr.splice(0, arr.length - 100);
    this.notes.set(sessionId, arr);
  }

  /** Queue a model-visible note for a session (also used by subscribers). */
  queueNote(sessionId: string, text: string): void {
    this.pushNote(sessionId, text);
  }

  pendingNotes(sessionId: string): string[] {
    return [...(this.notes.get(sessionId) ?? [])];
  }

  /** Drain (and clear) the pending notes for a session. */
  drainNotes(sessionId: string): string[] {
    const arr = this.notes.get(sessionId) ?? [];
    this.notes.delete(sessionId);
    return [...arr];
  }

  // -- Lifecycle --------------------------------------------------------------

  /** Reap every still-running process owned by a session. */
  disposeSession(sessionId: string): number {
    let killed = 0;
    for (const live of this.processes.values()) {
      if (live.record.sessionId === sessionId && live.record.status === 'running') {
        if (this.kill(live.record.id)) killed += 1;
      }
    }
    this.notes.delete(sessionId);
    return killed;
  }

  disposeAll(): void {
    for (const live of this.processes.values()) {
      if (live.record.status === 'running') this.kill(live.record.id);
    }
    this.notes.clear();
  }
}

/** Process-wide default registry (hosts may construct their own). */
export const defaultProcessRegistry = new ProcessRegistry();

/**
 * Runtime seam (CA-13 Monitor): move pending process notes for a
 * session into the runtime's SteerQueue. The host/runtime calls this at
 * the same turn boundary where steerQueue is drained (top of the loop
 * iteration in runtime.ts), so process exits and subscribed output
 * surface to the model as steering/system notes on the next turn
 * instead of being silently dropped. Returns how many notes moved.
 */
export function drainProcessNotesIntoSteer(
  registry: ProcessRegistry,
  steer: SteerEnqueuer,
  sessionId: string,
): number {
  const notes = registry.drainNotes(sessionId);
  for (const note of notes) steer.enqueue(sessionId, note);
  return notes.length;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ProcessToolsOptions {
  workspaceDir: WorkspaceSource;
  registry?: ProcessRegistry;
}

export function createProcessTools(opts: ProcessToolsOptions): ToolDefinition[] {
  const registry = opts.registry ?? defaultProcessRegistry;
  const wsOf = (ctx: ToolContext): string => resolveWorkspaceDir(opts.workspaceDir, ctx);

  return [
    {
      name: 'run_background',
      mutating: true,
      description:
        'Start a shell command as a tracked BACKGROUND process that keeps running across turns ' +
        '(dev servers, watchers, long builds). Returns a process id immediately. Execution is ' +
        'sandboxed through the same backend chain as run_command and the same catastrophic-command ' +
        'denylist applies. Read output incrementally with read_process_output; stop it with kill_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run (sh -c)' },
          cwd: { type: 'string', description: 'Workspace-relative working directory (default: workspace root)' },
          env: {
            type: 'object',
            description: 'Extra environment variables (string values) merged over the current environment',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const command = String(args.command ?? '');
        if (!command.trim()) throw new Error('run_background: "command" must not be empty');
        const ws = wsOf(ctx);
        const cwd =
          typeof args.cwd === 'string' && args.cwd ? confineRealpath(ws, args.cwd) : resolve(ws);
        const env: Record<string, string> | undefined =
          args.env && typeof args.env === 'object' && !Array.isArray(args.env)
            ? Object.fromEntries(
                Object.entries(args.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
              )
            : undefined;
        const record = registry.start({
          command,
          sessionId: ctx.sessionId,
          botId: ctx.botId,
          cwd,
          env,
        });
        return {
          processId: record.id,
          status: record.status,
          backend: record.backend,
          sandboxed: record.sandboxed,
          ...(record.warning ? { warning: record.warning } : {}),
          note: 'Process is running in the background. Poll read_process_output with sinceOffset for new output.',
        };
      },
    },
    {
      name: 'read_process_output',
      description:
        'Read a background process\'s output INCREMENTALLY: pass sinceOffset from the previous ' +
        'read\'s nextOffset (0 reads from the start of retained output). Returns the new chunk, ' +
        'the next offset, the process status and its exit code when finished.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Process id from run_background' },
          sinceOffset: { type: 'number', description: 'Absolute output offset to read from (default 0)' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        const rec = registry.get(id);
        if (!rec || rec.sessionId !== ctx.sessionId) {
          return { error: `no background process "${id}" in this session` };
        }
        const out = registry.readOutput(
          id,
          typeof args.sinceOffset === 'number' ? args.sinceOffset : 0,
        );
        return out ?? { error: `no background process "${id}" in this session` };
      },
    },
    {
      name: 'list_processes',
      description: 'List background processes started in this session, with status, backend and exit codes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ({
        processes: registry.list({ sessionId: ctx.sessionId }).map((r) => ({
          processId: r.id,
          command: r.command.slice(0, 200),
          status: r.status,
          exitCode: r.exitCode,
          backend: r.backend,
          sandboxed: r.sandboxed,
          startedAt: r.startedAt,
          ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
        })),
      }),
    },
    {
      name: 'kill_process',
      mutating: true,
      description: 'Stop a running background process by id (SIGTERM, then SIGKILL after a grace period).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Process id from run_background' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        const rec = registry.get(id);
        if (!rec || rec.sessionId !== ctx.sessionId) {
          return { killed: false, reason: `no background process "${id}" in this session` };
        }
        return registry.kill(id)
          ? { killed: true, processId: id }
          : { killed: false, reason: `process "${id}" is not running (status: ${rec.status})` };
      },
    },
    {
      name: 'poll_process_notes',
      description:
        'Poll pending process notes for this session (process exits and other Monitor events queued ' +
        'since the last poll). Returns and clears them; the runtime also drains these into the ' +
        'session automatically at turn boundaries when the host wires drainProcessNotesIntoSteer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ({ notes: registry.drainNotes(ctx.sessionId) }),
    },
  ];
}
