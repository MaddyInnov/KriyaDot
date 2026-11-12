// SPDX-License-Identifier: Apache-2.0
// Parked-ideas notebook (Timon parity B6) — ideas the user is NOT working
// on yet, kept where automation structurally cannot pick them up.
//
// WHY THIS IS A SEPARATE STORE, NOT A STATUS ON TASKS (the B6 invariant):
// Workspace Tasks (tasks.ts) and parked ideas used to differ only by
// intent. Any query, dispatcher or routine that enumerates "work to do"
// reads the tasks store — so an idea kept AS a task (or as a task status)
// is one sloppy filter away from being executed by accident. This module
// therefore keeps ideas in their OWN store (own file, own routes, own
// types):
//
//   - No code path in this module is imported by, or shares a query with,
//     the tasks store, the routines engine, the thread scheduler, or the
//     tracked-items read model. Enumeration of work NEVER sees ideas.
//   - The ONLY bridge from ideas to work is `actionParkedIdea()` below,
//     invoked exclusively by the explicit user action "Action this idea"
//     (POST /parked-ideas/:id/action). It creates a normal task and links
//     it back (`task.ideaId`, `idea.taskId`). Nothing else in this module
//     can create a task; the chat capture tool (parked-idea-tools.ts) is
//     write-only into this store by construction.
//   - A5 READINESS: A5's dispatcher will consume Tasks ONLY (TaskStore /
//     makeTaskCreator / listTrackedItems' injected task leg). B6's
//     separation is the safety property A5 relies on: because ideas never
//     enter the tasks store until a human actions them, the dispatcher
//     needs no "skip parked" filter and cannot develop one by omission.
//     The structural test in test/parked-ideas.test.ts runs the real task
//     enumerations and asserts ideas are absent — if a future change
//     merges the stores, that test fails before A5 can be hurt by it.
//
// OUTCOME LOOP: when a task created from an idea completes, the tasks
// routes' `onTaskCompleted` hook calls `noteTaskCompleted()`, which
// stamps an (initially empty, pending) outcome onto the idea so the UI
// can ask "how did it turn out?". The user fills the outcome text via
// POST /parked-ideas/:id/outcome; the ideas list then shows which past
// ideas paid off and which did not.
//
// Routes (mounted beside registerTasksRoutes, same router + principal
// conventions — the tasks router carries no per-route auth of its own):
//   GET    /parked-ideas                 list (parked first, newest first)
//   POST   /parked-ideas                 create { title, body?, source? }
//   GET    /parked-ideas/:id
//   PUT    /parked-ideas/:id             { title?, body?, state? } — state
//                                        may move parked<->archived only;
//                                        'actioned' is set ONLY by action.
//   DELETE /parked-ideas/:id
//   POST   /parked-ideas/:id/action      explicit user action → task
//   POST   /parked-ideas/:id/outcome     { text } — record the outcome
//
// The path is /parked-ideas, NOT /ideas: /api/ideas already belongs to
// the muse-modules dream-curation IdeaStore (ideas-ext-routes.ts), a
// different concept (machine-curated candidates). Sharing the path would
// shadow routes and blur exactly the boundary this module exists to keep.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { TaskStore, type Task } from './tasks.js';

/** Where an idea came from: typed in the UI, or captured from chat. */
export type ParkedIdeaSource = 'manual' | 'chat';

/**
 * Lifecycle: 'parked' (in the notebook, inert) → 'actioned' (a human
 * turned it into a task) or → 'archived' (dropped, kept for the record).
 */
export type ParkedIdeaState = 'parked' | 'actioned' | 'archived';

export interface ParkedIdeaOutcome {
  /** What actually happened. Empty while `outcomePending` on the idea. */
  text: string;
  /** When the linked task completed (ms epoch). */
  completedAt: number;
  /** The task whose completion produced this outcome. */
  taskId: string;
}

export interface ParkedIdea {
  id: string;
  title: string;
  body: string;
  source: ParkedIdeaSource;
  state: ParkedIdeaState;
  createdAt: number;
  updatedAt: number;
  /** Set exactly once, by the explicit "Action this idea" action. */
  taskId?: string;
  actionedAt?: number;
  /** Set when the linked task completes (or an outcome is recorded). */
  outcome?: ParkedIdeaOutcome;
  /** True when the linked task finished but no outcome text exists yet. */
  outcomePending?: boolean;
}

export interface ParkedIdeaInput {
  title: string;
  body?: string;
  source?: ParkedIdeaSource;
}

export interface ParkedIdeasDeps {
  dataDir: string;
  ideaStore?: ParkedIdeaStore;
  taskStore?: TaskStore;
}

