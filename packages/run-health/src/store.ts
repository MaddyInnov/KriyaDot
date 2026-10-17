// SPDX-License-Identifier: Apache-2.0
// SQLite persistence for run/turn health scores and the metric samples that
// feed regression detection. Separate tables in a dedicated database file
// (default <dataDir>/run-health.db); scores are keyed to run/bot records so
// they travel with the run history.

import type { DatabaseSync } from 'node:sqlite';
import type { MetricSample, RunHealth, TurnHealth } from './types.js';

// `node:sqlite` cannot be statically imported under vitest's Vite 5 pipeline
// (see packages/workflows/src/store.ts): load it at runtime instead.
import { openDb } from './sqlite.js';

interface RunHealthRow {
  run_id: string;
  workflow_id: string;
  score: string;
  findings_json: string;
  latency_ms: number | null;
  failed_nodes: number;
  generated_at: number;
}

interface TurnHealthRow {
  id: number;
  bot_id: string;
  session_id: string | null;
  score: string;
  findings_json: string;
  generated_at: number;
}

interface MetricRow {
  id: number;
  scope_kind: string;
  scope_id: string;
  ts: number;
  latency_ms: number | null;
  errored: number;
  cost_usd: number | null;
  tokens: number | null;
  run_id: string | null;
}

function toMetricSample(row: MetricRow): MetricSample {
  const sample: MetricSample = {
    scopeKind: row.scope_kind as 'workflow' | 'bot',
    scopeId: row.scope_id,
    ts: row.ts,
    latencyMs: row.latency_ms,
    errored: row.errored === 1,
  };
  if (row.cost_usd !== null) sample.costUsd = row.cost_usd;
  if (row.tokens !== null) sample.tokens = row.tokens;
  if (row.run_id !== null) sample.runId = row.run_id;
  return sample;
}

