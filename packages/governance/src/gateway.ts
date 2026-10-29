// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';
// NOTE: `node:sqlite` is loaded at runtime via process.getBuiltinModule
// instead of a top-level `import ... from 'node:sqlite'` because this repo's
// vitest (Vite 5.4.21) cannot statically resolve that specifier
// ("Failed to load url sqlite"). The cast keeps full typing.
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type Database = DatabaseSync;
import { DENYLIST_COMMAND_RE } from './default-policy.js';
import { checkHardFloor, type HardFloorConfig, type HardFloorHit } from './hard-floors.js';
import type {
  ActionClass,
  ApprovalRecord,
  ApprovalStatus,
  AuditEntry,
  Effect,
  EvalContext,
  EvaluateResult,
  Policy,
  PolicyRule,
  SimulationResult,
} from './types.js';

/** Default approval timeout when neither the constructor nor awaitDecision sets one. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Pure policy decision: no approvals minted, no audit written. */
interface PolicyDecision {
  effect: Effect;
  actionClass: ActionClass;
  floorHit: HardFloorHit | null;
  denylistHit: boolean;
  matchedRule?: PolicyRule;
}

export interface GatewayOptions {
  /** SQLite file path, or ':memory:' for an ephemeral database. */
  dbPath: string;
  policy: Policy;
  /** Fallback timeout for awaitDecision(). */
  approvalTimeoutMs?: number;
  /** Hard floors config. Defaults to { enabled: true }. */
  hardFloors?: HardFloorConfig;
  /** Audit-log retention tuning (M4). Defaults keep newest 50,000 rows plus
   *  the last 90 days, pruning every 1,000 inserts. */
  auditRetention?: AuditRetentionOptions;
}

/** Tunables for the audit_log retention sweep (M4). */
export interface AuditRetentionOptions {
  maxRows?: number;
  maxAgeMs?: number;
  pruneEveryInserts?: number;
}

export type PreHook = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: EvalContext,
) => Promise<void> | void;

export type PostHook = (
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: EvalContext,
) => Promise<void> | void;

interface Waiter {
  resolve: (decision: 'approved' | 'denied') => void;
  /** Absent for never-expire approvals waiting without a deadline (W12). */
  timer?: ReturnType<typeof setTimeout>;
}

/** Raw DB row shape for the approvals table. */
interface ApprovalRow {
  id: string;
  ts: number;
  session_id: string;
  bot_id: string;
  actor: string;
  tool_name: string;
  args_json: string;
  status: ApprovalStatus;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  provenance: string | null;
  relayed: number | null;
  addressee_person_id: string | null;
  expires_at: number | null;
  never_expire: number | null;
}

