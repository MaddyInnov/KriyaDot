// SPDX-License-Identifier: Apache-2.0
// Peer-approval routes (OpenMausBot parity): per-action Allow / Deny /
// Always-allow cards for bot→bot calls (ask_bot / message_bot / delegate),
// 15-minute expiry, persisted per-pair always-allow grants.
//
//   GET    /peer-approvals?status=pending|allowed|denied|expired|dismissed
//   POST   /peer-approvals/:id        { decision: 'allow'|'deny'|'always-allow', decidedBy? }
//   GET    /peer-grants
//   DELETE /peer-grants               { senderBotId, targetBotId, actionType }
//
// HOST WIRING (index.ts):
//   const peerApprovalStore = new PeerApprovalStore(config.dataDir);
//   const peerApprovalBroker = createPeerApprovalBroker(peerApprovalStore, {
//     audit: (action, fields) => governance.audit(action, fields),
//     onCard: (card) => { /* push "needs you" notification, best-effort */ },
//   });
//   router.use('/api', createPeerApprovalRouter({ store: peerApprovalStore, broker: peerApprovalBroker, audit, getBotName }));
//
// Bot-deletion paths should call peerApprovalsRemoveBot(dataDir, botId) so
// pending cards involving the deleted bot are dismissed.

import express, { type Router } from 'express';
import {
  PeerApprovalStore,
  isPeerActionType,
  isPeerDecision,
} from '@mvp/agent-runtime';
import type {
  PeerApprovalBroker,
  PeerApprovalCard,
  PeerDecision,
  RaisePeerCardInput,
} from '@mvp/agent-runtime';

interface ApiError {
  error: string;
  detail?: string;
}

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

export interface PeerApprovalRouterDeps {
  store: PeerApprovalStore;
  broker: PeerApprovalBroker;
  audit: (
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ) => void;
  getBotName?: (botId: string) => string | undefined;
}

const VALID_CARD_STATUSES = new Set(['pending', 'allowed', 'denied', 'expired', 'dismissed']);

