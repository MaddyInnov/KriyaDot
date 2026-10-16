// SPDX-License-Identifier: Apache-2.0
// Bot routines — named, bot-bound tasks that can be fired on demand.
//
// A routine is a bot + prompt template (+ optional fixed session). Unlike
// thread schedules (cron) and workflows (multi-step graphs), a routine is
// one agent turn triggered externally — the workstream-C ingress for that
// is a signed webhook (see webhooks.ts createRoutineWebhookRouter).
//
// HTTP (mounted at /api/routines by the host):
//   POST   /                        → { name, botId, promptTemplate, sessionId? }
//   GET    /                        → list routines
//   GET    /:id                     → one routine
//   PATCH  /:id                     → { name?, botId?, promptTemplate?, sessionId?, enabled? }
//   DELETE /:id                     → delete routine (+ its webhook triggers)
//   POST   /:id/triggers            → create webhook trigger → { trigger incl. secret (shown once) }
//   GET    /:id/triggers            → list triggers (secrets redacted)
//   DELETE /:id/triggers/:triggerId → revoke trigger
//
// Storage: <dataDir>/bot-routines.db (node:sqlite, same pattern as the
// workflow TriggerStore and thread schedules).

import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Request, type Response, type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export interface BotRoutine {
  id: string;
  name: string;
  botId: string;
  /**
   * Prompt template for the routine's turn. `{{payload}}` (alias `{{body}}`)
   * is replaced with the webhook request body (JSON) at fire time.
   */
  promptTemplate: string;
  /** Fixed session id; defaults to `routine_<id>` when unset. */
  sessionId?: string;
  enabled: boolean;
  createdAt: number;
}

export interface RoutineWebhookTrigger {
  id: string;
  routineId: string;
  /** Hex secret, returned once at creation; compared timing-safe on ingress. */
  secret: string;
  enabled: boolean;
  createdAt: number;
}

/** Trigger as exposed over the API: the secret is never listed. */
export type RoutineWebhookTriggerPublic = Omit<RoutineWebhookTrigger, 'secret'>;

interface RoutineRow {
  id: string;
  name: string;
  bot_id: string;
  prompt_template: string;
  session_id: string | null;
  enabled: number;
  created_at: number;
}

interface TriggerRow {
  id: string;
  routine_id: string;
  secret: string;
  enabled: number;
  created_at: number;
}

