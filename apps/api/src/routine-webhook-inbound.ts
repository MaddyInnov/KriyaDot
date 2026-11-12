// SPDX-License-Identifier: Apache-2.0
/**
 * Generic inbound webhook triggers for routines (B5, Timon parity
 * programme) — the fourth routine trigger kind, alongside schedules
 * (routine-schedules.ts), connected-app events (routine-events.ts), and
 * the two legacy webhook surfaces (header-secret triggers in
 * webhooks.ts and the per-routine public hook in routine-hooks.ts, both
 * of which store their secrets in PLAINTEXT — this module is the
 * hardened form and the one the routine editor now offers).
 *
 * Endpoint (public, token-authenticated):
 *
 *   POST /api/webhooks/routine/<token>
 *
 * mounted in index.ts BEFORE the loopback-auth middleware and the
 * global JSON parser (raw body, like /api/hooks), with
 * '/api/webhooks/routine' added to LOOPBACK_AUTH_EXEMPT_PATHS: the
 * token IS the auth for this path, exactly as the HMAC is for
 * /api/hooks. Management routes (create / list / rotate / disable /
 * revoke) are registered on the authenticated routines router:
 *
 *   POST   /api/routines/:id/inbound-webhooks                    → { trigger, token (shown once), url }
 *   GET    /api/routines/:id/inbound-webhooks                    → { triggers } (no token, no hash)
 *   PATCH  /api/routines/:id/inbound-webhooks/:triggerId         → { enabled?, rateLimitPerHour? }
 *   POST   /api/routines/:id/inbound-webhooks/:triggerId/rotate  → { trigger, token (shown once), url }
 *   DELETE /api/routines/:id/inbound-webhooks/:triggerId         → revoke
 *
 * THREAT MODEL (stated honestly, per B1): the token is a BEARER
 * CAPABILITY. Anyone who holds the URL can start the routine, with the
 * full JSON body as its trigger input — treat the URL like a password.
 * Consequences baked into the design:
 *   - 256-bit random token (32 bytes, base64url); only its SHA-256
 *     hash is stored (file-links.ts pattern), so a database leak does
 *     not leak usable URLs. The plaintext is returned exactly once, at
 *     create/rotate.
 *   - Verification hashes the presented token and compares digests
 *     with crypto.timingSafeEqual (the webhooks.ts pattern), never a
 *     plain string compare.
 *   - Rotation replaces the hash atomically — the old URL stops
 *     working the moment rotation returns. Disabling the trigger or
 *     the routine revokes access the same way.
 *   - Unknown token, malformed token, disabled trigger and disabled
 *     routine ALL return the same 404 {"error":"not found"}: the
 *     endpoint never reveals which case it was.
 *   - Per-trigger rate limit (default 60 starts/hour, configurable
 *     1..10000) counted over durable delivery rows → 429 with
 *     Retry-After. Body cap 64 KiB, `application/json` only.
 *   - Failed-auth attempts are journalled (source IP + reason), but
 *     journal writes are themselves throttled per (IP, reason) so the
 *     log cannot be flooded into a disk-fill / noise DoS.
 *   - NO tunnelling or exposure feature is added: the endpoint is
 *     reachable exactly where the instance is reachable (loopback by
 *     default). Reaching it from the internet remains the owner's own
 *     reverse-proxy/tunnel decision, as with /api/hooks.
 *
 * GOVERNANCE: a webhook start runs under the routine OWNER's existing
 * permissions. The run is started through the shared
 * RoutineRunExecutor with provenance { origin: 'webhook', relayed:
 * true }, so the agent runtime's consent rule applies (runtime.ts):
 * approvals on a non-user-origin turn can never be auto-approved by
 * reviewer models, session auto-approve, or bypass mode — they always
 * go to the human. The webhook path adds no approval bypass of its own.
 *
 * AUDIT: every accepted start leaves a normal routine run record
 * (trigger 'webhook', visible in Activity / run history) whose audit
 * entry carries the source IP and a payload SHAPE summary (top-level
 * keys + value types + byte size) — never payload values, because the
 * body is caller-controlled and may contain other people's secrets.
 * The full body is handed to the routine as its trigger input (the
 * {{payload}} template substitution, same as event triggers hand
 * their payload to the executor) but is not persisted by this module:
 * delivery rows store the summary only.
 *
 * Idempotency: an `Idempotency-Key` header (or `X-Idempotency-Key`,
 * the workflow-webhook spelling) claims a delivery row before the run
 * starts; the same key within 24h returns the original run instead of
 * starting the routine twice.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AgentRuntime, BotConfig, ProvenanceNote } from '@mvp/agent-runtime';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import type { BotRoutine, RoutineStore } from './bot-routines.js';
import type { RoutineRunExecutor } from './routine-runs.js';
import { renderRoutinePrompt } from './webhooks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Raw-body cap for inbound deliveries (matches HOOK_BODY_LIMIT_BYTES). */
export const INBOUND_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
/** Default per-trigger starts per rolling hour. */
export const INBOUND_WEBHOOK_DEFAULT_RATE_LIMIT_PER_HOUR = 60;
export const INBOUND_WEBHOOK_MIN_RATE_LIMIT_PER_HOUR = 1;
export const INBOUND_WEBHOOK_MAX_RATE_LIMIT_PER_HOUR = 10_000;
const RATE_WINDOW_MS = 60 * 60_000;
/** Same key within this window does not start the routine twice. */
export const INBOUND_WEBHOOK_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;
/** Journal rows older than this are pruned on write. */
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** At most one journal row per (source IP, reason) per this window. */
const JOURNAL_THROTTLE_MS = 10_000;
/** The single generic response for every not-found / not-authorized case. */
const NOT_FOUND_BODY = { error: 'not found' } as const;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** 32 random bytes → 43 base64url chars (~256 bits of entropy). */
export function generateInboundWebhookToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isInboundWebhookTokenShape(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

/** SHA-256 hex of a token — the only form ever stored. */
export function hashInboundWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time token verification: both sides are hashed to fixed-size
 * SHA-256 digests and compared with timingSafeEqual (the webhooks.ts
 * pattern), so neither length nor content leaks through timing.
 */
export function verifyInboundWebhookToken(token: string, storedHashHex: string): boolean {
  const presented = createHash('sha256').update(token, 'utf8').digest();
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHashHex, 'hex');
  } catch {
    return false;
  }
  if (stored.length !== presented.length) {
    // Still burn a comparison against the presented digest itself so a
    // corrupt stored hash does not create a timing oracle.
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, stored);
}