export function createPeerApprovalRouter(deps: PeerApprovalRouterDeps): Router {
  const router = express.Router();
  const { store, broker, audit } = deps;

  // Backstop expiry sweep on every list: cards whose TTL passed while no
  // waiter was watching still transition to 'expired'.
  router.get('/peer-approvals', (_req, res) => {
    try {
      const statusParam = typeof _req.query.status === 'string' ? _req.query.status : undefined;
      if (statusParam && !VALID_CARD_STATUSES.has(statusParam)) {
        res.status(400).json(errorBody(`Invalid status "${statusParam}" — expected pending|allowed|denied|expired|dismissed`));
        return;
      }
      const expired = store.expireStale();
      for (const id of expired) {
        broker.settle(id, 'expired');
        audit('peer-approval.expired', { detail: { cardId: id } });
      }
      res.json({
        ok: true,
        cards: store.listCards(statusParam as PeerApprovalCard['status'] | undefined),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list peer approvals', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/peer-approvals/:id', (req, res) => {
    const body = (req.body ?? {}) as { decision?: unknown; decidedBy?: unknown };
    if (!isPeerDecision(body.decision)) {
      res.status(400).json(errorBody('decision must be "allow", "deny", or "always-allow"'));
      return;
    }
    const decision: PeerDecision = body.decision;
    const decidedBy = typeof body.decidedBy === 'string' && body.decidedBy.trim() ? body.decidedBy.trim().slice(0, 120) : undefined;
    try {
      const card = store.decideCard(req.params.id, decision, decidedBy);
      broker.settle(card.id, decision === 'deny' ? 'denied' : 'allowed');
      audit('peer-approval.decided', {
        actor: decidedBy,
        sessionId: card.sessionId,
        decision: decision === 'deny' ? 'denied' : 'allowed',
        detail: {
          cardId: card.id,
          senderBotId: card.senderBotId,
          targetBotId: card.targetBotId,
          actionType: card.actionType,
          alwaysAllow: decision === 'always-allow',
        },
      });
      res.json({ ok: true, card });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/.test(msg)) {
        res.status(404).json(errorBody(msg));
        return;
      }
      if (/not pending/.test(msg)) {
        res.status(409).json(errorBody(msg));
        return;
      }
      res.status(500).json(errorBody('Failed to decide peer approval', msg));
    }
  });

  router.get('/peer-grants', (_req, res) => {
    try {
      res.json({ ok: true, grants: store.listGrants() });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list peer grants', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/peer-grants', (req, res) => {
    const body = (req.body ?? {}) as { senderBotId?: unknown; targetBotId?: unknown; actionType?: unknown };
    if (
      typeof body.senderBotId !== 'string' ||
      typeof body.targetBotId !== 'string' ||
      !isPeerActionType(body.actionType)
    ) {
      res.status(400).json(
        errorBody('Body must be { senderBotId: string, targetBotId: string, actionType: "ask"|"message"|"delegate" }'),
      );
      return;
    }
    try {
      const revoked = store.revokeGrant(body.senderBotId, body.targetBotId, body.actionType);
      if (!revoked) {
        res.status(404).json(errorBody('No such peer grant'));
        return;
      }
      audit('peer-approval.grant_revoked', {
        detail: {
          senderBotId: body.senderBotId,
          targetBotId: body.targetBotId,
          actionType: body.actionType,
        },
      });
      res.json({ ok: true, revoked: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to revoke peer grant', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Broker implementation (host side)
// ---------------------------------------------------------------------------

export interface PeerApprovalBrokerOpts {
  audit: (
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ) => void;
  /** Called right after a card is raised (push "needs you" notifications, etc.). */
  onCard?: (card: PeerApprovalCard) => void;
}

/**
 * Host implementation of PeerApprovalBroker: mints cards in the store,
 * holds in-flight awaitDecision waiters, and fails cards closed on expiry.
 * The HTTP decide path settles waiters via broker.settle().
 */
export function createPeerApprovalBroker(
  store: PeerApprovalStore,
  opts: PeerApprovalBrokerOpts,
): PeerApprovalBroker {
  const waiters = new Map<string, { resolve: (d: 'allowed' | 'denied' | 'expired') => void; timer: ReturnType<typeof setTimeout> }>();

  const settle = (cardId: string, decision: 'allowed' | 'denied' | 'expired'): void => {
    const w = waiters.get(cardId);
    if (!w) return;
    clearTimeout(w.timer);
    waiters.delete(cardId);
    w.resolve(decision);
  };

  return {
    async requestCard(input: RaisePeerCardInput): Promise<PeerApprovalCard> {
      const card = store.raiseCard(input);
      opts.audit('peer-approval.raised', {
        sessionId: card.sessionId,
        detail: {
          cardId: card.id,
          senderBotId: card.senderBotId,
          targetBotId: card.targetBotId,
          actionType: card.actionType,
        },
      });
      try {
        opts.onCard?.(card);
      } catch {
        // Notification hooks must never break card minting.
      }
      return card;
    },

    async awaitDecision(cardId: string, timeoutMs: number): Promise<'allowed' | 'denied' | 'expired'> {
      const card = store.getCard(cardId);
      if (!card) throw new Error(`peer approval card not found: ${cardId}`);
      if (card.status === 'allowed') return 'allowed';
      if (card.status === 'denied') return 'denied';
      if (card.status === 'expired' || card.status === 'dismissed') return 'expired';

      // Never wait past the card's own expiry — except never-expire cards
      // (W12), which are bounded only by the caller's timeout.
      const remaining =
        card.expiresAt === null
          ? Math.max(timeoutMs, 1000)
          : Math.min(Math.max(timeoutMs, 1000), Math.max(card.expiresAt - Date.now(), 1000));
      return new Promise<'allowed' | 'denied' | 'expired'>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(cardId);
          // Re-check: the HTTP decide path may have landed just before the
          // timer fired (settle clears the timer, but be defensive).
          const current = store.getCard(cardId);
          if (current?.status === 'allowed') {
            resolve('allowed');
            return;
          }
          if (current?.status === 'denied') {
            resolve('denied');
            return;
          }
          // W12: a never-expire card outlives the wait — resolve the wait
          // as denied (fail closed for this call) but leave the card
          // pending; it can still be decided later in the inbox.
          if (current?.neverExpire && current.status === 'pending') {
            resolve('denied');
            return;
          }
          // Fail closed: mark expired (only if still pending) and audit.
          const stillPending = current?.status === 'pending';
          if (stillPending) {
            store.expireStale();
            opts.audit('peer-approval.expired', {
              sessionId: card.sessionId,
              decision: 'expired',
              detail: { cardId },
            });
          }
          resolve('expired');
        }, remaining);
        if (typeof timer.unref === 'function') timer.unref();
        waiters.set(cardId, { resolve, timer });
      });
    },

    settle,
  };
}

/**
 * Dismiss pending peer cards involving a deleted bot. Call from bot-deletion
 * paths (mirrors groupChatsRemoveBot in group-chats-routes.ts).
 */
export function peerApprovalsRemoveBot(dataDir: string, botId: string): number {
  const store = new PeerApprovalStore(dataDir);
  try {
    return store.dismissBotCards(botId);
  } finally {
    store.close();
  }
}
