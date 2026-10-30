// SPDX-License-Identifier: Apache-2.0
// Idea run binding (I-3): an idea card runs in chat with live progress.
// The card's state is BOUND to the run: starting a run flips the idea to
// 'active' and binds the run id on the idea row; progress events append
// to mm_idea_run_events; completing/failing the run moves the idea to
// 'done' (or back to 'new' on failure) and unbinds. Subscribers receive
// every event as it lands — the API layer streams them to the card over
// SSE, and `state()` gives the card its poll/snapshot view.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';
import { IdeaStore, type Idea } from './index.js';

export type IdeaRunEventKind = 'started' | 'progress' | 'completed' | 'failed';

export interface IdeaRunEvent {
  id: string;
  ideaId: string;
  runId: string;
  kind: IdeaRunEventKind;
  /** 0..100 for progress/completed events. */
  pct?: number;
  note: string;
  createdAt: number;
}

export type IdeaRunStatus = 'running' | 'completed' | 'failed';

export interface IdeaRunState {
  idea: Idea;
  run: {
    runId: string;
    status: IdeaRunStatus;
    pct: number;
    lastNote: string;
    startedAt: number;
    updatedAt: number;
    events: IdeaRunEvent[];
  } | null;
}

interface RunEventRow {
  id: string;
  idea_id: string;
  run_id: string;
  kind: string;
  pct: number | null;
  note: string;
  created_at: number;
}

function rowToEvent(row: RunEventRow): IdeaRunEvent {
  return {
    id: row.id,
    ideaId: row.idea_id,
    runId: row.run_id,
    kind: row.kind as IdeaRunEventKind,
    pct: row.pct ?? undefined,
    note: row.note,
    createdAt: row.created_at,
  };
}

export type IdeaRunListener = (event: IdeaRunEvent) => void;

export class IdeaRunTracker {
  private readonly ideas: IdeaStore;
  private readonly listeners = new Set<IdeaRunListener>();

  constructor(private readonly mdb: ModuleDb) {
    this.ideas = new IdeaStore(mdb);
  }

  /** Subscribe to every run event (live progress for cards). Returns unsubscribe. */
  subscribe(listener: IdeaRunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private append(ideaId: string, runId: string, kind: IdeaRunEventKind, pct: number | undefined, note: string): IdeaRunEvent {
    const event: IdeaRunEvent = {
      id: randomUUID(),
      ideaId,
      runId,
      kind,
      pct,
      note: note.slice(0, 500),
      createdAt: Date.now(),
    };
    this.mdb.db
      .prepare('INSERT INTO mm_idea_run_events (id, idea_id, run_id, kind, pct, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.id, ideaId, runId, kind, pct ?? null, event.note, event.createdAt);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken card subscriber must never break the run.
      }
    }
    return event;
  }

  private eventsFor(runId: string): IdeaRunEvent[] {
    const rows = this.mdb.db
      .prepare('SELECT id, idea_id, run_id, kind, pct, note, created_at FROM mm_idea_run_events WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(runId) as unknown as RunEventRow[];
    return rows.map(rowToEvent);
  }

  private ideaForRun(runId: string): Idea {
    const row = this.mdb.db
      .prepare('SELECT idea_id FROM mm_idea_run_events WHERE run_id = ? LIMIT 1')
      .get(runId) as { idea_id: string } | undefined;
    if (!row) throw new NotFoundError(`unknown run: ${runId}`);
    return this.ideas.get(row.idea_id);
  }

  /**
   * Start a run for an idea: idea → active, run bound to the card.
   * Returns the run id the chat executor reports progress against.
   */
  start(ideaId: string, note = 'run started'): { runId: string; idea: Idea } {
    const idea = this.ideas.get(ideaId);
    if (idea.runId) throw new ValidationError(`idea already has a bound run: ${idea.runId}`);
    const active = idea.status === 'active' ? idea : this.ideas.run(ideaId);
    const runId = `run_${randomUUID()}`;
    this.ideas.bindRun(ideaId, runId);
    this.append(ideaId, runId, 'started', 0, note);
    return { runId, idea: this.ideas.get(active.id) };
  }

  /** Report progress (0..100) for a running run. */
  progress(runId: string, pct: number, note = ''): IdeaRunEvent {
    const idea = this.ideaForRun(runId);
    if (idea.runId !== runId) throw new ValidationError(`run ${runId} is not the bound run for idea ${idea.id}`);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      throw new ValidationError('progress "pct" must be an integer 0–100');
    }
    return this.append(idea.id, runId, 'progress', pct, note);
  }

  /** Finish a run successfully: idea → done, run unbound. */
  complete(runId: string, note = 'run completed'): IdeaRunEvent {
    const idea = this.ideaForRun(runId);
    if (idea.runId !== runId) throw new ValidationError(`run ${runId} is not the bound run for idea ${idea.id}`);
    const event = this.append(idea.id, runId, 'completed', 100, note);
    this.ideas.complete(idea.id);
    this.ideas.clearRun(idea.id);
    return event;
  }

  /** Fail a run: idea returns to 'new' (retryable), run unbound, reason kept. */
  fail(runId: string, note = 'run failed'): IdeaRunEvent {
    const idea = this.ideaForRun(runId);
    if (idea.runId !== runId) throw new ValidationError(`run ${runId} is not the bound run for idea ${idea.id}`);
    const event = this.append(idea.id, runId, 'failed', undefined, note);
    this.mdb.db
      .prepare("UPDATE mm_ideas SET status = 'new', retire_reason = NULL, run_id = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), idea.id);
    return event;
  }

  /** Card state for one idea: the idea plus its latest run (bound or most recent). */
  state(ideaId: string): IdeaRunState {
    const idea = this.ideas.get(ideaId);
    let runId = idea.runId;
    if (!runId) {
      const row = this.mdb.db
        .prepare('SELECT run_id FROM mm_idea_run_events WHERE idea_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(ideaId) as { run_id: string } | undefined;
      runId = row?.run_id ?? null;
    }
    if (!runId) return { idea, run: null };
    const events = this.eventsFor(runId);
    if (events.length === 0) return { idea, run: null };
    const last = events[events.length - 1]!;
    const status: IdeaRunStatus = last.kind === 'completed' ? 'completed' : last.kind === 'failed' ? 'failed' : 'running';
    const pct = [...events].reverse().find((e) => e.pct !== undefined)?.pct ?? 0;
    return {
      idea,
      run: {
        runId,
        status,
        pct,
        lastNote: last.note,
        startedAt: events[0]!.createdAt,
        updatedAt: last.createdAt,
        events,
      },
    };
  }
}
