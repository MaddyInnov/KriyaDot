// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets broker (Timon parity programme, item A12).
 *
 * Reasoning: bots sometimes need to act on an outside service (GitHub)
 * with the user's credential, but the credential VALUE must never enter
 * the bot's context — the same trust model as the type_login tool, one
 * level up. Instead of handing the bot a token, the APP holds the token
 * (in the encrypted vault) and performs the authenticated call itself:
 * the bot requests a typed ACTION from a small catalogue, the broker
 * checks a grant, executes the call against the identity's canonical API
 * host only, and returns just the shaped result.
 *
 * What the broker does and does not protect (stated honestly, in our own
 * words): it protects the credential value — the token never appears in
 * tool arguments, tool results, transcripts, error messages, or the
 * journal. It does NOT hide how the credential is used: every grant
 * decision and every executed/refused action is journaled, and that
 * journal is the control surface for usage.
 *
 * Grants (mirroring the PC-access pattern in pc-access.ts):
 * - Per-run grants: when a bot first requests an action class for an
 *   identity in a run (session), a request card is raised through the
 *   host approval flow. Approving grants that (bot, session, identity,
 *   action class) until the run ends or the run-grant TTL lapses —
 *   whichever comes first; expiry fails closed. Deny (or no approval
 *   host, timeout, expiry) refuses the action and no call is made.
 * - Standing grants: per bot+identity+action class, created ONLY by the
 *   user in Settings (the API routes call addStandingGrant; the bot
 *   plane has no path to it — approving a request card never creates
 *   one). Revocation takes effect on the very next broker call because
 *   grants are read from the store on every execution.
 *
 * Host allowlist: every brokered call goes to the identity's canonical
 * API base (https://api.github.com for GitHub) whose host must be on the
 * configured allowlist — construction fails closed otherwise. Action
 * arguments can never steer the call: URL/host/header-shaped argument
 * keys are rejected, and owner/repo/number arguments are strictly
 * pattern-validated before a path is built from catalogue templates.
 *
 * Policy ceiling: this module sits BELOW governance. The broker tool is
 * marked mutating, so the caller's governance policy (approval modes,
 * catastrophic denials) still evaluates first, unchanged.
 *
 * Journal: append-only rows in `broker.db` carrying the event, bot,
 * session, identity, action, action class, target resource id, and a
 * SHA-256 hash of the arguments — never the credential, and never
 * argument bodies (issue titles/bodies are user content; only their
 * hash and the resulting resource id are journaled).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './sqlite.js';

// ---------------------------------------------------------------------------
// Identities + action catalogue
// ---------------------------------------------------------------------------

export type BrokerIdentity = 'github';

export type BrokerActionClass = 'read' | 'write';

export const BROKER_IDENTITIES: readonly BrokerIdentity[] = ['github'];

/** Canonical API base per identity — the ONLY base the broker will call. */
export const BROKER_CANONICAL_BASE: Record<BrokerIdentity, string> = {
  github: 'https://api.github.com',
};

/** Vault secret name holding the GitHub credential (written by Settings). */
export const GITHUB_BROKER_VAULT_NAME = 'broker-github';

export interface BrokerActionSpec {
  /** Dotted action name the bot asks for, e.g. "github.create_issue". */
  name: string;
  identity: BrokerIdentity;
  actionClass: BrokerActionClass;
  mutating: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// Argument validation (strict — arguments can never steer the request)
// ---------------------------------------------------------------------------

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Argument keys that could steer the call or smuggle a credential. */
const FORBIDDEN_ARG_KEYS = new Set([
  'url',
  'baseurl',
  'base_url',
  'host',
  'hostname',
  'endpoint',
  'apiurl',
  'api_url',
  'token',
  'accesstoken',
  'access_token',
  'authorization',
  'headers',
  'header',
]);

export class BrokerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function brokerError(code: string, message: string): BrokerError {
  return new BrokerError(code, message);
}

function rejectForbiddenKeys(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_ARG_KEYS.has(key.toLowerCase())) {
      throw brokerError(
        'steering_rejected',
        `argument "${key}" is not allowed: brokered calls always go to the identity's canonical API host with the app-held credential`,
      );
    }
  }
}

