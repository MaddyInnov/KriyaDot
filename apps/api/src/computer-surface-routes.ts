// SPDX-License-Identifier: Apache-2.0
// Per-bot "Works on" computer surface API (OpenMausBot parity P1 #14).
//
//   GET    /api/bots/:id/computer          — surface + resolved backend + instance status
//                                            (+ W4 browserProfile info: dir, exists, bytes)
//   PUT    /api/bots/:id/computer          — { surface } (persists, drops cached instances)
//   POST   /api/bots/:id/computer/restart  — drop the bot's instances (fresh on next use)
//   POST   /api/bots/:id/computer/wipe-browser-profile
//                                          — W4: delete the bot's persistent browser
//                                            profile (audited; the ONLY way a profile
//                                            is deleted — restarts/deletes keep it)
//   GET    /api/bots/:id/computer/pins     — per-conversation surface pins
//   PUT    /api/bots/:id/computer/pin      — { conversationId, surface|null }

import type { Request, Response, Router } from 'express';
import type { BotConfig, ComputerSurface, PerBotComputerManager } from '@mvp/agent-runtime';
import { resolveSurfaceKind } from '@mvp/agent-runtime';
import {
  loadComputerSurfacePins,
  saveBotComputerSurface,
  saveComputerSurfacePin,
} from './computer-surfaces.js';

export interface ComputerSurfaceRouteDeps {
  bots: BotConfig[];
  dataDir: string;
  computerManager: PerBotComputerManager;
  /** routes.ts's errorBody(error, detail?) shape. */
  errorBody: (error: string, detail?: string) => { error: string; detail?: string };
  /** Optional audit sink (profile wipes are audited — metadata only). */
  audit?: (
    action: string,
    fields: { actor?: string; toolName?: string; detail?: unknown },
  ) => void;
}

const BOT_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

function botOf(deps: ComputerSurfaceRouteDeps, id: string): BotConfig | undefined {
  return deps.bots.find((b) => b.id === id);
}

function surfaceSummary(deps: ComputerSurfaceRouteDeps, bot: BotConfig) {
  const surface: ComputerSurface = bot.computerSurface ?? 'auto';
  const resolved = resolveSurfaceKind(surface);
  // W4: the bot's persistent browser profile (dir + disk usage), so the
  // Computer tab can show it and offer the wipe action.
  const profile = deps.computerManager.profileInfo(bot.id);
  return {
    botId: bot.id,
    surface,
    resolved: resolved === 'off' ? null : resolved,
    off: resolved === 'off',
    instances: deps.computerManager.status(bot.id),
    browserProfile: {
      profileDir: profile.profileDir,
      exists: profile.exists,
      bytes: profile.bytes,
      files: profile.files,
    },
  };
}

export function registerComputerSurfaceRoutes(router: Router, deps: ComputerSurfaceRouteDeps): void {
  router.get('/bots/:id/computer', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return;
    }
    const bot = botOf(deps, id);
    if (!bot) {
      res.status(404).json(deps.errorBody('Unknown bot', `No bot with id "${id}"`));
      return;
    }
    res.json({ ok: true, ...surfaceSummary(deps, bot) });
  });

  router.put('/bots/:id/computer', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return;
    }
    const body = (req.body ?? {}) as { surface?: unknown };
    try {
      const surface = saveBotComputerSurface(deps.dataDir, deps.bots, id, body.surface);
      // Drop cached instances so the next computer-tool use builds the new surface.
      await deps.computerManager.setSurface(id, surface);
      const bot = botOf(deps, id);
      res.json({ ok: true, ...(bot ? surfaceSummary(deps, bot) : { botId: id, surface }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(deps.errorBody('Failed to save computer surface', message));
    }
  });

  router.post('/bots/:id/computer/restart', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return;
    }
    const bot = botOf(deps, id);
    if (!bot) {
      res.status(404).json(deps.errorBody('Unknown bot', `No bot with id "${id}"`));
      return;
    }
    await deps.computerManager.restart(id);
    res.json({ ok: true, ...surfaceSummary(deps, bot) });
  });

  // W4: explicit browser-profile wipe. Deletes the bot's persistent
  // profile directory (cookies/logins gone; next browser launch starts
  // fresh). This is a deliberate user action from the Computer tab —
  // bot deletion, surface changes, restarts and idle teardown all KEEP
  // the profile. Audited with metadata only.
  router.post('/bots/:id/computer/wipe-browser-profile', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return;
    }
    const bot = botOf(deps, id);
    if (!bot) {
      res.status(404).json(deps.errorBody('Unknown bot', `No bot with id "${id}"`));
      return;
    }
    const result = await deps.computerManager.wipeBrowserProfile(id);
    try {
      deps.audit?.('computer.browser_profile_wiped', {
        actor: 'user',
        toolName: 'computer',
        detail: { botId: id, wiped: result.wiped, bytesFreed: result.bytesFreed },
      });
    } catch {
      // Audit must never break the wipe response.
    }
    res.json({ ok: true, ...result, ...surfaceSummary(deps, bot) });
  });

  router.get('/bots/:id/computer/pins', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return;
    }
    if (!botOf(deps, id)) {
      res.status(404).json(deps.errorBody('Unknown bot', `No bot with id "${id}"`));
      return;
    }
    const filePins = loadComputerSurfacePins(deps.dataDir, id);
    const seen = new Set(filePins.map((p) => p.conversationId));
    res.json({
      ok: true,
      botId: id,
      pins: [
        ...filePins,
        ...deps.computerManager
          .listPins(id)
          .filter((p) => !seen.has(p.conversationId)),
      ],
    });
  });

  router.put('/bots/:id/computer/pin', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return;
    }
    if (!botOf(deps, id)) {
      res.status(404).json(deps.errorBody('Unknown bot', `No bot with id "${id}"`));
      return;
    }
    const body = (req.body ?? {}) as { conversationId?: unknown; surface?: unknown };
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!conversationId || conversationId.length > 256) {
      res.status(400).json(deps.errorBody('"conversationId" must be a non-empty string (max 256 chars)'));
      return;
    }
    try {
      const surface = body.surface === null || body.surface === undefined ? null : body.surface;
      saveComputerSurfacePin(deps.dataDir, id, conversationId, surface as ComputerSurface | null);
      deps.computerManager.pinSurface(id, conversationId, surface as ComputerSurface | null);
      res.json({ ok: true, botId: id, conversationId, surface });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json(deps.errorBody('Failed to save surface pin', message));
    }
  });
}
