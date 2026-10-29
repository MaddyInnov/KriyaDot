// SPDX-License-Identifier: Apache-2.0
// REST API for message reactions (Codync parity).
//
// Mounted at /api/chat/:sessionId/messages by the host:
//
//   POST /:messageId/reactions  { emoji, userId? } → { reactions, added }
//   GET  /:messageId/reactions                       → { reactions }
//   GET  /reactions?ids=1,2,3                        → { byMessageId: { id: reactions[] } }
//
// Toggle semantics: POSTing an emoji the user already used removes it.
// userId defaults to 'user' (the local user); bots pass their bot id.

import express from 'express';
import { MessageReactionStore } from './message-reactions.js';
import type { ReactionAnswerService, ReactionResolution } from './chat-ux.js';

export interface MessageReactionsRouterDeps {
  store: MessageReactionStore;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  /**
   * Reactions-as-answers (W8b): when set, a 👍/👎 reaction that names a
   * pending target (approvalId / widgetId in the POST body) resolves it
   * through the same decision path as clicking the card. Reactions on
   * ordinary messages (no target) are stored/displayed only.
   */
  reactionAnswers?: ReactionAnswerService;
}

function errorBody(message: string, detail?: string) {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

export function createMessageReactionsRouter(deps: MessageReactionsRouterDeps): express.Router {
  const router = express.Router({ mergeParams: true });

  /** Batch fetch for rendering a message list. */
  router.get('/reactions', (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const byMessageId: Record<string, unknown> = {};
    for (const [messageId, reactions] of deps.store.listForMessages(sessionId, ids)) {
      byMessageId[messageId] = reactions;
    }
    res.json({ ok: true, byMessageId });
  });

  router.get('/:messageId/reactions', (req, res) => {
    const { sessionId, messageId } = req.params as { sessionId: string; messageId: string };
    res.json({ ok: true, reactions: deps.store.list(sessionId, messageId) });
  });

  router.post('/:messageId/reactions', async (req, res) => {
    const { sessionId, messageId } = req.params as { sessionId: string; messageId: string };
    const body = (req.body ?? {}) as { emoji?: unknown; userId?: unknown; approvalId?: unknown; widgetId?: unknown };
    if (typeof body.emoji !== 'string' || !body.emoji) {
      res.status(400).json(errorBody('body.emoji is required'));
      return;
    }
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : 'user';
    try {
      const { reactions, added } = deps.store.toggle(sessionId, messageId, body.emoji, userId);
      deps.audit?.('chat.reaction_toggle', {
        actor: userId,
        detail: { sessionId, messageId, emoji: body.emoji, added },
      });
      // W8b: an ADDED 👍/👎 on a message carrying a pending question or
      // approval resolves it (same decision path as the card). Toggling
      // a reaction OFF never un-decides anything.
      let resolved: ReactionResolution | null = null;
      if (added && deps.reactionAnswers) {
        try {
          resolved = await deps.reactionAnswers.resolve({
            sessionId,
            messageId,
            emoji: body.emoji,
            approvalId: typeof body.approvalId === 'string' && body.approvalId ? body.approvalId : undefined,
            widgetId: typeof body.widgetId === 'string' && body.widgetId ? body.widgetId : undefined,
          });
        } catch {
          resolved = null; // Reaction storage already succeeded; resolution is best-effort on top.
        }
      }
      res.json({ ok: true, reactions, added, ...(resolved ? { resolved } : {}) });
    } catch (err) {
      res.status(400).json(errorBody('Failed to toggle reaction', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