/** Raw DB row shape for the audit_log table. */
interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  session_id: string | null;
  action: string;
  tool_name: string | null;
  decision: string | null;
  detail: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  note TEXT,
  provenance TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  tool_name TEXT,
  decision TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_status_ts ON approvals(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`;

/**
 * Audit-log retention (M4): the audit table is append-only but bounded.
 * Pruning keeps the NEWEST `AUDIT_RETENTION_MAX_ROWS` rows plus every row
 * from the last `AUDIT_RETENTION_MAX_AGE_MS` — whichever keeps more — and
 * deletes the rest. Pruning runs every `AUDIT_PRUNE_EVERY_INSERTS` inserts
 * so a long-lived gateway never grows the table without bound.
 */
export const AUDIT_RETENTION_MAX_ROWS = 50_000;
export const AUDIT_RETENTION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const AUDIT_PRUNE_EVERY_INSERTS = 1_000;

/**
 * Deny-by-default action gateway.
 *
 * Every proposed tool call is classified, matched against the policy (first
 * rule wins, else defaultEffect), and resolved to allow / require-approval /
 * deny. Approvals are persisted in SQLite; audit entries are append-only and
 * secret-redacted.
 */
export class GovernanceGateway {
  private static readonly READ_TOOLS = new Set([
    'read_file',
    'web_search',
    'web_fetch',
    'list_dir',
  ]);
  private static readonly WRITE_TOOLS = new Set([
    'write_file',
    'edit_file',
    'create_file',
    'delete_file',
    'remove_file',
  ]);
  private static readonly EXECUTE_TOOLS = new Set([
    'run_command',
    'exec',
    'shell',
  ]);

  private readonly db: Database;
  private readonly policy: Policy;
  private readonly approvalTimeoutMs: number;
  private readonly hardFloorConfig: HardFloorConfig;
  private readonly waiters = new Map<string, Waiter>();
  private readonly preHooks: PreHook[] = [];
  private readonly postHooks: PostHook[] = [];
  private auditInsertsSincePrune = 0;
  private readonly auditMaxRows: number;
  private readonly auditMaxAgeMs: number;
  private readonly auditPruneEvery: number;

  constructor(options: GatewayOptions) {
    this.policy = options.policy;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.hardFloorConfig = options.hardFloors ?? { enabled: true };
    const ar = options.auditRetention ?? {};
    this.auditMaxRows = ar.maxRows ?? AUDIT_RETENTION_MAX_ROWS;
    this.auditMaxAgeMs = ar.maxAgeMs ?? AUDIT_RETENTION_MAX_AGE_MS;
    this.auditPruneEvery = ar.pruneEveryInserts ?? AUDIT_PRUNE_EVERY_INSERTS;
    this.db = openDb(options.dbPath);
    this.db.exec(SCHEMA);
    // Migration: provenance column for older databases.
    try {
      this.db.exec('ALTER TABLE approvals ADD COLUMN provenance TEXT');
    } catch {
      // Column already exists.
    }
    // Migration (guarded external messages): relayed flag — a relayed
    // message can NEVER satisfy an approval.
    try {
      this.db.exec('ALTER TABLE approvals ADD COLUMN relayed INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists.
    }
    // Migration (W7 multiplayer): addressee person id — the bot owner's
    // person id, recorded when the approval is minted so the approvals
    // inbox / team inbox can route and filter by person.
    try {
      this.db.exec('ALTER TABLE approvals ADD COLUMN addressee_person_id TEXT');
    } catch {
      // Column already exists.
    }
    // Migration (W12 never-expire cards): stored expiry + never-expire
    // flag. expires_at is NULL for never-expire approvals.
    try {
      this.db.exec('ALTER TABLE approvals ADD COLUMN expires_at INTEGER');
    } catch {
      // Column already exists.
    }
    try {
      this.db.exec('ALTER TABLE approvals ADD COLUMN never_expire INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists.
    }
  }

  /** Release the SQLite connection. */
  close(): void {
    for (const [, waiter] of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    this.waiters.clear();
    this.db.close();
  }

  /**
   * Classify a tool into a broad action class. Unknown tools are treated as
   * 'write' (conservative) so they never auto-run under the default policy.
   */
  classify(toolName: string): ActionClass {
    const name = toolName.trim();
    if (GovernanceGateway.READ_TOOLS.has(name)) return 'read';
    if (GovernanceGateway.WRITE_TOOLS.has(name)) return 'write';
    if (GovernanceGateway.EXECUTE_TOOLS.has(name)) return 'execute';
    if (name.startsWith('mcp:') || name.startsWith('http')) return 'network';
    return 'write';
  }

  /**
   * Evaluate a proposed tool call. First matching rule wins; otherwise the
   * policy defaultEffect applies. 'require-approval' creates a pending
   * approval record and returns its id. 'deny' (including denylist hits) is
   * audited.
   */
  async evaluate(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
  ): Promise<EvaluateResult> {
    return this.evaluateInner(toolName, args, ctx, this.policy);
  }

  /**
   * Evaluate against an explicit policy instead of the gateway's own — used
   * by the API's governance adapter for per-bot policies (the bot's rules
   * merged ahead of the global policy). Approvals and audit entries land in
   * the same database, so the inbox and audit trail stay unified.
   */
  async evaluateWithPolicy(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
    policy: Policy,
  ): Promise<EvaluateResult> {
    return this.evaluateInner(toolName, args, ctx, policy);
  }

  /**
   * Pure policy decision: hard floors → denylist → first matching rule →
   * default effect. No side effects (no approvals minted, no audit written)
   * — shared by evaluateInner() and simulate() so the simulator can never
   * drift from the live decision logic.
   */
  private decidePolicy(toolName: string, args: Record<string, unknown>, policy: Policy): PolicyDecision {
    const actionClass = this.classify(toolName);

    // Hard floors FIRST — before denylist, policy rules, always-allow,
    // learned preferences, and reviewer. No mode can bypass these.
    //
    // TWO TIERS (see hard-floors.ts):
    // - 'catastrophic' → UNCONDITIONAL DENIAL. Never executable, never
    //   approvable: no approval record is minted, so there is nothing a
    //   human can click to approve. A human approval click is not a
    //   sufficient safeguard for instant-destruction commands.
    // - 'destructive' → human approval required (approval minted below).
    const floorHit = checkHardFloor(toolName, args, this.hardFloorConfig);
    if (floorHit && floorHit.tier === 'catastrophic') {
      return { effect: 'deny', actionClass, floorHit, denylistHit: false };
    }
    if (floorHit) {
      return { effect: 'require-approval', actionClass, floorHit, denylistHit: false };
    }

    // Hard denylist on run_command args — unconditional deny, no rule needed.
    const command = args['command'];
    if (typeof command === 'string' && DENYLIST_COMMAND_RE.test(command)) {
      return { effect: 'deny', actionClass, floorHit: null, denylistHit: true };
    }

    const matchedRule = policy.rules.find((r) => this.ruleMatches(r, toolName, actionClass));
    return {
      effect: matchedRule?.effect ?? policy.defaultEffect,
      actionClass,
      floorHit: null,
      denylistHit: false,
      matchedRule,
    };
  }

  /**
   * Side-effect-free policy simulation (dry-run): returns the decision the
   * gateway WOULD make for a proposed tool call — including hard floors,
   * the denylist, the matched rule, and whether a live evaluation would
   * mint a pending approval — WITHOUT creating approvals or writing audit
   * entries. Powers the policy simulator (POST /api/policy/simulate) so
   * policy authors can test rules safely before they govern real runs.
   *
   * Evaluates against an explicit policy when given (per-bot merged policy
   * from the API layer), otherwise the gateway's own policy.
   */
  async simulate(
    toolName: string,
    args: Record<string, unknown>,
    policy?: Policy,
  ): Promise<SimulationResult> {
    const d = this.decidePolicy(toolName, args, policy ?? this.policy);
    const reason =
      d.floorHit?.reason ??
      (d.denylistHit ? 'denylist: destructive command pattern' : (d.matchedRule?.reason ?? 'default policy'));
    return {
      effect: d.effect,
      actionClass: d.actionClass,
      matchedRuleId: d.matchedRule?.id,
      reason,
      wouldCreateApproval: d.effect === 'require-approval',
      hardFloor: d.floorHit
        ? { tier: d.floorHit.tier, reason: d.floorHit.reason, patternId: d.floorHit.patternId }
        : undefined,
      denylist: d.denylistHit || undefined,
      simulated: true,
    };
  }

  private async evaluateInner(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
    policy: Policy,
  ): Promise<EvaluateResult> {
    const d = this.decidePolicy(toolName, args, policy);
    const { actionClass, floorHit, matchedRule: rule } = d;

    if (floorHit && floorHit.tier === 'catastrophic') {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'deny',
        detail: {
          reason: floorHit.reason,
          actionClass,
          catastrophic: true,
          patternId: floorHit.patternId,
          args: redactSecrets(args),
        },
      });
      return { effect: 'deny' };
    }
    if (floorHit) {
      const approvalId = this.requestApproval(toolName, args, ctx, {
        provenance: 'hard-floor-escalated',
        relayed: ctx.relayed,
        addresseePersonId: ctx.addresseePersonId,
        neverExpire: ctx.neverExpire,
      });
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'require-approval',
        detail: {
          reason: floorHit.reason,
          actionClass,
          provenance: 'hard-floor-escalated',
          patternId: floorHit.patternId,
          args: redactSecrets(args),
        },
      });
      return { effect: 'require-approval', approvalId };
    }

    if (d.denylistHit) {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'deny',
        detail: {
          reason: 'denylist: destructive command pattern',
          actionClass,
          args: redactSecrets(args),
        },
      });
      return { effect: 'deny' };
    }

    const effect = d.effect;

    if (effect === 'allow') {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'allow',
        detail: { reason: rule?.reason ?? 'default policy', ruleId: rule?.id },
      });
      return { effect };
    }

    if (effect === 'deny') {
      this.audit('tool.evaluate', {
        actor: ctx.actor,
        sessionId: ctx.sessionId,
        toolName,
        decision: 'deny',
        detail: {
          reason: rule?.reason ?? 'default policy',
          ruleId: rule?.id,
          args: redactSecrets(args),
        },
      });
      return { effect };
    }

    // require-approval: persist a pending approval with a redacted args snapshot.
    const approvalId = this.requestApproval(toolName, args, ctx, {
      relayed: ctx.relayed,
      addresseePersonId: ctx.addresseePersonId,
      neverExpire: ctx.neverExpire,
    });
    this.audit('approval.created', {
      actor: ctx.actor,
      sessionId: ctx.sessionId,
      toolName,
      decision: 'require-approval',
      detail: { approvalId, args: redactSecrets(args) },
    });
    return { effect, approvalId };
  }

  /**
   * Create a standalone approval request (e.g. for workflow approval nodes
   * or any human-in-the-loop step that is not a tool call). Returns the
   * approval id; the caller typically follows with awaitDecision().
   */
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
    opts: {
      provenance?: string;
      relayed?: boolean;
      addresseePersonId?: string;
      /** W12: the approval never expires (expiresAt = null). */
      neverExpire?: boolean;
    } = {},
  ): string {
    const addresseePersonId = opts.addresseePersonId ?? ctx.addresseePersonId;
    const neverExpire = opts.neverExpire === true || ctx.neverExpire === true;
    const now = Date.now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      ts: now,
      sessionId: ctx.sessionId,
      botId: ctx.botId,
      actor: ctx.actor,
      toolName,
      args: redactSecrets(args),
      status: 'pending',
      provenance: opts.provenance,
      expiresAt: neverExpire ? null : now + this.approvalTimeoutMs,
      ...(neverExpire ? { neverExpire: true } : {}),
      ...(opts.relayed === true ? { relayed: true } : {}),
      ...(addresseePersonId ? { addresseePersonId } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, ts, session_id, bot_id, actor, tool_name, args_json, status, provenance, relayed, addressee_person_id, expires_at, never_expire)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.ts,
        record.sessionId,
        record.botId,
        record.actor,
        record.toolName,
        JSON.stringify(record.args),
        record.status,
        record.provenance ?? null,
        record.relayed === true ? 1 : 0,
        record.addresseePersonId ?? null,
        record.expiresAt ?? null,
        neverExpire ? 1 : 0,
      );
    return record.id;
  }

  /**
   * Wait until an approval is decided. Resolves 'approved' or 'denied'.
   * On timeout the approval is marked 'expired' and the promise resolves
   * 'denied' (fail closed).
   */
  async awaitDecision(
    approvalId: string,
    timeoutMs?: number,
  ): Promise<'approved' | 'denied'> {
    const rec = this.getApproval(approvalId);
    if (!rec) {
      throw new Error(`approval not found: ${approvalId}`);
    }
    if (rec.status === 'approved') return 'approved';
    if (rec.status === 'denied' || rec.status === 'expired') return 'denied';

    const timeout = timeoutMs ?? this.approvalTimeoutMs;
    // W12: a never-expire approval is NEVER marked expired. When the
    // caller supplied an explicit wait timeout, the wait still ends
    // (resolving 'denied' for this caller, fail-closed) but the record
    // stays pending and decidable; with no explicit timeout the wait is
    // unbounded and resolves only on decide().
    const neverExpire = rec.neverExpire === true;
    return new Promise<'approved' | 'denied'>((resolve) => {
      if (neverExpire && timeoutMs === undefined) {
        this.waiters.set(approvalId, { resolve });
        return;
      }
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        if (!neverExpire) {
          this.markExpired(approvalId);
          this.audit('approval.expired', {
            actor: rec.actor,
            sessionId: rec.sessionId,
            toolName: rec.toolName,
            decision: 'expired',
            detail: { approvalId },
          });
        }
        resolve('denied');
      }, timeout);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiters.set(approvalId, { resolve, timer });
    });
  }

  /**
   * Record a human decision on a pending approval. Throws if the approval
   * does not exist or is no longer pending. Resolves any in-flight
   * awaitDecision() waiter and appends an audit entry.
   *
   * Guarded external messages: a relayed approval can NEVER be approved —
   * the decision throws, the approval stays pending (the operator can deny
   * it explicitly). Denying a relayed approval is always allowed.
   */
  decide(
    approvalId: string,
    decision: 'approved' | 'denied',
    opts: { decidedBy?: string; note?: string } = {},
  ): ApprovalRecord {
    const rec = this.getApproval(approvalId);
    if (!rec) {
      throw new Error(`approval not found: ${approvalId}`);
    }
    if (rec.status !== 'pending') {
      throw new Error(`approval ${approvalId} is ${rec.status}, not pending`);
    }
    if (decision === 'approved' && rec.relayed === true) {
      this.audit('approval.relayed_blocked', {
        actor: opts.decidedBy ?? rec.actor,
        sessionId: rec.sessionId,
        toolName: rec.toolName,
        decision: 'deny',
        detail: { approvalId, reason: 'relayed messages can never satisfy an approval' },
      });
      throw new Error(
        `approval ${approvalId} was raised from a relayed external message and cannot be approved — deny it or handle it out of band`,
      );
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE approvals
         SET status = ?, decided_at = ?, decided_by = ?, note = ?
         WHERE id = ?`,
      )
      .run(decision, now, opts.decidedBy ?? null, opts.note ?? null, approvalId);

    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.waiters.delete(approvalId);
      waiter.resolve(decision);
    }

    this.audit('approval.decided', {
      actor: opts.decidedBy ?? rec.actor,
      sessionId: rec.sessionId,
      toolName: rec.toolName,
      decision,
      detail: { approvalId, note: opts.note },
    });

    const updated = this.getApproval(approvalId);
    if (!updated) {
      throw new Error(`approval vanished after decision: ${approvalId}`);
    }
    return updated;
  }

  /**
   * List approvals, newest first, optionally filtered by status and/or
   * (W7) addressee person / bot. Filters combine with AND.
   */
  listApprovals(
    status?: ApprovalStatus,
    filter?: { addresseePersonId?: string; botId?: string },
  ): ApprovalRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (filter?.addresseePersonId) {
      clauses.push('addressee_person_id = ?');
      params.push(filter.addresseePersonId);
    }
    if (filter?.botId) {
      clauses.push('bot_id = ?');
      params.push(filter.botId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM approvals${where} ORDER BY ts DESC`)
      .all(...params) as unknown as ApprovalRow[];
    return rows.map(GovernanceGateway.rowToRecord);
  }

  /** Fetch a single approval by id. */
  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .get(id) as unknown as ApprovalRow | undefined;
    return row ? GovernanceGateway.rowToRecord(row) : undefined;
  }

  /**
   * Append an audit entry. `detail` is secret-redacted and JSON-stringified
   * before storage, so API keys and tokens never reach the audit log.
   */
  audit(
    action: string,
    fields: {
      actor?: string;
      sessionId?: string;
      toolName?: string;
      decision?: string;
      detail?: unknown;
    } = {},
  ): void {
    let detailJson: string | null = null;
    if (fields.detail !== undefined) {
      const redacted = redactSecrets(fields.detail);
      try {
        detailJson = JSON.stringify(redacted);
      } catch {
        detailJson = JSON.stringify({ note: '[unserializable detail]' });
      }
    }
    this.db
      .prepare(
        `INSERT INTO audit_log
           (ts, actor, session_id, action, tool_name, decision, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        fields.actor ?? 'system',
        fields.sessionId ?? null,
        action,
        fields.toolName ?? null,
        fields.decision ?? null,
        detailJson,
      );
    // M4: periodic retention sweep — every K inserts, prune old rows. A
    // prune failure must never break auditing, so it is best-effort.
    this.auditInsertsSincePrune += 1;
    if (this.auditInsertsSincePrune >= this.auditPruneEvery) {
      this.auditInsertsSincePrune = 0;
      try {
        this.pruneAuditLog(this.auditMaxRows, this.auditMaxAgeMs);
      } catch {
        // ignore — auditing continues; the next sweep retries
      }
    }
  }

  /**
   * Enforce audit-log retention (M4): keep the newest `maxRows` rows plus
   * every row newer than `maxAgeMs` — whichever keeps more — and delete the
   * rest. Public so admins/tests can trigger it directly.
   */
  pruneAuditLog(
    maxRows: number = AUDIT_RETENTION_MAX_ROWS,
    maxAgeMs: number = AUDIT_RETENTION_MAX_AGE_MS,
  ): { deleted: number } {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare(
        `DELETE FROM audit_log
          WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)
            AND ts < ?`,
      )
      .run(Math.max(0, Math.floor(maxRows)), cutoff);
    return { deleted: Number(result.changes ?? 0) };
  }

  /** Append-only audit log, newest first. */
  listAudit(limit = 100, offset = 0): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      sessionId: row.session_id ?? undefined,
      action: row.action,
      toolName: row.tool_name ?? undefined,
      decision: row.decision ?? undefined,
      detail: row.detail ?? undefined,
    }));
  }

  /** Register a pre-tool-execution hook (runs before the tool call). */
  addPreHook(fn: PreHook): void {
    this.preHooks.push(fn);
  }

  /** Register a post-tool-execution hook (runs after the tool call). */
  addPostHook(fn: PostHook): void {
    this.postHooks.push(fn);
  }

  /** Run pre-hooks in registration order; invoked by the agent runtime. */
  async runPreHooks(
    toolName: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
  ): Promise<void> {
    for (const fn of this.preHooks) {
      await fn(toolName, args, ctx);
    }
  }

  /** Run post-hooks in registration order; invoked by the agent runtime. */
  async runPostHooks(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    ctx: EvalContext,
  ): Promise<void> {
    for (const fn of this.postHooks) {
      await fn(toolName, args, result, ctx);
    }
  }

  private ruleMatches(
    rule: PolicyRule,
    toolName: string,
    actionClass: ActionClass,
  ): boolean {
    if (rule.actionClass !== undefined && rule.actionClass !== actionClass) {
      return false;
    }
    let re: RegExp;
    try {
      // Case-insensitive per the denylist naming convention (/delete|remove|drop|exec/i).
      re = new RegExp(rule.toolPattern, 'i');
    } catch {
      return false; // Invalid pattern: fail closed (no match).
    }
    return re.test(toolName);
  }

  private markExpired(approvalId: string): void {
    this.db
      .prepare(`UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`)
      .run(approvalId);
  }

  /**
   * W12 sweep: mark pending approvals whose stored expires_at has passed
   * as 'expired' and fail their in-flight waiters closed. Never-expire
   * approvals (expires_at NULL / flagged) and pre-W12 records (no stored
   * expiry) never match. Returns the transitioned ids.
   */
  expireStaleApprovals(now = Date.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND COALESCE(never_expire, 0) = 0 AND expires_at <= ?`,
      )
      .all(now) as unknown as Array<{ id: string }>;
    const expired: string[] = [];
    for (const r of rows) {
      this.markExpired(r.id);
      const waiter = this.waiters.get(r.id);
      if (waiter) {
        if (waiter.timer) clearTimeout(waiter.timer);
        this.waiters.delete(r.id);
        waiter.resolve('denied');
      }
      expired.push(r.id);
    }
    return expired;
  }

  private static rowToRecord(row: ApprovalRow): ApprovalRecord {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.args_json);
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt args_json: keep empty rather than crashing the gateway.
    }
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      botId: row.bot_id,
      actor: row.actor,
      toolName: row.tool_name,
      args,
      status: row.status,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      note: row.note ?? undefined,
      provenance: row.provenance ?? undefined,
      relayed: row.relayed === 1 ? true : undefined,
      addresseePersonId: row.addressee_person_id ?? undefined,
      // W12: never-expire approvals read back expiresAt: null + the flag;
      // ordinary approvals expose their stored expiry when present.
      expiresAt: row.never_expire === 1 ? null : (row.expires_at ?? undefined),
      ...(row.never_expire === 1 ? { neverExpire: true } : {}),
    };
  }
}
