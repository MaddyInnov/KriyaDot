// SPDX-License-Identifier: Apache-2.0
// Goal finishes (Muse parity audit §4.4: G-2 / G-3 / G-5 / G-6 / G-7 / G-8).
//
// Everything the base GoalStore (./index.ts) did not have, built as a
// companion store over the SAME ModuleDb so the coordinator only has to
// export this file from the package index and mount the routes listed in
// the Wave-5 wiring note — the base store and its schema are untouched.
//
//   G-2  editGoal()            — title / description editing after creation.
//   G-3  editProgressEntry() / deleteProgressEntry()
//                              — fix or remove a wrong progress entry; the
//                                goal's progress/status is recomputed from
//                                the remaining history so the log and the
//                                headline number can never disagree.
//   G-6  createSubgoal()       — ONE level of nesting (a subgoal may not
//                                itself have subgoals), via a relation
//                                table so mm_goals needs no migration.
//   G-7  bindFile()/bindJob()  — per-goal workspace: files and scheduled
//                                jobs bound to the goal object itself.
//   G-8  briefing letters      — deterministic per-goal letters rendered
//                                from goal state, stored as artifacts, plus
//                                a briefing schedule (a goal-owned job of
//                                kind 'briefing') and a due-generator the
//                                host scheduler can call once a day.
//   G-5  deleteGoalCascade()   — confirm-gated (exact goal title), audited
//                                deletion of the goal, its subgoals, all
//                                history / milestones / briefings / file
//                                and job bindings. The audit row is kept
//                                in mm_goal_audit, which the cascade never
//                                deletes, so a deletion stays provable.
//
// All new tables are created lazily by this store (CREATE IF NOT EXISTS),
// namespaced mm_goal_* like the rest of the module database.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';
import { GoalStore, GoalMilestoneStore, type Goal, type GoalProgressEntry } from './index.js';

const FINISHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_goal_relations (
  child_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_relations_parent ON mm_goal_relations (parent_id);
CREATE TABLE IF NOT EXISTS mm_goal_files (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (goal_id, path)
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_files_goal ON mm_goal_files (goal_id, created_at);
CREATE TABLE IF NOT EXISTS mm_goal_jobs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'job',
  label TEXT NOT NULL DEFAULT '',
  cron TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (goal_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_jobs_goal ON mm_goal_jobs (goal_id, created_at);
CREATE TABLE IF NOT EXISTS mm_goal_briefings (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  letter_md TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_briefings_goal ON mm_goal_briefings (goal_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mm_goal_audit (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_audit_goal ON mm_goal_audit (goal_id, created_at);
`;

export interface GoalFileBinding {
  id: string;
  goalId: string;
  path: string;
  label: string;
  createdAt: number;
}

export interface GoalJobBinding {
  id: string;
  goalId: string;
  jobId: string;
  kind: string;
  label: string;
  cron: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface GoalBriefing {
  id: string;
  goalId: string;
  title: string;
  letterMd: string;
  kind: 'manual' | 'scheduled';
  createdAt: number;
}

export interface GoalWorkspace {
  goal: Goal;
  files: GoalFileBinding[];
  jobs: GoalJobBinding[];
  subgoals: Goal[];
  briefingSchedule: GoalJobBinding | null;
}

export interface GoalTreeNode extends Goal {
  parentId: string | null;
  subgoals: Goal[];
}

export interface GoalDeletionPreview {
  goalId: string;
  title: string;
  subgoals: number;
  historyEntries: number;
  milestones: number;
  briefings: number;
  files: number;
  jobs: number;
}

export interface GoalDeletionReceipt extends GoalDeletionPreview {
  deletedAt: number;
  auditId: string;
}

export const BRIEFING_JOB_KIND = 'briefing';

export function briefingJobIdFor(goalId: string): string {
  return `goal-briefing:${goalId}`;
}

interface FileRow { id: string; goal_id: string; path: string; label: string; created_at: number }
interface JobRow { id: string; goal_id: string; job_id: string; kind: string; label: string; cron: string | null; enabled: number; created_at: number }
interface BriefingRow { id: string; goal_id: string; title: string; letter_md: string; kind: string; created_at: number }

function rowToFile(r: FileRow): GoalFileBinding {
  return { id: r.id, goalId: r.goal_id, path: r.path, label: r.label, createdAt: r.created_at };
}
function rowToJob(r: JobRow): GoalJobBinding {
  return {
    id: r.id, goalId: r.goal_id, jobId: r.job_id, kind: r.kind, label: r.label,
    cron: r.cron, enabled: r.enabled === 1, createdAt: r.created_at,
  };
}
function rowToBriefing(r: BriefingRow): GoalBriefing {
  return {
    id: r.id, goalId: r.goal_id, title: r.title, letterMd: r.letter_md,
    kind: r.kind === 'scheduled' ? 'scheduled' : 'manual', createdAt: r.created_at,
  };
}

function checkTitle(title: unknown): string {
  const t = (title ?? '').toString().trim();
  if (!t) throw new ValidationError('goal "title" must be a non-empty string');
  if (t.length > 200) throw new ValidationError('goal "title" must be at most 200 characters');
  return t;
}
function checkDescription(description: unknown): string {
  const d = (description ?? '').toString().trim();
  if (d.length > 2000) throw new ValidationError('goal "description" must be at most 2000 characters');
  return d;
}

export class GoalFinishesStore {
  private readonly goals: GoalStore;
  private readonly milestones: GoalMilestoneStore;

  constructor(private readonly mdb: ModuleDb) {
    this.mdb.db.exec(FINISHES_SCHEMA);
    this.goals = new GoalStore(mdb);
    this.milestones = new GoalMilestoneStore(mdb);
  }

  private audit(goalId: string, action: string, detail: Record<string, unknown>): string {
    const id = randomUUID();
    this.mdb.db
      .prepare('INSERT INTO mm_goal_audit (id, goal_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, goalId, action, JSON.stringify(detail), Date.now());
    return id;
  }

  listAudit(goalId: string): Array<{ id: string; goalId: string; action: string; detail: Record<string, unknown>; createdAt: number }> {
    const rows = this.mdb.db
      .prepare('SELECT id, goal_id, action, detail_json, created_at FROM mm_goal_audit WHERE goal_id = ? ORDER BY created_at ASC')
      .all(goalId) as unknown as Array<{ id: string; goal_id: string; action: string; detail_json: string; created_at: number }>;
    return rows.map((r) => {
      let detail: Record<string, unknown> = {};
      try { detail = JSON.parse(r.detail_json) as Record<string, unknown>; } catch { detail = {}; }
      return { id: r.id, goalId: r.goal_id, action: r.action, detail, createdAt: r.created_at };
    });
  }

  // ---- G-2: title / description editing -----------------------------------

  editGoal(id: string, patch: { title?: string; description?: string }): Goal {
    const goal = this.goals.get(id); // NotFoundError for unknown goals
    if (patch.title === undefined && patch.description === undefined) {
      throw new ValidationError('editGoal needs a "title" and/or "description"');
    }
    const title = patch.title === undefined ? goal.title : checkTitle(patch.title);
    const description = patch.description === undefined ? goal.description : checkDescription(patch.description);
    this.mdb.db
      .prepare('UPDATE mm_goals SET title = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(title, description, Date.now(), id);
    this.audit(id, 'goal.edited', { title, description });
    return this.goals.get(id);
  }

  // ---- G-3: progress-entry edit / delete -----------------------------------

  /** Recompute headline progress/status from the newest remaining entry. */
  private recomputeFromHistory(goalId: string): void {
    const rows = this.mdb.db
      .prepare('SELECT pct FROM mm_goal_progress WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .all(goalId) as unknown as Array<{ pct: number }>;
    const pct = rows[0]?.pct ?? 0;
    const status = pct === 100 ? 'completed' : 'active';
    this.mdb.db
      .prepare('UPDATE mm_goals SET progress = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(pct, status, Date.now(), goalId);
  }

  editProgressEntry(goalId: string, entryId: string, patch: { note?: string; pct?: number }): GoalProgressEntry {
    this.goals.get(goalId);
    const entry = this.goals.history(goalId).find((e) => e.id === entryId);
    if (!entry) throw new NotFoundError(`unknown progress entry: ${entryId}`);
    let pct = entry.pct;
    if (patch.pct !== undefined) {
      if (!Number.isInteger(patch.pct) || patch.pct < 0 || patch.pct > 100) {
        throw new ValidationError('progress entry "pct" must be an integer 0–100');
      }
      pct = patch.pct;
    }
    const note = patch.note === undefined ? entry.note : patch.note.trim().slice(0, 500);
    this.mdb.db.prepare('UPDATE mm_goal_progress SET pct = ?, note = ? WHERE id = ? AND goal_id = ?').run(pct, note, entryId, goalId);
    this.recomputeFromHistory(goalId);
    this.audit(goalId, 'goal.progress_entry_edited', { entryId, pct, note });
    return this.goals.history(goalId).find((e) => e.id === entryId)!;
  }

  deleteProgressEntry(goalId: string, entryId: string): { deleted: true; goal: Goal } {
    this.goals.get(goalId);
    const entry = this.goals.history(goalId).find((e) => e.id === entryId);
    if (!entry) throw new NotFoundError(`unknown progress entry: ${entryId}`);
    this.mdb.db.prepare('DELETE FROM mm_goal_progress WHERE id = ? AND goal_id = ?').run(entryId, goalId);
    this.recomputeFromHistory(goalId);
    this.audit(goalId, 'goal.progress_entry_deleted', { entryId, pct: entry.pct, note: entry.note });
    return { deleted: true, goal: this.goals.get(goalId) };
  }

  // ---- G-6: one-level subgoals ---------------------------------------------

  parentOf(goalId: string): string | null {
    const row = this.mdb.db
      .prepare('SELECT parent_id FROM mm_goal_relations WHERE child_id = ?')
      .get(goalId) as unknown as { parent_id: string } | undefined;
    return row?.parent_id ?? null;
  }

  createSubgoal(parentId: string, input: { title: string; description?: string }): Goal {
    const parent = this.goals.get(parentId);
    if (parent.status !== 'active') throw new ValidationError('cannot add subgoals to a completed goal');
    if (this.parentOf(parentId) !== null) {
      throw new ValidationError('subgoals are one level deep: a subgoal cannot have subgoals');
    }
    const child = this.goals.create(input);
    this.mdb.db
      .prepare('INSERT INTO mm_goal_relations (child_id, parent_id, created_at) VALUES (?, ?, ?)')
      .run(child.id, parentId, Date.now());
    this.audit(parentId, 'goal.subgoal_created', { subgoalId: child.id, title: child.title });
    return child;
  }

  listSubgoals(parentId: string): Goal[] {
    this.goals.get(parentId);
    const rows = this.mdb.db
      .prepare('SELECT child_id FROM mm_goal_relations WHERE parent_id = ? ORDER BY created_at ASC')
      .all(parentId) as unknown as Array<{ child_id: string }>;
    return rows.map((r) => this.goals.get(r.child_id));
  }

  /** All top-level goals, each with its (one level of) subgoals attached. */
  listGoalTree(status?: 'active' | 'completed'): GoalTreeNode[] {
    return this.goals
      .list(status)
      .filter((g) => this.parentOf(g.id) === null)
      .map((g) => ({ ...g, parentId: null, subgoals: this.listSubgoals(g.id) }));
  }

  // ---- G-7: per-goal workspace (files + scheduled jobs) ---------------------

  bindFile(goalId: string, input: { path: string; label?: string }): GoalFileBinding {
    this.goals.get(goalId);
    const p = (input.path ?? '').trim().replace(/\\/g, '/');
    if (!p) throw new ValidationError('file binding "path" must be a non-empty string');
    if (p.startsWith('/') || /^[A-Za-z]:\//.test(p) || p.split('/').includes('..')) {
      throw new ValidationError('file binding "path" must be a workspace-relative path');
    }
    const existing = this.mdb.db
      .prepare('SELECT id, goal_id, path, label, created_at FROM mm_goal_files WHERE goal_id = ? AND path = ?')
      .get(goalId, p) as unknown as FileRow | undefined;
    if (existing) return rowToFile(existing);
    const id = randomUUID();
    this.mdb.db
      .prepare('INSERT INTO mm_goal_files (id, goal_id, path, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, goalId, p, (input.label ?? '').trim().slice(0, 200), Date.now());
    this.audit(goalId, 'goal.file_bound', { path: p });
    const row = this.mdb.db.prepare('SELECT id, goal_id, path, label, created_at FROM mm_goal_files WHERE id = ?').get(id) as unknown as FileRow;
    return rowToFile(row);
  }

  listFiles(goalId: string): GoalFileBinding[] {
    this.goals.get(goalId);
    const rows = this.mdb.db
      .prepare('SELECT id, goal_id, path, label, created_at FROM mm_goal_files WHERE goal_id = ? ORDER BY created_at ASC')
      .all(goalId) as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  unbindFile(goalId: string, bindingId: string): boolean {
    this.goals.get(goalId);
    const res = this.mdb.db.prepare('DELETE FROM mm_goal_files WHERE id = ? AND goal_id = ?').run(bindingId, goalId);
    if (res.changes > 0) this.audit(goalId, 'goal.file_unbound', { bindingId });
    return res.changes > 0;
  }

  bindJob(goalId: string, input: { jobId: string; kind?: string; label?: string; cron?: string; enabled?: boolean }): GoalJobBinding {
    this.goals.get(goalId);
    const jobId = (input.jobId ?? '').trim();
    if (!jobId) throw new ValidationError('job binding "jobId" must be a non-empty string');
    const kind = (input.kind ?? 'job').trim() || 'job';
    const existing = this.mdb.db
      .prepare('SELECT id, goal_id, job_id, kind, label, cron, enabled, created_at FROM mm_goal_jobs WHERE goal_id = ? AND job_id = ?')
      .get(goalId, jobId) as unknown as JobRow | undefined;
    if (existing) {
      // Re-binding updates the mutable fields (used by the briefing schedule).
      this.mdb.db
        .prepare('UPDATE mm_goal_jobs SET kind = ?, label = ?, cron = ?, enabled = ? WHERE id = ?')
        .run(kind, (input.label ?? existing.label).trim().slice(0, 200), input.cron ?? existing.cron, input.enabled === false ? 0 : 1, existing.id);
      const row = this.mdb.db.prepare('SELECT id, goal_id, job_id, kind, label, cron, enabled, created_at FROM mm_goal_jobs WHERE id = ?').get(existing.id) as unknown as JobRow;
      return rowToJob(row);
    }
    const id = randomUUID();
    this.mdb.db
      .prepare('INSERT INTO mm_goal_jobs (id, goal_id, job_id, kind, label, cron, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, goalId, jobId, kind, (input.label ?? '').trim().slice(0, 200), input.cron ?? null, input.enabled === false ? 0 : 1, Date.now());
    this.audit(goalId, 'goal.job_bound', { jobId, kind });
    const row = this.mdb.db.prepare('SELECT id, goal_id, job_id, kind, label, cron, enabled, created_at FROM mm_goal_jobs WHERE id = ?').get(id) as unknown as JobRow;
    return rowToJob(row);
  }

  listJobs(goalId: string): GoalJobBinding[] {
    this.goals.get(goalId);
    const rows = this.mdb.db
      .prepare('SELECT id, goal_id, job_id, kind, label, cron, enabled, created_at FROM mm_goal_jobs WHERE goal_id = ? ORDER BY created_at ASC')
      .all(goalId) as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  unbindJob(goalId: string, bindingId: string): boolean {
    this.goals.get(goalId);
    const res = this.mdb.db.prepare('DELETE FROM mm_goal_jobs WHERE id = ? AND goal_id = ?').run(bindingId, goalId);
    if (res.changes > 0) this.audit(goalId, 'goal.job_unbound', { bindingId });
    return res.changes > 0;
  }

  workspace(goalId: string): GoalWorkspace {
    const goal = this.goals.get(goalId);
    const jobs = this.listJobs(goalId);
    return {
      goal,
      files: this.listFiles(goalId),
      jobs,
      subgoals: this.listSubgoals(goalId),
      briefingSchedule: jobs.find((j) => j.kind === BRIEFING_JOB_KIND) ?? null,
    };
  }

  // ---- G-8: per-goal briefing letters ---------------------------------------

  setBriefingSchedule(goalId: string, input: { cron: string; enabled?: boolean }): GoalJobBinding {
    const cron = (input.cron ?? '').trim();
    if (!cron) throw new ValidationError('briefing schedule "cron" must be a non-empty string');
    return this.bindJob(goalId, {
      jobId: briefingJobIdFor(goalId),
      kind: BRIEFING_JOB_KIND,
      label: 'Per-goal briefing letter',
      cron,
      enabled: input.enabled !== false,
    });
  }

  getBriefingSchedule(goalId: string): GoalJobBinding | null {
    return this.listJobs(goalId).find((j) => j.kind === BRIEFING_JOB_KIND) ?? null;
  }

  /** Render the letter for a goal from its current state (pure, no LLM). */
  renderBriefingLetter(goalId: string, now: number = Date.now()): { title: string; letterMd: string } {
    const goal = this.goals.get(goalId);
    const history = this.goals.history(goalId);
    const detail = this.milestones.detail(goalId);
    const subgoals = this.listSubgoals(goalId);
    const files = this.listFiles(goalId);
    const jobs = this.listJobs(goalId);
    const date = new Date(now).toISOString().slice(0, 10);
    const title = `Briefing — ${goal.title} — ${date}`;
    const lines: string[] = [
      `# ${title}`,
      '',
      `Dear you,`,
      '',
      `Here is where **${goal.title}** stands on ${date}: ${goal.progress}% complete, status ${goal.status}.`,
    ];
    if (goal.description) lines.push('', goal.description);
    lines.push('', '## Recent progress');
    const recent = history.slice(-5).reverse();
    if (recent.length === 0) lines.push('- No progress logged yet.');
    for (const h of recent) {
      lines.push(`- ${new Date(h.createdAt).toISOString().slice(0, 10)} — ${h.pct}%${h.note ? ` — ${h.note}` : ''}`);
    }
    if (detail.milestonesTotal > 0) {
      lines.push('', `## Milestones (${detail.milestonesDone}/${detail.milestonesTotal} done)`);
      for (const m of detail.milestones) lines.push(`- ${m.done ? '☑' : '☐'} ${m.title}`);
    }
    if (subgoals.length > 0) {
      lines.push('', '## Subgoals');
      for (const s of subgoals) lines.push(`- ${s.title} — ${s.progress}% (${s.status})`);
    }
    if (files.length > 0) {
      lines.push('', '## Workspace files');
      for (const f of files) lines.push(`- ${f.path}${f.label ? ` — ${f.label}` : ''}`);
    }
    const scheduled = jobs.filter((j) => j.kind !== BRIEFING_JOB_KIND);
    if (scheduled.length > 0) {
      lines.push('', '## Scheduled jobs');
      for (const j of scheduled) lines.push(`- ${j.label || j.jobId}${j.cron ? ` (${j.cron})` : ''}${j.enabled ? '' : ' — paused'}`);
    }
    lines.push('', '— Your KriyaDot goals briefing');
    return { title, letterMd: lines.join('\n') };
  }

  generateBriefing(goalId: string, kind: 'manual' | 'scheduled' = 'manual', now: number = Date.now()): GoalBriefing {
    const { title, letterMd } = this.renderBriefingLetter(goalId, now);
    const id = randomUUID();
    this.mdb.db
      .prepare('INSERT INTO mm_goal_briefings (id, goal_id, title, letter_md, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, goalId, title, letterMd, kind, now);
    this.audit(goalId, 'goal.briefing_generated', { briefingId: id, kind });
    const row = this.mdb.db.prepare('SELECT id, goal_id, title, letter_md, kind, created_at FROM mm_goal_briefings WHERE id = ?').get(id) as unknown as BriefingRow;
    return rowToBriefing(row);
  }

  listBriefings(goalId: string): GoalBriefing[] {
    this.goals.get(goalId);
    const rows = this.mdb.db
      .prepare('SELECT id, goal_id, title, letter_md, kind, created_at FROM mm_goal_briefings WHERE goal_id = ? ORDER BY created_at DESC')
      .all(goalId) as unknown as BriefingRow[];
    return rows.map(rowToBriefing);
  }

  /**
   * Host-scheduler entrypoint: render a 'scheduled' briefing for every
   * goal with an enabled briefing schedule that has none yet today (UTC
   * date of `now`). Returns the briefings created. Idempotent per day.
   */
  generateDueBriefings(now: number = Date.now()): GoalBriefing[] {
    const rows = this.mdb.db
      .prepare(`SELECT goal_id FROM mm_goal_jobs WHERE kind = ? AND enabled = 1`)
      .all(BRIEFING_JOB_KIND) as unknown as Array<{ goal_id: string }>;
    const day = new Date(now).toISOString().slice(0, 10);
    const made: GoalBriefing[] = [];
    for (const r of rows) {
      let goal: Goal;
      try { goal = this.goals.get(r.goal_id); } catch { continue; }
      if (goal.status !== 'active') continue;
      const already = this.listBriefings(r.goal_id).some(
        (b) => b.kind === 'scheduled' && new Date(b.createdAt).toISOString().slice(0, 10) === day,
      );
      if (already) continue;
      made.push(this.generateBriefing(r.goal_id, 'scheduled', now));
    }
    return made;
  }

  // ---- G-5: deletion cascade (confirm-gated, audited) ------------------------

  previewDelete(goalId: string): GoalDeletionPreview {
    const goal = this.goals.get(goalId);
    const subgoals = this.listSubgoals(goalId);
    const countFor = (ids: string[]) => {
      let historyEntries = 0; let milestones = 0; let briefings = 0; let files = 0; let jobs = 0;
      for (const id of ids) {
        historyEntries += (this.mdb.db.prepare('SELECT COUNT(*) AS c FROM mm_goal_progress WHERE goal_id = ?').get(id) as unknown as { c: number }).c;
        milestones += (this.mdb.db.prepare('SELECT COUNT(*) AS c FROM mm_goal_milestones WHERE goal_id = ?').get(id) as unknown as { c: number }).c;
        briefings += (this.mdb.db.prepare('SELECT COUNT(*) AS c FROM mm_goal_briefings WHERE goal_id = ?').get(id) as unknown as { c: number }).c;
        files += (this.mdb.db.prepare('SELECT COUNT(*) AS c FROM mm_goal_files WHERE goal_id = ?').get(id) as unknown as { c: number }).c;
        jobs += (this.mdb.db.prepare('SELECT COUNT(*) AS c FROM mm_goal_jobs WHERE goal_id = ?').get(id) as unknown as { c: number }).c;
      }
      return { historyEntries, milestones, briefings, files, jobs };
    };
    const totals = countFor([goalId, ...subgoals.map((s) => s.id)]);
    return { goalId, title: goal.title, subgoals: subgoals.length, ...totals };
  }

  /**
   * Delete a goal and everything it owns. Confirm-gated: `confirmTitle`
   * must exactly equal the goal's current title (the UI shows the preview
   * and asks the user to type it). The audit row is written BEFORE the
   * cascade and lives in mm_goal_audit, which is never cascaded.
   */
  deleteGoalCascade(goalId: string, input: { confirmTitle: string }): GoalDeletionReceipt {
    const goal = this.goals.get(goalId);
    if ((input.confirmTitle ?? '') !== goal.title) {
      throw new ValidationError(
        `deletion is confirm-gated: confirmTitle must exactly match the goal title "${goal.title}"`,
      );
    }
    const preview = this.previewDelete(goalId);
    const auditId = this.audit(goalId, 'goal.deleted_cascade', { ...preview });
    const ids = [goalId, ...this.listSubgoals(goalId).map((s) => s.id)];
    for (const id of ids) {
      this.mdb.db.prepare('DELETE FROM mm_goal_progress WHERE goal_id = ?').run(id);
      this.mdb.db.prepare('DELETE FROM mm_goal_milestones WHERE goal_id = ?').run(id);
      this.mdb.db.prepare('DELETE FROM mm_goal_briefings WHERE goal_id = ?').run(id);
      this.mdb.db.prepare('DELETE FROM mm_goal_files WHERE goal_id = ?').run(id);
      this.mdb.db.prepare('DELETE FROM mm_goal_jobs WHERE goal_id = ?').run(id);
      this.mdb.db.prepare('DELETE FROM mm_goal_relations WHERE child_id = ? OR parent_id = ?').run(id, id);
      this.mdb.db.prepare('DELETE FROM mm_goals WHERE id = ?').run(id);
    }
    return { ...preview, deletedAt: Date.now(), auditId };
  }
}