function requireOwner(args: Record<string, unknown>): string {
  const v = args['owner'];
  if (typeof v !== 'string' || !OWNER_PATTERN.test(v)) {
    throw brokerError('invalid_args', '"owner" must be a valid GitHub owner login (letters, digits, hyphens)');
  }
  return v;
}

function requireRepo(args: Record<string, unknown>): string {
  const v = args['repo'];
  if (
    typeof v !== 'string' ||
    !REPO_PATTERN.test(v) ||
    v === '.' ||
    v === '..' ||
    v.includes('..') ||
    v.includes('/') ||
    v.includes('\\')
  ) {
    throw brokerError('invalid_args', '"repo" must be a valid GitHub repository name (no slashes or dot segments)');
  }
  return v;
}

function requireTitle(args: Record<string, unknown>): string {
  const v = args['title'];
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 256) {
    throw brokerError('invalid_args', '"title" must be a non-empty string of at most 256 characters');
  }
  return v;
}

function optionalBody(args: Record<string, unknown>): string | undefined {
  const v = args['body'];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > 65_536) {
    throw brokerError('invalid_args', '"body" must be a string of at most 64 KiB');
  }
  return v;
}

function requireCommentBody(args: Record<string, unknown>): string {
  const v = args['body'];
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 65_536) {
    throw brokerError('invalid_args', '"body" must be a non-empty string of at most 64 KiB');
  }
  return v;
}

function requireIssueNumber(args: Record<string, unknown>): number {
  const v = args['number'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10_000_000) {
    throw brokerError('invalid_args', '"number" must be a positive integer (issue or pull request number)');
  }
  return v;
}

function optionalState(args: Record<string, unknown>): 'open' | 'closed' | 'all' {
  const v = args['state'];
  if (v === undefined) return 'open';
  if (v !== 'open' && v !== 'closed' && v !== 'all') {
    throw brokerError('invalid_args', '"state" must be one of open|closed|all');
  }
  return v;
}

function optionalPerPage(args: Record<string, unknown>): number {
  const v = args['perPage'];
  if (v === undefined) return 30;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
    throw brokerError('invalid_args', '"perPage" must be an integer between 1 and 100');
  }
  return v;
}

// ---------------------------------------------------------------------------
// Planned calls: a validated action becomes exactly one HTTP request built
// from a catalogue template. `resource` is the journal-safe target id.
// ---------------------------------------------------------------------------

