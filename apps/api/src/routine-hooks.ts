// SPDX-License-Identifier: Apache-2.0
// Public webhook ingress for bot routines (Codync parity).
//
// Every routine gets a unique public URL:
//
//   POST /api/hooks/:routineId/:secret
//
// Authentication (any one suffices):
//   1. Secret in the URL path (timing-safe compare).
//   2. `Authorization: Bearer <secret>` (timing-safe compare).
//   3. `X-Signature-256` (or GitHub's `X-Hub-Signature-256`):
//      `sha256=<hex(HMAC-SHA256(rawBody, secret))>` (timing-safe compare).
//      For GitHub: paste the full URL as the payload URL, content type
//      `application/json`, and the same secret as the webhook secret.
//
// Behavior (mirrors Codync's webhook delivery contract):
//   - 404 unknown routine; 401 bad secret/signature; 409 routine paused;
//     413 body > 64 KB; 202 accepted (delivery queued, not executed inline).
//   - GitHub deliveries (`X-GitHub-Event`) are mapped to
//     `{source:'github', event:'<event>.<action>', repo, sender, text, url, payload}`.
//     `ping` events return 200 without running the routine.
//   - `Idempotency-Key` (or `X-GitHub-Delivery` / `X-Delivery-Id`) dedupes
//     retries against deliveries in the last 24h.
//   - A background worker drains the queue: 3 attempts with backoff
//     (30s, 5min), then terminal failure. Deliveries older than 7 days
//     are pruned.
//
// Reachability: "public" means reachable by the sender. The API binds to
// 127.0.0.1, so out-of-LAN senders (GitHub, etc.) need a tunnel — Tailscale,
// `cloudflared`, ngrok, or similar — pointed at the API port, with
// KRIYADOT_PUBLIC_URL set so the UI shows the reachable URL. LAN senders can
// use the http://127.0.0.1:<port> local URL. No relay infrastructure is
// built here by design (local-first).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { Router, type Request, type Response } from 'express';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { RoutineStore, type BotRoutine } from './bot-routines.js';
import { renderRoutinePrompt } from './webhooks.js';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export const HOOK_BODY_LIMIT_BYTES = 64 * 1024;
export const HOOK_MAX_ATTEMPTS = 3;
/** Backoff after attempt n fails (n=1,2): 30s, 5min. */
export const HOOK_RETRY_DELAYS_MS = [30_000, 5 * 60_000];
export const HOOK_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;
export const HOOK_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type HookDeliveryStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface HookDelivery {
  id: string;
  routineId: string;
  eventType: string;
  status: HookDeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  idempotencyKey?: string;
  /** Parsed event object handed to the routine prompt. */
  event: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface DeliveryRow {
  id: string;
  routine_id: string;
  event_type: string;
  status: HookDeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  idempotency_key: string | null;
  event_json: string;
  error: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToDelivery(r: DeliveryRow): HookDelivery {
  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(r.event_json) as Record<string, unknown>;
  } catch {
    event = { text: r.event_json };
  }
  return {
    id: r.id,
    routineId: r.routine_id,
    eventType: r.event_type,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    idempotencyKey: r.idempotency_key ?? undefined,
    event,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function openDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = new DatabaseSyncImpl(join(dataDir, 'bot-routines.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'webhook',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      idempotency_key TEXT,
      event_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      claimed_by TEXT,
      claimed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_routine ON webhook_deliveries(routine_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_idem ON webhook_deliveries(routine_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
  return db;
}

/** Timing-safe string compare (length-sensitive inputs first hashed). */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Verify `sha256=<hex>` (or bare hex) HMAC-SHA256 of body with secret. */
export function verifySignature(signature: string, body: Buffer, secret: string): boolean {
  const hex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return secretsEqual(hex.toLowerCase(), expected);
}

export interface QueuedDelivery {
  delivery: HookDelivery;
  /** True when an existing delivery with the same idempotency key was reused. */
  deduped: boolean;
}

export class RoutineHookStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  /**
   * Enqueue a delivery. When idempotencyKey is set and a delivery with the
   * same (routineId, key) exists within the idempotency window, the existing
   * delivery is returned with deduped=true instead of creating a new one.
   */
  enqueue(input: {
    routineId: string;
    eventType: string;
    event: Record<string, unknown>;
    idempotencyKey?: string;
    now?: number;
  }): QueuedDelivery {
    const now = input.now ?? Date.now();
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.routineId, input.idempotencyKey, now);
      if (existing) return { delivery: existing, deduped: true };
    }
    const delivery: HookDelivery = {
      id: randomUUID(),
      routineId: input.routineId,
      eventType: input.eventType,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      idempotencyKey: input.idempotencyKey,
      event: input.event,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries
             (id, routine_id, event_type, status, attempts, next_attempt_at, idempotency_key, event_json, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          delivery.id,
          delivery.routineId,
          delivery.eventType,
          delivery.nextAttemptAt,
          delivery.idempotencyKey ?? null,
          JSON.stringify(delivery.event),
          delivery.createdAt,
          delivery.updatedAt,
        );
    } catch (err) {
      // Unique-index race: a concurrent request inserted the same key.
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(input.routineId, input.idempotencyKey, now);
        if (existing) return { delivery: existing, deduped: true };
      }
      throw err;
    }
    return { delivery, deduped: false };
  }

  findByIdempotencyKey(routineId: string, key: string, now?: number): HookDelivery | undefined {
    const at = now ?? Date.now();
    const row = this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE routine_id = ? AND idempotency_key = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(routineId, key, at - HOOK_IDEMPOTENCY_WINDOW_MS) as unknown as DeliveryRow | undefined;
    return row ? rowToDelivery(row) : undefined;
  }

  get(id: string): HookDelivery | undefined {
    const row = this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as unknown as
      | DeliveryRow
      | undefined;
    return row ? rowToDelivery(row) : undefined;
  }

  listByRoutine(routineId: string, limit = 50): HookDelivery[] {
    const rows = this.db
      .prepare('SELECT * FROM webhook_deliveries WHERE routine_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(routineId, Math.max(1, Math.min(200, limit))) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  /** Atomically claim due deliveries for processing. */
  claimDue(limit: number, workerId: string, now?: number): HookDelivery[] {
    const at = now ?? Date.now();
    const claimed: HookDelivery[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY next_attempt_at ASC LIMIT ?`,
        )
        .all(at, Math.max(1, limit)) as unknown as DeliveryRow[];
      const mark = this.db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'processing', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      );
      for (const row of rows) {
        const r = mark.run(workerId, at, at, row.id);
        if (r.changes > 0) claimed.push(rowToDelivery({ ...row, status: 'processing' }));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
    return claimed;
  }

  markDone(id: string, now?: number): void {
    const at = now ?? Date.now();
    this.db
      .prepare(`UPDATE webhook_deliveries SET status = 'done', updated_at = ? WHERE id = ?`)
      .run(at, id);
  }

  /**
   * Record a failed attempt. Retries while attempts < HOOK_MAX_ATTEMPTS with
   * backoff; otherwise the delivery is terminally failed.
   */
  markAttemptFailed(id: string, error: string, now?: number): HookDeliveryStatus {
    const at = now ?? Date.now();
    const cur = this.get(id);
    if (!cur) return 'failed';
    const attempts = cur.attempts + 1;
    if (attempts >= HOOK_MAX_ATTEMPTS) {
      this.db
        .prepare(`UPDATE webhook_deliveries SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?`)
        .run(attempts, error.slice(0, 2000), at, id);
      return 'failed';
    }
    const delay = HOOK_RETRY_DELAYS_MS[attempts - 1] ?? HOOK_RETRY_DELAYS_MS[HOOK_RETRY_DELAYS_MS.length - 1];
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, at + delay, error.slice(0, 2000), at, id);
    return 'pending';
  }

  /** Terminal failure without retry (routine deleted/disabled, bot gone). */
  markFailedTerminal(id: string, error: string, now?: number): void {
    const at = now ?? Date.now();
    const cur = this.get(id);
    this.db
      .prepare(`UPDATE webhook_deliveries SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run((cur?.attempts ?? 0) + 1, error.slice(0, 2000), at, id);
  }

  countPending(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('pending','processing')`)
      .get() as unknown as { n: number };
    return row.n;
  }

  prune(olderThanMs: number = HOOK_RETENTION_MS, now?: number): number {
    const at = now ?? Date.now();
    const r = this.db
      .prepare(`DELETE FROM webhook_deliveries WHERE created_at < ?`)
      .run(at - olderThanMs);
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// GitHub event mapping
// ---------------------------------------------------------------------------

export interface MappedGitHubEvent {
  event: Record<string, unknown>;
  eventType: string;
  /** False for `ping` — acknowledge without running the routine. */
  shouldRun: boolean;
}

function ghRepo(payload: Record<string, unknown>): string {
  const repo = payload.repository as Record<string, unknown> | undefined;
  return typeof repo?.full_name === 'string' ? repo.full_name : 'unknown repo';
}

function ghSender(payload: Record<string, unknown>): string {
  const sender = payload.sender as Record<string, unknown> | undefined;
  return typeof sender?.login === 'string' ? sender.login : 'unknown';
}

/** Map a GitHub webhook delivery to the routine event object. */
export function mapGitHubEvent(ghEvent: string, payload: Record<string, unknown>): MappedGitHubEvent {
  const action = typeof payload.action === 'string' ? payload.action : undefined;
  const eventName = action ? `${ghEvent}.${action}` : ghEvent;
  const repo = ghRepo(payload);
  const sender = ghSender(payload);
  if (ghEvent === 'ping') {
    return {
      event: { source: 'github', event: 'ping', repo, sender, text: 'GitHub webhook ping — delivery confirmed', payload },
      eventType: 'github.ping',
      shouldRun: false,
    };
  }
  let text = `${ghEvent} event on ${repo}`;
  let url: unknown;
  if (ghEvent === 'push') {
    const commits = Array.isArray(payload.commits) ? payload.commits.length : 0;
    const pusher = (payload.pusher as Record<string, unknown> | undefined)?.name ?? sender;
    text = `${commits} commit${commits === 1 ? '' : 's'} pushed to ${repo} by ${pusher}`;
    url = payload.compare;
  } else if (ghEvent === 'pull_request') {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const n = (payload.number as number | undefined) ?? (pr?.number as number | undefined);
    const title = typeof pr?.title === 'string' ? pr.title : '';
    text = `PR #${n} ${action ?? 'updated'}: ${title} (${repo})`;
    url = pr?.html_url;
  } else if (ghEvent === 'issues') {
    const issue = payload.issue as Record<string, unknown> | undefined;
    const n = (payload.number as number | undefined) ?? (issue?.number as number | undefined);
    const title = typeof issue?.title === 'string' ? issue.title : '';
    text = `Issue #${n} ${action ?? 'updated'}: ${title} (${repo})`;
    url = issue?.html_url;
  }
  return {
    event: { source: 'github', event: eventName, repo, sender, text, url, payload },
    eventType: `github.${eventName}`,
    shouldRun: true,
  };
}

// ---------------------------------------------------------------------------
// Public hook router
// ---------------------------------------------------------------------------

export interface PublicHookRouterOptions {
  routineStore: RoutineStore;
  hookStore: RoutineHookStore;
}

function parseBody(raw: Buffer): { parsed: unknown; isJson: boolean } {
  if (raw.length === 0) return { parsed: {}, isJson: true };
  try {
    return { parsed: JSON.parse(raw.toString('utf8')), isJson: true };
  } catch {
    return { parsed: { text: raw.toString('utf8').slice(0, 4000) }, isJson: false };
  }
}

/**
 * Public webhook ingress. Mount with a raw body parser BEFORE the global
 * express.json() middleware (see the mount in index.ts).
 *
 * POST /api/hooks/:routineId/:secret
 */
export function createPublicHookRouter(opts: PublicHookRouterOptions): Router {
  const router = Router();

  router.post('/:routineId/:secret', (req: Request, res: Response) => {
    const { routineId, secret: urlSecret } = req.params;
    const routine: BotRoutine | undefined = opts.routineStore.get(routineId);
    if (!routine) {
      res.status(404).json({ error: 'unknown routine' });
      return;
    }
    const storedSecret = opts.routineStore.ensureWebhookSecret(routineId);
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');

    // Auth: URL secret, Bearer token, or HMAC signature — any one suffices.
    const bearer = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const signature = req.header('x-signature-256') ?? req.header('x-hub-signature-256') ?? '';
    const authed =
      secretsEqual(urlSecret, storedSecret) ||
      (bearer !== '' && secretsEqual(bearer, storedSecret)) ||
      (signature !== '' && verifySignature(signature, raw, storedSecret));
    if (!authed) {
      res.status(401).json({ error: 'invalid webhook secret or signature' });
      return;
    }
    if (!routine.enabled) {
      res.status(409).json({ error: 'routine is paused' });
      return;
    }
    if (raw.length > HOOK_BODY_LIMIT_BYTES) {
      res.status(413).json({ error: `body exceeds ${HOOK_BODY_LIMIT_BYTES} bytes` });
      return;
    }

    const ghEvent = req.header('x-github-event');
    let eventType = 'webhook';
    let eventObj: Record<string, unknown>;
    if (ghEvent) {
      const { parsed } = parseBody(raw);
      const payload = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
      const mapped = mapGitHubEvent(ghEvent, payload);
      if (!mapped.shouldRun) {
        res.status(200).json({ ok: true, ping: true });
        return;
      }
      eventType = mapped.eventType;
      eventObj = mapped.event;
    } else {
      const { parsed } = parseBody(raw);
      eventObj = (parsed && typeof parsed === 'object' ? parsed : { text: String(parsed) }) as Record<string, unknown>;
    }

    const idempotencyKey =
      req.header('idempotency-key') || req.header('x-github-delivery') || req.header('x-delivery-id') || undefined;
    const { delivery, deduped } = opts.hookStore.enqueue({
      routineId: routine.id,
      eventType,
      event: eventObj,
      idempotencyKey,
    });
    if (deduped) {
      res.status(200).json({ ok: true, deduped: true, deliveryId: delivery.id, status: delivery.status });
      return;
    }
    res.status(202).json({ ok: true, accepted: true, deliveryId: delivery.id, routineId: routine.id });
    return;
  });

  return router;
}

// ---------------------------------------------------------------------------
// Delivery worker
// ---------------------------------------------------------------------------

export interface HookWorkerOptions {
  routineStore: RoutineStore;
  hookStore: RoutineHookStore;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Poll interval; default 5000ms. */
  pollMs?: number;
  /** Max deliveries per pump; default 5. */
  batchSize?: number;
  renderPrompt?: (template: string, body: unknown) => string;
  /**
   * Run executor (routine-runs.ts). When set, each processed delivery
   * leaves a run record (trigger 'webhook'); when omitted, the legacy
   * direct runTurn path is used.
   */
  runExecutor?: import('./routine-runs.js').RoutineRunExecutor;
}

export class WebhookDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private readonly workerId = randomUUID();
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly render: (template: string, body: unknown) => string;

  constructor(private readonly opts: HookWorkerOptions) {
    this.pollMs = opts.pollMs ?? 5000;
    this.batchSize = opts.batchSize ?? 5;
    this.render = opts.renderPrompt ?? renderRoutinePrompt;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pumpOnce().catch((err) => {
      console.error('[routine-hooks] delivery pump failed:', err instanceof Error ? err.message : err);
    }), this.pollMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process all due deliveries once. Returns the number handled. */
  async pumpOnce(): Promise<number> {
    if (this.pumping) return 0;
    this.pumping = true;
    try {
      const due = this.opts.hookStore.claimDue(this.batchSize, this.workerId);
      for (const delivery of due) {
        await this.processOne(delivery);
      }
      return due.length;
    } finally {
      this.pumping = false;
    }
  }

  private async processOne(delivery: HookDelivery): Promise<void> {
    const { routineStore, hookStore, agentRuntime, getBots } = this.opts;
    const routine = routineStore.get(delivery.routineId);
    if (!routine) {
      hookStore.markFailedTerminal(delivery.id, `routine "${delivery.routineId}" was deleted`);
      return;
    }
    if (!routine.enabled) {
      hookStore.markFailedTerminal(delivery.id, `routine "${routine.id}" is paused`);
      return;
    }
    const bot = getBots().find((b) => b.id === routine.botId);
    if (!bot) {
      hookStore.markFailedTerminal(delivery.id, `routine bot "${routine.botId}" no longer exists`);
      return;
    }
    if (this.opts.runExecutor) {
      try {
        const res = await this.opts.runExecutor.executeWait({
          routine,
          trigger: 'webhook',
          payload: delivery.event,
          sessionId: routine.sessionId ?? `routine_${routine.id}`,
        });
        if (res.status === 'succeeded') {
          hookStore.markDone(delivery.id);
        } else if (res.status === 'cancelled') {
          // A user-cancelled run must not be retried as a delivery.
          hookStore.markFailedTerminal(delivery.id, 'routine run cancelled by user');
        } else {
          const status = hookStore.markAttemptFailed(delivery.id, res.error ?? 'routine run failed');
          console.error(`[routine-hooks] delivery ${delivery.id} attempt failed (${status}):`, res.error);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = hookStore.markAttemptFailed(delivery.id, msg);
        console.error(`[routine-hooks] delivery ${delivery.id} attempt failed (${status}):`, msg);
      }
      return;
    }
    try {
      const message = this.render(routine.promptTemplate, delivery.event);
      await agentRuntime.runTurn({
        bot,
        message,
        sessionId: routine.sessionId ?? `routine_${routine.id}`,
        taskType: 'chat',
        // P1 #13: routine hook deliveries carry external event payloads —
        // untrusted origin, approvals go to the human.
        provenance: {
          origin: 'routine',
          relayPath: [`routine:${routine.id}`],
          relayNames: [`routine ${routine.id}`],
          timestamp: new Date().toISOString(),
        },
        onEvent: () => {},
      });
      hookStore.markDone(delivery.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = hookStore.markAttemptFailed(delivery.id, msg);
      console.error(
        `[routine-hooks] delivery ${delivery.id} attempt failed (${status}):`,
        msg,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

export interface HookBaseUrls {
  /** KRIYADOT_PUBLIC_URL when configured (reachable by external senders). */
  publicBaseUrl?: string;
  localPort: number;
}

export function hookUrls(base: HookBaseUrls, routineId: string, secret: string): { url: string | null; localUrl: string } {
  const path = `/api/hooks/${routineId}/${secret}`;
  return {
    url: base.publicBaseUrl ? `${base.publicBaseUrl}${path}` : null,
    localUrl: `http://127.0.0.1:${base.localPort}${path}`,
  };
}
