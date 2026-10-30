// SPDX-License-Identifier: Apache-2.0
// Unified tracked-items view (Muse parity audit §4.4: G-10).
//
// Reminders, commitments and tasks were three separate stores with three
// separate surfaces. This module is the ONE read model over all of them:
// it never writes to any source store — it normalises each source's rows
// into a single lifecycle shape (open / due / done / missed / cancelled),
// computes overdue, and sorts by due time so the Goals view (and any
// other surface) can render a single "everything you are tracking" list.
//
// Tasks live outside muse-modules (apps/api TaskStore, JSON file), so the
// task leg is an injected provider with the Task shape mirrored here —
// the API wiring passes `() => taskStore.list()`.

import type { ModuleDb } from '../db.js';
import { ReminderStore, type Reminder } from '../reminders/index.js';
import { CommitmentStore, type Commitment } from '../commitments/index.js';

export type TrackedItemKind = 'reminder' | 'commitment' | 'task';
export type TrackedItemStatus = 'open' | 'due' | 'done' | 'missed' | 'cancelled';

export interface TrackedItem {
  id: string;
  kind: TrackedItemKind;
  title: string;
  /** Normalised lifecycle status across all three source stores. */
  status: TrackedItemStatus;
  /** Due time, ms epoch; null when the item has no deadline. */
  dueAt: number | null;
  /** True when status is open/due and dueAt has passed. */
  overdue: boolean;
  createdAt: number;
  /** Goal the item serves, when the source records one (commitments). */
  goalId: string | null;
  detail: string;
}

/** Mirror of apps/api TaskStore's Task shape (structural, no import). */
export interface TrackedTaskLike {
  id: string;
  title: string;
  notes?: string;
  /** ISO-8601 timestamp or null. */
  dueAt: string | null;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TrackedItemsOptions {
  /** Injected task source (apps/api TaskStore.list in production). */
  tasks?: () => TrackedTaskLike[];
  now?: number;
  kind?: TrackedItemKind;
  status?: TrackedItemStatus;
  /** Only items linked to this goal (commitments carry goalId). */
  goalId?: string;
}

function fromReminder(r: Reminder, now: number): TrackedItem {
  const status: TrackedItemStatus =
    r.status === 'scheduled' ? (r.when <= now ? 'due' : 'open')
    : r.status === 'fired' ? 'due'
    : r.status === 'done' ? 'done'
    : 'cancelled';
  return {
    id: r.id, kind: 'reminder', title: r.title, status,
    dueAt: r.when, overdue: (status === 'open' || status === 'due') && r.when <= now,
    createdAt: r.createdAt, goalId: null, detail: `via ${r.channel}`,
  };
}

function fromCommitment(c: Commitment, now: number): TrackedItem {
  const status: TrackedItemStatus =
    c.status === 'open' ? (c.dueAt !== null && c.dueAt <= now ? 'due' : 'open')
    : c.status === 'kept' ? 'done'
    : c.status === 'missed' ? 'missed'
    : 'cancelled';
  return {
    id: c.id, kind: 'commitment', title: c.title, status,
    dueAt: c.dueAt, overdue: status === 'due',
    createdAt: c.createdAt, goalId: c.goalId, detail: c.outcome || c.detail,
  };
}

function fromTask(t: TrackedTaskLike, now: number): TrackedItem {
  const dueMs = t.dueAt ? Date.parse(t.dueAt) : NaN;
  const dueAt = Number.isFinite(dueMs) ? dueMs : null;
  const status: TrackedItemStatus = t.done ? 'done' : dueAt !== null && dueAt <= now ? 'due' : 'open';
  return {
    id: t.id, kind: 'task', title: t.title, status,
    dueAt, overdue: status === 'due',
    createdAt: t.createdAt, goalId: null, detail: t.notes ?? '',
  };
}

/**
 * The unified view: every reminder + commitment + (injected) task,
 * normalised, overdue-flagged, sorted by due time (no-deadline last),
 * then by creation time. Filters are applied after normalisation.
 */
export function listTrackedItems(mdb: ModuleDb, opts: TrackedItemsOptions = {}): TrackedItem[] {
  const now = opts.now ?? Date.now();
  const items: TrackedItem[] = [
    ...new ReminderStore(mdb).list().map((r) => fromReminder(r, now)),
    ...new CommitmentStore(mdb).list().map((c) => fromCommitment(c, now)),
    ...(opts.tasks ? opts.tasks().map((t) => fromTask(t, now)) : []),
  ];
  const filtered = items.filter((i) =>
    (opts.kind === undefined || i.kind === opts.kind) &&
    (opts.status === undefined || i.status === opts.status) &&
    (opts.goalId === undefined || i.goalId === opts.goalId),
  );
  filtered.sort((a, b) => {
    const ad = a.dueAt ?? Number.POSITIVE_INFINITY;
    const bd = b.dueAt ?? Number.POSITIVE_INFINITY;
    return ad - bd || a.createdAt - b.createdAt;
  });
  return filtered;
}

export interface TrackedItemsSummary {
  total: number;
  overdue: number;
  byKind: Record<TrackedItemKind, number>;
  byStatus: Record<TrackedItemStatus, number>;
}

export function summariseTrackedItems(items: TrackedItem[]): TrackedItemsSummary {
  const byKind: Record<TrackedItemKind, number> = { reminder: 0, commitment: 0, task: 0 };
  const byStatus: Record<TrackedItemStatus, number> = { open: 0, due: 0, done: 0, missed: 0, cancelled: 0 };
  let overdue = 0;
  for (const i of items) {
    byKind[i.kind] += 1;
    byStatus[i.status] += 1;
    if (i.overdue) overdue += 1;
  }
  return { total: items.length, overdue, byKind, byStatus };
}
