// SPDX-License-Identifier: Apache-2.0
// User tasks + calendar events. Same JSON-file store style as notes.ts /
// BotMemoryStore: sync persistence under the data dir, no secrets held.
//
// Mount at boot, e.g.:
//   import { registerTasksRoutes } from './tasks.js';
//   const tasksRouter = express.Router();
//   registerTasksRoutes(tasksRouter, { dataDir: config.dataDir });
//   app.use('/api', tasksRouter);
//
// Routes:
//   Tasks — GET/POST /api/tasks, GET/PUT/DELETE /api/tasks/:id
//   (PUT accepts { title?, notes?, dueAt?, done? }; dueAt = ISO string or null)
//   Events — GET/POST /api/events, GET/PUT/DELETE /api/events/:id
//
// Also exports makeTaskCreator(deps): (input) => Task — the hook the
// coordinator wires into the workflow scheduler (e.g. Scheduler.onFire in
// @mvp/workflows triggers) so scheduled/cron workflows can create tasks.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

export interface Task {
  id: string;
  title: string;
  notes?: string;
  /** ISO-8601 timestamp or null. */
  dueAt: string | null;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * B6: set only when this task was created by the explicit "Action this
   * idea" action on a parked idea (parked-ideas.ts). The link lives on
   * the TASK side so the ideas store stays structurally separate — task
   * enumeration never needs to know ideas exist.
   */
  ideaId?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO-8601 timestamps. */
  startsAt: string;
  endsAt: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskInput {
  title: string;
  notes?: string;
  /** ISO-8601 string; null clears the due date. */
  dueAt?: string | null;
  /** B6: originating parked-idea id, set by the action bridge only. */
  ideaId?: string;
}

export interface EventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
}

export interface TasksDeps {
  dataDir: string;
  taskStore?: TaskStore;
  eventStore?: CalendarEventStore;
  /**
   * B6 outcome loop: called when a task transitions open → done through
   * the routes, so the host can write the completion back to a linked
   * parked idea. Optional; failures are swallowed by the route.
   */
  onTaskCompleted?: (task: Task) => void;
}

abstract class JsonFileStore {
  private readonly file: string;

  constructor(dataDir: string, fileName: string) {
    this.file = join(dataDir, fileName);
  }

  path(): string {
    return this.file;
  }

  protected readRows(): unknown[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  protected writeRows(rows: unknown[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2), 'utf8');
  }
}

/** JSON-file persistence for tasks: `<dataDir>/tasks.json`. */
export class TaskStore extends JsonFileStore {
  constructor(dataDir: string) {
    super(dataDir, 'tasks.json');
  }

  list(): Task[] {
    return this.readRows()
      .filter(isTask)
      .sort((a, b) => byDoneThenDue(a, b));
  }

  get(id: string): Task | undefined {
    return this.readRows().filter(isTask).find((t) => t.id === id);
  }

  create(input: TaskInput): Task {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      title: requireTitle(input.title),
      notes: optNotes(input.notes),
      dueAt: normalizeDueAt(input.dueAt),
      done: false,
      createdAt: now,
      updatedAt: now,
      ...(typeof input.ideaId === 'string' && input.ideaId ? { ideaId: input.ideaId } : {}),
    };
    const rows = this.readRows();
    rows.push(task);
    this.writeRows(rows);
    return task;
  }

  update(id: string, input: Partial<TaskInput> & { done?: boolean }): Task {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isTask(r) && r.id === id);
    if (idx === -1) throw storeNotFound('task', id);
    const current = rows[idx] as Task;
    const next: Task = {
      ...current,
      title: input.title === undefined ? current.title : requireTitle(input.title),
      notes: input.notes === undefined ? current.notes : optNotes(input.notes),
      dueAt: input.dueAt === undefined ? current.dueAt : normalizeDueAt(input.dueAt),
      done: input.done === undefined ? current.done : requireBool(input.done, 'done'),
      // Monotonic: an update must always sort after the previous state, even
      // when two ops land in the same millisecond.
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }

  remove(id: string): void {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isTask(r) && r.id === id);
    if (idx === -1) throw storeNotFound('task', id);
    rows.splice(idx, 1);
    this.writeRows(rows);
  }
}

/** JSON-file persistence for calendar events: `<dataDir>/events.json`. */
export class CalendarEventStore extends JsonFileStore {
  constructor(dataDir: string) {
    super(dataDir, 'events.json');
  }

  list(): CalendarEvent[] {
    return this.readRows()
      .filter(isCalendarEvent)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  }

