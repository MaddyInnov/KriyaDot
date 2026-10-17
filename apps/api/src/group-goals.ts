// SPDX-License-Identifier: Apache-2.0
// Group goals — data model + SQLite store (<dataDir>/group-goals.db).
//
// A group goal is a bounded multi-turn coordinator/worker run with explicit
// completion decisions (OpenMausBot parity P1 #11). The coordinator works in
// turns (default max 13); each turn ends with a control decision parsed from
// a fenced envelope: completed | needs-input | blocked | continue.
//
//   GroupGoal { id, title, description, coordinatorBotId, workerBotIds[],
//               maxTurns, status, groupId?, routineId?, summary? }
//   GoalTurn  { id, goalId, turnNumber, decision, coordinatorText,
//               nextStep?, summary?, delegations[] }

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  clampGoalMaxTurns,
  isGoalId,
  newGoalId,
  newGoalTurnId,
  validGoalTitle,
  type GoalControlDecision,
} from '@mvp/agent-runtime';

import { openDb } from '@mvp/agent-runtime';

export type GroupGoalStatus =
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'max-turns'
  | 'completed'
  | 'stopped'
  | 'failed';

export const GOAL_STATUSES: readonly GroupGoalStatus[] = [
  'running',
  'needs-input',
  'blocked',
  'max-turns',
  'completed',
  'stopped',
  'failed',
] as const;

/** Paused statuses a resume call may restart. */
export const RESUMABLE_GOAL_STATUSES: readonly GroupGoalStatus[] = [
  'needs-input',
  'blocked',
  'max-turns',
] as const;

export function isGroupGoalStatus(v: unknown): v is GroupGoalStatus {
  return typeof v === 'string' && (GOAL_STATUSES as readonly string[]).includes(v);
}

