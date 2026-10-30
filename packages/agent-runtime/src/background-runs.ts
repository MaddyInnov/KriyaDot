// SPDX-License-Identifier: Apache-2.0
/**
 * Background specialist runs (Octomind parity).
 *
 * A turn can hand a self-contained task to a specialist bot — an
 * existing roster bot or an EPHEMERAL bot defined inline for this one
 * job — and keep working. The specialist runs in the background on its
 * own session; when it finishes, its result is injected into the
 * originating session at the start of the next turn ("result
 * injection"), so the originating bot continues with the findings in
 * context. Runs are listable and stoppable; stopping aborts the run's
 * turn via its AbortController.
 *
 * Persistence (closure #44): pass a `store` (e.g.
 * FileBackgroundRunStore) and records — including completed-but-not-
 * yet-injected results — survive a restart and still deliver. Without
 * a store the registry stays in-memory as before.
 *
 * Resume (closure #14): `prepareResume` re-dispatches a stopped/failed
 * run with the same spec plus a prior-context summary.
 *
 * Concurrency (closure #17): `SpawnConcurrencyGate` caps concurrent
 * ACP + background spawns; the runtime acquires a slot before dispatch.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type BackgroundRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface BackgroundRunRecord {
  id: string;
  /** The bot doing the work (roster bot id, or the ephemeral bot's id). */
  botId: string;
  botName: string;
  ephemeral: boolean;
  originBotId: string;
  originSessionId: string;
  task: string;
  status: BackgroundRunStatus;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** When the result was injected into the origin session (once only). */
  injectedAt?: number;
  /** Closure #14: set on a resumed run — the run it resumes + prior context. */
  resumedFromId?: string;
  priorContext?: string;
  /** Epoch ms when a queued run (cap, #17) actually started dispatching. */
  dispatchedAt?: number;
  /** CA-5: specialist profile / agent-definition id this run was spawned from. */
  profileId?: string;
  /** CA-5: auto-created isolation worktree attached to this run (branch kept on cleanup). */
  worktreePath?: string;
  worktreeBranch?: string | null;
}

/** Pluggable persistence for the registry (closure #44). */
export interface BackgroundRunStore {
  load(): BackgroundRunRecord[];
  save(records: BackgroundRunRecord[]): void;
}

/** In-memory store (tests / explicit opt-out of persistence). */
export class MemoryBackgroundRunStore implements BackgroundRunStore {
  private data: BackgroundRunRecord[] = [];
  load(): BackgroundRunRecord[] { return this.data.map((r) => ({ ...r })); }
  save(records: BackgroundRunRecord[]): void { this.data = records.map((r) => ({ ...r })); }
}

/** JSON-file store using the same plain-file pattern as other host stores. */
export class FileBackgroundRunStore implements BackgroundRunStore {
  constructor(private readonly path: string) {}
  load(): BackgroundRunRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as BackgroundRunRecord[]) : [];
    } catch { return []; }
  }
  save(records: BackgroundRunRecord[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(records));
    } catch { /* persistence must never break a run */ }
  }
}

export class BackgroundRunRegistry {
  private readonly runs = new Map<string, BackgroundRunRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly store?: BackgroundRunStore;

  constructor(opts: { store?: BackgroundRunStore } = {}) {
    this.store = opts.store;
    if (this.store) {
      for (const rec of this.store.load()) {
        // A run that was 'running' at shutdown can never finish; mark it
        // failed so its (missing) result is honest, while completed-
        // undelivered results stay injectable (#44).
        if (rec.status === 'running' || rec.status === 'queued') {
          rec.status = 'failed';
          rec.error = rec.error ?? 'interrupted by a server restart before it finished';
          rec.finishedAt = rec.finishedAt ?? Date.now();
        }
        this.runs.set(rec.id, rec);
      }
    }
  }

  private persist(): void {
    this.store?.save([...this.runs.values()]);
  }