  get(id: string): CalendarEvent | undefined {
    return this.readRows().filter(isCalendarEvent).find((e) => e.id === id);
  }

  create(input: EventInput): CalendarEvent {
    const now = Date.now();
    const event: CalendarEvent = {
      id: randomUUID(),
      title: requireTitle(input.title),
      startsAt: requireTimestamp(input.startsAt, 'startsAt'),
      endsAt: requireTimestamp(input.endsAt, 'endsAt'),
      notes: optNotes(input.notes),
      createdAt: now,
      updatedAt: now,
    };
    assertRange(event.startsAt, event.endsAt);
    const rows = this.readRows();
    rows.push(event);
    this.writeRows(rows);
    return event;
  }

  update(id: string, input: Partial<EventInput>): CalendarEvent {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isCalendarEvent(r) && r.id === id);
    if (idx === -1) throw storeNotFound('event', id);
    const current = rows[idx] as CalendarEvent;
    const next: CalendarEvent = {
      ...current,
      title: input.title === undefined ? current.title : requireTitle(input.title),
      startsAt: input.startsAt === undefined ? current.startsAt : requireTimestamp(input.startsAt, 'startsAt'),
      endsAt: input.endsAt === undefined ? current.endsAt : requireTimestamp(input.endsAt, 'endsAt'),
      notes: input.notes === undefined ? current.notes : optNotes(input.notes),
      // Monotonic timestamps (see task update above).
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    assertRange(next.startsAt, next.endsAt);
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }

  remove(id: string): void {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isCalendarEvent(r) && r.id === id);
    if (idx === -1) throw storeNotFound('event', id);
    rows.splice(idx, 1);
    this.writeRows(rows);
  }
}

export function registerTasksRoutes(router: Router, deps: TasksDeps): void {
  const tasks = deps.taskStore ?? new TaskStore(deps.dataDir);
  const events = deps.eventStore ?? new CalendarEventStore(deps.dataDir);

  // ---- Tasks ---------------------------------------------------------------
  router.get('/tasks', (_req: Request, res: Response) => {
    try {
      res.json(tasks.list());
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list tasks') });
    }
  });

  router.post('/tasks', (req: Request, res: Response) => {
    try {
      res.status(201).json(tasks.create(taskInputFrom(req.body)));
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to create task') });
    }
  });

  router.get('/tasks/:id', (req: Request, res: Response) => {
    const task = tasks.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: `unknown task: ${req.params.id}` });
      return;
    }
    res.json(task);
  });

  router.put('/tasks/:id', (req: Request, res: Response) => {
    try {
      const before = tasks.get(req.params.id);
      const updated = tasks.update(req.params.id, taskUpdateFrom(req.body));
      // B6: open → done transition notifies the host (outcome write-back
      // to a linked parked idea). Best-effort: never fails the update.
      if (before && !before.done && updated.done && deps.onTaskCompleted) {
        try {
          deps.onTaskCompleted(updated);
        } catch (hookErr) {
          console.error('[tasks] onTaskCompleted hook failed:', errMessage(hookErr, 'unknown'));
        }
      }
      res.json(updated);
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to update task') });
    }
  });

  router.delete('/tasks/:id', (req: Request, res: Response) => {
    try {
      tasks.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to delete task') });
    }
  });

  // ---- Calendar events ------------------------------------------------------
  router.get('/events', (_req: Request, res: Response) => {
    try {
      res.json(events.list());
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list events') });
    }
  });

  router.post('/events', (req: Request, res: Response) => {
    try {
      res.status(201).json(events.create(eventInputFrom(req.body)));
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to create event') });
    }
  });

  router.get('/events/:id', (req: Request, res: Response) => {
    const event = events.get(req.params.id);
    if (!event) {
      res.status(404).json({ error: `unknown event: ${req.params.id}` });
      return;
    }
    res.json(event);
  });

  router.put('/events/:id', (req: Request, res: Response) => {
    try {
      res.json(events.update(req.params.id, eventUpdateFrom(req.body)));
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to update event') });
    }
  });

  router.delete('/events/:id', (req: Request, res: Response) => {
    try {
      events.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err, 'failed to delete event') });
    }
  });
}

// ---------------------------------------------------------------------------
// Workflow → task bridge
// ---------------------------------------------------------------------------

export interface TaskCreatorInput {
  title: string;
  notes?: string;
  dueAt?: string | null;
}

