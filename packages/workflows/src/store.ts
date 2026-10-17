// SPDX-License-Identifier: Apache-2.0

import type { DatabaseSync } from 'node:sqlite';
import type {
  NodeState,
  NodeStatus,
  RunStatus,
  WorkflowDefinition,
  WorkflowRun,
} from './types.js';

// `node:sqlite` cannot be statically imported under vitest's Vite 5 pipeline
// ("Failed to load url sqlite"): Vite 5 predates the builtin and strips the
// `node:` prefix. Load it at runtime via process.getBuiltinModule instead,
// which is fully typed in @types/node and works in both vitest and node.
// (The `import type` above is erased at compile time and never resolved
// by Vite.)
import { openDb } from '@mvp/agent-runtime';

/** Raw DB row shapes (narrowed from the driver's generic record type). */
interface RunRow {
  id: string;
  workflow_id: string;
  status: string;
  input_json: string | null;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  current_step_index: number | null;
  step_outputs_json: string | null;
}

interface NodeStateRow {
  run_id: string;
  node_id: string;
  status: string;
  output_json: string | null;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  approval_id: string | null;
  attempts: number | null;
}

/**
 * SQLite-backed persistence for workflow definitions, runs and node states.
 * Every state transition in a run is written through this store so runs
 * survive process restarts and can be inspected / resumed by the API layer.
 */