interface PlannedCall {
  method: 'GET' | 'POST';
  /** Path (+ query) appended to the identity's canonical base. */
  path: string;
  body?: Record<string, unknown>;
  /** Journal-safe target, e.g. "octocat/hello-world#42". Never content. */
  resource: string;
  /** Shape the upstream JSON into the minimal result returned to the bot. */
  shape: (data: unknown) => unknown;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

interface ActionDef extends BrokerActionSpec {
  plan: (args: Record<string, unknown>) => PlannedCall;
}

const GITHUB_ACTIONS: ActionDef[] = [
  {
    name: 'github.list_repos',
    identity: 'github',
    actionClass: 'read',
    mutating: false,
    description: 'List repositories visible to the connected GitHub credential.',
    plan: (args) => {
      const perPage = optionalPerPage(args);
      return {
        method: 'GET',
        path: `/user/repos?per_page=${perPage}&sort=updated`,
        resource: '@viewer/repos',
        shape: (data) =>
          Array.isArray(data)
            ? data.map((r) => pick(asRecord(r), ['full_name', 'private', 'default_branch']))
            : [],
      };
    },
  },
  {
    name: 'github.get_repo',
    identity: 'github',
    actionClass: 'read',
    mutating: false,
    description: 'Read one repository’s metadata.',
    plan: (args) => {
      const owner = requireOwner(args);
      const repo = requireRepo(args);
      return {
        method: 'GET',
        path: `/repos/${owner}/${repo}`,
        resource: `${owner}/${repo}`,
        shape: (data) =>
          pick(asRecord(data), ['full_name', 'private', 'default_branch', 'open_issues_count']),
      };
    },
  },
  {
    name: 'github.list_issues',
    identity: 'github',
    actionClass: 'read',
    mutating: false,
    description: 'List issues on a repository.',
    plan: (args) => {
      const owner = requireOwner(args);
      const repo = requireRepo(args);
      const state = optionalState(args);
      const perPage = optionalPerPage(args);
      return {
        method: 'GET',
        path: `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`,
        resource: `${owner}/${repo}`,
        shape: (data) =>
          Array.isArray(data)
            ? data.map((i) => pick(asRecord(i), ['number', 'title', 'state']))
            : [],
      };
    },
  },
  {
    name: 'github.list_pull_requests',
    identity: 'github',
    actionClass: 'read',
    mutating: false,
    description: 'List pull requests on a repository.',
    plan: (args) => {
      const owner = requireOwner(args);
      const repo = requireRepo(args);
      const state = optionalState(args);
      const perPage = optionalPerPage(args);
      return {
        method: 'GET',
        path: `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`,
        resource: `${owner}/${repo}`,
        shape: (data) =>
          Array.isArray(data)
            ? data.map((p) => pick(asRecord(p), ['number', 'title', 'state']))
            : [],
      };
    },
  },
  {
    name: 'github.create_issue',
    identity: 'github',
    actionClass: 'write',
    mutating: true,
    description: 'Create an issue on a repository.',
    plan: (args) => {
      const owner = requireOwner(args);
      const repo = requireRepo(args);
      const title = requireTitle(args);
      const body = optionalBody(args);
      return {
        method: 'POST',
        path: `/repos/${owner}/${repo}/issues`,
        body: { title, ...(body !== undefined ? { body } : {}) },
        resource: `${owner}/${repo}`,
        shape: (data) => pick(asRecord(data), ['number', 'html_url', 'state']),
      };
    },
  },
  {
    name: 'github.comment',
    identity: 'github',
    actionClass: 'write',
    mutating: true,
    description: 'Comment on an issue or pull request (GitHub serves both through the issue-comments endpoint).',
    plan: (args) => {
      const owner = requireOwner(args);
      const repo = requireRepo(args);
      const number = requireIssueNumber(args);
      const body = requireCommentBody(args);
      return {
        method: 'POST',
        path: `/repos/${owner}/${repo}/issues/${number}/comments`,
        body: { body },
        resource: `${owner}/${repo}#${number}`,
        shape: (data) => pick(asRecord(data), ['id', 'html_url']),
      };
    },
  },
];

export const BROKER_ACTIONS: readonly BrokerActionSpec[] = GITHUB_ACTIONS.map(
  ({ name, identity, actionClass, mutating, description }) => ({
    name,
    identity,
    actionClass,
    mutating,
    description,
  }),
);

const ACTION_BY_NAME = new Map<string, ActionDef>(GITHUB_ACTIONS.map((a) => [a.name, a]));

export function brokerActionSpec(name: string): BrokerActionSpec | undefined {
  const def = ACTION_BY_NAME.get(name);
  if (!def) return undefined;
  const { name: n, identity, actionClass, mutating, description } = def;
  return { name: n, identity, actionClass, mutating, description };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export type BrokerJournalEvent =
  | 'grant_requested'
  | 'grant_approved'
  | 'grant_denied'
  | 'action_executed'
  | 'action_refused'
  | 'standing_grant_created'
  | 'standing_grant_revoked'
  | 'identity_connected'
  | 'identity_disconnected';

export interface BrokerJournalEntry {
  id: string;
  ts: number;
  botId: string;
  sessionId: string | null;
  identity: BrokerIdentity;
  action: string | null;
  actionClass: BrokerActionClass | null;
  event: BrokerJournalEvent;
  /** Target resource id (e.g. "octocat/hello-world#42") — never content. */
  resource: string | null;
  /** SHA-256 of the canonical argument JSON — never the arguments. */
  argsHash: string | null;
  /** Machine-readable refusal/outcome code, e.g. "denied", "http_422". */
  detail: string | null;
}

export function hashBrokerArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex');
}

// ---------------------------------------------------------------------------
// Grants + request cards + journal store (SQLite, broker.db)
// ---------------------------------------------------------------------------

export interface BrokerStandingGrant {
  id: string;
  identity: BrokerIdentity;
  actionClass: BrokerActionClass;
  /** 'all' = every bot; otherwise the single bot id this grant is for. */
  scope: string;
  createdAt: number;
  createdVia: 'settings';
}

export type BrokerRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface BrokerGrantRequest {
  id: string;
  botId: string;
  sessionId: string;
  identity: BrokerIdentity;
  actionClass: BrokerActionClass;
  /** The action that triggered the request (display + journal context). */
  action: string;
  resource: string | null;
  status: BrokerRequestStatus;
  createdAt: number;
  expiresAt: number | null;
  decidedAt: number | null;
}

export const BROKER_REQUEST_TTL_MS = 15 * 60 * 1000;
export const BROKER_RUN_GRANT_TTL_MS = 60 * 60 * 1000;

interface StandingRow {
  id: string;
  identity: string;
  action_class: string;
  bot_id: string;
  created_at: number;
}

interface RequestRow {
  id: string;
  bot_id: string;
  session_id: string;
  identity: string;
  action_class: string;
  action: string;
  resource: string | null;
  status: string;
  created_at: number;
  expires_at: number | null;
  decided_at: number | null;
}

interface JournalRow {
  id: string;
  ts: number;
  bot_id: string;
  session_id: string | null;
  identity: string;
  action: string | null;
  action_class: string | null;
  event: string;
  resource: string | null;
  args_hash: string | null;
  detail: string | null;
}

export interface BrokerStoreOptions {
  requestTtlMs?: number;
  runGrantTtlMs?: number;
}

export class BrokerStore {
  private readonly db: DatabaseSync;
  private readonly requestTtlMs: number;
  private readonly runGrantTtlMs: number;
  /** requestId → waiter for the in-flight broker call. */
  private readonly waiters = new Map<string, (approved: boolean) => void>();
  /** Per-run (per-session) grants: key → expiresAt. In-memory by design —
   *  a run grant must not outlive the process that hosts the run. */
  private readonly runGrants = new Map<string, number>();