/**
 * Build the function the coordinator hands to the workflow scheduler (e.g.
 * the `onFire` callback of the cron Scheduler in @mvp/workflows/triggers) so
 * scheduled workflows can drop a task into the user's list. Sync — same
 * JSON-file store as the HTTP routes, so tasks created here show up in the
 * Tasks UI immediately.
 *
 * Example:
 *   const createTaskFromWorkflow = makeTaskCreator({ dataDir: config.dataDir });
 *   scheduler.start(runner, triggerStore, (trigger) =>
 *     createTaskFromWorkflow({ title: `Follow up: ${trigger.workflowId}` }),
 *   );
 */
export function makeTaskCreator(deps: TasksDeps): (input: TaskCreatorInput) => Task {
  const store = deps.taskStore ?? new TaskStore(deps.dataDir);
  return (input: TaskCreatorInput): Task => {
    return store.create({ title: input.title, notes: input.notes, dueAt: input.dueAt });
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function taskInputFrom(body: unknown): TaskInput {
  const b = (body ?? {}) as Record<string, unknown>;
  // Note: "done" is ignored on create — new tasks are always open.
  return {
    title: b.title as string,
    notes: b.notes as string | undefined,
    dueAt: (b.dueAt as string | null | undefined) ?? undefined,
  };
}

function taskUpdateFrom(body: unknown): Partial<TaskInput> & { done?: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<TaskInput> & { done?: boolean } = {};
  if ('title' in b) out.title = b.title as string;
  if ('notes' in b) out.notes = b.notes as string | undefined;
  if ('dueAt' in b) out.dueAt = b.dueAt as string | null | undefined;
  if ('done' in b) out.done = b.done as boolean;
  return out;
}

function eventInputFrom(body: unknown): EventInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    title: b.title as string,
    startsAt: b.startsAt as string,
    endsAt: b.endsAt as string,
    notes: b.notes as string | undefined,
  };
}

function eventUpdateFrom(body: unknown): Partial<EventInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<EventInput> = {};
  if ('title' in b) out.title = b.title as string;
  if ('startsAt' in b) out.startsAt = b.startsAt as string;
  if ('endsAt' in b) out.endsAt = b.endsAt as string;
  if ('notes' in b) out.notes = b.notes as string | undefined;
  return out;
}

function isTask(v: unknown): v is Task {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    (o.dueAt === null || typeof o.dueAt === 'string') &&
    typeof o.done === 'boolean' &&
    typeof o.createdAt === 'number'
  );
}

function isCalendarEvent(v: unknown): v is CalendarEvent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.startsAt === 'string' &&
    typeof o.endsAt === 'string' &&
    typeof o.createdAt === 'number'
  );
}

function requireTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
    throw validationError('task "title" must be a non-empty string (max 200 chars)');
  }
  return title.trim();
}

function optNotes(notes: unknown): string | undefined {
  if (notes === undefined || notes === null) return undefined;
  if (typeof notes !== 'string') throw validationError('"notes" must be a string');
  const trimmed = notes.trim();
  return trimmed ? trimmed : undefined;
}

/** dueAt: undefined → keep current (update) / null (create); null → clear; string → must parse. */
function normalizeDueAt(dueAt: unknown): string | null {
  if (dueAt === undefined || dueAt === null) return null;
  if (typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt))) {
    throw validationError('"dueAt" must be an ISO-8601 date string or null');
  }
  return new Date(dueAt).toISOString();
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw validationError(`event "${field}" must be an ISO-8601 date string`);
  }
  return new Date(value).toISOString();
}

function assertRange(startsAt: string, endsAt: string): void {
  if (Date.parse(endsAt) < Date.parse(startsAt)) {
    throw validationError('event "endsAt" must not be before "startsAt"');
  }
}

function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(`"${field}" must be a boolean`);
  return value;
}

/** Open tasks first (by due date, nulls last), then completed. */
function byDoneThenDue(a: Task, b: Task): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return b.createdAt - a.createdAt;
}

const NOT_FOUND_MARK = '__tasks_not_found__';
const VALIDATION_MARK = '__tasks_validation__';

function storeNotFound(kind: string, id: string): Error {
  const err = new Error(`unknown ${kind}: ${id}`);
  (err as Error & { code?: string }).code = NOT_FOUND_MARK;
  return err;
}

function validationError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VALIDATION_MARK;
  return err;
}

function statusFor(err: unknown): number {
  if (!(err instanceof Error)) return 500;
  const code = (err as Error & { code?: string }).code;
  if (code === NOT_FOUND_MARK) return 404;
  if (code === VALIDATION_MARK) return 400;
  return 500;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