// ---------------------------------------------------------------------------
// Payload shape summary (audit-safe: keys + types, never values)
// ---------------------------------------------------------------------------

export interface PayloadSummary {
  /** JSON type of the top-level body: 'object' | 'array' | primitive name. */
  topLevelType: string;
  /** Top-level object keys (sorted, capped) — empty for non-objects. */
  keys: string[];
  /** Per-key JSON value type for top-level object keys. */
  types: Record<string, string>;
  /** Raw body size in bytes. */
  bytes: number;
  /** True when the key list was capped. */
  keysTruncated?: boolean;
}

const SUMMARY_MAX_KEYS = 32;

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function summarizePayload(body: unknown, bytes: number): PayloadSummary {
  const topLevelType = jsonType(body);
  if (topLevelType !== 'object') {
    return { topLevelType, keys: [], types: {}, bytes };
  }
  const allKeys = Object.keys(body as Record<string, unknown>).sort();
  const keys = allKeys.slice(0, SUMMARY_MAX_KEYS);
  const types: Record<string, string> = {};
  for (const k of keys) types[k] = jsonType((body as Record<string, unknown>)[k]);
  return {
    topLevelType,
    keys,
    types,
    bytes,
    ...(allKeys.length > keys.length ? { keysTruncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RoutineInboundTrigger {
  id: string;
  routineId: string;
  enabled: boolean;
  rateLimitPerHour: number;
  createdAt: number;
  rotatedAt: number | null;
  lastFiredAt: number | null;
}

/** Trigger as exposed over the management API: no token, no hash, ever. */
export type RoutineInboundTriggerPublic = RoutineInboundTrigger;

interface TriggerRow {
  id: string;
  routine_id: string;
  token_hash: string;
  enabled: number;
  rate_limit_per_hour: number;
  created_at: number;
  rotated_at: number | null;
  last_fired_at: number | null;
}

export interface InboundDelivery {
  id: string;
  triggerId: string;
  routineId: string;
  runId: string | null;
  idempotencyKey: string | null;
  sourceIp: string;
  payloadSummary: PayloadSummary;
  createdAt: number;
}

interface DeliveryRow {
  id: string;
  trigger_id: string;
  routine_id: string;
  run_id: string | null;
  idempotency_key: string | null;
  source_ip: string;
  payload_summary: string;
  created_at: number;
}

export interface AuthJournalEntry {
  id: string;
  sourceIp: string;
  reason: string;
  createdAt: number;
}

function rowToTrigger(r: TriggerRow): RoutineInboundTrigger {
  return {
    id: r.id,
    routineId: r.routine_id,
    enabled: r.enabled === 1,
    rateLimitPerHour: r.rate_limit_per_hour,
    createdAt: r.created_at,
    rotatedAt: r.rotated_at,
    lastFiredAt: r.last_fired_at,
  };
}

function rowToDelivery(r: DeliveryRow): InboundDelivery {
  let payloadSummary: PayloadSummary = { topLevelType: 'object', keys: [], types: {}, bytes: 0 };
  try {
    payloadSummary = JSON.parse(r.payload_summary) as PayloadSummary;
  } catch {
    // A corrupt summary must not break listing; fall back to empty shape.
  }
  return {
    id: r.id,
    triggerId: r.trigger_id,
    routineId: r.routine_id,
    runId: r.run_id,
    idempotencyKey: r.idempotency_key,
    sourceIp: r.source_ip,
    payloadSummary,
    createdAt: r.created_at,
  };
}

function openDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = openSqliteDb(join(dataDir, 'bot-routines.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS routine_inbound_triggers (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit_per_hour INTEGER NOT NULL DEFAULT ${INBOUND_WEBHOOK_DEFAULT_RATE_LIMIT_PER_HOUR},
      created_at INTEGER NOT NULL,
      rotated_at INTEGER,
      last_fired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_triggers_routine ON routine_inbound_triggers(routine_id);
    CREATE TABLE IF NOT EXISTS routine_inbound_deliveries (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      run_id TEXT,
      idempotency_key TEXT,
      source_ip TEXT NOT NULL DEFAULT '',
      payload_summary TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_trigger ON routine_inbound_deliveries(trigger_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_deliveries_idem
      ON routine_inbound_deliveries(trigger_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS routine_inbound_auth_journal (
      id TEXT PRIMARY KEY,
      source_ip TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_journal_created ON routine_inbound_auth_journal(created_at);
  `);
  return db;
}

function clampRateLimit(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return INBOUND_WEBHOOK_DEFAULT_RATE_LIMIT_PER_HOUR;
  return Math.max(
    INBOUND_WEBHOOK_MIN_RATE_LIMIT_PER_HOUR,
    Math.min(INBOUND_WEBHOOK_MAX_RATE_LIMIT_PER_HOUR, Math.floor(v)),
  );
}

export class RoutineInboundWebhookStore {
  private readonly db: DatabaseSync;
  /** (ip|reason) → last journaled ms; bounds journal write rate. */
  private readonly journalThrottle = new Map<string, number>();

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  /** Create a trigger. The plaintext token is returned ONCE, here only. */
  create(routineId: string, opts?: { rateLimitPerHour?: number }): { trigger: RoutineInboundTrigger; token: string } {
    const token = generateInboundWebhookToken();
    const row: TriggerRow = {
      id: randomUUID(),
      routine_id: routineId,
      token_hash: hashInboundWebhookToken(token),
      enabled: 1,
      rate_limit_per_hour: clampRateLimit(opts?.rateLimitPerHour),
      created_at: Date.now(),
      rotated_at: null,
      last_fired_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO routine_inbound_triggers
           (id, routine_id, token_hash, enabled, rate_limit_per_hour, created_at, rotated_at, last_fired_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL, NULL)`,
      )
      .run(row.id, row.routine_id, row.token_hash, row.rate_limit_per_hour, row.created_at);
    return { trigger: rowToTrigger(row), token };
  }

  get(id: string): RoutineInboundTrigger | undefined {
    const row = this.db.prepare('SELECT * FROM routine_inbound_triggers WHERE id = ?').get(id) as unknown as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  /** Stored hash for a trigger (verification only — never leave the server). */
  getTokenHash(id: string): string | undefined {
    const row = this.db.prepare('SELECT token_hash FROM routine_inbound_triggers WHERE id = ?').get(id) as unknown as
      | { token_hash: string }
      | undefined;
    return row?.token_hash;
  }

  /**
   * Resolve a presented token to its trigger. Lookup is by SHA-256 hash
   * (unique index); the caller MUST still run verifyInboundWebhookToken
   * against getTokenHash() so the acceptance decision itself is a
   * constant-time digest comparison.
   */
  findByToken(token: string): RoutineInboundTrigger | undefined {
    const row = this.db
      .prepare('SELECT * FROM routine_inbound_triggers WHERE token_hash = ?')
      .get(hashInboundWebhookToken(token)) as unknown as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  listByRoutine(routineId: string): RoutineInboundTrigger[] {
    const rows = this.db
      .prepare('SELECT * FROM routine_inbound_triggers WHERE routine_id = ? ORDER BY created_at DESC')
      .all(routineId) as unknown as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  setEnabled(id: string, enabled: boolean): RoutineInboundTrigger | undefined {
    this.db.prepare('UPDATE routine_inbound_triggers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  setRateLimitPerHour(id: string, rateLimitPerHour: number): RoutineInboundTrigger | undefined {
    this.db.prepare('UPDATE routine_inbound_triggers SET rate_limit_per_hour = ? WHERE id = ?').run(clampRateLimit(rateLimitPerHour), id);
    return this.get(id);
  }

  /**
   * Rotate: replace the stored hash with a fresh token's hash. The old
   * URL is invalid from the moment this returns. Returns the new token
   * ONCE. A disabled trigger stays disabled after rotation.
   */
  rotate(id: string): { trigger: RoutineInboundTrigger; token: string } | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const token = generateInboundWebhookToken();
    this.db
      .prepare('UPDATE routine_inbound_triggers SET token_hash = ?, rotated_at = ? WHERE id = ?')
      .run(hashInboundWebhookToken(token), Date.now(), id);
    return { trigger: this.get(id) as RoutineInboundTrigger, token };
  }

  revoke(id: string): boolean {
    const r = this.db.prepare('DELETE FROM routine_inbound_triggers WHERE id = ?').run(id);
    return r.changes > 0;
  }

  deleteByRoutine(routineId: string): void {
    this.db.prepare('DELETE FROM routine_inbound_triggers WHERE routine_id = ?').run(routineId);
    this.db.prepare('DELETE FROM routine_inbound_deliveries WHERE routine_id = ?').run(routineId);
  }

  // --- Deliveries / rate limiting / idempotency ---------------------------

  /** Starts recorded for a trigger since `sinceMs` (the rate-limit count). */
  countDeliveriesSince(triggerId: string, sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM routine_inbound_deliveries WHERE trigger_id = ? AND created_at >= ?')
      .get(triggerId, sinceMs) as unknown as { n: number };
    return row.n;
  }

  /** Oldest delivery timestamp in the current rate window (Retry-After). */
  oldestDeliveryAtSince(triggerId: string, sinceMs: number): number | null {
    const row = this.db
      .prepare('SELECT MIN(created_at) AS t FROM routine_inbound_deliveries WHERE trigger_id = ? AND created_at >= ?')
      .get(triggerId, sinceMs) as unknown as { t: number | null };
    return row.t;
  }

  findByIdempotencyKey(triggerId: string, key: string, now = Date.now()): InboundDelivery | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM routine_inbound_deliveries
         WHERE trigger_id = ? AND idempotency_key = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(triggerId, key, now - INBOUND_WEBHOOK_IDEMPOTENCY_WINDOW_MS) as unknown as DeliveryRow | undefined;
    return row ? rowToDelivery(row) : undefined;
  }

  /**
   * Claim a delivery row BEFORE the run starts, so a concurrent retry
   * with the same idempotency key dedupes instead of double-firing.
   * Returns null when the (trigger, key) claim already exists.
   */
  claimDelivery(input: {
    triggerId: string;
    routineId: string;
    idempotencyKey?: string;
    sourceIp: string;
    payloadSummary: PayloadSummary;
    now?: number;
  }): InboundDelivery | null {
    const now = input.now ?? Date.now();
    const delivery: InboundDelivery = {
      id: randomUUID(),
      triggerId: input.triggerId,
      routineId: input.routineId,
      runId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      sourceIp: input.sourceIp,
      payloadSummary: input.payloadSummary,
      createdAt: now,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO routine_inbound_deliveries
             (id, trigger_id, routine_id, run_id, idempotency_key, source_ip, payload_summary, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          delivery.id,
          delivery.triggerId,
          delivery.routineId,
          delivery.idempotencyKey,
          delivery.sourceIp,
          JSON.stringify(delivery.payloadSummary),
          delivery.createdAt,
        );
    } catch {
      // Unique-index collision on (trigger_id, idempotency_key).
      return null;
    }
    this.db.prepare('UPDATE routine_inbound_triggers SET last_fired_at = ? WHERE id = ?').run(now, input.triggerId);
    return delivery;
  }

  attachRunId(deliveryId: string, runId: string): void {
    this.db.prepare('UPDATE routine_inbound_deliveries SET run_id = ? WHERE id = ?').run(runId, deliveryId);
  }

  listDeliveries(routineId: string, limit = 50): InboundDelivery[] {
    const rows = this.db
      .prepare('SELECT * FROM routine_inbound_deliveries WHERE routine_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(routineId, Math.max(1, Math.min(200, limit))) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  // --- Failed-auth journal (throttled writes) ------------------------------

  /**
   * Journal a failed-auth attempt. Returns true when a row was written.
   * Writes are throttled to one per (source IP, reason) per
   * JOURNAL_THROTTLE_MS so an attacker spraying bad tokens cannot flood
   * the log itself; old rows are pruned opportunistically.
   */
  journalAuthFailure(input: { sourceIp: string; reason: string; now?: number }): boolean {
    const now = input.now ?? Date.now();
    const key = `${input.sourceIp}|${input.reason}`;
    const last = this.journalThrottle.get(key) ?? 0;
    if (now - last < JOURNAL_THROTTLE_MS) return false;
    this.journalThrottle.set(key, now);
    if (this.journalThrottle.size > 4096) this.journalThrottle.clear();
    this.db.prepare('DELETE FROM routine_inbound_auth_journal WHERE created_at < ?').run(now - JOURNAL_RETENTION_MS);
    this.db
      .prepare('INSERT INTO routine_inbound_auth_journal (id, source_ip, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), input.sourceIp.slice(0, 128), input.reason.slice(0, 64), now);
    return true;
  }

  listAuthJournal(limit = 50): AuthJournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM routine_inbound_auth_journal ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as unknown as Array<{
        id: string; source_ip: string; reason: string; created_at: number;
      }>;
    return rows.map((r) => ({ id: r.id, sourceIp: r.source_ip, reason: r.reason, createdAt: r.created_at }));
  }
}

// ---------------------------------------------------------------------------
// Ingress router: POST /api/webhooks/routine/<token>
// ---------------------------------------------------------------------------

export interface RoutineInboundWebhookRouterOptions {
  routineStore: RoutineStore;
  inboundStore: RoutineInboundWebhookStore;
  getBots: () => BotConfig[];
  /** Shared run executor — webhook starts leave normal run records. */
  runExecutor?: RoutineRunExecutor;
  /** Legacy direct-turn fallback when no run executor is wired. */
  agentRuntime?: AgentRuntime;
  /** Host audit sink (governance.audit in index.ts). Never receives payload values. */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Clock override for tests. */
  now?: () => number;
}

function sourceIpOf(req: Request): string {
  return (req.ip ?? req.socket?.remoteAddress ?? '').slice(0, 128);
}

/**
 * Body-parser error handler for the ingress mount: express.raw()'s
 * entity.too.large becomes the API's JSON 413 instead of the default
 * HTML error page. Mount directly after the ingress router in index.ts
 * (and in tests).
 */
export function inboundWebhookBodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: `body exceeds ${INBOUND_WEBHOOK_BODY_LIMIT_BYTES} bytes` });
    return;
  }
  next(err as Error);
}

export function createRoutineInboundWebhookRouter(opts: RoutineInboundWebhookRouterOptions): Router {
  const router = Router();
  const now = opts.now ?? (() => Date.now());

  router.post('/:token', async (req: Request, res: Response) => {
    const sourceIp = sourceIpOf(req);
    const failAuth = (reason: string): void => {
      const journaled = opts.inboundStore.journalAuthFailure({ sourceIp, reason, now: now() });
      if (journaled) {
        try {
          opts.audit?.('routine.webhook_auth_failed', { actor: 'webhook', detail: { sourceIp, reason } });
        } catch {
          // Auditing must never change the response.
        }
      }
      res.status(404).json(NOT_FOUND_BODY);
    };

    // 1. Token shape → generic 404 (never reveal which check failed).
    const token = req.params.token;
    if (!isInboundWebhookTokenShape(token)) {
      failAuth('malformed_token');
      return;
    }
    // 2. Resolve by hash, then decide by constant-time digest compare.
    const trigger = opts.inboundStore.findByToken(token);
    if (!trigger) {
      failAuth('unknown_token');
      return;
    }
    const storedHash = opts.inboundStore.getTokenHash(trigger.id);
    if (!storedHash || !verifyInboundWebhookToken(token, storedHash)) {
      failAuth('unknown_token');
      return;
    }
    // 3. Disabled trigger / missing or disabled routine → same 404.
    if (!trigger.enabled) {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }
    const routine: BotRoutine | undefined = opts.routineStore.get(trigger.routineId);
    if (!routine || !routine.enabled) {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }

    // 4. JSON only (checked after auth, so probing learns nothing).
    const contentType = (req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      res.status(415).json({ error: 'content-type must be application/json' });
      return;
    }

    // 5. Body: raw bytes when mounted with express.raw (production and
    // tests); an already-parsed object is accepted for hosts that mount
    // behind a JSON parser (size was enforced upstream there).
    let body: unknown;
    let bodyBytes = 0;
    if (Buffer.isBuffer(req.body)) {
      bodyBytes = req.body.length;
      if (bodyBytes > INBOUND_WEBHOOK_BODY_LIMIT_BYTES) {
        res.status(413).json({ error: `body exceeds ${INBOUND_WEBHOOK_BODY_LIMIT_BYTES} bytes` });
        return;
      }
      const rawText = req.body.toString('utf8');
      if (rawText.trim() === '') {
        body = {};
      } else {
        try {
          body = JSON.parse(rawText);
        } catch {
          res.status(400).json({ error: 'body must be valid JSON' });
          return;
        }
      }
    } else if (req.body !== undefined && req.body !== null) {
      body = req.body;
      try {
        bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      } catch {
        bodyBytes = 0;
      }
      if (bodyBytes > INBOUND_WEBHOOK_BODY_LIMIT_BYTES) {
        res.status(413).json({ error: `body exceeds ${INBOUND_WEBHOOK_BODY_LIMIT_BYTES} bytes` });
        return;
      }
    } else {
      body = {};
    }

    const at = now();
    const summary = summarizePayload(body, bodyBytes);
    const idempotencyKey =
      req.header('idempotency-key') || req.header('x-idempotency-key') || undefined;

    // 6. Idempotency: a retry of an accepted delivery returns the
    // original run instead of starting the routine again.
    if (idempotencyKey) {
      const existing = opts.inboundStore.findByIdempotencyKey(trigger.id, idempotencyKey, at);
      if (existing) {
        res.status(200).json({ ok: true, deduped: true, runId: existing.runId, deliveryId: existing.id });
        return;
      }
    }

    // 7. Per-trigger rate limit over durable delivery rows.
    const windowStart = at - RATE_WINDOW_MS;
    if (opts.inboundStore.countDeliveriesSince(trigger.id, windowStart) >= trigger.rateLimitPerHour) {
      const oldest = opts.inboundStore.oldestDeliveryAtSince(trigger.id, windowStart);
      const retryAfterSec = oldest ? Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - at) / 1000)) : 60;
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    // 8. Claim the delivery (idempotency race guard), then start.
    const delivery = opts.inboundStore.claimDelivery({
      triggerId: trigger.id,
      routineId: routine.id,
      idempotencyKey,
      sourceIp,
      payloadSummary: summary,
      now: at,
    });
    if (!delivery) {
      // Lost a same-key race: report the winner as the dedupe.
      const existing = idempotencyKey
        ? opts.inboundStore.findByIdempotencyKey(trigger.id, idempotencyKey, at)
        : undefined;
      res.status(200).json({ ok: true, deduped: true, runId: existing?.runId ?? null, deliveryId: existing?.id });
      return;
    }

    const bot = opts.getBots().find((b) => b.id === routine.botId);
    if (!bot) {
      res.status(500).json({ error: 'routine cannot run' });
      return;
    }
    const sessionId = routine.sessionId ?? `routine_${routine.id}`;
    const provenance: ProvenanceNote = {
      origin: 'webhook',
      relayPath: [`webhook:${trigger.id}`],
      relayNames: [`webhook trigger ${trigger.id}`],
      timestamp: new Date(at).toISOString(),
      relayed: true,
    };
    const auditEntry: Record<string, unknown> = {
      source: 'webhook-inbound',
      triggerId: trigger.id,
      sourceIp,
      payloadSummary: summary,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };

    let runId: string | undefined;
    try {
      if (opts.runExecutor) {
        runId = await opts.runExecutor.execute({
          routine,
          trigger: 'webhook',
          payload: body,
          sessionId,
          provenance,
          audit: auditEntry,
        });
      } else if (opts.agentRuntime) {
        const message = renderRoutinePrompt(routine.promptTemplate, body);
        void opts.agentRuntime
          .runTurn({
            bot,
            message,
            sessionId,
            taskType: 'chat',
            provenance,
            onEvent: () => {},
          })
          .catch((err) => {
            console.error(
              `[routine-webhook-inbound] turn failed for routine "${routine.id}":`,
              err instanceof Error ? err.message : err,
            );
          });
      } else {
        res.status(500).json({ error: 'routine cannot run' });
        return;
      }
    } catch (err) {
      console.error(
        `[routine-webhook-inbound] failed to start routine "${routine.id}":`,
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({ error: 'failed to start routine' });
      return;
    }
    if (runId) opts.inboundStore.attachRunId(delivery.id, runId);
    try {
      opts.audit?.('routine.webhook_started', {
        actor: 'webhook',
        detail: { routineId: routine.id, triggerId: trigger.id, sourceIp, payloadSummary: summary, runId: runId ?? null },
      });
    } catch {
      // Auditing must never change the response.
    }
    res.status(202).json({ ok: true, accepted: true, runId: runId ?? null, routineId: routine.id, triggerId: trigger.id });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Management routes (authenticated — registered on the routines router)
// ---------------------------------------------------------------------------

export interface RoutineInboundWebhookRouteDeps {
  routineStore: RoutineStore;
  inboundStore: RoutineInboundWebhookStore;
  /** Base URLs for building the callable URL returned at create/rotate. */
  getBaseUrls: () => { publicBaseUrl?: string; localPort: number };
}

function inboundUrl(deps: RoutineInboundWebhookRouteDeps, token: string): string {
  const base = deps.getBaseUrls();
  const origin = base.publicBaseUrl ?? `http://127.0.0.1:${base.localPort}`;
  return `${origin.replace(/\/+$/, '')}/api/webhooks/routine/${token}`;
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export function registerRoutineInboundWebhookRoutes(router: Router, deps: RoutineInboundWebhookRouteDeps): void {
  const requireRoutine = (res: Response, id: string): BotRoutine | undefined => {
    if (!validId(id)) {
      res.status(400).json({ ok: false, error: 'Invalid routine id' });
      return undefined;
    }
    const routine = deps.routineStore.get(id);
    if (!routine) {
      res.status(404).json({ ok: false, error: `Unknown routine "${id}"` });
      return undefined;
    }
    return routine;
  };
  const requireTrigger = (res: Response, routine: BotRoutine, triggerId: string): RoutineInboundTrigger | undefined => {
    if (!validId(triggerId)) {
      res.status(400).json({ ok: false, error: 'Invalid trigger id' });
      return undefined;
    }
    const trigger = deps.inboundStore.get(triggerId);
    if (!trigger || trigger.routineId !== routine.id) {
      res.status(404).json({ ok: false, error: `Unknown inbound webhook trigger "${triggerId}" for this routine` });
      return undefined;
    }
    return trigger;
  };

  router.post('/:id/inbound-webhooks', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const body = (req.body ?? {}) as { rateLimitPerHour?: unknown };
    const { trigger, token } = deps.inboundStore.create(routine.id, {
      rateLimitPerHour: typeof body.rateLimitPerHour === 'number' ? body.rateLimitPerHour : undefined,
    });
    // The token appears in this response ONLY — shown once, never listed.
    res.status(201).json({ ok: true, trigger, token, url: inboundUrl(deps, token) });
  });

  router.get('/:id/inbound-webhooks', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const base = deps.getBaseUrls();
    const origin = base.publicBaseUrl ?? `http://127.0.0.1:${base.localPort}`;
    res.json({
      ok: true,
      triggers: deps.inboundStore.listByRoutine(routine.id),
      // The callable URL cannot be rebuilt for existing triggers (the
      // token is stored hashed) — the template documents its shape.
      urlTemplate: `${origin.replace(/\/+$/, '')}/api/webhooks/routine/<token>`,
    });
  });

  router.patch('/:id/inbound-webhooks/:triggerId', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const trigger = requireTrigger(res, routine, req.params.triggerId);
    if (!trigger) return;
    const body = (req.body ?? {}) as { enabled?: unknown; rateLimitPerHour?: unknown };
    let next = trigger;
    if (typeof body.rateLimitPerHour === 'number') {
      next = deps.inboundStore.setRateLimitPerHour(trigger.id, body.rateLimitPerHour) ?? next;
    }
    if (typeof body.enabled === 'boolean') {
      next = deps.inboundStore.setEnabled(trigger.id, body.enabled) ?? next;
    }
    res.json({ ok: true, trigger: next });
  });

  router.post('/:id/inbound-webhooks/:triggerId/rotate', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const trigger = requireTrigger(res, routine, req.params.triggerId);
    if (!trigger) return;
    const rotated = deps.inboundStore.rotate(trigger.id);
    if (!rotated) {
      res.status(404).json({ ok: false, error: 'Unknown inbound webhook trigger' });
      return;
    }
    // New token shown once; the old URL stopped working above.
    res.json({ ok: true, trigger: rotated.trigger, token: rotated.token, url: inboundUrl(deps, rotated.token) });
  });

  router.delete('/:id/inbound-webhooks/:triggerId', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const trigger = requireTrigger(res, routine, req.params.triggerId);
    if (!trigger) return;
    deps.inboundStore.revoke(trigger.id);
    res.json({ ok: true, revoked: trigger.id });
  });
}
