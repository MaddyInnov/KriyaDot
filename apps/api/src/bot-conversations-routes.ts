// SPDX-License-Identifier: Apache-2.0
// Bot-to-bot conversation sheets — REST API.
//
//   GET /api/bots/:botId/conversations
//       → { peers: [{ peerId, exchangeCount, lastAt }] }
//   GET /api/bots/:botId/conversations/:otherBotId?limit=
//       → { exchanges: [...] }  (oldest first; direction per exchange)
//
// Read-only pair history of ask_bot / message_bot exchanges (Codync:
// botConversation). The sheet UI merges these; they are never injected into
// chat transcripts.
//
// HOST WIRING (index.ts):
//   import { createBotConversationsRouter } from './bot-conversations-routes.js';
//   app.use('/api/bots', createBotConversationsRouter({
//     store,                       // BotConversationStore (from bot-team wiring)
//     getBots: () => seed.bots,
//   }));

import express, { type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';
import { BotConversationStore } from './bot-conversations.js';

export interface BotConversationsDeps {
  store: BotConversationStore;
  /** Live bot list (seed roster + imports) — validates ids. */
  getBots: () => BotConfig[];
}

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

export function createBotConversationsRouter(deps: BotConversationsDeps): Router {
  const router = express.Router();

  const knownBot = (id: string): boolean =>
    BOT_ID_RE.test(id) && deps.getBots().some((b) => b.id === id);

  /** Peers this bot has exchanged with. */
  router.get('/:botId/conversations', (req, res) => {
    const botId = req.params.botId as string;
    if (!knownBot(botId)) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    res.json({ ok: true, peers: deps.store.listPeers(botId) });
  });

  /** Pair history sheet, oldest first. */
  router.get('/:botId/conversations/:otherBotId', (req, res) => {
    const botId = req.params.botId as string;
    const otherBotId = req.params.otherBotId as string;
    if (!knownBot(botId)) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    if (!knownBot(otherBotId)) {
      res.status(404).json(errorBody(`Unknown bot "${otherBotId}"`));
      return;
    }
    if (botId === otherBotId) {
      res.status(400).json(errorBody('A bot has no conversation sheet with itself'));
      return;
    }
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === 'string' && /^\d+$/.test(limitRaw)
        ? Math.min(Math.max(parseInt(limitRaw, 10), 1), 500)
        : 200;
    res.json({ ok: true, exchanges: deps.store.listPair(botId, otherBotId, limit) });
  });

  return router;
}