  start(input: {
    botId: string;
    botName: string;
    ephemeral: boolean;
    originBotId: string;
    originSessionId: string;
    task: string;
    profileId?: string;
    worktreePath?: string;
    worktreeBranch?: string | null;
  }): { record: BackgroundRunRecord; signal: AbortSignal } {
    const id = `bgr-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const record: BackgroundRunRecord = {
      id,
      botId: input.botId,
      botName: input.botName,
      ephemeral: input.ephemeral,
      originBotId: input.originBotId,
      originSessionId: input.originSessionId,
      task: input.task,
      status: 'running',
      startedAt: Date.now(),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
      ...(input.worktreeBranch !== undefined ? { worktreeBranch: input.worktreeBranch } : {}),
    };
    this.runs.set(id, record);
    this.controllers.set(id, controller);
    this.persist();
    return { record, signal: controller.signal };
  }

  complete(id: string, result: string): void {
    const record = this.runs.get(id);
    if (!record || record.status !== 'running') return;
    record.status = 'done';
    record.result = result;
    record.finishedAt = Date.now();
    this.controllers.delete(id);
    this.persist();
  }

  fail(id: string, error: string): void {
    const record = this.runs.get(id);
    if (!record || record.status !== 'running') return;
    record.status = 'failed';
    record.error = error;
    record.finishedAt = Date.now();
    this.controllers.delete(id);
    this.persist();
  }

  /** Stop a running run (aborts its turn). Returns false if not running. */
  stop(id: string): boolean {
    const record = this.runs.get(id);
    if (!record || record.status !== 'running') return false;
    record.status = 'stopped';
    record.finishedAt = Date.now();
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.persist();
    return true;
  }

  get(id: string): BackgroundRunRecord | undefined {
    return this.runs.get(id);
  }

  list(filter: { originSessionId?: string; originBotId?: string; status?: BackgroundRunStatus } = {}): BackgroundRunRecord[] {
    return [...this.runs.values()]
      .filter(
        (r) =>
          (filter.originSessionId === undefined || r.originSessionId === filter.originSessionId) &&
          (filter.originBotId === undefined || r.originBotId === filter.originBotId) &&
          (filter.status === undefined || r.status === filter.status),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Finished runs for an origin session whose results have not been
   * injected yet. Marks them injected — injection happens exactly once.
   */
  drainInjectable(originSessionId: string): BackgroundRunRecord[] {
    const ready = [...this.runs.values()].filter(
      (r) =>
        r.originSessionId === originSessionId &&
        r.injectedAt === undefined &&
        (r.status === 'done' || r.status === 'failed' || r.status === 'stopped'),
    );
    for (const r of ready) r.injectedAt = Date.now();
    if (ready.length > 0) this.persist();
    return ready.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }

  /** Finished, undelivered runs WITHOUT marking them injected (live-turn peek, #14). */
  peekInjectable(originSessionId: string): BackgroundRunRecord[] {
    return [...this.runs.values()].filter(
      (r) =>
        r.originSessionId === originSessionId &&
        r.injectedAt === undefined &&
        (r.status === 'done' || r.status === 'failed' || r.status === 'stopped'),
    );
  }

  /**
   * Resume (#14): prepare a NEW run for a stopped/failed run, carrying
   * the same spec plus a prior-context summary (previous result excerpt
   * or the failure). Returns undefined when the run is not resumable.
   */
  prepareResume(id: string): { record: BackgroundRunRecord; signal: AbortSignal } | undefined {
    const prev = this.runs.get(id);
    if (!prev || (prev.status !== 'stopped' && prev.status !== 'failed')) return undefined;
    const priorContext =
      prev.status === 'failed'
        ? `A previous attempt at this task FAILED: ${prev.error ?? 'unknown error'}. Do not repeat the failing approach.`
        : `A previous attempt at this task was stopped before finishing.${prev.result ? ` Partial result: ${prev.result.slice(0, 1000)}` : ''} Continue from there.`;
    const { record, signal } = this.start({
      botId: prev.botId,
      botName: prev.botName,
      ephemeral: prev.ephemeral,
      originBotId: prev.originBotId,
      originSessionId: prev.originSessionId,
      task: prev.task,
      ...(prev.profileId ? { profileId: prev.profileId } : {}),
      ...(prev.worktreePath ? { worktreePath: prev.worktreePath } : {}),
      ...(prev.worktreeBranch !== undefined ? { worktreeBranch: prev.worktreeBranch } : {}),
    });
    record.resumedFromId = prev.id;
    record.priorContext = priorContext;
    this.persist();
    return { record, signal };
  }
}

/**
 * Concurrency gate for ACP + background spawns (#17): at most `cap`
 * holders run at once; further acquirers queue FIFO until a release.
 */
export class SpawnConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly cap = 4) {}
  get activeCount(): number { return this.active; }
  get waitingCount(): number { return this.waiters.length; }
  get limit(): number { return this.cap; }
  async acquire(): Promise<() => void> {
    if (this.active >= this.cap) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
  /** Sync try-acquire: returns a release fn or null when at cap. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.cap) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/** Render a finished run as the user-role injection message. */
export function renderRunInjection(record: BackgroundRunRecord): string {
  const head =
    record.status === 'done'
      ? `[Background run ${record.id} — ${record.botName} finished]`
      : record.status === 'failed'
        ? `[Background run ${record.id} — ${record.botName} FAILED: ${record.error ?? 'unknown error'}]`
        : `[Background run ${record.id} — ${record.botName} was stopped]`;
  const taskLine = `Task: ${record.task.slice(0, 300)}`;
  const body = record.status === 'done' ? `\n\nResult:\n${(record.result ?? '').slice(0, 6000)}` : '';
  return `${head}\n${taskLine}${body}`;
}
