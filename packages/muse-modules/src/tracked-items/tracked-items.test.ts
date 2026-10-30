// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ReminderStore } from '../reminders/index.js';
import { CommitmentStore } from '../commitments/index.js';
import { listTrackedItems, summariseTrackedItems, type TrackedTaskLike } from './index.js';

describe('listTrackedItems (G-10)', () => {
  let db: ModuleDb;
  const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

  beforeEach(() => {
    db = new ModuleDb(':memory:');
  });

  it('merges reminders, commitments and injected tasks into one due-sorted view', () => {
    const reminders = new ReminderStore(db);
    reminders.create({ title: 'Future reminder', when: NOW + 3600_000, channel: 'push' });
    reminders.create({ title: 'Past reminder', when: NOW - 3600_000, channel: 'email' });
    const commitments = new CommitmentStore(db);
    commitments.create({ title: 'Ship the thing', dueAt: NOW - 1000 });
    const kept = commitments.create({ title: 'Kept promise' });
    commitments.resolve(kept.id, 'kept', 'done as promised');
    const tasks: TrackedTaskLike[] = [
      { id: 't1', title: 'Open task', dueAt: new Date(NOW + 7200_000).toISOString(), done: false, createdAt: NOW - 5000, updatedAt: NOW },
      { id: 't2', title: 'Done task', dueAt: null, done: true, createdAt: NOW - 4000, updatedAt: NOW },
    ];

    const items = listTrackedItems(db, { tasks: () => tasks, now: NOW });
    expect(items.map((i) => i.title)).toEqual([
      'Past reminder', 'Ship the thing', 'Future reminder', 'Open task', 'Done task', 'Kept promise',
    ]);
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle['Past reminder']).toMatchObject({ kind: 'reminder', status: 'due', overdue: true });
    expect(byTitle['Ship the thing']).toMatchObject({ kind: 'commitment', status: 'due', overdue: true });
    expect(byTitle['Future reminder']).toMatchObject({ status: 'open', overdue: false });
    expect(byTitle['Kept promise']).toMatchObject({ status: 'done' });
    expect(byTitle['Done task']).toMatchObject({ kind: 'task', status: 'done' });

    const summary = summariseTrackedItems(items);
    expect(summary.total).toBe(6);
    expect(summary.overdue).toBe(2);
    expect(summary.byKind).toEqual({ reminder: 2, commitment: 2, task: 2 });
  });

  it('filters by kind, status and goalId; works without a task provider', () => {
    const commitments = new CommitmentStore(db);
    commitments.create({ title: 'Goal-linked', goalId: 'goal-1', dueAt: NOW + 1000 });
    commitments.create({ title: 'Unlinked' });
    expect(listTrackedItems(db, { now: NOW, kind: 'commitment' })).toHaveLength(2);
    expect(listTrackedItems(db, { now: NOW, goalId: 'goal-1' }).map((i) => i.title)).toEqual(['Goal-linked']);
    expect(listTrackedItems(db, { now: NOW, status: 'done' })).toHaveLength(0);
    expect(listTrackedItems(db, { now: NOW, kind: 'task' })).toHaveLength(0);
  });
});