function rowToRoutine(r: RoutineRow): BotRoutine {
  return {
    id: r.id,
    name: r.name,
    botId: r.bot_id,
    promptTemplate: r.prompt_template,
    sessionId: r.session_id ?? undefined,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

function rowToTrigger(r: TriggerRow): RoutineWebhookTrigger {
  return {
    id: r.id,
    routineId: r.routine_id,
    secret: r.secret,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export function publicTrigger(t: RoutineWebhookTrigger): RoutineWebhookTriggerPublic {
  const { secret: _secret, ...rest } = t;
  void _secret;
  return rest;
}

function openDb(dataDir: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = new DatabaseSyncImpl(join(dataDir, 'bot-routines.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      session_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routine_webhook_triggers (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_triggers_routine ON routine_webhook_triggers(routine_id);
  `);
  // Migration: per-routine public webhook secret (Codync parity: every
  // routine has a public URL + key). Backfilled lazily on first use.
  const cols = db.prepare('PRAGMA table_info(bot_routines)').all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'webhook_secret')) {
    db.exec('ALTER TABLE bot_routines ADD COLUMN webhook_secret TEXT');
  }
  return db;
}

function validSessionId(v: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(v);
}

export class RoutineStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  create(input: { name: string; botId: string; promptTemplate: string; sessionId?: string }): BotRoutine {
    const name = input.name.trim().slice(0, 120);
    if (!name) throw new Error('name is required');
    const promptTemplate = input.promptTemplate.trim();
    if (!promptTemplate || promptTemplate.length > 4000) {
      throw new Error('promptTemplate is required (max 4000 chars)');
    }
    if (input.sessionId !== undefined && !validSessionId(input.sessionId)) {
      throw new Error('sessionId must match /^[a-zA-Z0-9_-]{1,128}$/');
    }
    const routine: BotRoutine = {
      id: randomUUID(),
      name,
      botId: input.botId,
      promptTemplate,
      sessionId: input.sessionId,
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO bot_routines (id, name, bot_id, prompt_template, session_id, enabled, created_at, webhook_secret) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run(
        routine.id,
        routine.name,
        routine.botId,
        routine.promptTemplate,
        routine.sessionId ?? null,
        routine.createdAt,
        randomBytes(32).toString('hex'),
      );
    return routine;
  }

  get(id: string): BotRoutine | undefined {
    const row = this.db.prepare('SELECT * FROM bot_routines WHERE id = ?').get(id) as unknown as RoutineRow | undefined;
    return row ? rowToRoutine(row) : undefined;
  }

  list(): BotRoutine[] {
    const rows = this.db.prepare('SELECT * FROM bot_routines ORDER BY created_at DESC').all() as unknown as RoutineRow[];
    return rows.map(rowToRoutine);
  }

  update(
    id: string,
    patch: { name?: string; botId?: string; promptTemplate?: string; sessionId?: string | null; enabled?: boolean },
  ): BotRoutine | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: BotRoutine = { ...cur };
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120);
      if (!name) throw new Error('name must not be empty');
      next.name = name;
    }
    if (patch.botId !== undefined) next.botId = patch.botId;
    if (patch.promptTemplate !== undefined) {
      const t = patch.promptTemplate.trim();
      if (!t || t.length > 4000) throw new Error('promptTemplate is required (max 4000 chars)');
      next.promptTemplate = t;
    }
    if (patch.sessionId !== undefined) {
      if (patch.sessionId !== null && !validSessionId(patch.sessionId)) {
        throw new Error('sessionId must match /^[a-zA-Z0-9_-]{1,128}$/');
      }
      next.sessionId = patch.sessionId ?? undefined;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    this.db
      .prepare('UPDATE bot_routines SET name = ?, bot_id = ?, prompt_template = ?, session_id = ?, enabled = ? WHERE id = ?')
      .run(next.name, next.botId, next.promptTemplate, next.sessionId ?? null, next.enabled ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    this.db.prepare('DELETE FROM routine_webhook_triggers WHERE routine_id = ?').run(id);
    const r = this.db.prepare('DELETE FROM bot_routines WHERE id = ?').run(id);
    return r.changes > 0;
  }

  /**
   * Per-routine public webhook secret (32 random bytes, hex). Generated at
   * creation for new routines; backfilled lazily for older ones via
   * ensureWebhookSecret(). Never exposed in list/get — use the dedicated
   * reveal/regenerate endpoints.
   */
  getWebhookSecret(id: string): string | undefined {
    const row = this.db.prepare('SELECT webhook_secret FROM bot_routines WHERE id = ?').get(id) as unknown as
      | { webhook_secret: string | null }
      | undefined;
    return row?.webhook_secret ?? undefined;
  }

  setWebhookSecret(id: string, secret: string): void {
    this.db.prepare('UPDATE bot_routines SET webhook_secret = ? WHERE id = ?').run(secret, id);
  }

  ensureWebhookSecret(id: string): string {
    const existing = this.getWebhookSecret(id);
    if (existing) return existing;
    const secret = randomBytes(32).toString('hex');
    this.setWebhookSecret(id, secret);
    return secret;
  }

  regenerateWebhookSecret(id: string): string {
    const secret = randomBytes(32).toString('hex');
    this.setWebhookSecret(id, secret);
    return secret;
  }
}

export class RoutineWebhookTriggerStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  /** Create a trigger; the secret is returned once — store it on the sender side. */
  create(routineId: string): RoutineWebhookTrigger {
    const trigger: RoutineWebhookTrigger = {
      id: randomUUID(),
      routineId,
      secret: randomBytes(32).toString('hex'),
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO routine_webhook_triggers (id, routine_id, secret, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(trigger.id, trigger.routineId, trigger.secret, trigger.createdAt);
    return trigger;
  }

  get(id: string): RoutineWebhookTrigger | undefined {
    const row = this.db.prepare('SELECT * FROM routine_webhook_triggers WHERE id = ?').get(id) as unknown as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  listByRoutine(routineId: string): RoutineWebhookTrigger[] {
    const rows = this.db
      .prepare('SELECT * FROM routine_webhook_triggers WHERE routine_id = ? ORDER BY created_at DESC')
      .all(routineId) as unknown as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  setEnabled(id: string, enabled: boolean): RoutineWebhookTrigger | undefined {
    this.db.prepare('UPDATE routine_webhook_triggers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  revoke(id: string): boolean {
    const r = this.db.prepare('DELETE FROM routine_webhook_triggers WHERE id = ?').run(id);
    return r.changes > 0;
  }
}

export interface RoutineRouteDeps {
  dataDir: string;
  getBots: () => BotConfig[];
  /** Delivery-queue store for the public hook ingress (routine-hooks.ts). */
  hookStore: import('./routine-hooks.js').RoutineHookStore;
  /** Base URLs for building the public/local hook URLs shown in the UI. */
  getBaseUrls: () => { publicBaseUrl?: string; localPort: number };
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Register bot-routine management routes. Mount the returned router at
 * `/api/routines`, e.g.:
 *
 *   const routinesRouter = express.Router();
 *   const { routineStore, triggerStore } = registerRoutineRoutes(routinesRouter, { dataDir, getBots });
 *   router.use('/routines', routinesRouter);
 *
 * The returned stores are shared with the webhook ingress router
 * (createRoutineWebhookRouter in webhooks.ts) — construct both from the
 * same factory call so triggers created here are honored there.
 */
export function registerRoutineRoutes(
  router: Router,
  deps: RoutineRouteDeps,
): { routineStore: RoutineStore; triggerStore: RoutineWebhookTriggerStore } {
  const routineStore = new RoutineStore(deps.dataDir);
  const triggerStore = new RoutineWebhookTriggerStore(deps.dataDir);

  const requireRoutine = (res: Response, id: string): BotRoutine | undefined => {
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid routine id'));
      return undefined;
    }
    const routine = routineStore.get(id);
    if (!routine) {
      res.status(404).json(errorBody(`Unknown routine "${id}"`));
      return undefined;
    }
    return routine;
  };

  router.post('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      botId?: unknown;
      promptTemplate?: unknown;
      sessionId?: unknown;
    };
    const botId = typeof body.botId === 'string' ? body.botId : '';
    if (!deps.getBots().some((b) => b.id === botId)) {
      res.status(400).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    try {
      const routine = routineStore.create({
        name: typeof body.name === 'string' ? body.name : '',
        botId,
        promptTemplate: typeof body.promptTemplate === 'string' ? body.promptTemplate : '',
        sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined,
      });
      res.status(201).json({ ok: true, routine });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to create routine'));
    }
  });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, routines: routineStore.list() });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, routine });
  });

  router.patch('/:id', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const body = (req.body ?? {}) as {
      name?: unknown;
      botId?: unknown;
      promptTemplate?: unknown;
      sessionId?: unknown;
      enabled?: unknown;
    };
    if (body.botId !== undefined && !deps.getBots().some((b) => b.id === body.botId)) {
      res.status(400).json(errorBody(`Unknown bot "${String(body.botId)}"`));
      return;
    }
    try {
      const updated = routineStore.update(routine.id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        botId: typeof body.botId === 'string' ? body.botId : undefined,
        promptTemplate: typeof body.promptTemplate === 'string' ? body.promptTemplate : undefined,
        sessionId:
          body.sessionId === null
            ? null
            : typeof body.sessionId === 'string' && body.sessionId
              ? body.sessionId
              : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      res.json({ ok: true, routine: updated });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to update routine'));
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid routine id'));
      return;
    }
    if (!routineStore.remove(id)) {
      res.status(404).json(errorBody(`Unknown routine "${id}"`));
      return;
    }
    res.json({ ok: true, deleted: id });
  });

  router.post('/:id/triggers', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const trigger = triggerStore.create(routine.id);
    res.status(201).json({ ok: true, trigger });
  });

  router.get('/:id/triggers', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, triggers: triggerStore.listByRoutine(routine.id).map(publicTrigger) });
  });

  router.delete('/:id/triggers/:triggerId', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const triggerId = req.params.triggerId;
    if (!validId(triggerId)) {
      res.status(400).json(errorBody('Invalid trigger id'));
      return;
    }
    const trigger = triggerStore.get(triggerId);
    if (!trigger || trigger.routineId !== routine.id) {
      res.status(404).json(errorBody(`Unknown trigger "${triggerId}" for this routine`));
      return;
    }
    triggerStore.revoke(triggerId);
    res.json({ ok: true, revoked: triggerId });
  });

  // --- Public webhook hook (Codync parity) ---------------------------------
  // Every routine has a public URL + secret: POST /api/hooks/:id/:secret.
  // The secret itself is never returned by GET — use reveal/regenerate.

  const hookInfo = (routine: BotRoutine, opts?: { includeSecret: boolean }) => {
    const base = deps.getBaseUrls();
    const secret = routineStore.ensureWebhookSecret(routine.id);
    const path = `/api/hooks/${routine.id}/${secret}`;
    const publicUrl = base.publicBaseUrl ? `${base.publicBaseUrl}${path}` : null;
    const local = `http://127.0.0.1:${base.localPort}${path}`;
    const deliveries = deps.hookStore.listByRoutine(routine.id, 1);
    const info: Record<string, unknown> = {
      routineId: routine.id,
      url: publicUrl,
      localUrl: local,
      hasSecret: true,
      // "connected" only after a real delivery arrived (Codync contract).
      connected: deliveries.some((d) => d.status === 'done'),
      queueDepth: deps.hookStore.countPending(),
    };
    if (opts?.includeSecret) {
      info.secret = secret;
    } else {
      // Never leak the secret in the info endpoint — redact it from the
      // URLs; use /hook/reveal for an explicit one-time display.
      if (typeof info.url === 'string') info.url = (info.url as string).replace(secret, '<secret>');
      info.localUrl = (info.localUrl as string).replace(secret, '<secret>');
    }
    return info;
  };

  router.get('/:id/hook', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, hook: hookInfo(routine) });
  });

  router.post('/:id/hook/reveal', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    res.json({ ok: true, hook: hookInfo(routine, { includeSecret: true }) });
  });

  router.post('/:id/hook/regenerate', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    routineStore.regenerateWebhookSecret(routine.id);
    res.json({ ok: true, hook: hookInfo(routine, { includeSecret: true }) });
  });

  router.get('/:id/deliveries', (req: Request, res: Response) => {
    const routine = requireRoutine(res, req.params.id);
    if (!routine) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const deliveries = deps.hookStore.listByRoutine(routine.id, limit).map((d) => ({
      id: d.id,
      eventType: d.eventType,
      status: d.status,
      attempts: d.attempts,
      error: d.error,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
    res.json({ ok: true, deliveries });
  });

  return { routineStore, triggerStore };
}