  constructor(dataDir: string, opts: BrokerStoreOptions = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.requestTtlMs = opts.requestTtlMs ?? BROKER_REQUEST_TTL_MS;
    this.runGrantTtlMs = opts.runGrantTtlMs ?? BROKER_RUN_GRANT_TTL_MS;
    this.db = openDb(join(dataDir, 'broker.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS broker_standing_grants (
        id TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        action_class TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_broker_grants ON broker_standing_grants (identity, action_class, bot_id);
      CREATE TABLE IF NOT EXISTS broker_requests (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        action_class TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_broker_requests_status ON broker_requests (status, expires_at);
      CREATE TABLE IF NOT EXISTS broker_journal (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        bot_id TEXT NOT NULL,
        session_id TEXT,
        identity TEXT NOT NULL,
        action TEXT,
        action_class TEXT,
        event TEXT NOT NULL,
        resource TEXT,
        args_hash TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_broker_journal_ts ON broker_journal (ts);
    `);
  }

  // ---- standing grants (USER-created in Settings only) --------------------

  addStandingGrant(input: {
    identity: BrokerIdentity;
    actionClass: BrokerActionClass;
    botId?: string | null;
  }): BrokerStandingGrant {
    const botKey = input.botId ?? '';
    const existing = this.db
      .prepare(
        'SELECT * FROM broker_standing_grants WHERE identity = ? AND action_class = ? AND bot_id = ? LIMIT 1',
      )
      .get(input.identity, input.actionClass, botKey) as StandingRow | undefined;
    if (existing) return this.rowToStanding(existing);
    const grant: BrokerStandingGrant = {
      id: randomUUID(),
      identity: input.identity,
      actionClass: input.actionClass,
      scope: botKey === '' ? 'all' : botKey,
      createdAt: Date.now(),
      createdVia: 'settings',
    };
    this.db
      .prepare(
        'INSERT INTO broker_standing_grants (id, identity, action_class, bot_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(grant.id, grant.identity, grant.actionClass, botKey, grant.createdAt);
    return grant;
  }

  listStandingGrants(): BrokerStandingGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM broker_standing_grants ORDER BY created_at ASC')
      .all() as unknown as StandingRow[];
    return rows.map((r) => this.rowToStanding(r));
  }

  revokeStandingGrant(id: string): BrokerStandingGrant | null {
    const row = this.db.prepare('SELECT * FROM broker_standing_grants WHERE id = ?').get(id) as
      | StandingRow
      | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM broker_standing_grants WHERE id = ?').run(id);
    return this.rowToStanding(row);
  }

  /** Read fresh on every broker execution — revocation is immediate. */
  hasStandingGrant(botId: string, identity: BrokerIdentity, actionClass: BrokerActionClass): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM broker_standing_grants WHERE identity = ? AND action_class = ? AND (bot_id = '' OR bot_id = ?) LIMIT 1",
      )
      .get(identity, actionClass, botId) as { id: string } | undefined;
    return row !== undefined;
  }

  // ---- per-run grants (session-scoped, TTL, fail closed) ------------------

  private runKey(botId: string, sessionId: string, identity: string, actionClass: string): string {
    return [botId, sessionId, identity, actionClass].join(' ');
  }

  grantRun(input: {
    botId: string;
    sessionId: string;
    identity: BrokerIdentity;
    actionClass: BrokerActionClass;
    ttlMs?: number;
  }): void {
    this.runGrants.set(
      this.runKey(input.botId, input.sessionId, input.identity, input.actionClass),
      Date.now() + (input.ttlMs ?? this.runGrantTtlMs),
    );
  }

  hasRunGrant(
    botId: string,
    sessionId: string,
    identity: BrokerIdentity,
    actionClass: BrokerActionClass,
    now = Date.now(),
  ): boolean {
    const key = this.runKey(botId, sessionId, identity, actionClass);
    const expiresAt = this.runGrants.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.runGrants.delete(key); // expired — fail closed
      return false;
    }
    return true;
  }

  // ---- just-in-time grant request cards ------------------------------------

  requestGrant(input: {
    botId: string;
    sessionId: string;
    identity: BrokerIdentity;
    actionClass: BrokerActionClass;
    action: string;
    resource?: string | null;
  }): BrokerGrantRequest {
    const existing = this.db
      .prepare(
        "SELECT * FROM broker_requests WHERE bot_id = ? AND session_id = ? AND identity = ? AND action_class = ? AND status = 'pending' LIMIT 1",
      )
      .get(input.botId, input.sessionId, input.identity, input.actionClass) as RequestRow | undefined;
    if (existing) return this.rowToRequest(existing);
    const now = Date.now();
    const req: BrokerGrantRequest = {
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId,
      identity: input.identity,
      actionClass: input.actionClass,
      action: input.action,
      resource: input.resource ?? null,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.requestTtlMs,
      decidedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO broker_requests (id, bot_id, session_id, identity, action_class, action, resource, status, created_at, expires_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        req.id, req.botId, req.sessionId, req.identity, req.actionClass, req.action,
        req.resource, req.status, req.createdAt, req.expiresAt, null,
      );
    return req;
  }

  getRequest(id: string): BrokerGrantRequest | undefined {
    const row = this.db.prepare('SELECT * FROM broker_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    return row ? this.rowToRequest(row) : undefined;
  }

  listRequests(status?: BrokerRequestStatus): BrokerGrantRequest[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM broker_requests WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM broker_requests ORDER BY created_at DESC').all()) as unknown as RequestRow[];
    return rows.map((r) => this.rowToRequest(r));
  }

  /**
   * Settle a request card with the user's decision. 'approve' records a
   * per-run grant for the requesting (bot, session, identity, class) —
   * it NEVER creates a standing grant; standing grants are a deliberate
   * Settings action only. Returns null when the card isn't pending.
   */
  decide(id: string, decision: 'approve' | 'deny'): BrokerGrantRequest | null {
    const req = this.getRequest(id);
    if (!req || req.status !== 'pending') return null;
    const status: BrokerRequestStatus = decision === 'approve' ? 'approved' : 'denied';
    const now = Date.now();
    this.db.prepare('UPDATE broker_requests SET status = ?, decided_at = ? WHERE id = ?').run(status, now, id);
    if (decision === 'approve') {
      this.grantRun({ botId: req.botId, sessionId: req.sessionId, identity: req.identity, actionClass: req.actionClass });
    }
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(decision === 'approve');
    }
    return { ...req, status, decidedAt: now };
  }

  /** Transition past-TTL pending cards to 'expired'. Returns expired ids. */
  expireStale(now = Date.now()): string[] {
    const rows = this.db
      .prepare("SELECT id FROM broker_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as unknown as Array<{ id: string }>;
    for (const r of rows) {
      this.db.prepare("UPDATE broker_requests SET status = 'expired', decided_at = ? WHERE id = ?").run(now, r.id);
      const waiter = this.waiters.get(r.id);
      if (waiter) {
        this.waiters.delete(r.id);
        waiter(false); // fail closed
      }
    }
    return rows.map((r) => r.id);
  }

  /** Wait for the user's decision. Resolves false on deny/expire/timeout. */
  awaitOutcome(id: string, timeoutMs = BROKER_REQUEST_TTL_MS): Promise<boolean> {
    const req = this.getRequest(id);
    if (!req) return Promise.resolve(false);
    if (req.status === 'approved') return Promise.resolve(true);
    if (req.status !== 'pending') return Promise.resolve(false);
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolvePromise(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiters.set(id, (approved) => {
        clearTimeout(timer);
        resolvePromise(approved);
      });
    });
  }

  // ---- journal ---------------------------------------------------------------

  appendJournal(entry: Omit<BrokerJournalEntry, 'id' | 'ts'> & { ts?: number }): BrokerJournalEntry {
    const full: BrokerJournalEntry = { ...entry, id: randomUUID(), ts: entry.ts ?? Date.now() };
    this.db
      .prepare(
        'INSERT INTO broker_journal (id, ts, bot_id, session_id, identity, action, action_class, event, resource, args_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        full.id, full.ts, full.botId, full.sessionId, full.identity, full.action,
        full.actionClass, full.event, full.resource, full.argsHash, full.detail,
      );
    return full;
  }

  listJournal(limit = 200): BrokerJournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM broker_journal ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as unknown as JournalRow[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      botId: r.bot_id,
      sessionId: r.session_id,
      identity: r.identity as BrokerIdentity,
      action: r.action,
      actionClass: r.action_class as BrokerActionClass | null,
      event: r.event as BrokerJournalEvent,
      resource: r.resource,
      argsHash: r.args_hash,
      detail: r.detail,
    }));
  }

  close(): void {
    this.db.close();
  }

  private rowToStanding(row: StandingRow): BrokerStandingGrant {
    return {
      id: row.id,
      identity: row.identity as BrokerIdentity,
      actionClass: row.action_class as BrokerActionClass,
      scope: row.bot_id === '' ? 'all' : row.bot_id,
      createdAt: row.created_at,
      createdVia: 'settings',
    };
  }

  private rowToRequest(row: RequestRow): BrokerGrantRequest {
    return {
      id: row.id,
      botId: row.bot_id,
      sessionId: row.session_id,
      identity: row.identity as BrokerIdentity,
      actionClass: row.action_class as BrokerActionClass,
      action: row.action,
      resource: row.resource,
      status: row.status as BrokerRequestStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Approval host (wired by the API, mirroring PcAccessHost)
// ---------------------------------------------------------------------------

export interface BrokerApprovalHost {
  /**
   * Raise a grant request card for (bot, session, identity, action class)
   * and await the user's decision. Implementations mint the card via the
   * BrokerStore, journal/audit the request, and resolve true only on an
   * explicit approve — deny, expiry, and timeout all resolve false.
   */
  requestGrant(input: {
    botId: string;
    sessionId: string;
    identity: BrokerIdentity;
    actionClass: BrokerActionClass;
    action: string;
    resource?: string | null;
  }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Broker service: holds the credential, makes the call, returns the result
// ---------------------------------------------------------------------------

/** Minimal fetch surface (the global fetch satisfies this structurally). */
export type BrokerFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SecretsBrokerOptions {
  store: BrokerStore;
  /**
   * Server-side credential resolution from the vault. Called inside
   * execute() only; the returned value is used solely as the outbound
   * Authorization header and is scrubbed from every output surface.
   */
  getCredential: (identity: BrokerIdentity) => string | undefined;
  /** Approval host for per-run grant cards. Absent → ungranted = refused. */
  approvalHost?: BrokerApprovalHost;
  /** Fetch implementation (tests inject one bound to a fake server). */
  fetchFn?: BrokerFetch;
  /**
   * API base per identity. Defaults to the canonical base. Overridable
   * ONLY by host wiring (tests point GitHub at a 127.0.0.1 fake) — never
   * by action arguments.
   */
  baseUrls?: Partial<Record<BrokerIdentity, string>>;
  /**
   * Hosts brokered calls may go to. Defaults to the canonical hosts.
   * Construction fails closed when a configured base is not allowlisted.
   */
  allowedHosts?: readonly string[];
  /** Fan-out for each journal entry (API wiring maps it to governance audit → Activity). */
  onJournal?: (entry: BrokerJournalEntry) => void;
}

export interface BrokerExecutionResult {
  ok: true;
  identity: BrokerIdentity;
  action: string;
  actionClass: BrokerActionClass;
  resource: string;
  result: unknown;
}

/** Replace every occurrence of the credential in a string. Defense in
 *  depth: outputs are constructed so this should never fire, but if an
 *  upstream body ever echoed the credential, it still cannot leak. */
export function scrubCredential(text: string, credential: string | undefined): string {
  if (!credential) return text;
  return text.split(credential).join('[redacted]');
}

export class SecretsBroker {
  private readonly store: BrokerStore;
  private readonly getCredential: SecretsBrokerOptions['getCredential'];
  private readonly approvalHost?: BrokerApprovalHost;
  private readonly fetchFn: BrokerFetch;
  private readonly baseUrls: Record<BrokerIdentity, string>;
  private readonly onJournal?: (entry: BrokerJournalEntry) => void;

  constructor(opts: SecretsBrokerOptions) {
    this.store = opts.store;
    this.getCredential = opts.getCredential;
    this.approvalHost = opts.approvalHost;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.onJournal = opts.onJournal;
    // Allowlist compares hostnames (no port): the canonical host is
    // "api.github.com"; test fakes are "127.0.0.1" on an ephemeral port.
    const allowed = new Set(
      (opts.allowedHosts ?? Object.values(BROKER_CANONICAL_BASE).map((b) => new URL(b).hostname)).map((h) =>
        h.toLowerCase(),
      ),
    );
    this.baseUrls = { ...BROKER_CANONICAL_BASE, ...(opts.baseUrls ?? {}) };
    for (const identity of BROKER_IDENTITIES) {
      const base = this.baseUrls[identity];
      let parsed: URL;
      try {
        parsed = new URL(base);
      } catch {
        throw brokerError('host_not_allowed', `broker base for ${identity} is not a valid URL`);
      }
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !allowed.has(parsed.hostname.toLowerCase())) {
        throw brokerError(
          'host_not_allowed',
          `broker base host for ${identity} is not on the allowlist — refusing to construct the broker`,
        );
      }
    }
  }

  private journal(entry: Omit<BrokerJournalEntry, 'id' | 'ts'>): void {
    const full = this.store.appendJournal(entry);
    try {
      this.onJournal?.(full);
    } catch {
      // Fan-out failures must never break the broker.
    }
  }

  /**
   * Execute one brokered action for a bot. Throws BrokerError on refusal;
   * error messages are built from fixed templates + allowlisted fields
   * only, so a credential value can never be interpolated into them (and
   * upstream text is scrubbed before any of it is quoted).
   */
  async execute(input: {
    botId: string;
    sessionId: string;
    identity: string;
    action: string;
    args?: Record<string, unknown>;
  }): Promise<BrokerExecutionResult> {
    const { botId, sessionId } = input;
    const args = input.args ?? {};
    const identity = input.identity as BrokerIdentity;
    const def = ACTION_BY_NAME.get(input.action);
    if (!def || def.identity !== identity || !(BROKER_IDENTITIES as readonly string[]).includes(identity)) {
      throw brokerError(
        'unknown_action',
        `unknown brokered action "${input.action}" for identity "${input.identity}" — see the broker action catalogue`,
      );
    }
    const base = { botId, sessionId, identity, action: def.name, actionClass: def.actionClass };

    // 1) Plan + validate arguments (steering keys rejected here).
    let plan: PlannedCall;
    try {
      rejectForbiddenKeys(args);
      plan = def.plan(args);
    } catch (err) {
      this.journal({
        ...base,
        event: 'action_refused',
        resource: null,
        argsHash: hashBrokerArgs(args),
        detail: err instanceof BrokerError ? err.code : 'invalid_args',
      });
      throw err;
    }
    const argsHash = hashBrokerArgs(args);

    // 2) Credential must be connected (checked before grants so the bot
    //    gets the actionable "connect it in Settings" answer).
    const credential = this.getCredential(identity);
    if (!credential) {
      this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: 'credential_not_connected' });
      throw brokerError(
        'credential_not_connected',
        `no ${identity} credential is connected — the user can connect one in Settings → Providers → Brokered identities`,
      );
    }

    // 3) Grant check: standing grant → live per-run grant → request card.
    const granted =
      this.store.hasStandingGrant(botId, identity, def.actionClass) ||
      this.store.hasRunGrant(botId, sessionId, identity, def.actionClass);
    if (!granted) {
      if (!this.approvalHost) {
        this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: 'no_grant_no_host' });
        throw brokerError(
          'grant_required',
          `no grant covers ${identity} ${def.actionClass} actions in this run, and no approval flow is attached to this turn — the user can add a standing grant in Settings → Providers → Brokered identities`,
        );
      }
      this.journal({ ...base, event: 'grant_requested', resource: plan.resource, argsHash, detail: null });
      let approved = false;
      try {
        approved = await this.approvalHost.requestGrant({
          botId,
          sessionId,
          identity,
          actionClass: def.actionClass,
          action: def.name,
          resource: plan.resource,
        });
      } catch {
        approved = false; // host failure fails closed
      }
      this.journal({
        ...base,
        event: approved ? 'grant_approved' : 'grant_denied',
        resource: plan.resource,
        argsHash,
        detail: approved ? null : 'denied_or_expired',
      });
      if (!approved) {
        throw brokerError(
          'grant_denied',
          `the user did not approve ${identity} ${def.actionClass} access for this run — no call was made`,
        );
      }
      // The host's decide() records the per-run grant in the store; a
      // host that resolved true without recording one is re-checked here
      // and fails closed rather than trusting the boolean alone.
      if (
        !this.store.hasStandingGrant(botId, identity, def.actionClass) &&
        !this.store.hasRunGrant(botId, sessionId, identity, def.actionClass)
      ) {
        this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: 'grant_not_recorded' });
        throw brokerError('grant_denied', 'the approval was not recorded as a grant — no call was made');
      }
    }

    // 4) Build the URL from the catalogue template + canonical base, and
    //    verify the result still points at the allowlisted host.
    const baseUrl = this.baseUrls[identity];
    const url = new URL(plan.path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (url.host.toLowerCase() !== new URL(baseUrl).host.toLowerCase()) {
      this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: 'host_mismatch' });
      throw brokerError('host_not_allowed', 'the planned call would leave the canonical API host — refused');
    }

    // 5) Execute with the app-held credential. The credential is used
    //    ONLY in the Authorization header below.
    let status: number;
    let rawText: string;
    try {
      const res = await this.fetchFn(url.toString(), {
        method: plan.method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'KriyaDot-SecretsBroker',
          ...(plan.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
      });
      status = res.status;
      rawText = await res.text();
    } catch {
      this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: 'network_error' });
      throw brokerError('upstream_error', `${identity} API call failed (network error) for ${plan.resource}`);
    }
    // Scrub BEFORE parsing/quoting anything upstream sent back.
    const safeText = scrubCredential(rawText, credential);
    if (status < 200 || status >= 300) {
      let upstreamMessage = '';
      try {
        const parsed = JSON.parse(safeText) as { message?: unknown };
        if (typeof parsed.message === 'string') upstreamMessage = parsed.message.slice(0, 200);
      } catch {
        // Non-JSON error body: quote nothing.
      }
      this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: `http_${status}` });
      throw brokerError(
        'upstream_error',
        `${identity} API returned HTTP ${status} for ${plan.resource}${upstreamMessage ? `: ${upstreamMessage}` : ''}`,
      );
    }
    let data: unknown;
    try {
      data = safeText ? JSON.parse(safeText) : null;
    } catch {
      this.journal({ ...base, event: 'action_refused', resource: plan.resource, argsHash, detail: 'bad_upstream_json' });
      throw brokerError('upstream_error', `${identity} API returned a non-JSON response for ${plan.resource}`);
    }
    const result = plan.shape(data);
    this.journal({ ...base, event: 'action_executed', resource: plan.resource, argsHash, detail: `http_${status}` });
    return { ok: true, identity, action: def.name, actionClass: def.actionClass, resource: plan.resource, result };
  }
}
