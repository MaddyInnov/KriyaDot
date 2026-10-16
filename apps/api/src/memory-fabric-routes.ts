// SPDX-License-Identifier: Apache-2.0
// Memory fabric routes (Atomic parity): typed links between memory atoms,
// contradiction conflicts with voting/resolution, and the on-demand
// reflection pass.
//
//   POST   /links                  { botId, fromAtomId, toAtomId, kind? }
//   GET    /links?botId[&atomId]
//   DELETE /links/:id?botId
//   GET    /conflicts?botId[&status=open|resolved|all]
//   POST   /conflicts/:id/vote     { botId, winnerId }
//   POST   /conflicts/:id/resolve  { botId, winnerId }
//   POST   /reflect                { botId }
//
// HOST WIRING (routes.ts — the main router mounts this at /memory):
//   router.use('/memory', createMemoryFabricRouter({
//     tieredMemoryStore,
//     findBot: (id) => bots.find((b) => b.id === id),
//   }));

import express, { type Router } from 'express';
import type { BotConfig, TieredMemoryStore } from '@mvp/agent-runtime';
import { buildBotChatFn } from './memory-fabric.js';

export interface MemoryFabricRouterDeps {
  tieredMemoryStore: TieredMemoryStore;
  findBot: (botId: string) => BotConfig | undefined;
}

interface ApiError {
  error: string;
  detail?: string;
}

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

type LinkKind = 'relates' | 'contradicts' | 'supersedes';

export function createMemoryFabricRouter(deps: MemoryFabricRouterDeps): Router {
  const router = express.Router();
  const { tieredMemoryStore, findBot } = deps;

  // Links: typed relations between atoms. A 'contradicts' link opens a
  // conflict so the contradiction can be voted on and resolved.
  router.post('/links', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown; fromAtomId?: unknown; toAtomId?: unknown; kind?: unknown };
    if (typeof body.botId !== 'string' || typeof body.fromAtomId !== 'string' || typeof body.toAtomId !== 'string') {
      res.status(400).json(errorBody('Body must be { botId: string, fromAtomId: string, toAtomId: string, kind?: string }'));
      return;
    }
    try {
      const id = tieredMemoryStore.createLink(
        body.botId,
        body.fromAtomId,
        body.toAtomId,
        (typeof body.kind === 'string' ? body.kind : 'relates') as LinkKind,
      );
      res.json({ ok: true, id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown atom') ? 404 : 400;
      res.status(status).json(errorBody('Failed to create memory link', message));
    }
  });

  router.get('/links', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    const atomId = typeof req.query.atomId === 'string' ? req.query.atomId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      const links = atomId ? tieredMemoryStore.getLinksForAtom(botId, atomId) : tieredMemoryStore.getLinks(botId);
      res.json({ ok: true, botId, links });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list memory links', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/links/:id', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      if (!tieredMemoryStore.deleteLink(botId, req.params.id)) {
        res.status(404).json(errorBody(`Unknown link "${req.params.id}"`));
        return;
      }
      res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to delete memory link', err instanceof Error ? err.message : String(err)));
    }
  });

  // Conflicts: open contradictions between two memories. Voting is
  // non-binding (consensus signal); resolution keeps the winner active and
  // marks the loser inactive (kept for the audit trail).
  router.get('/conflicts', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'open';
    const status = statusRaw === 'resolved' || statusRaw === 'all' ? statusRaw : 'open';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      const conflicts = tieredMemoryStore.listConflicts(botId, status);
      res.json({ ok: true, botId, conflicts });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list memory conflicts', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/conflicts/:id/vote', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown; winnerId?: unknown };
    if (typeof body.botId !== 'string' || typeof body.winnerId !== 'string') {
      res.status(400).json(errorBody('Body must be { botId: string, winnerId: string }'));
      return;
    }
    try {
      const conflict = tieredMemoryStore.voteConflict(body.botId, req.params.id, body.winnerId, 'user');
      res.json({ ok: true, conflict });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown conflict') ? 404 : 400;
      res.status(status).json(errorBody('Failed to record vote', message));
    }
  });

  router.post('/conflicts/:id/resolve', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown; winnerId?: unknown };
    if (typeof body.botId !== 'string' || typeof body.winnerId !== 'string') {
      res.status(400).json(errorBody('Body must be { botId: string, winnerId: string }'));
      return;
    }
    try {
      const conflict = tieredMemoryStore.resolveConflict(body.botId, req.params.id, body.winnerId);
      res.json({ ok: true, conflict });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown conflict') ? 404 : 400;
      res.status(status).json(errorBody('Failed to resolve conflict', message));
    }
  });

  // Reflection pass: on-demand. The periodic auto pass (every 50 turns for
  // bots with memoryReflection) is triggered from the chat route. This is a
  // model call and can take a while — it is low-priority background work.
  router.post('/reflect', async (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown };
    if (typeof body.botId !== 'string') {
      res.status(400).json(errorBody('Body must be { botId: string }'));
      return;
    }
    const bot = findBot(body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${body.botId}"`));
      return;
    }
    const chat = buildBotChatFn(bot);
    if (!chat) {
      res.status(500).json(errorBody('Could not build a model client for this bot (provider unconfigured?)'));
      return;
    }
    try {
      const result = await tieredMemoryStore.runReflectionPass(body.botId, chat);
      const { ok: _ok, ...rest } = result;
      void _ok;
      res.json({ ok: true, botId: body.botId, ...rest });
    } catch (err) {
      res.status(500).json(errorBody('Reflection pass failed', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