export class RunHealthStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_health_scores (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        score TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        latency_ms INTEGER,
        failed_nodes INTEGER NOT NULL DEFAULT 0,
        generated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_health_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        session_id TEXT,
        score TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        latency_ms INTEGER,
        errored INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        tokens INTEGER,
        run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_health_workflow ON run_health_scores(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_turn_health_bot ON turn_health_scores(bot_id, generated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_metrics_scope ON run_metrics(scope_kind, scope_id, ts);
    `);
  }

  close(): void {
    this.db.close();
  }

  // -- run health ----------------------------------------------------------

  saveRunHealth(health: RunHealth): void {
    this.db
      .prepare(
        `INSERT INTO run_health_scores (run_id, workflow_id, score, findings_json, latency_ms, failed_nodes, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           workflow_id = excluded.workflow_id,
           score = excluded.score,
           findings_json = excluded.findings_json,
           latency_ms = excluded.latency_ms,
           failed_nodes = excluded.failed_nodes,
           generated_at = excluded.generated_at`,
      )
      .run(
        health.runId,
        health.workflowId,
        health.score,
        JSON.stringify(health.findings),
        health.latencyMs,
        health.failedNodes,
        health.generatedAt,
      );
  }

  getRunHealth(runId: string): RunHealth | undefined {
    const row = this.db
      .prepare('SELECT * FROM run_health_scores WHERE run_id = ?')
      .get(runId) as unknown as RunHealthRow | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      workflowId: row.workflow_id,
      score: row.score as RunHealth['score'],
      findings: JSON.parse(row.findings_json) as RunHealth['findings'],
      latencyMs: row.latency_ms,
      failedNodes: row.failed_nodes,
      generatedAt: row.generated_at,
    };
  }

  /** Newest first. */
  listRunHealth(workflowId?: string, limit = 50): RunHealth[] {
    const rows = (
      workflowId
        ? this.db
            .prepare('SELECT * FROM run_health_scores WHERE workflow_id = ? ORDER BY generated_at DESC LIMIT ?')
            .all(workflowId, limit)
        : this.db.prepare('SELECT * FROM run_health_scores ORDER BY generated_at DESC LIMIT ?').all(limit)
    ) as unknown as RunHealthRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      workflowId: row.workflow_id,
      score: row.score as RunHealth['score'],
      findings: JSON.parse(row.findings_json) as RunHealth['findings'],
      latencyMs: row.latency_ms,
      failedNodes: row.failed_nodes,
      generatedAt: row.generated_at,
    }));
  }

  // -- turn health ----------------------------------------------------------

  saveTurnHealth(health: TurnHealth): void {
    this.db
      .prepare(
        'INSERT INTO turn_health_scores (bot_id, session_id, score, findings_json, generated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(health.botId, health.sessionId ?? null, health.score, JSON.stringify(health.findings), health.generatedAt);
  }

  /** Newest first. */
  listTurnHealth(botId?: string, limit = 50): TurnHealth[] {
    const rows = (
      botId
        ? this.db
            .prepare('SELECT * FROM turn_health_scores WHERE bot_id = ? ORDER BY generated_at DESC, id DESC LIMIT ?')
            .all(botId, limit)
        : this.db.prepare('SELECT * FROM turn_health_scores ORDER BY generated_at DESC, id DESC LIMIT ?').all(limit)
    ) as unknown as TurnHealthRow[];
    return rows.map((row) => ({
      botId: row.bot_id,
      sessionId: row.session_id ?? undefined,
      score: row.score as TurnHealth['score'],
      findings: JSON.parse(row.findings_json) as TurnHealth['findings'],
      generatedAt: row.generated_at,
    }));
  }

  // -- metric samples (regression input) ------------------------------------

  recordMetric(sample: MetricSample): void {
    this.db
      .prepare(
        'INSERT INTO run_metrics (scope_kind, scope_id, ts, latency_ms, errored, cost_usd, tokens, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sample.scopeKind,
        sample.scopeId,
        sample.ts,
        sample.latencyMs,
        sample.errored ? 1 : 0,
        sample.costUsd ?? null,
        sample.tokens ?? null,
        sample.runId ?? null,
      );
  }

  /** Distinct scopes that have any metric samples. */
  listScopes(): Array<{ scopeKind: 'workflow' | 'bot'; scopeId: string }> {
    const rows = this.db
      .prepare('SELECT DISTINCT scope_kind, scope_id FROM run_metrics ORDER BY scope_kind ASC, scope_id ASC')
      .all() as unknown as { scope_kind: string; scope_id: string }[];
    return rows.map((r) => ({ scopeKind: r.scope_kind as 'workflow' | 'bot', scopeId: r.scope_id }));
  }

  /** Samples for one scope in [from, to], oldest first. */
  queryMetrics(scopeKind: 'workflow' | 'bot', scopeId: string, from: number, to: number): MetricSample[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM run_metrics WHERE scope_kind = ? AND scope_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC',
      )
      .all(scopeKind, scopeId, from, to) as unknown as MetricRow[];
    return rows.map(toMetricSample);
  }

  /** Baseline stats for scoring: rolling p50 latency / p50 tokens per scope. */
  scopeBaselines(
    scopeKind: 'workflow' | 'bot',
    scopeId: string,
    since: number,
  ): { p50LatencyMs?: number; p50Tokens?: number } {
    const latRows = this.db
      .prepare(
        'SELECT latency_ms FROM run_metrics WHERE scope_kind = ? AND scope_id = ? AND ts >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC',
      )
      .all(scopeKind, scopeId, since) as unknown as { latency_ms: number }[];
    const tokRows = this.db
      .prepare(
        'SELECT tokens FROM run_metrics WHERE scope_kind = ? AND scope_id = ? AND ts >= ? AND tokens IS NOT NULL ORDER BY tokens ASC',
      )
      .all(scopeKind, scopeId, since) as unknown as { tokens: number }[];
    const pick = (rows: Array<{ [k: string]: number }>, key: string): number | undefined => {
      if (rows.length === 0) return undefined;
      return rows[Math.floor(rows.length / 2)][key];
    };
    const out: { p50LatencyMs?: number; p50Tokens?: number } = {};
    const p50l = pick(latRows, 'latency_ms');
    const p50t = pick(tokRows, 'tokens');
    if (p50l !== undefined) out.p50LatencyMs = p50l;
    if (p50t !== undefined) out.p50Tokens = p50t;
    return out;
  }
}
