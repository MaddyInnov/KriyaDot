// SPDX-License-Identifier: Apache-2.0
// Memory upkeep HTTP API (OpenMausBot parity — background capture, nightly
// tidy, about-me, undoable journal).
//
//   POST /api/memory/upkeep/capture   { botId } → background capture pass
//   POST /api/memory/upkeep/tidy      { botId } → dedupe + contradiction check
//   GET  /api/memory/upkeep/journal?botId&limit → recent journal entries
//   POST /api/memory/upkeep/journal/undo { botId } → undo the last change
//   GET  /api/memory/about-me        → the user-editable profile
//   PUT  /api/memory/about-me        { text } → save the profile
//
// HOST WIRING (index.ts):
//   import { createMemoryUpkeepRouter, startMemoryUpkeep } from './memory-upkeep-routes.js';
//   router.use('/memory', createMemoryUpkeepRouter({
//     dataDir: config.dataDir,
//     tieredMemoryStore,
//     getBots: () => bots,
//   }));
//   startMemoryUpkeep({
//     dataDir: config.dataDir,
//     tieredMemoryStore,
//     getBots: () => bots,
//     isIdle: () => <true when no turn/routine is running>,
//     audit: (action, fields) => governance.audit(action, fields),
//   });
//   // About-me in context:
//   agentRuntime.addContextProvider(({ bot }) => aboutMeContext(config.dataDir, bot.id));
//
// The idle capture pass and the nightly tidy are timer-driven here (they
// are host-level maintenance, not user routines). Both are cheap,
// deterministic, and zero-LLM.

import express, { type Router } from 'express';
import type { TieredMemoryStore } from '@mvp/agent-runtime';
import {
  MemoryJournal,
  capturePass,
  readAboutMe,
  tidyMemory,
  writeAboutMe,
} from '@mvp/agent-runtime';

export interface MemoryUpkeepRouterDeps {
  dataDir: string;
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function requireBotId(body: unknown, getBots: () => Array<{ id: string }>): string {
  const b = (body ?? {}) as { botId?: unknown };
  if (typeof b.botId !== 'string' || !b.botId.trim()) throw new Error('"botId" is required');
  const id = b.botId.trim();
  if (!getBots().some((bot) => bot.id === id)) throw new Error(`Unknown bot "${id}"`);
  return id;
}

export function createMemoryUpkeepRouter(deps: MemoryUpkeepRouterDeps): Router {
  const router = express.Router();
  const journal = new MemoryJournal(deps.dataDir);

  router.post('/upkeep/capture', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const result = capturePass(deps.tieredMemoryStore, journal, botId);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json(errorBody('Capture pass failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/upkeep/tidy', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const result = tidyMemory(deps.tieredMemoryStore, journal, botId);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json(errorBody('Tidy pass failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/upkeep/journal', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isSafeInteger(rawLimit) ? rawLimit : 20;
    try {
      res.json({ ok: true, botId, entries: journal.list(botId, limit) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list journal', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/upkeep/journal/undo', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const undone = journal.undoLast(botId, deps.tieredMemoryStore);
      if (!undone) {
        res.status(404).json(errorBody('Nothing to undo — the journal is empty'));
        return;
      }
      res.json({ ok: true, undone });
    } catch (err) {
      res.status(500).json(errorBody('Undo failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/about-me', (_req, res) => {
    try {
      res.json({ ok: true, ...readAboutMe(deps.dataDir) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to read about-me', err instanceof Error ? err.message : String(err)));
    }
  });

  router.put('/about-me', (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') {
      res.status(400).json(errorBody('"text" (string) is required'));
      return;
    }
    try {
      const profile = writeAboutMe(deps.dataDir, body.text);
      res.json({ ok: true, ...profile });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to save about-me'));
    }
  });

  return router;
}

/**
 * Context section injected into every bot turn: the user's about-me
 * profile. Empty string when unset (no noise in the prompt).
 */
export function aboutMeContext(dataDir: string, _botId: string): string {
  try {
    const { text } = readAboutMe(dataDir);
    if (!text.trim()) return '';
    return ['# About the user (their own words — treat as trusted context)', '', text.trim()].join('\n');
  } catch {
    return '';
  }
}

export interface MemoryUpkeepSchedulerDeps {
  dataDir: string;
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
  /** True when no agent turn or routine run is currently executing. */
  isIdle: () => boolean;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Override for tests. */
  captureIntervalMs?: number;
  tidyIntervalMs?: number;
}

export interface MemoryUpkeepScheduler {
  stop: () => void;
}

/**
 * Start the background upkeep timers:
 * - idle capture every 15 min (skipped when the host is busy — runs on
 *   idle, never during a turn),
 * - nightly tidy every 24 h (first run ~1 min after boot so a fresh
 *   install self-organizes, then daily).
 * Returns a stop handle. Timers are unref'd so they never hold the process.
 */
export function startMemoryUpkeep(deps: MemoryUpkeepSchedulerDeps): MemoryUpkeepScheduler {
  const journal = new MemoryJournal(deps.dataDir);
  const captureIntervalMs = deps.captureIntervalMs ?? 15 * 60 * 1000;
  const tidyIntervalMs = deps.tidyIntervalMs ?? 24 * 60 * 60 * 1000;

  const runCapture = (): void => {
    let idle = false;
    try {
      idle = deps.isIdle();
    } catch {
      idle = false;
    }
    if (!idle) return; // runs on idle, not every turn
    for (const bot of deps.getBots()) {
      try {
        const r = capturePass(deps.tieredMemoryStore, journal, bot.id, { maxEvents: 100 });
        if (r.atomsStored > 0) {
          deps.audit('memory.upkeep_capture', { actor: 'system', detail: r });
        }
      } catch {
        // upkeep must never break the server
      }
    }
  };

  const runTidy = (): void => {
    for (const bot of deps.getBots()) {
      try {
        const r = tidyMemory(deps.tieredMemoryStore, journal, bot.id);
        deps.audit('memory.upkeep_tidy', { actor: 'system', detail: r });
      } catch {
        // upkeep must never break the server
      }
    }
  };

  const captureTimer = setInterval(runCapture, captureIntervalMs);
  const tidyTimer = setInterval(runTidy, tidyIntervalMs);
  // First tidy shortly after boot so a fresh install self-organizes.
  const firstTidy = setTimeout(runTidy, 60_000);
  for (const t of [captureTimer, tidyTimer, firstTidy]) {
    if (typeof t.unref === 'function') t.unref();
  }
  return {
    stop: () => {
      clearInterval(captureTimer);
      clearInterval(tidyTimer);
      clearTimeout(firstTidy);
      journal.close();
    },
  };
}
