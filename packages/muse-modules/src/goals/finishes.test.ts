// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { GoalStore, GoalMilestoneStore } from './index.js';
import { GoalFinishesStore } from './finishes.js';

describe('GoalFinishesStore', () => {
  let db: ModuleDb;
  let goals: GoalStore;
  let fin: GoalFinishesStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    goals = new GoalStore(db);
    fin = new GoalFinishesStore(db);
  });

  it('G-2: edits title and description, validates like create', () => {
    const g = goals.create({ title: 'Old', description: 'old desc' });
    const edited = fin.editGoal(g.id, { title: 'New title' });
    expect(edited.title).toBe('New title');
    expect(edited.description).toBe('old desc');
    expect(fin.editGoal(g.id, { description: 'new desc' }).description).toBe('new desc');
    expect(() => fin.editGoal(g.id, {})).toThrow(ValidationError);
    expect(() => fin.editGoal(g.id, { title: '  ' })).toThrow(ValidationError);
    expect(() => fin.editGoal('nope', { title: 'x' })).toThrow(NotFoundError);
  });

  it('G-3: edits and deletes progress entries, recomputing the headline', () => {
    const g = goals.create({ title: 'Progress' });
    goals.updateProgress(g.id, 40, 'first');
    goals.updateProgress(g.id, 70, 'second');
    const history = goals.history(g.id);
    const wrong = history[2]!;
    const fixed = fin.editProgressEntry(g.id, wrong.id, { pct: 60, note: 'corrected' });
    expect(fixed.pct).toBe(60);
    expect(fixed.note).toBe('corrected');
    expect(goals.get(g.id).progress).toBe(60); // newest entry drives headline
    const { goal } = fin.deleteProgressEntry(g.id, wrong.id);
    expect(goal.progress).toBe(40);
    expect(goals.history(g.id)).toHaveLength(2);
    expect(() => fin.deleteProgressEntry(g.id, 'nope')).toThrow(NotFoundError);
    expect(() => fin.editProgressEntry(g.id, history[1]!.id, { pct: 101 })).toThrow(ValidationError);
  });

  it('G-3: deleting the 100% entry un-completes the goal', () => {
    const g = goals.create({ title: 'Done then not' });
    goals.updateProgress(g.id, 100, 'premature');
    expect(goals.get(g.id).status).toBe('completed');
    const entry = goals.history(g.id).at(-1)!;
    const { goal } = fin.deleteProgressEntry(g.id, entry.id);
    expect(goal.status).toBe('active');
    expect(goal.progress).toBe(0);
  });

  it('G-6: creates one level of subgoals and builds the tree', () => {
    const parent = goals.create({ title: 'Parent' });
    const child = fin.createSubgoal(parent.id, { title: 'Child' });
    expect(fin.parentOf(child.id)).toBe(parent.id);
    expect(fin.listSubgoals(parent.id).map((s) => s.title)).toEqual(['Child']);
    expect(() => fin.createSubgoal(child.id, { title: 'Grandchild' })).toThrow(ValidationError);
    const tree = fin.listGoalTree();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.subgoals.map((s) => s.title)).toEqual(['Child']);
  });

  it('G-7: binds files and jobs to the goal workspace (deduped, validated)', () => {
    const g = goals.create({ title: 'Workspace goal' });
    const f = fin.bindFile(g.id, { path: 'docs/plan.md', label: 'Plan' });
    expect(fin.bindFile(g.id, { path: 'docs/plan.md' }).id).toBe(f.id);
    expect(() => fin.bindFile(g.id, { path: '../escape.md' })).toThrow(ValidationError);
    expect(() => fin.bindFile(g.id, { path: '/abs.md' })).toThrow(ValidationError);
    const j = fin.bindJob(g.id, { jobId: 'cron-1', cron: '0 9 * * *', label: 'Morning job' });
    expect(j.cron).toBe('0 9 * * *');
    const ws = fin.workspace(g.id);
    expect(ws.files).toHaveLength(1);
    expect(ws.jobs).toHaveLength(1);
    expect(fin.unbindFile(g.id, f.id)).toBe(true);
    expect(fin.unbindJob(g.id, j.id)).toBe(true);
    expect(fin.workspace(g.id).files).toHaveLength(0);
  });

  it('G-8: renders and stores briefing letters; schedule + due generation are per-day idempotent', () => {
    const g = goals.create({ title: 'Brief me', description: 'A goal worth briefing' });
    goals.updateProgress(g.id, 30, 'started');
    new GoalMilestoneStore(db).add(g.id, { title: 'First milestone' });
    fin.bindFile(g.id, { path: 'notes.md' });
    const letter = fin.generateBriefing(g.id, 'manual', Date.UTC(2026, 9, 30, 7));
    expect(letter.letterMd).toContain('# Briefing — Brief me — 2026-10-30');
    expect(letter.letterMd).toContain('30% complete');
    expect(letter.letterMd).toContain('First milestone');
    expect(letter.letterMd).toContain('notes.md');
    expect(fin.listBriefings(g.id)).toHaveLength(1);

    fin.setBriefingSchedule(g.id, { cron: '0 7 * * *' });
    expect(fin.getBriefingSchedule(g.id)?.jobId).toBe(`goal-briefing:${g.id}`);
    const now = Date.UTC(2026, 9, 31, 7);
    expect(fin.generateDueBriefings(now)).toHaveLength(1);
    expect(fin.generateDueBriefings(now)).toHaveLength(0); // same day: no duplicate
    expect(fin.generateDueBriefings(now + 24 * 3600 * 1000)).toHaveLength(1);
    expect(fin.listBriefings(g.id).filter((b) => b.kind === 'scheduled')).toHaveLength(2);
  });

  it('G-5: deletion cascade is confirm-gated, cascades everything, and keeps the audit row', () => {
    const parent = goals.create({ title: 'Delete me' });
    const child = fin.createSubgoal(parent.id, { title: 'Child goal' });
    goals.updateProgress(parent.id, 50, 'halfway');
    fin.bindFile(parent.id, { path: 'a.md' });
    fin.bindJob(child.id, { jobId: 'job-x' });
    fin.generateBriefing(parent.id);
    new GoalMilestoneStore(db).add(parent.id, { title: 'M1' });

    const preview = fin.previewDelete(parent.id);
    expect(preview).toMatchObject({ subgoals: 1, files: 1, jobs: 1, briefings: 1, milestones: 1 });
    expect(preview.historyEntries).toBeGreaterThanOrEqual(3);

    expect(() => fin.deleteGoalCascade(parent.id, { confirmTitle: 'wrong' })).toThrow(ValidationError);
    expect(() => goals.get(parent.id)).not.toThrow(); // refused deletion changed nothing

    const receipt = fin.deleteGoalCascade(parent.id, { confirmTitle: 'Delete me' });
    expect(receipt.auditId).toBeTruthy();
    expect(() => goals.get(parent.id)).toThrow(NotFoundError);
    expect(() => goals.get(child.id)).toThrow(NotFoundError);
    expect(fin.listGoalTree()).toHaveLength(0);
    const audit = fin.listAudit(parent.id);
    expect(audit.some((a) => a.action === 'goal.deleted_cascade')).toBe(true);
  });
});