/** JSON-file persistence for parked ideas: `<dataDir>/parked-ideas.json`. */
export class ParkedIdeaStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'parked-ideas.json');
  }

  path(): string {
    return this.file;
  }

  private readRows(): unknown[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private writeRows(rows: unknown[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2), 'utf8');
  }

  /** Parked first, then actioned, then archived; newest first within each. */
  list(): ParkedIdea[] {
    const rank: Record<ParkedIdeaState, number> = { parked: 0, actioned: 1, archived: 2 };
    return this.readRows()
      .filter(isParkedIdea)
      .sort((a, b) => rank[a.state] - rank[b.state] || b.createdAt - a.createdAt);
  }

  get(id: string): ParkedIdea | undefined {
    return this.readRows().filter(isParkedIdea).find((i) => i.id === id);
  }

  /** The idea a task was created from, if any (outcome write-back lookup). */
  getByTaskId(taskId: string): ParkedIdea | undefined {
    return this.readRows().filter(isParkedIdea).find((i) => i.taskId === taskId);
  }

  create(input: ParkedIdeaInput): ParkedIdea {
    const now = Date.now();
    const idea: ParkedIdea = {
      id: randomUUID(),
      title: requireIdeaTitle(input.title),
      body: optBody(input.body),
      source: input.source === 'chat' ? 'chat' : 'manual',
      state: 'parked',
      createdAt: now,
      updatedAt: now,
    };
    const rows = this.readRows();
    rows.push(idea);
    this.writeRows(rows);
    return idea;
  }

  update(
    id: string,
    input: Partial<Pick<ParkedIdeaInput, 'title' | 'body'>> & { state?: ParkedIdeaState },
  ): ParkedIdea {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isParkedIdea(r) && r.id === id);
    if (idx === -1) throw storeNotFound(id);
    const current = rows[idx] as ParkedIdea;
    if (input.state !== undefined) assertManualStateTransition(current.state, input.state);
    const next: ParkedIdea = {
      ...current,
      title: input.title === undefined ? current.title : requireIdeaTitle(input.title),
      body: input.body === undefined ? current.body : optBody(input.body),
      state: input.state === undefined ? current.state : input.state,
      // Monotonic, same convention as the tasks store.
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }

  remove(id: string): void {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isParkedIdea(r) && r.id === id);
    if (idx === -1) throw storeNotFound(id);
    rows.splice(idx, 1);
    this.writeRows(rows);
  }

  /**
   * Link a freshly created task to this idea and mark it actioned.
   * Guarded: an idea that already has a task refuses a second one, so
   * "Action this idea" can never create the task twice.
   */
  markActioned(id: string, taskId: string): ParkedIdea {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isParkedIdea(r) && r.id === id);
    if (idx === -1) throw storeNotFound(id);
    const current = rows[idx] as ParkedIdea;
    if (current.taskId) throw alreadyActioned(id, current.taskId);
    if (current.state === 'archived') {
      throw validationError('idea is archived; unarchive it before actioning');
    }
    const next: ParkedIdea = {
      ...current,
      state: 'actioned',
      taskId,
      actionedAt: Date.now(),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }

  /**
   * Outcome write-back: the linked task completed. Stamps the outcome
   * slot (pre-filled from the task's result summary when the caller has
   * one) and flags it pending while no text exists, so the UI surfaces
   * the "how did it turn out?" prompt. Idempotent: a second completion
   * notice never overwrites an outcome the user already wrote.
   */
  noteTaskCompleted(taskId: string, resultSummary?: string): ParkedIdea | undefined {
    const idea = this.getByTaskId(taskId);
    if (!idea || idea.state !== 'actioned' || idea.outcome) return idea;
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isParkedIdea(r) && r.id === idea.id);
    if (idx === -1) return undefined;
    const text = typeof resultSummary === 'string' ? resultSummary.trim() : '';
    const next: ParkedIdea = {
      ...idea,
      outcome: { text, completedAt: Date.now(), taskId },
      outcomePending: text.length === 0,
      updatedAt: Math.max(Date.now(), idea.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }

  /** Record (or amend) the outcome text for an actioned idea. */
  recordOutcome(id: string, text: string): ParkedIdea {
    if (typeof text !== 'string' || !text.trim()) {
      throw validationError('outcome "text" must be a non-empty string');
    }
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isParkedIdea(r) && r.id === id);
    if (idx === -1) throw storeNotFound(id);
    const current = rows[idx] as ParkedIdea;
    if (!current.taskId) {
      throw validationError('only an actioned idea (one with a task) can record an outcome');
    }
    const next: ParkedIdea = {
      ...current,
      outcome: {
        text: text.trim().slice(0, 2000),
        completedAt: current.outcome?.completedAt ?? Date.now(),
        taskId: current.taskId,
      },
      outcomePending: false,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }
}

/**
 * THE bridge from ideas to work — and the only one. Called exclusively
 * from the explicit user action (POST /parked-ideas/:id/action). Creates
 * a normal task in the tasks store, linked back to the idea, and marks
 * the idea actioned. Double-action is guarded in markActioned AND here:
 * an idea that already has a task returns that link state as a conflict
 * instead of creating a second task.
 */
