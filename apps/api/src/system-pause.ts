// SPDX-License-Identifier: Apache-2.0
// Global pause (W14d): one persisted switch that stops ALL new agent work.
//
// When paused:
//   - chat turns are refused with a clear "paused" notice (routes.ts),
//   - the routine scheduler, the W5 watcher and the W2 event poller skip
//     their ticks (each takes an optional `isPaused` gate),
//   - phone-action tools refuse to dispatch (phone-actions.ts).
//
// The flag lives in <dataDir>/system-pause.db (node:sqlite) so it survives
// restarts — a pause set before a crash is still in force after boot.
// Pause/resume are audit-logged with the actor by the route layer.

import express from 'express';
import type { Request, Response } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';

export interface PauseState {
  paused: boolean;
  /** Epoch ms when the current pause began (null when not paused). */
  pausedAt: number | null;
  /** Who paused (user id / 'user' / 'cli'), when known. */
  pausedBy: string | null;
  /** Optional free-text reason supplied by the pauser. */
  reason: string | null;
  /** Epoch ms of the most recent resume (null when never resumed). */
  resumedAt: number | null;
  resumedBy: string | null;
}

const NOT_PAUSED: PauseState = {
  paused: false,
  pausedAt: null,
  pausedBy: null,
  reason: null,
  resumedAt: null,
  resumedBy: null,
};

interface PauseRow {
  paused: number;
  paused_at: number | null;
  paused_by: string | null;
  reason: string | null;
  resumed_at: number | null;
  resumed_by: string | null;
}

export class PauseRegistry {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'system-pause.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pause_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        paused INTEGER NOT NULL DEFAULT 0,
        paused_at INTEGER,
        paused_by TEXT,
        reason TEXT,
        resumed_at INTEGER,
        resumed_by TEXT
      );
    `);
  }

  state(): PauseState {
    const row = this.db.prepare('SELECT * FROM pause_state WHERE id = 1').get() as unknown as
      | PauseRow
      | undefined;
    if (!row) return { ...NOT_PAUSED };
    return {
      paused: row.paused === 1,
      pausedAt: row.paused_at,
      pausedBy: row.paused_by,
      reason: row.reason,
      resumedAt: row.resumed_at,
      resumedBy: row.resumed_by,
    };
  }

  isPaused(): boolean {
    return this.state().paused;
  }

  pause(actor: string, reason?: string, now = Date.now()): PauseState {
    const cur = this.state();
    if (cur.paused) return cur; // idempotent: keep the original pause record
    this.db
      .prepare(
        `INSERT INTO pause_state (id, paused, paused_at, paused_by, reason, resumed_at, resumed_by)
         VALUES (1, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET paused = 1, paused_at = excluded.paused_at,
           paused_by = excluded.paused_by, reason = excluded.reason`,
      )
      .run(now, actor.slice(0, 128), reason ? reason.slice(0, 300) : null, cur.resumedAt, cur.resumedBy);
    return this.state();
  }

  resume(actor: string, now = Date.now()): PauseState {
    const cur = this.state();
    if (!cur.paused) return cur;
    this.db
      .prepare(
        `INSERT INTO pause_state (id, paused, paused_at, paused_by, reason, resumed_at, resumed_by)
         VALUES (1, 0, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET paused = 0, paused_at = NULL, paused_by = NULL,
           reason = NULL, resumed_at = excluded.resumed_at, resumed_by = excluded.resumed_by`,
      )
      .run(now, actor.slice(0, 128));
    return this.state();
  }
}

/** The gate shape schedulers / tools accept: `() => boolean`. */
export function pauseGate(registry: PauseRegistry): () => boolean {
  return () => registry.isPaused();
}

export const PAUSED_MESSAGE =
  'KriyaDot is paused — new work is on hold. Resume from the header, Settings, or `kriyadot resume` to continue.';

// ---------------------------------------------------------------------------
// HTTP surface: /api/system/pause, /api/system/resume, /api/system/pause-state
// ---------------------------------------------------------------------------

export interface SystemPauseRouteDeps {
  registry: PauseRegistry;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
}

function actorOf(req: Request): string {
  const body = (req.body ?? {}) as { actor?: unknown };
  if (typeof body.actor === 'string' && body.actor.trim()) return body.actor.trim().slice(0, 128);
  const hdr = req.headers['x-user-id'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim().slice(0, 128);
  return 'user';
}

export function registerSystemPauseRoutes(router: express.Router, deps: SystemPauseRouteDeps): void {
  const r = express.Router();

  r.get('/pause-state', (_req: Request, res: Response) => {
    res.json({ ok: true, ...deps.registry.state() });
  });

  r.post('/pause', (req: Request, res: Response) => {
    const actor = actorOf(req);
    const reasonRaw = (req.body as { reason?: unknown } | undefined)?.reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : undefined;
    const state = deps.registry.pause(actor, reason);
    try {
      deps.audit?.('system.paused', {
        actor,
        toolName: 'system',
        detail: { pausedAt: state.pausedAt, ...(reason ? { reason } : {}) },
      });
    } catch {
      // Audit must never break pause.
    }
    res.json({ ok: true, ...state });
  });

  r.post('/resume', (req: Request, res: Response) => {
    const actor = actorOf(req);
    const was = deps.registry.state();
    const state = deps.registry.resume(actor);
    try {
      deps.audit?.('system.resumed', {
        actor,
        toolName: 'system',
        detail: { pausedAt: was.pausedAt, pausedBy: was.pausedBy, resumedAt: state.resumedAt },
      });
    } catch {
      // Audit must never break resume.
    }
    res.json({ ok: true, ...state });
  });

  router.use('/system', r);
}
