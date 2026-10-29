// SPDX-License-Identifier: Apache-2.0
// Proactive care — HTTP routes (router factory; mount at /api).
//
//   GET  /bots/:botId/care-config   → { ok, config }
//   PUT  /bots/:botId/care-config   → { enabled?, maxPerWeek?, windowStartHour?,
//                                       windowEndHour?, minGapHours?,
//                                       personOptedOut?, ownerPersonId? }
//   GET  /care/sends[?botId=]       → { ok, sends }
//   POST /care/run-once             → run one engine tick now (force=true)
//                                     → { ok, actions }
//
// HOST WIRING (index.ts merge): construct ProactiveCareStore +
// ProactiveCareEngine with getAtoms backed by the TieredMemoryStore,
// addInboxItem backed by TeamInboxStore (kind 'fyi'), deliverChat backed
// by appending a bot message to the bot's chat thread with the owner,
// push backed by PushService.notify, and isPaused by the system-pause
// gate; call engine.tick() from a host interval (e.g. every 15 min).

import express, { type Router } from 'express';
import type { ProactiveCareEngine, ProactiveCareStore } from './proactive-care.js';

export interface ProactiveCareRouteDeps {
  store: ProactiveCareStore;
  engine: ProactiveCareEngine;
  /** Resolve a bot's owner person id (for config defaults). */
  getBotOwner?: (botId: string) => string | undefined;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

export function createProactiveCareRouter(deps: ProactiveCareRouteDeps): Router {
  const router = express.Router();

  router.get('/bots/:botId/care-config', (req, res) => {
    const config = deps.store.getConfig(req.params.botId, deps.getBotOwner?.(req.params.botId) ?? 'you');
    res.json({ ok: true, config });
  });

  router.put('/bots/:botId/care-config', (req, res) => {
    try {
      const config = deps.store.setConfig(
        req.params.botId,
        req.body ?? {},
        deps.getBotOwner?.(req.params.botId) ?? 'you',
      );
      deps.audit('proactive_care.config_updated', {
        actor: 'user',
        detail: { botId: req.params.botId, enabled: config.enabled, maxPerWeek: config.maxPerWeek, personOptedOut: config.personOptedOut },
      });
      res.json({ ok: true, config });
    } catch (err) {
      res.status(400).json(errorBody('Failed to update care config', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/care/sends', (req, res) => {
    const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    res.json({ ok: true, sends: deps.store.listSends(botId, Number.isFinite(limit) ? limit : 50) });
  });

  router.post('/care/run-once', async (_req, res) => {
    const actions = await deps.engine.tick({ force: true });
    res.json({ ok: true, actions });
  });

  return router;
}