export function actionParkedIdea(
  ideas: ParkedIdeaStore,
  tasks: TaskStore,
  id: string,
): { idea: ParkedIdea; task: Task } {
  const idea = ideas.get(id);
  if (!idea) throw storeNotFound(id);
  if (idea.taskId) throw alreadyActioned(id, idea.taskId);
  if (idea.state === 'archived') {
    throw validationError('idea is archived; unarchive it before actioning');
  }
  const task = tasks.create({
    title: idea.title,
    notes: idea.body || undefined,
    ideaId: idea.id,
  });
  try {
    const updated = ideas.markActioned(id, task.id);
    return { idea: updated, task };
  } catch (err) {
    // The idea was actioned concurrently between get() and markActioned:
    // remove the orphan task so exactly one task ever exists per idea.
    try {
      tasks.remove(task.id);
    } catch {
      /* best effort — the guard error is what the caller needs */
    }
    throw err;
  }
}

export function registerParkedIdeasRoutes(router: Router, deps: ParkedIdeasDeps): void {
  const ideas = deps.ideaStore ?? new ParkedIdeaStore(deps.dataDir);
  const tasks = deps.taskStore ?? new TaskStore(deps.dataDir);

  router.get('/parked-ideas', (_req: Request, res: Response) => {
    try {
      res.json(ideas.list());
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list parked ideas') });
    }
  });

  router.post('/parked-ideas', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json(
        ideas.create({
          title: b.title as string,
          body: b.body as string | undefined,
          source: b.source === 'chat' ? 'chat' : 'manual',
        }),
      );
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to create parked idea') });
    }
  });

  router.get('/parked-ideas/:id', (req: Request, res: Response) => {
    const idea = ideas.get(req.params.id);
    if (!idea) {
      res.status(404).json({ error: `unknown parked idea: ${req.params.id}` });
      return;
    }
    res.json(idea);
  });

  router.put('/parked-ideas/:id', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const input: Partial<Pick<ParkedIdeaInput, 'title' | 'body'>> & { state?: ParkedIdeaState } = {};
      if ('title' in b) input.title = b.title as string;
      if ('body' in b) input.body = b.body as string | undefined;
      if ('state' in b) input.state = b.state as ParkedIdeaState;
      res.json(ideas.update(req.params.id, input));
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to update parked idea') });
    }
  });

  router.delete('/parked-ideas/:id', (req: Request, res: Response) => {
    try {
      ideas.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to delete parked idea') });
    }
  });

  // The explicit user action. This is the ONLY route in the module that
  // touches the tasks store, and it only ever CREATES one linked task.
  router.post('/parked-ideas/:id/action', (req: Request, res: Response) => {
    try {
      const { idea, task } = actionParkedIdea(ideas, tasks, req.params.id);
      res.status(201).json({ idea, task });
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to action parked idea') });
    }
  });

  router.post('/parked-ideas/:id/outcome', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(ideas.recordOutcome(req.params.id, b.text as string));
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to record outcome') });
    }
  });
}

// ---------------------------------------------------------------------------
// Validation helpers (tasks.ts conventions, local copies — the stores
// share conventions, never code paths; see the header for why)
// ---------------------------------------------------------------------------

/** Manual state edits may only park/archive; 'actioned' is action-only. */
function assertManualStateTransition(from: ParkedIdeaState, to: ParkedIdeaState): void {
  if (to !== 'parked' && to !== 'archived') {
    throw validationError(
      `state cannot be set to "${String(to)}" directly — use the "Action this idea" action`,
    );
  }
  if (from === 'actioned' && to === 'parked') {
    throw validationError('an actioned idea cannot go back to parked; archive it instead');
  }
}

function isParkedIdea(v: unknown): v is ParkedIdea {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.body === 'string' &&
    (o.source === 'manual' || o.source === 'chat') &&
    (o.state === 'parked' || o.state === 'actioned' || o.state === 'archived') &&
    typeof o.createdAt === 'number'
  );
}

function requireIdeaTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
    throw validationError('idea "title" must be a non-empty string (max 200 chars)');
  }
  return title.trim();
}

function optBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw validationError('"body" must be a string');
  return body.trim().slice(0, 4000);
}

const NOT_FOUND_MARK = '__parked_ideas_not_found__';
const VALIDATION_MARK = '__parked_ideas_validation__';
const CONFLICT_MARK = '__parked_ideas_conflict__';

function storeNotFound(id: string): Error {
  const err = new Error(`unknown parked idea: ${id}`);
  (err as Error & { code?: string }).code = NOT_FOUND_MARK;
  return err;
}

function validationError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VALIDATION_MARK;
  return err;
}

function alreadyActioned(id: string, taskId: string): Error {
  const err = new Error(`parked idea ${id} was already actioned as task ${taskId}`);
  (err as Error & { code?: string }).code = CONFLICT_MARK;
  return err;
}

function statusFor(err: unknown): number {
  if (!(err instanceof Error)) return 500;
  const code = (err as Error & { code?: string }).code;
  if (code === NOT_FOUND_MARK) return 404;
  if (code === VALIDATION_MARK) return 400;
  if (code === CONFLICT_MARK) return 409;
  return 500;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
