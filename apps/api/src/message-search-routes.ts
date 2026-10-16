// SPDX-License-Identifier: Apache-2.0
// Full-text message search (OpenMausBot parity).
//
//   GET  /?q=...&botId=&sessionId=&limit= → { ok, results }
//   POST /rebuild                           → { ok, indexed }
//
// Search itself lives in the agent-runtime SessionStore (SQLite FTS5 over
// chat messages, maintained incrementally by triggers). This router adds
// HTTP validation, thread titles for result context, and the rebuild hook.
//
// HOST WIRING (index.ts — this module is not mounted by itself):
//   import { createMessageSearchRouter } from './message-search-routes.js';
//   import { ThreadTitleStore } from './chat-threads-routes.js';
//   const threadTitles = new ThreadTitleStore(config.dataDir);
//   app.use('/api/search/messages', createMessageSearchRouter({
//     searchMessages: (q, opts) => agentRuntime.sessionStore.searchMessages(q, opts),
//     rebuildSearchIndex: () => agentRuntime.sessionStore.rebuildSearchIndex(),
//     getThreadTitle: (id) => threadTitles.getTitle(id),
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import type { MessageSearchHit, MessageSearchOptions } from '@mvp/agent-runtime';

export interface MessageSearchDeps {
  /** FTS search — AgentRuntime.sessionStore.searchMessages in production. */
  searchMessages: (query: string, opts: MessageSearchOptions) => MessageSearchHit[] | Promise<MessageSearchHit[]>;
  /** Full index rebuild — AgentRuntime.sessionStore.rebuildSearchIndex. */
  rebuildSearchIndex: () => number | Promise<number>;
  /** Thread title for result context (may be undefined). */
  getThreadTitle: (threadId: string) => string | undefined;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

export interface MessageSearchResult extends MessageSearchHit {
  /** Thread/conversation title for display (when known). */
  title?: string;
}

export function createMessageSearchRouter(deps: MessageSearchDeps): Router {
  const router = express.Router();

  /**
   * Full-text search across chat sessions. Returns snippets with
   * \u0001..\u0002 match markers (the client converts them to <mark>).
   * Each result is a jump-to-message deep link payload: { sessionId, messageId }.
   */
  router.get('/', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q || q.trim().length < 2) {
      res.status(400).json(errorBody('q is required (at least 2 characters)'));
      return;
    }
    if (q.length > 200) {
      res.status(400).json(errorBody('q is too long (max 200 characters)'));
      return;
    }
    const botId =
      typeof req.query.botId === 'string' && req.query.botId.trim() ? req.query.botId.trim().slice(0, 128) : undefined;
    const sessionId =
      typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
        ? req.query.sessionId.trim().slice(0, 256)
        : undefined;
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 20;

    const hits = await deps.searchMessages(q, { ...(botId ? { botId } : {}), ...(sessionId ? { sessionId } : {}), limit });
    const results: MessageSearchResult[] = hits.map((h) => {
      const title = deps.getThreadTitle(h.sessionId);
      return title ? { ...h, title } : { ...h };
    });
    res.json({ ok: true, results });
  });

  /** Rebuild the FTS index from all stored messages. */
  router.post('/rebuild', async (_req, res) => {
    const indexed = await deps.rebuildSearchIndex();
    deps.audit('search.messages_rebuild', { actor: 'api', detail: { indexed } });
    res.json({ ok: true, indexed });
  });

  return router;
}