export class WorkflowStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        idempotency_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_states (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        approval_id TEXT,
        PRIMARY KEY (run_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_runs_idempotency ON runs(idempotency_key);
      -- Definition version history: every saveWorkflow that changes the JSON
      -- archives the previous definition here (version = 1-based sequence).
      CREATE TABLE IF NOT EXISTS workflow_versions (
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, version)
      );
    `);
    // Crash-resume checkpoint columns (added 2026-10-09). ALTER on existing
    // tables is a no-op when the column already exists — ignore that error.
    // Per-node attempt counts for run-health retry heuristics (added
    // 2026-10-09, same pattern).
    for (const ddl of [
      'ALTER TABLE runs ADD COLUMN current_step_index INTEGER',
      'ALTER TABLE runs ADD COLUMN step_outputs_json TEXT',
      'ALTER TABLE node_states ADD COLUMN attempts INTEGER',
    ]) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        if (!/duplicate column name/i.test(err instanceof Error ? err.message : String(err))) throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // -- workflows -----------------------------------------------------------

  saveWorkflow(def: WorkflowDefinition): void {
    const nextJson = JSON.stringify(def);
    const current = this.getWorkflow(def.id);
    if (current && JSON.stringify(current) !== nextJson) {
      // Archive the previous definition before overwriting (version history).
      const row = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM workflow_versions WHERE workflow_id = ?')
        .get(def.id) as unknown as { max_version: number };
      this.db
        .prepare(
          'INSERT INTO workflow_versions (workflow_id, version, definition_json, saved_at) VALUES (?, ?, ?, ?)',
        )
        .run(def.id, row.max_version + 1, JSON.stringify(current), Date.now());
    }
    this.db
      .prepare('INSERT INTO workflows (id, definition_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json')
      .run(def.id, nextJson);
  }

  /**
   * Version history for a workflow: [{ version, savedAt }] oldest first.
   * Version N is the definition that was live before save N+1 overwrote it.
   */
  listWorkflowVersions(id: string): { version: number; savedAt: number }[] {
    const rows = this.db
      .prepare(
        'SELECT version, saved_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version ASC',
      )
      .all(id) as unknown as { version: number; saved_at: number }[];
    return rows.map((r) => ({ version: r.version, savedAt: r.saved_at }));
  }

  /** A previously archived definition, or undefined when absent. */
  getWorkflowVersion(id: string, version: number): WorkflowDefinition | undefined {
    const row = this.db
      .prepare('SELECT definition_json FROM workflow_versions WHERE workflow_id = ? AND version = ?')
      .get(id, version) as unknown as { definition_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.definition_json) as WorkflowDefinition;
  }

  getWorkflow(id: string): WorkflowDefinition | undefined {
    const row = this.db
      .prepare('SELECT definition_json FROM workflows WHERE id = ?')
      .get(id) as unknown as { definition_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.definition_json) as WorkflowDefinition;
  }

  listWorkflows(): WorkflowDefinition[] {
    const rows = this.db
      .prepare('SELECT definition_json FROM workflows ORDER BY id ASC')
      .all() as unknown as { definition_json: string }[];
    return rows.map((r) => JSON.parse(r.definition_json) as WorkflowDefinition);
  }

  // -- runs ----------------------------------------------------------------

  /** Insert a new run together with its initial node states. Throws on duplicate id / idempotency key. */
  insertRun(run: WorkflowRun): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO runs (id, workflow_id, status, input_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          run.id,
          run.workflowId,
          run.status,
          run.input === undefined ? null : JSON.stringify(run.input),
          run.idempotencyKey ?? null,
          run.createdAt,
          run.updatedAt,
        );
      const stmt = this.db.prepare(
        'INSERT INTO node_states (run_id, node_id, status, output_json, error, started_at, ended_at, approval_id, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const [nodeId, state] of Object.entries(run.nodeStates)) {
        stmt.run(
          run.id,
          nodeId,
          state.status,
          state.output === undefined ? null : JSON.stringify(state.output),
          state.error ?? null,
          state.startedAt ?? null,
          state.endedAt ?? null,
          state.approvalId ?? null,
          state.attempts ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getRun(id: string): WorkflowRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
    if (!row) return undefined;
    return this.assembleRun(row);
  }

  getRunByIdempotencyKey(key: string): WorkflowRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE idempotency_key = ?')
      .get(key) as unknown as RunRow | undefined;
    if (!row) return undefined;
    return this.assembleRun(row);
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const rows = (
      workflowId
        ? this.db.prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, id DESC').all(workflowId)
        : this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all()
    ) as unknown as RunRow[];
    return rows.map((row) => this.assembleRun(row));
  }

  updateRunStatus(id: string, status: RunStatus, updatedAt: number): void {
    this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
  }

  /**
   * Durable crash-resume checkpoint: the last completed step index and the
   * outputs of every completed step, written AFTER each step finishes (and on
   * pause). On recovery the node_states table is the source of truth for which
   * steps are done; this row is the fast resume cursor plus an audit trail.
   */
  checkpointRun(
    id: string,
    checkpoint: { currentStepIndex: number; stepOutputs: Record<string, unknown> },
    updatedAt: number,
  ): void {
    this.db
      .prepare('UPDATE runs SET current_step_index = ?, step_outputs_json = ?, updated_at = ? WHERE id = ?')
      .run(checkpoint.currentStepIndex, JSON.stringify(checkpoint.stepOutputs), updatedAt, id);
  }

  /** Runs stuck in 'running' — i.e. the process died mid-flight. */
  listCrashedRuns(): WorkflowRun[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY updated_at ASC")
      .all() as unknown as RunRow[];
    return rows.map((row) => this.assembleRun(row));
  }

  upsertNodeState(runId: string, nodeId: string, state: NodeState): void {
    this.db
      .prepare(
        `INSERT INTO node_states (run_id, node_id, status, output_json, error, started_at, ended_at, approval_id, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_id) DO UPDATE SET
           status = excluded.status,
           output_json = excluded.output_json,
           error = excluded.error,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           approval_id = excluded.approval_id,
           attempts = excluded.attempts`,
      )
      .run(
        runId,
        nodeId,
        state.status,
        state.output === undefined ? null : JSON.stringify(state.output),
        state.error ?? null,
        state.startedAt ?? null,
        state.endedAt ?? null,
        state.approvalId ?? null,
        state.attempts ?? null,
      );
  }

  private assembleRun(row: RunRow): WorkflowRun {
    const stateRows = this.db
      .prepare('SELECT * FROM node_states WHERE run_id = ?')
      .all(row.id) as unknown as NodeStateRow[];
    const nodeStates: Record<string, NodeState> = {};
    for (const s of stateRows) {
      const state: NodeState = { status: s.status as NodeStatus };
      if (s.output_json !== null) state.output = JSON.parse(s.output_json) as unknown;
      if (s.error !== null) state.error = s.error;
      if (s.started_at !== null) state.startedAt = s.started_at;
      if (s.ended_at !== null) state.endedAt = s.ended_at;
      if (s.approval_id !== null) state.approvalId = s.approval_id;
      if (s.attempts !== null) state.attempts = s.attempts;
      nodeStates[s.node_id] = state;
    }
    const run: WorkflowRun = {
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status as RunStatus,
      nodeStates,
      input: row.input_json === null ? undefined : (JSON.parse(row.input_json) as unknown),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.idempotency_key !== null) run.idempotencyKey = row.idempotency_key;
    if (row.current_step_index !== null) run.currentStepIndex = row.current_step_index;
    if (row.step_outputs_json !== null) run.stepOutputs = JSON.parse(row.step_outputs_json) as Record<string, unknown>;
    return run;
  }
}