export interface GroupGoal {
  id: string;
  title: string;
  description: string | null;
  coordinatorBotId: string;
  workerBotIds: string[];
  maxTurns: number;
  status: GroupGoalStatus;
  /** Attached group room (visible turns); null → headless background goal. */
  groupId: string | null;
  /** Routine this goal was started from (routine-as-goal); null otherwise. */
  routineId: string | null;
  /** Final summary (completed) or stop/failure reason. */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalDelegation {
  botId: string;
  botName: string;
  task: string;
  summary?: string;
  done: boolean;
}

export interface GoalTurn {
  id: string;
  goalId: string;
  turnNumber: number;
  decision: GoalControlDecision;
  coordinatorText: string;
  nextStep: string | null;
  summary: string | null;
  delegations: GoalDelegation[];
  createdAt: string;
}

interface GoalRow {
  goal_id: string;
  title: string;
  description: string | null;
  coordinator_bot_id: string;
  worker_bot_ids: string;
  max_turns: number;
  status: string;
  group_id: string | null;
  routine_id: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  turn_id: string;
  goal_id: string;
  turn_number: number;
  decision: string;
  coordinator_text: string;
  next_step: string | null;
  summary: string | null;
  delegations: string;
  created_at: string;
}

function rowToGoal(r: GoalRow): GroupGoal {
  return {
    id: r.goal_id,
    title: r.title,
    description: r.description,
    coordinatorBotId: r.coordinator_bot_id,
    workerBotIds: JSON.parse(r.worker_bot_ids) as string[],
    maxTurns: r.max_turns,
    status: isGroupGoalStatus(r.status) ? r.status : 'failed',
    groupId: r.group_id,
    routineId: r.routine_id,
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToTurn(r: TurnRow): GoalTurn {
  return {
    id: r.turn_id,
    goalId: r.goal_id,
    turnNumber: r.turn_number,
    decision: r.decision as GoalControlDecision,
    coordinatorText: r.coordinator_text,
    nextStep: r.next_step,
    summary: r.summary,
    delegations: JSON.parse(r.delegations) as GoalDelegation[],
    createdAt: r.created_at,
  };
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  coordinatorBotId: string;
  workerBotIds: string[];
  maxTurns?: number;
  groupId?: string;
  routineId?: string;
}

/** Persistent group goals + turns: <dataDir>/group-goals.db. */
export class GroupGoalStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'group-goals.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        coordinator_bot_id TEXT NOT NULL,
        worker_bot_ids TEXT NOT NULL,
        max_turns INTEGER NOT NULL,
        status TEXT NOT NULL,
        group_id TEXT,
        routine_id TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_turns (
        turn_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        decision TEXT NOT NULL,
        coordinator_text TEXT NOT NULL,
        next_step TEXT,
        summary TEXT,
        delegations TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (goal_id) REFERENCES goals(goal_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_goal_turns_goal ON goal_turns(goal_id, turn_number);
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, updated_at DESC);
    `);
  }

  createGoal(input: CreateGoalInput): GroupGoal {
    if (!validGoalTitle(input.title)) throw new Error('title is required (max 140 chars)');
    const id = newGoalId();
    const now = new Date().toISOString();
    const goal: GroupGoal = {
      id,
      title: input.title.trim(),
      description: input.description?.trim().slice(0, 4000) || null,
      coordinatorBotId: input.coordinatorBotId,
      workerBotIds: [...new Set(input.workerBotIds)],
      maxTurns: clampGoalMaxTurns(input.maxTurns),
      status: 'running',
      groupId: input.groupId ?? null,
      routineId: input.routineId ?? null,
      summary: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO goals (goal_id, title, description, coordinator_bot_id, worker_bot_ids,
          max_turns, status, group_id, routine_id, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.id,
        goal.title,
        goal.description,
        goal.coordinatorBotId,
        JSON.stringify(goal.workerBotIds),
        goal.maxTurns,
        goal.status,
        goal.groupId,
        goal.routineId,
        goal.summary,
        goal.createdAt,
        goal.updatedAt,
      );
    return goal;
  }

  getGoal(goalId: string): GroupGoal | null {
    if (!isGoalId(goalId)) return null;
    const row = this.db.prepare(`SELECT * FROM goals WHERE goal_id = ?`).get(goalId) as
      | GoalRow
      | undefined;
    return row ? rowToGoal(row) : null;
  }

  listGoals(limit = 50): GroupGoal[] {
    const rows = this.db
      .prepare(`SELECT * FROM goals ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as unknown as GoalRow[];
    return rows.map(rowToGoal);
  }

  updateGoal(
    goalId: string,
    patch: { status?: GroupGoalStatus; summary?: string | null; maxTurns?: number },
  ): GroupGoal | null {
    const existing = this.getGoal(goalId);
    if (!existing) return null;
    const status = patch.status ?? existing.status;
    const summary = patch.summary !== undefined ? patch.summary : existing.summary;
    const maxTurns = patch.maxTurns !== undefined ? clampGoalMaxTurns(patch.maxTurns) : existing.maxTurns;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE goals SET status = ?, summary = ?, max_turns = ?, updated_at = ? WHERE goal_id = ?`)
      .run(status, summary, maxTurns, updatedAt, goalId);
    return this.getGoal(goalId);
  }

  addTurn(
    goalId: string,
    turn: {
      turnNumber: number;
      decision: GoalControlDecision;
      coordinatorText: string;
      nextStep?: string | null;
      summary?: string | null;
      delegations: GoalDelegation[];
    },
  ): GoalTurn {
    const id = newGoalTurnId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO goal_turns (turn_id, goal_id, turn_number, decision, coordinator_text,
          next_step, summary, delegations, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        goalId,
        turn.turnNumber,
        turn.decision,
        turn.coordinatorText,
        turn.nextStep ?? null,
        turn.summary ?? null,
        JSON.stringify(turn.delegations),
        createdAt,
      );
    this.db.prepare(`UPDATE goals SET updated_at = ? WHERE goal_id = ?`).run(createdAt, goalId);
    return {
      id,
      goalId,
      turnNumber: turn.turnNumber,
      decision: turn.decision,
      coordinatorText: turn.coordinatorText,
      nextStep: turn.nextStep ?? null,
      summary: turn.summary ?? null,
      delegations: turn.delegations,
      createdAt,
    };
  }

  listTurns(goalId: string): GoalTurn[] {
    const rows = this.db
      .prepare(`SELECT * FROM goal_turns WHERE goal_id = ? ORDER BY turn_number ASC`)
      .all(goalId) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }

  turnCount(goalId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM goal_turns WHERE goal_id = ?`)
      .get(goalId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

export { isGoalId, validGoalTitle };
