// SPDX-License-Identifier: Apache-2.0
// Processing rules + firing log (Laya-inspired, adapted — not copied).
//
// User-defined rules that act on items flowing through the platform
// (messages, files, events, workflow outputs). Each rule has a matcher and
// an ordered action list; the supported actions are:
//
// - `tag`       — attach a label to the item (params: { tag: string }).
// - `route`     — route the item to a destination queue/bot (params: { destination: string }).
// - `run-agent` — invoke a platform agent/bot on the item (params: { agentId: string, input?: string }).
// - `egress`    — hand the item to an external target (params: { target: string }).
//
// Every rule FIRING (a rule whose matcher hit an item) writes one firing-log
// entry PER ACTION with rule id, item, action, outcome
// (success | error | skipped + reason) and timestamp. The firing log is
// queryable by rule, status, and time range via queryFiringLog().
//
// Persistence: SQLite `<dbPath>` (two tables: processing_rules,
// firing_log). The API layer exposes CRUD + the log over REST; the module
// API below is complete on its own.

import { randomUUID } from 'node:crypto';

// `node:sqlite` is loaded at runtime via process.getBuiltinModule instead of
// a static import because this repo's vitest (Vite 5.4.21) cannot statically
// resolve that specifier ("Failed to load url sqlite").
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type Database = InstanceType<typeof DatabaseSync>;

/** Actions a processing rule can take on a matched item. */
export type ProcessingActionType = 'tag' | 'route' | 'run-agent' | 'egress';

export const PROCESSING_ACTION_TYPES: ReadonlySet<string> = new Set([
  'tag',
  'route',
  'run-agent',
  'egress',
]);

export interface ProcessingAction {
  type: ProcessingActionType;
  params: Record<string, unknown>;
}

/**
 * Matcher: every specified field must match (AND). Omitted fields match
 * everything. `textPattern` is compiled as a case-insensitive RegExp and
 * tested against the item's text.
 */
export interface RuleMatch {
  textPattern?: string;
  kind?: string;
  source?: string;
}

export interface ProcessingRule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  actions: ProcessingAction[];
  createdAt: number;
  updatedAt: number;
}

/** The thing a rule acts on: a message, file, event, workflow output, … */
export interface ProcessingItem {
  id: string;
  kind: string;
  source?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

/** Outcome of a single action attempt. */
export type FiringStatus = 'success' | 'error' | 'skipped';

export interface ActionOutcome {
  status: FiringStatus;
  /** Human-readable reason for error/skipped (and optional note for success). */
  reason?: string;
  /** Small JSON-safe payload (ids, tags, destinations — never secrets). */
  detail?: Record<string, unknown>;
}

/** One row of the firing log: rule id, item, action, outcome, timestamp. */
export interface FiringLogEntry {
  id: number;
  ts: number;
  ruleId: string;
  ruleName: string;
  itemId: string;
  itemKind: string;
  action: ProcessingActionType;
  status: FiringStatus;
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * Executes a single action against an item. Hosts inject their own runner
 * (e.g. one that really routes items or invokes agents); the default runner
 * handles tag/route locally and skips run-agent/egress without handlers.
 */
export interface ActionRunner {
  run(
    action: ProcessingAction,
    item: ProcessingItem,
    ctx: { ruleId: string; ruleName: string; actor: string },
  ): Promise<ActionOutcome>;
}

export interface DefaultActionRunnerOptions {
  /** Actually invoke an agent. Without it, run-agent actions are 'skipped'. */
  agentRunner?: (
    action: ProcessingAction,
    item: ProcessingItem,
  ) => Promise<{ status: 'success' | 'error'; reason?: string; detail?: Record<string, unknown> }>;
  /** Actually egress the item. Without it, egress actions are 'skipped'. */
  egressRunner?: (
    action: ProcessingAction,
    item: ProcessingItem,
  ) => Promise<{ status: 'success' | 'error'; reason?: string; detail?: Record<string, unknown> }>;
}

/** Sensible default runner: tag/route are recorded; agent/egress need handlers. */
export class DefaultActionRunner implements ActionRunner {
  private readonly agentRunner?: DefaultActionRunnerOptions['agentRunner'];
  private readonly egressRunner?: DefaultActionRunnerOptions['egressRunner'];

