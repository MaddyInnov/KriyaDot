// SPDX-License-Identifier: Apache-2.0
// Fusion run history — data model.
//
// Persistent record of fusion runs (planner + parallel workers + fusion
// synthesis): <dataDir>/fusion-runs.db (SQLite, node:sqlite). Separate DB
// so no schema migration is needed elsewhere.
//
// Run ids: fr_<base36time>_<rand> (opaque strings, like group ids).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  FusionPlan,
  FusionResultSummary,
  FusionRunStatus,
  FusionWorkerResult,
  TokenUsage,
} from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export function newFusionRunId(): string {
  return `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const RUN_ID_RE = /^fr_[a-z0-9]+_[a-z0-9]+$/;

export function isFusionRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

export interface FusionRunRecord {
  runId: string;
  botId: string;
  botName: string;
  task: string;
  status: 'running' | FusionRunStatus;
  plan: FusionPlan | null;
  workerResults: FusionWorkerResult[];
  fused: string | null;
  fallbackSingleAgent: boolean;
  usage: TokenUsage | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

function safeJsonParse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Persistent fusion runs: <dataDir>/fusion-runs.db. */
export class FusionRunStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'fusion-runs.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fusion_runs (
        run_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT,
        results_json TEXT NOT NULL DEFAULT '[]',
        fused TEXT,
        fallback INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        cost_usd REAL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fusion_runs_created ON fusion_runs(created_at DESC);
    `);
  }

  createRun(args: { botId: string; botName: string; task: string }): FusionRunRecord {
    const runId = newFusionRunId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO fusion_runs (run_id, bot_id, bot_name, task, status, created_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(runId, args.botId, args.botName, args.task, createdAt);
    const rec = this.getRun(runId);
    if (!rec) throw new Error('Failed to create fusion run');
    return rec;
  }

  setPlan(runId: string, plan: FusionPlan | null): void {
    this.db
      .prepare(`UPDATE fusion_runs SET plan_json = ? WHERE run_id = ?`)
      .run(plan ? JSON.stringify(plan) : null, runId);
  }

  setWorkerResults(runId: string, results: FusionWorkerResult[]): void {
    this.db
      .prepare(`UPDATE fusion_runs SET results_json = ? WHERE run_id = ?`)
      .run(JSON.stringify(results), runId);
  }

  completeRun(runId: string, summary: FusionResultSummary): void {
    this.db
      .prepare(
        `UPDATE fusion_runs
         SET status = ?, plan_json = ?, results_json = ?, fused = ?, fallback = ?,
             usage_json = ?, cost_usd = ?, error = ?, completed_at = ?
         WHERE run_id = ?`,
      )
      .run(
        summary.status,
        summary.plan ? JSON.stringify(summary.plan) : null,
        JSON.stringify(summary.workerResults),
        summary.fused,
        summary.fallbackSingleAgent ? 1 : 0,
        JSON.stringify(summary.usage),
        summary.costUsd ?? null,
        summary.error ?? null,
        new Date().toISOString(),
        runId,
      );
  }

  failRun(runId: string, error: string): void {
    this.db
      .prepare(`UPDATE fusion_runs SET status = 'failed', error = ?, completed_at = ? WHERE run_id = ?`)
      .run(error, new Date().toISOString(), runId);
  }

  getRun(runId: string): FusionRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM fusion_runs WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  listRuns(limit = 50): FusionRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM fusion_runs ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: Record<string, unknown>): FusionRunRecord {
    const status = String(row.status);
    return {
      runId: String(row.run_id),
      botId: String(row.bot_id),
      botName: String(row.bot_name),
      task: String(row.task),
      status: status === 'running' ? 'running' : (status as FusionRunStatus),
      plan: safeJsonParse<FusionPlan | null>(row.plan_json as string | null, null),
      workerResults: safeJsonParse<FusionWorkerResult[]>(row.results_json as string | null, []),
      fused: (row.fused as string | null) ?? null,
      fallbackSingleAgent: Number(row.fallback) === 1,
      usage: safeJsonParse<TokenUsage | null>(row.usage_json as string | null, null),
      costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : null,
      error: (row.error as string | null) ?? null,
      createdAt: String(row.created_at),
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
