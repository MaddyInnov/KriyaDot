// SPDX-License-Identifier: Apache-2.0
// Eval harnesses — data model.
//
// - Suites: editable JSON files in <dataDir>/evals/*.json. The three
//   built-in suites are seeded on first boot; users may edit them freely
//   afterwards (files win over code).
// - Run history: <dataDir>/eval-runs.db (SQLite, node:sqlite).
//
// Run ids: ev_<base36time>_<rand> (opaque strings, like fusion ids).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BUILTIN_EVAL_SUITES,
  validateEvalSuite,
  type EvalCaseResultSummary,
  type EvalRunReportSummary,
  type EvalRunStatus,
  type EvalSuite,
  type TokenUsage,
} from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export function newEvalRunId(): string {
  return `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const RUN_ID_RE = /^ev_[a-z0-9]+_[a-z0-9]+$/;

export function isEvalRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

const SUITE_FILENAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.json$/;

export interface EvalRunRecord {
  runId: string;
  suiteId: string;
  suiteName: string;
  botId: string;
  botName: string;
  status: 'running' | EvalRunStatus;
  score: number | null;
  passed: number | null;
  failed: number | null;
  caseResults: EvalCaseResultSummary[] | null;
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

/** Editable eval suites: <dataDir>/evals/*.json */
export class EvalSuiteStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'evals');
    mkdirSync(this.dir, { recursive: true });
    this.ensureBuiltinSuites();
  }

  private ensureBuiltinSuites(): void {
    for (const suite of BUILTIN_EVAL_SUITES) {
      const path = join(this.dir, `${suite.id}.json`);
      try {
        readFileSync(path, 'utf8');
      } catch {
        // Missing (or unreadable) → seed from the built-in definition.
        try {
          writeFileSync(path, JSON.stringify(suite, null, 2) + '\n', 'utf8');
        } catch {
          // A read-only data dir must not break boot.
        }
      }
    }
  }

  listSuites(): EvalSuite[] {
    const suites: EvalSuite[] = [];
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return suites;
    }
    for (const file of files.sort()) {
      if (!SUITE_FILENAME_RE.test(file)) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
        const v = validateEvalSuite(parsed);
        if (v.ok) suites.push(parsed as EvalSuite);
      } catch {
        // Skip invalid files rather than breaking the list.
      }
    }
    return suites;
  }

  getSuite(id: string): EvalSuite | null {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8'));
      const v = validateEvalSuite(parsed);
      return v.ok ? (parsed as EvalSuite) : null;
    } catch {
      return null;
    }
  }

  saveSuite(suite: unknown): { ok: boolean; errors: string[]; suite?: EvalSuite } {
    const v = validateEvalSuite(suite);
    if (!v.ok) return { ok: false, errors: v.errors };
    const s = suite as EvalSuite;
    writeFileSync(join(this.dir, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n', 'utf8');
    return { ok: true, errors: [], suite: s };
  }

  deleteSuite(id: string): boolean {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return false;
    try {
      const { unlinkSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs');
      unlinkSync(join(this.dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

/** Persistent eval runs: <dataDir>/eval-runs.db. */
export class EvalRunStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'eval-runs.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_runs (
        run_id TEXT PRIMARY KEY,
        suite_id TEXT NOT NULL,
        suite_name TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        status TEXT NOT NULL,
        score REAL,
        passed INTEGER,
        failed INTEGER,
        cases_json TEXT,
        usage_json TEXT,
        cost_usd REAL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite_id, created_at DESC);
    `);
  }

  createRun(args: { suiteId: string; suiteName: string; botId: string; botName: string }): EvalRunRecord {
    const runId = newEvalRunId();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO eval_runs (run_id, suite_id, suite_name, bot_id, bot_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(runId, args.suiteId, args.suiteName, args.botId, args.botName, createdAt);
    const rec = this.getRun(runId);
    if (!rec) throw new Error('Failed to create eval run');
    return rec;
  }

  getRun(runId: string): EvalRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM eval_runs WHERE run_id = ?`).get(runId) as Record<
      string,
      unknown
    > | null;
    return row ? this.mapRow(row) : null;
  }

  listRuns(limit = 50, suiteId?: string): EvalRunRecord[] {
    const lim = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = (
      suiteId
        ? this.db
            .prepare(`SELECT * FROM eval_runs WHERE suite_id = ? ORDER BY created_at DESC LIMIT ?`)
            .all(suiteId, lim)
        : this.db.prepare(`SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?`).all(lim)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  completeRun(runId: string, report: EvalRunReportSummary): void {
    this.db
      .prepare(
        `UPDATE eval_runs
         SET status = ?, score = ?, passed = ?, failed = ?, cases_json = ?,
             usage_json = ?, cost_usd = ?, error = ?, completed_at = ?
         WHERE run_id = ?`,
      )
      .run(
        report.status,
        report.score,
        report.passed,
        report.failed,
        JSON.stringify(report.caseResults),
        JSON.stringify(report.usage),
        report.costUsd ?? null,
        report.error ?? null,
        report.completedAt,
        runId,
      );
  }

  failRun(runId: string, error: string): void {
    this.db
      .prepare(`UPDATE eval_runs SET status = 'failed', error = ?, completed_at = ? WHERE run_id = ?`)
      .run(error.slice(0, 2000), new Date().toISOString(), runId);
  }

  private mapRow(row: Record<string, unknown>): EvalRunRecord {
    return {
      runId: String(row.run_id),
      suiteId: String(row.suite_id),
      suiteName: String(row.suite_name),
      botId: String(row.bot_id),
      botName: String(row.bot_name),
      status: row.status as EvalRunRecord['status'],
      score: row.score === null ? null : Number(row.score),
      passed: row.passed === null ? null : Number(row.passed),
      failed: row.failed === null ? null : Number(row.failed),
      caseResults: safeJsonParse<EvalCaseResultSummary[] | null>(row.cases_json as string | null, null),
      usage: safeJsonParse<TokenUsage | null>(row.usage_json as string | null, null),
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    };
  }
}