  constructor(opts: DefaultActionRunnerOptions = {}) {
    this.agentRunner = opts.agentRunner;
    this.egressRunner = opts.egressRunner;
  }

  async run(
    action: ProcessingAction,
    item: ProcessingItem,
    _ctx: { ruleId: string; ruleName: string; actor: string },
  ): Promise<ActionOutcome> {
    switch (action.type) {
      case 'tag': {
        const tag = action.params['tag'];
        if (typeof tag !== 'string' || tag.length === 0) {
          return { status: 'error', reason: 'tag action requires a non-empty string param "tag"' };
        }
        return { status: 'success', detail: { tag, itemId: item.id } };
      }
      case 'route': {
        const destination = action.params['destination'];
        if (typeof destination !== 'string' || destination.length === 0) {
          return { status: 'error', reason: 'route action requires a non-empty string param "destination"' };
        }
        return { status: 'success', detail: { destination, itemId: item.id } };
      }
      case 'run-agent': {
        if (!this.agentRunner) {
          return { status: 'skipped', reason: 'no agent runner configured for run-agent actions' };
        }
        const res = await this.agentRunner(action, item);
        return { status: res.status, reason: res.reason, detail: res.detail };
      }
      case 'egress': {
        if (!this.egressRunner) {
          return { status: 'skipped', reason: 'no egress runner configured for egress actions' };
        }
        const res = await this.egressRunner(action, item);
        return { status: res.status, reason: res.reason, detail: res.detail };
      }
    }
  }
}

export interface FiringReport {
  itemId: string;
  /** Ids of rules whose matcher hit, in evaluation order. */
  matchedRuleIds: string[];
  /** One entry per attempted action, in execution order. */
  firings: FiringLogEntry[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS firing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_firing_rule_ts ON firing_log(rule_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_firing_status_ts ON firing_log(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_firing_ts ON firing_log(ts DESC);
`;

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  match_json: string;
  actions_json: string;
  created_at: number;
  updated_at: number;
}

interface FiringRow {
  id: number;
  ts: number;
  rule_id: string;
  rule_name: string;
  item_id: string;
  item_kind: string;
  action: string;
  status: string;
  reason: string | null;
  detail_json: string | null;
}

function requireNonEmptyString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v.trim();
}

function validateMatch(match: unknown): RuleMatch {
  if (match === undefined || match === null) return {};
  if (typeof match !== 'object' || Array.isArray(match)) {
    throw new Error('rule "match" must be an object');
  }
  const m = match as Record<string, unknown>;
  const out: RuleMatch = {};
  if (m['textPattern'] !== undefined) {
    const p = requireNonEmptyString(m['textPattern'], 'match.textPattern');
    try {
      new RegExp(p, 'i');
    } catch {
      throw new Error(`match.textPattern is not a valid regular expression: ${p}`);
    }
    out.textPattern = p;
  }
  if (m['kind'] !== undefined) out.kind = requireNonEmptyString(m['kind'], 'match.kind');
  if (m['source'] !== undefined) out.source = requireNonEmptyString(m['source'], 'match.source');
  return out;
}

const ACTION_REQUIRED_PARAMS: Record<ProcessingActionType, string> = {
  tag: 'tag',
  route: 'destination',
  'run-agent': 'agentId',
  egress: 'target',
};

function validateActions(actions: unknown): ProcessingAction[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('rule "actions" must be a non-empty array');
  }
  return actions.map((a, i) => {
    if (typeof a !== 'object' || a === null) {
      throw new Error(`actions[${i}] must be an object`);
    }
    const { type, params } = a as { type?: unknown; params?: unknown };
    if (typeof type !== 'string' || !PROCESSING_ACTION_TYPES.has(type)) {
      throw new Error(
        `actions[${i}].type must be one of ${[...PROCESSING_ACTION_TYPES].join('|')}`,
      );
    }
    const t = type as ProcessingActionType;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new Error(`actions[${i}].params must be an object`);
    }
    const required = ACTION_REQUIRED_PARAMS[t];
    const pv = (params as Record<string, unknown>)[required];
    if (typeof pv !== 'string' || pv.length === 0) {
      throw new Error(`actions[${i}] (${t}) requires a non-empty string param "${required}"`);
    }
    return { type: t, params: params as Record<string, unknown> };
  });
}

function rowToRule(row: RuleRow): ProcessingRule {
  let match: RuleMatch = {};
  let actions: ProcessingAction[] = [];
  try {
    const m: unknown = JSON.parse(row.match_json);
    if (typeof m === 'object' && m !== null) match = m as RuleMatch;
  } catch {
    // keep default
  }
  try {
    const a: unknown = JSON.parse(row.actions_json);
    if (Array.isArray(a)) actions = a as ProcessingAction[];
  } catch {
    // keep default
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    match,
    actions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEntry(row: FiringRow): FiringLogEntry {
  let detail: Record<string, unknown> | undefined;
  if (row.detail_json) {
    try {
      const d: unknown = JSON.parse(row.detail_json);
      if (typeof d === 'object' && d !== null) detail = d as Record<string, unknown>;
    } catch {
      // keep undefined
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    itemId: row.item_id,
    itemKind: row.item_kind,
    action: row.action as ProcessingActionType,
    status: row.status as FiringStatus,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * SQLite-backed store for processing rules and their firing log.
 * Lives in its own `<dataDir>/processing-rules.db` so rule administration
 * never contends with approval/audit writes in governance.db.
 */
export class ProcessingRuleStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Create a rule. Throws on invalid match/actions. */
  createRule(input: {
    name: unknown;
    match?: unknown;
    actions: unknown;
    enabled?: unknown;
    id?: string;
  }): ProcessingRule {
    const name = requireNonEmptyString(input.name, 'rule "name"');
    const match = validateMatch(input.match);
    const actions = validateActions(input.actions);
    const enabled = input.enabled === undefined ? true : input.enabled === true;
    const now = Date.now();
    const rule: ProcessingRule = {
      id: input.id ?? `rule_${randomUUID()}`,
      name,
      enabled,
      match,
      actions,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO processing_rules (id, name, enabled, match_json, actions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        JSON.stringify(rule.match),
        JSON.stringify(rule.actions),
        rule.createdAt,
        rule.updatedAt,
      );
    return rule;
  }

  getRule(id: string): ProcessingRule | undefined {
    const row = this.db
      .prepare(`SELECT * FROM processing_rules WHERE id = ?`)
      .get(id) as unknown as RuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  listRules(opts: { enabledOnly?: boolean } = {}): ProcessingRule[] {
    const rows = this.db
      .prepare(
        opts.enabledOnly
          ? `SELECT * FROM processing_rules WHERE enabled = 1 ORDER BY created_at ASC`
          : `SELECT * FROM processing_rules ORDER BY created_at ASC`,
      )
      .all() as unknown as RuleRow[];
    return rows.map(rowToRule);
  }

  /** Partial update: name, match, actions, enabled. Throws on invalid input. */
  updateRule(
    id: string,
    patch: { name?: unknown; match?: unknown; actions?: unknown; enabled?: unknown },
  ): ProcessingRule {
    const existing = this.getRule(id);
    if (!existing) throw new Error(`unknown processing rule: ${id}`);
    const name = patch.name === undefined ? existing.name : requireNonEmptyString(patch.name, 'rule "name"');
    const match = patch.match === undefined ? existing.match : validateMatch(patch.match);
    const actions = patch.actions === undefined ? existing.actions : validateActions(patch.actions);
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled === true;
    const updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE processing_rules SET name = ?, enabled = ?, match_json = ?, actions_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(name, enabled ? 1 : 0, JSON.stringify(match), JSON.stringify(actions), updatedAt, id);
    const updated = this.getRule(id);
    if (!updated) throw new Error(`processing rule vanished after update: ${id}`);
    return updated;
  }

  deleteRule(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM processing_rules WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /**
   * Evaluate all enabled rules against an item, run each matched rule's
   * actions through the runner, and append one firing-log entry per action
   * (success | error | skipped + reason). Runner exceptions become 'error'
   * entries — firing never throws for a bad action.
   */
  async fire(
    item: ProcessingItem,
    opts: { runner?: ActionRunner; actor?: string } = {},
  ): Promise<FiringReport> {
    requireNonEmptyString(item.id, 'item.id');
    requireNonEmptyString(item.kind, 'item.kind');
    const runner = opts.runner ?? new DefaultActionRunner();
    const actor = opts.actor ?? 'system';
    const rules = this.listRules({ enabledOnly: true });
    const report: FiringReport = { itemId: item.id, matchedRuleIds: [], firings: [] };
    for (const rule of rules) {
      if (!ruleMatches(rule.match, item)) continue;
      const single = await this.fireOne(rule, item, runner, actor);
      report.matchedRuleIds.push(...single.matchedRuleIds);
      report.firings.push(...single.firings);
    }
    return report;
  }

  /**
   * Fire exactly one rule by id against an item. Throws when the rule is
   * unknown; a disabled rule matches nothing (no firings, no log entries).
   */
  async fireRule(
    ruleId: string,
    item: ProcessingItem,
    opts: { runner?: ActionRunner; actor?: string } = {},
  ): Promise<FiringReport> {
    requireNonEmptyString(item.id, 'item.id');
    requireNonEmptyString(item.kind, 'item.kind');
    const rule = this.getRule(ruleId);
    if (!rule) throw new Error(`unknown processing rule: ${ruleId}`);
    if (!rule.enabled) {
      return { itemId: item.id, matchedRuleIds: [], firings: [] };
    }
    const runner = opts.runner ?? new DefaultActionRunner();
    return this.fireOne(rule, item, runner, opts.actor ?? 'system');
  }

  private async fireOne(
    rule: ProcessingRule,
    item: ProcessingItem,
    runner: ActionRunner,
    actor: string,
  ): Promise<FiringReport> {
    const report: FiringReport = { itemId: item.id, matchedRuleIds: [], firings: [] };
    if (!ruleMatches(rule.match, item)) return report;
    report.matchedRuleIds.push(rule.id);
    for (const action of rule.actions) {
      let outcome: ActionOutcome;
      try {
        outcome = await runner.run(action, item, {
          ruleId: rule.id,
          ruleName: rule.name,
          actor,
        });
      } catch (err) {
        outcome = {
          status: 'error',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      report.firings.push(this.appendFiring(rule, item, action.type, outcome));
    }
    return report;
  }

  private appendFiring(
    rule: ProcessingRule,
    item: ProcessingItem,
    action: ProcessingActionType,
    outcome: ActionOutcome,
  ): FiringLogEntry {
    const ts = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO firing_log (ts, rule_id, rule_name, item_id, item_kind, action, status, reason, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        rule.id,
        rule.name,
        item.id,
        item.kind,
        action,
        outcome.status,
        outcome.reason ?? null,
        outcome.detail ? JSON.stringify(outcome.detail) : null,
      );
    return {
      id: Number(res.lastInsertRowid),
      ts,
      ruleId: rule.id,
      ruleName: rule.name,
      itemId: item.id,
      itemKind: item.kind,
      action,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  /**
   * Search the firing log, newest first. Filter by rule id, outcome
   * status, and/or an inclusive [since, until] timestamp range (ms).
   */
  queryFiringLog(
    opts: {
      ruleId?: string;
      status?: FiringStatus | string;
      since?: number;
      until?: number;
      limit?: number;
    } = {},
  ): FiringLogEntry[] {
    const conds: string[] = [];
    const args: Array<string | number> = [];
    if (opts.ruleId) {
      conds.push('rule_id = ?');
      args.push(opts.ruleId);
    }
    if (opts.status) {
      conds.push('status = ?');
      args.push(opts.status);
    }
    if (opts.since !== undefined) {
      conds.push('ts >= ?');
      args.push(opts.since);
    }
    if (opts.until !== undefined) {
      conds.push('ts <= ?');
      args.push(opts.until);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const rows = this.db
      .prepare(`SELECT * FROM firing_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as unknown as FiringRow[];
    return rows.map(rowToEntry);
  }
}

function ruleMatches(match: RuleMatch, item: ProcessingItem): boolean {
  if (match.kind !== undefined && match.kind !== item.kind) return false;
  if (match.source !== undefined && match.source !== item.source) return false;
  if (match.textPattern !== undefined) {
    const text = item.text ?? '';
    let re: RegExp;
    try {
      re = new RegExp(match.textPattern, 'i');
    } catch {
      return false; // invalid pattern: fail closed (no match)
    }
    if (!re.test(text)) return false;
  }
  return true;
}
