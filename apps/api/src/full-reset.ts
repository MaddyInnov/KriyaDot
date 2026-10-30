// SPDX-License-Identifier: Apache-2.0
// DA-2 — Single full-reset action.
//
// POST /api/full-reset wipes, in ONE confirm-gated action:
//   - chats:        conversation/thread stores in the data dir
//   - files:        everything under the workspace dir + chat uploads
//   - active tasks: the task store, chat queue and routine run records
//
// Safety rails (governance is never weakened):
//   - The caller must type the exact confirm phrase
//     (FULL_RESET_CONFIRM_PHRASE) — the same type-to-confirm discipline
//     as the goal-delete cascade (memory-goals-routes.ts confirmTitle).
//   - While turns are active the reset REFUSES (409) unless the caller
//     also passes `force: true` explicitly.
//   - The wipe is enumerated: only the stores listed below are touched.
//     The vault, provider keys, bot definitions, routines and settings
//     survive — this is a data reset, not an uninstall.
//   - An audit tombstone (reset-tombstone.json) plus a lifecycle-audit
//     entry are written AFTER the wipe, so the fact of the reset itself
//     is never erased by it.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { LifecycleAuditLog } from './lifecycle-approval.js';

export const FULL_RESET_CONFIRM_PHRASE = 'RESET MY DATA';
export const RESET_TOMBSTONE_NAME = 'reset-tombstone.json';

/** Data-dir entries wiped as "chats". */
export const RESET_CHAT_STORES: readonly string[] = [
  'bot-conversations.db',
  'chat-threads.db',
  'group-chats.db',
  'message-threads.db',
  'message-reactions.db',
];

/** Data-dir entries wiped as "active tasks". */
export const RESET_TASK_STORES: readonly string[] = [
  'tasks.json',
  'chat-queue.db',
  'routine-runs.db',
];

export interface FullResetReceipt {
  wipedAt: string;
  actor: string;
  forced: boolean;
  /** Data-dir entry names actually removed (stores that existed). */
  removedStores: string[];
  /** Workspace entries removed (names only, not contents). */
  removedWorkspaceEntries: string[];
  uploadsRemoved: boolean;
}

export interface FullResetDeps {
  dataDir: string;
  workspaceDir: string;
  /** Chat uploads dir; defaults to <dataDir>/uploads (file-links default). */
  uploadsDir?: string;
  /** Live count of in-flight turns; reset refuses while > 0 unless forced. */
  activeTurns?: () => number;
  auditLog?: LifecycleAuditLog;
  now?: () => Date;
}

export class FullResetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FullResetError';
  }
}

export class FullResetService {
  private readonly dataDir: string;
  private readonly workspaceDir: string;
  private readonly uploadsDir: string;
  private readonly activeTurns: () => number;
  private readonly auditLog: LifecycleAuditLog;
  private readonly nowFn: () => Date;

  constructor(deps: FullResetDeps) {
    this.dataDir = deps.dataDir;
    this.workspaceDir = deps.workspaceDir;
    this.uploadsDir = deps.uploadsDir ?? join(deps.dataDir, 'uploads');
    this.activeTurns = deps.activeTurns ?? (() => 0);
    this.auditLog = deps.auditLog ?? new LifecycleAuditLog(deps.dataDir);
    this.nowFn = deps.now ?? (() => new Date());
  }

  /** What a reset WOULD remove, without removing anything. */
  preview(): { stores: string[]; workspaceEntries: string[]; uploadsPresent: boolean; activeTurns: number } {
    const stores = [...RESET_CHAT_STORES, ...RESET_TASK_STORES].filter((name) =>
      existsSync(join(this.dataDir, name)),
    );
    let workspaceEntries: string[] = [];
    try {
      workspaceEntries = readdirSync(this.workspaceDir);
    } catch {
      workspaceEntries = [];
    }
    return {
      stores,
      workspaceEntries,
      uploadsPresent: existsSync(this.uploadsDir),
      activeTurns: this.activeTurns(),
    };
  }

  reset(input: { confirmText?: string; force?: boolean; actor?: string }): FullResetReceipt {
    if (input.confirmText !== FULL_RESET_CONFIRM_PHRASE) {
      throw new FullResetError(
        `full reset requires confirmText to be exactly "${FULL_RESET_CONFIRM_PHRASE}"`,
        400,
      );
    }
    const active = this.activeTurns();
    if (active > 0 && input.force !== true) {
      throw new FullResetError(
        `${active} turn(s) are active; wait for them to finish or pass force: true to reset anyway`,
        409,
      );
    }

    const removedStores: string[] = [];
    for (const name of [...RESET_CHAT_STORES, ...RESET_TASK_STORES]) {
      const abs = join(this.dataDir, name);
      if (!existsSync(abs)) continue;
      removedStores.push(name);
      // SQLite sidecars go with their database.
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(abs + suffix)) rmSync(abs + suffix, { force: true });
      }
    }

    let uploadsRemoved = false;
    if (existsSync(this.uploadsDir)) {
      rmSync(this.uploadsDir, { recursive: true, force: true });
      uploadsRemoved = true;
    }

    const removedWorkspaceEntries: string[] = [];
    mkdirSync(this.workspaceDir, { recursive: true });
    for (const entry of readdirSync(this.workspaceDir)) {
      rmSync(join(this.workspaceDir, entry), { recursive: true, force: true });
      removedWorkspaceEntries.push(entry);
    }

    const receipt: FullResetReceipt = {
      wipedAt: this.nowFn().toISOString(),
      actor: input.actor || 'api',
      forced: input.force === true,
      removedStores,
      removedWorkspaceEntries,
      uploadsRemoved,
    };

    // Tombstone + audit are written AFTER the wipe so the reset can
    // never erase the record of itself.
    writeFileSync(
      join(this.dataDir, RESET_TOMBSTONE_NAME),
      JSON.stringify({ kind: 'kriyadot.full-reset-tombstone', ...receipt }, null, 2),
      { mode: 0o600 },
    );
    this.auditLog.record('data.full_reset', receipt.actor, {
      forced: receipt.forced,
      removedStores: receipt.removedStores,
      removedWorkspaceEntries: receipt.removedWorkspaceEntries,
      uploadsRemoved: receipt.uploadsRemoved,
    });

    return receipt;
  }
}

// ---------------------------------------------------------------------------
// Routes — register-style: mount the returned router at /api
// (paths are /full-reset).
// ---------------------------------------------------------------------------

export function createFullResetRouter(deps: FullResetDeps): Router {
  const service = new FullResetService(deps);
  const router = Router();

  router.get('/full-reset/preview', (_req: Request, res: Response) => {
    res.json({ ok: true, confirmPhrase: FULL_RESET_CONFIRM_PHRASE, preview: service.preview() });
  });

  router.post('/full-reset', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { confirmText?: unknown; force?: unknown; actor?: unknown };
      const receipt = service.reset({
        confirmText: typeof body.confirmText === 'string' ? body.confirmText : undefined,
        force: body.force === true,
        actor: typeof body.actor === 'string' ? body.actor : undefined,
      });
      res.json({ ok: true, receipt });
    } catch (err) {
      if (err instanceof FullResetError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'full reset failed' });
    }
  });

  return router;
}
