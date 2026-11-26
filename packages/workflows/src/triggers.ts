// SPDX-License-Identifier: Apache-2.0
// Workflow triggers: cron schedules and webhook entry points.
//
// - TriggerStore: SQLite-backed CRUD for triggers (own `triggers.db`, same
//   node:sqlite loading pattern as store.ts). Webhook secrets are stored
//   SHA-256-hashed at rest (A-12, mirroring A-1; see webhook-secrets.ts):
//   plaintext is shown once at create/rotate, listings redact it, and
//   there is no reveal path — the stored hash is not recoverable.
// - Cron: self-implemented 5-field cron matcher (minute hour dom month dow),
//   no new dependencies.
// - Scheduler: interval tick that fires due cron triggers through the
//   WorkflowRunner. Runs are started with the trigger context as input and an
//   idempotency key per (trigger, minute) so a restart/tick overlap never
//   double-fires the same minute.

import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkflowRunner } from './runner.js';
import {
  hashWorkflowSecret,
  isHashedWorkflowSecret,
  migrateWorkflowTriggerSecrets,
  verifyPresentedWorkflowSecret,
} from './webhook-secrets.js';

// `node:sqlite` cannot be statically imported under vitest's Vite 5 pipeline
// (see store.ts for the full explanation); load at runtime instead.
import { openDb } from '@mvp/agent-runtime';

export type TriggerKind = 'cron' | 'webhook';

export interface Trigger {
  id: string;
  workflowId: string;
  kind: TriggerKind;
  /** 5-field cron expression; required when kind === 'cron'. */
  cron?: string;
  /**
   * Shared secret for the `x-webhook-secret` header check; required when
   * kind === 'webhook'. A-12 hash-at-rest semantics (mirroring A-1): on
   * objects returned by create()/rotateSecret() this is the PLAINTEXT,
   * shown exactly once. On objects returned by get()/list()/listEnabled()
   * it is the stored form, `sha256:<hex>` — never a usable secret.
   * Verification goes through verifySecret() against that stored form.
   * Listings for display must use publicTrigger(), which strips it.
   */
  secret?: string;
  enabled: boolean;
  createdAt: number;
}

/** Trigger as exposed for display/listing: the secret (and its hash) is never included. */
export type TriggerPublic = Omit<Trigger, 'secret'>;

export function publicTrigger(t: Trigger): TriggerPublic {
  const { secret: _secret, ...rest } = t;
  void _secret;
  return rest;
}

interface TriggerRow {
  id: string;
  workflow_id: string;
  kind: string;
  cron: string | null;
  secret: string | null;
  enabled: number;
  created_at: number;
}

/**
 * SQLite-backed persistence for workflow triggers. Lives in its own
 * `triggers.db` file inside the data dir (separate from workflows.db so
 * trigger administration never contends with run execution writes).
 */
export class TriggerStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        cron TEXT,
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_workflow ON triggers(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_triggers_kind ON triggers(kind);
    `);
    // A-12 hash-at-rest migration: any legacy plaintext webhook secret
    // still in this DB is replaced by its SHA-256 hash in place.
    // Idempotent — see webhook-secrets.ts.
    migrateWorkflowTriggerSecrets(this.db);
  }

  close(): void {
    this.db.close();
  }

  create(input: Omit<Trigger, 'id' | 'createdAt'> & { id?: string }): Trigger {
    if (input.kind === 'cron') {
      if (!input.cron) throw new Error('cron trigger requires a cron expression');
      parseCron(input.cron); // validate eagerly
    }
    if (input.kind === 'webhook') {
      if (!input.secret || input.secret.length < 16) {
        throw new Error('webhook trigger requires a secret of at least 16 characters');
      }
    }
    const trigger: Trigger = {
      id: input.id ?? randomUUID(),
      workflowId: input.workflowId,
      kind: input.kind,
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
    };
    if (input.cron !== undefined) trigger.cron = input.cron;
    if (input.secret !== undefined) trigger.secret = input.secret;
    this.db
      .prepare(
        'INSERT INTO triggers (id, workflow_id, kind, cron, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        trigger.id,
        trigger.workflowId,
        trigger.kind,
        trigger.cron ?? null,
        // A-12: only the SHA-256 hash of a webhook secret is stored.
        // The returned trigger above still carries the plaintext, shown
        // exactly once (at creation); get()/list() expose only the hash.
        trigger.secret === undefined
          ? null
          : isHashedWorkflowSecret(trigger.secret)
            ? trigger.secret
            : hashWorkflowSecret(trigger.secret),
        trigger.enabled ? 1 : 0,
        trigger.createdAt,
      );
    return trigger;
  }

  /** Timing-safe check of a presented webhook secret against the stored hash. */
  verifySecret(id: string, presented: string | undefined): boolean {
    const trigger = this.get(id);
    if (!trigger?.secret) return false;
    return verifyPresentedWorkflowSecret(presented, trigger.secret);
  }

  /**
   * Rotation: mint a fresh secret, store only its hash, and return the
   * trigger carrying the PLAINTEXT exactly once. The old secret stops
   * working immediately. There is deliberately no reveal path: after
   * creation/rotation only the hash exists, so the secret is not
   * recoverable — rotation is how a new usable secret is obtained.
   */
  rotateSecret(id: string): Trigger | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    if (cur.kind !== 'webhook') throw new Error('only webhook triggers have a secret to rotate');
    const plaintext = randomBytes(32).toString('hex');
    this.db.prepare('UPDATE triggers SET secret = ? WHERE id = ?').run(hashWorkflowSecret(plaintext), id);
    const next = this.get(id);
    return next ? { ...next, secret: plaintext } : undefined;
  }

  /** Redacted view for listings/display: never includes secret or hash. */
  getPublic(id: string): TriggerPublic | undefined {
    const t = this.get(id);
    return t ? publicTrigger(t) : undefined;
  }

  listPublic(): TriggerPublic[] {
    return this.list().map(publicTrigger);
  }

  get(id: string): Trigger | undefined {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as unknown as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  list(): Trigger[] {
    const rows = this.db.prepare('SELECT * FROM triggers ORDER BY created_at ASC, id ASC').all() as unknown as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  listEnabled(kind?: TriggerKind): Trigger[] {
    const rows = (
      kind
        ? this.db
            .prepare('SELECT * FROM triggers WHERE enabled = 1 AND kind = ? ORDER BY created_at ASC, id ASC')
            .all(kind)
        : this.db.prepare('SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at ASC, id ASC').all()
    ) as unknown as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  setEnabled(id: string, enabled: boolean): void {
    const info = this.db.prepare('UPDATE triggers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (info.changes === 0) throw new Error(`unknown trigger: ${id}`);
  }

  remove(id: string): void {
    const info = this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
    if (info.changes === 0) throw new Error(`unknown trigger: ${id}`);
  }
}

function rowToTrigger(row: TriggerRow): Trigger {
  const t: Trigger = {
    id: row.id,
    workflowId: row.workflow_id,
    kind: row.kind as TriggerKind,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
  if (row.cron !== null) t.cron = row.cron;
  if (row.secret !== null) t.secret = row.secret;
  return t;
}

// ---------------------------------------------------------------------------
// Cron matcher (5 fields: minute hour day-of-month month day-of-week)
// ---------------------------------------------------------------------------

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface CronField {
  values: Set<number>;
  isStar: boolean; // the field was a bare '*'
  min: number;
  max: number;
}

function parseCronValueToken(token: string, names: Record<string, number> | null): number {
  const lower = token.toLowerCase();
  if (names && lower in names) return names[lower];
  const n = Number(token);
  if (!Number.isInteger(n)) throw new Error(`invalid cron token: "${token}"`);
  return n;
}

/** Parse one cron field into its matching value set. */
function parseCronField(raw: string, min: number, max: number, names: Record<string, number> | null): CronField {
  const values = new Set<number>();
  const isStar = raw.trim() === '*';
  if (raw.trim() === '') throw new Error('empty cron field');
  for (const part of raw.split(',')) {
    // part := range [/ step]   |   * [/ step]   |   value
    const [rangePartRaw, stepRaw] = part.split('/');
    const rangePart = rangePartRaw.trim();
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step in "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseCronValueToken(a.trim(), names);
      hi = parseCronValueToken(b.trim(), names);
      if (lo > hi) throw new Error(`invalid cron range "${part}"`);
    } else {
      lo = hi = parseCronValueToken(rangePart, names);
    }
    // Sunday may be written as 7 as well as 0.
    if (names === DOW_NAMES) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max) throw new Error(`cron value out of range [${min}-${max}] in "${part}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`cron field "${raw}" matches nothing`);
  return { values, isStar, min, max };
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/** Parse and validate a 5-field cron expression. Throws on invalid input. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (minute hour dom month dow), got ${fields.length}: "${expr}"`);
  }
  return {
    minute: parseCronField(fields[0], 0, 59, null),
    hour: parseCronField(fields[1], 0, 23, null),
    dayOfMonth: parseCronField(fields[2], 1, 31, null),
    month: parseCronField(fields[3], 1, 12, MONTH_NAMES),
    dayOfWeek: parseCronField(fields[4], 0, 7, DOW_NAMES),
  };
}

/**
 * Standard cron day semantics: minute/hour/month must match; for day-of-month
 * vs day-of-week, when both are restricted either may match (classic cron OR),
 * otherwise the restricted one must match.
 */
export function matchesCron(expr: string, date: Date): boolean {
  const c = parseCron(expr);
  if (!c.minute.values.has(date.getMinutes())) return false;
  if (!c.hour.values.has(date.getHours())) return false;
  if (!c.month.values.has(date.getMonth() + 1)) return false;
  const domMatch = c.dayOfMonth.values.has(date.getDate());
  const dowMatch = c.dayOfWeek.values.has(date.getDay());
  if (!c.dayOfMonth.isStar && !c.dayOfWeek.isStar) return domMatch || dowMatch;
  if (!c.dayOfMonth.isStar) return domMatch;
  if (!c.dayOfWeek.isStar) return dowMatch;
  return true;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  /** Tick interval in ms (default 30_000). Lower it in tests. */
  tickMs?: number;
  /** Clock source (default: () => new Date()). Injectable for tests. */
  now?: () => Date;
}

export type CronFireCallback = (trigger: Trigger, runId: string) => void;

/**
 * Polls enabled cron triggers and starts a workflow run when the current
 * minute matches the trigger's schedule. Each (trigger, minute) fires at
 * most once — the idempotency key also protects against double-starts
 * across restarts.
 */
export class Scheduler {
  private tickMs: number;
  private now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firedMinutes = new Map<string, string>(); // triggerId -> "YYYY-MM-DDTHH:mm"

  constructor(opts: SchedulerOptions = {}) {
    this.tickMs = opts.tickMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
  }

  start(runner: WorkflowRunner, store: TriggerStore, onFire?: CronFireCallback): void {
    if (this.timer) return; // already started
    this.timer = setInterval(() => {
      void this.tick(runner, store, onFire).catch((err: unknown) => {
        console.error('[scheduler] tick failed:', err);
      });
    }, this.tickMs);
    // Fire immediately on boot too (covers a schedule missed while down is
    // deliberately NOT backfilled — only the current minute fires).
    void this.tick(runner, store, onFire).catch((err: unknown) => {
      console.error('[scheduler] initial tick failed:', err);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Single tick — also usable directly in tests. */
  async tick(runner: WorkflowRunner, store: TriggerStore, onFire?: CronFireCallback): Promise<string[]> {
    const now = this.now();
    const minuteKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const fired: string[] = [];
    for (const trigger of store.listEnabled('cron')) {
      if (!trigger.cron) continue;
      let due = false;
      try {
        due = matchesCron(trigger.cron, now);
      } catch (err) {
        console.error(`[scheduler] invalid cron on trigger ${trigger.id}:`, err);
        continue;
      }
      if (!due) continue;
      if (this.firedMinutes.get(trigger.id) === minuteKey) continue; // already fired this minute
      const idempotencyKey = `cron:${trigger.id}:${minuteKey}`;
      if (runner.getRunByIdempotencyKey(idempotencyKey)) {
        // A previous process already fired this minute (e.g. crash between
        // startRun and our dedup write) — recover() resumes it; never double-start.
        this.firedMinutes.set(trigger.id, minuteKey);
        continue;
      }
      this.firedMinutes.set(trigger.id, minuteKey);
      try {
        const run = await runner.startRun(
          trigger.workflowId,
          { trigger: 'cron', triggerId: trigger.id, firedAt: now.toISOString() },
          { idempotencyKey },
        );
        fired.push(run.id);
        onFire?.(trigger, run.id);
      } catch (err) {
        // One bad trigger must not stop the rest of the tick.
        console.error(`[scheduler] failed to start run for trigger ${trigger.id}:`, err);
      }
    }
    // Bound the dedup map.
    if (this.firedMinutes.size > 10_000) this.firedMinutes.clear();
    return fired;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
