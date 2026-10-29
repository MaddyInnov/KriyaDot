// SPDX-License-Identifier: Apache-2.0
// Multiplayer layer (W7) — HTTP routes. Mounted at /api by index.ts.
//
//   GET    /people                          → { people } (default user first)
//   POST   /people                          → create a person
//   GET    /people/:id                      → one person
//   PATCH  /people/:id                      → update (name, picture, channels, chief…)
//   DELETE /people/:id                      → delete (default user protected)
//   POST   /people/:id/chief                → { botId | null } designate per-person chief
//   GET    /people/:id/chats                → that person's private chats (filtered)
//   GET    /org                             → org view: one column per person + their bots
//   POST   /bots/:botId/owner               → { personId } reassign owner (audited)
//   GET    /team-inbox?personId=&state=     → aggregated inbox (needsYou/fyi/done)
//   POST   /team-inbox/items                → create a stored item (fyi / run-result / mention)
//   POST   /team-inbox/:id/state            → { state } move a stored item
//   POST   /team-inbox/:id/reply            → reply to a relay → fenced into the origin chat
//   POST   /relays                          → approval-gated relay send (waits for decision)
//   POST   /relays/inbound                  → gateway-inbound reply interface
//
// Person context: `x-person-id` header / `?personId=` (see people.ts —
// a UI-level identity selector, not authentication).

import express, { type Router } from 'express';
import {
  DEFAULT_PERSON_ID,
  aggregateTeamInbox,
  buildOrgView,
  type BotConfig,
  type TeamInboxKind,
  type TeamInboxState,
  type WidgetInboxSource,
} from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import {
  resolvePersonContext,
  saveBotOwner,
  type PeopleService,
} from './people.js';

export interface PeopleRouteDeps {
  dataDir: string;
  service: PeopleService;
  getBots: () => BotConfig[];
  governance: GovernanceGateway;
  /** Live widget records for question aggregation (optional). */
  listWidgets?: () => WidgetInboxSource[];
  /** Private-chat listing (SessionStore.listSessions in production). */
  listSessions?: (opts: { ownerPersonId?: string; limit?: number }) => Array<{
    id: string;
    botId: string;
    createdAt: string;
    ownerPersonId?: string;
    messageCount: number;
    lastMessageTs: string | null;
  }>;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

const INBOX_KINDS: readonly string[] = ['approval', 'question', 'relay', 'mention', 'fyi', 'run-result'];
const INBOX_STATES: readonly string[] = ['needs-you', 'fyi', 'done'];

export function createPeopleRouter(deps: PeopleRouteDeps): Router {
  const router = express.Router();
  const { people, inbox } = deps.service;
  const bots = (): BotConfig[] => deps.getBots();

  // ---- People directory -----------------------------------------------------

  router.get('/people', (_req, res) => {
    res.json({ ok: true, people: people.listPeople() });
  });

  router.post('/people', (req, res) => {
    try {
      const person = people.createPerson((req.body ?? {}) as never);
      deps.audit('people.create', { actor: 'user', detail: { personId: person.id, name: person.name } });
      res.status(201).json({ ok: true, person });
    } catch (err) {
      res.status(400).json(errorBody('Failed to create person', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/people/:id', (req, res) => {
    const person = people.getPerson(req.params.id);
    if (!person) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, person });
  });

  router.patch('/people/:id', (req, res) => {
    try {
      const person = people.updatePerson(req.params.id, (req.body ?? {}) as never);
      if (!person) {
        res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
        return;
      }
      res.json({ ok: true, person });
    } catch (err) {
      res.status(400).json(errorBody('Failed to update person', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/people/:id', (req, res) => {
    const person = people.getPerson(req.params.id);
    if (!person) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    if (person.isDefaultUser) {
      res.status(400).json(errorBody('The default user ("You") cannot be deleted'));
      return;
    }
    people.deletePerson(req.params.id);
    deps.audit('people.delete', { actor: 'user', detail: { personId: req.params.id } });
    res.json({ ok: true, deleted: req.params.id });
  });

  router.post('/people/:id/chief', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown };
    const botId = body.botId === null ? null : typeof body.botId === 'string' ? body.botId : undefined;
    if (botId === undefined) {
      res.status(400).json(errorBody('Body must be { botId: string | null }'));
      return;
    }
    if (botId !== null && !bots().some((b) => b.id === botId)) {
      res.status(400).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    const person = people.setChief(req.params.id, botId);
    if (!person) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    deps.audit('people.chief', {
      actor: 'user',
      detail: { personId: person.id, chiefBotId: botId },
    });
    res.json({ ok: true, person });
  });

  /** A person's private 1:1 chats — filtered at the store level by owner. */
  router.get('/people/:id/chats', (req, res) => {
    const person = people.getPerson(req.params.id);
    if (!person) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    if (!deps.listSessions) {
      res.json({ ok: true, personId: person.id, chats: [] });
      return;
    }
    const chats = deps.listSessions({ ownerPersonId: person.id, limit: 100 });
    res.json({ ok: true, personId: person.id, chats });
  });

  // ---- Org view + ownership ---------------------------------------------------

  router.get('/org', (_req, res) => {
    res.json({ ok: true, columns: buildOrgView(people.listPeople(), bots()) });
  });

  router.post('/bots/:botId/owner', (req, res) => {
    const body = (req.body ?? {}) as { personId?: unknown };
    const personId = typeof body.personId === 'string' ? body.personId : '';
    const bot = bots().find((b) => b.id === req.params.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${req.params.botId}"`));
      return;
    }
    if (!personId || !people.getPerson(personId)) {
      res.status(400).json(errorBody(`Unknown person "${personId}"`));
      return;
    }
    try {
      const { previousOwnerId } = saveBotOwner(deps.dataDir, bots(), bot.id, personId);
      deps.audit('people.bot_owner_reassigned', {
        actor: resolvePersonContext(req),
        detail: { botId: bot.id, fromPersonId: previousOwnerId, toPersonId: personId },
      });
      res.json({ ok: true, bot: { ...bot }, previousOwnerId });
    } catch (err) {
      res.status(400).json(errorBody('Failed to reassign owner', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Team inbox ---------------------------------------------------------------

  router.get('/team-inbox', (req, res) => {
    const personId =
      typeof req.query.personId === 'string' && req.query.personId ? req.query.personId : DEFAULT_PERSON_ID;
    const person = people.getPerson(personId);
    if (!person) {
      res.status(404).json(errorBody(`Unknown person "${personId}"`));
      return;
    }
    const view = aggregateTeamInbox({
      personId,
      stored: inbox.listItems(),
      approvals: deps.governance.listApprovals().map((a) => ({
        id: a.id,
        botId: a.botId,
        toolName: a.toolName,
        status: a.status,
        ts: a.ts,
        addresseePersonId: a.addresseePersonId,
      })),
      widgets: deps.listWidgets?.() ?? [],
      bots: bots(),
    });
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (state === 'needs-you' || state === 'fyi' || state === 'done') {
      res.json({ ok: true, personId, state, items: view[state === 'needs-you' ? 'needsYou' : state] });
      return;
    }
    res.json({
      ok: true,
      personId,
      needsYou: view.needsYou,
      fyi: view.fyi,
      done: view.done,
      counts: { needsYou: view.needsYou.length, fyi: view.fyi.length, done: view.done.length },
    });
  });

  router.post('/team-inbox/items', async (req, res) => {
    const body = (req.body ?? {}) as {
      personId?: unknown; kind?: unknown; state?: unknown; title?: unknown;
      summary?: unknown; botId?: unknown; sessionId?: unknown; groupId?: unknown;
    };
    const personId = typeof body.personId === 'string' ? body.personId : '';
    const person = people.getPerson(personId);
    if (!person) {
      res.status(400).json(errorBody(`Unknown person "${personId}"`));
      return;
    }
    if (typeof body.kind !== 'string' || !INBOX_KINDS.includes(body.kind)) {
      res.status(400).json(errorBody(`kind must be one of ${INBOX_KINDS.join('|')}`));
      return;
    }
    if (typeof body.title !== 'string' || !body.title.trim()) {
      res.status(400).json(errorBody('title is required'));
      return;
    }
    const item = inbox.addItem({
      personId,
      kind: body.kind as TeamInboxKind,
      ...(typeof body.state === 'string' && INBOX_STATES.includes(body.state)
        ? { state: body.state as TeamInboxState }
        : {}),
      title: body.title,
      summary: typeof body.summary === 'string' ? body.summary : '',
      ...(typeof body.botId === 'string' ? { botId: body.botId } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
    });
    if (item.state === 'needs-you') await deps.service.notifyNeedsYou(person, item);
    res.status(201).json({ ok: true, item });
  });

  router.post('/team-inbox/:id/state', (req, res) => {
    if (req.params.id.includes(':')) {
      res.status(400).json(errorBody('Synthesized approval/question items change state through their source (approvals API / widget answer), not here'));
      return;
    }
    const body = (req.body ?? {}) as { state?: unknown };
    if (typeof body.state !== 'string' || !INBOX_STATES.includes(body.state)) {
      res.status(400).json(errorBody(`state must be one of ${INBOX_STATES.join('|')}`));
      return;
    }
    const item = inbox.setState(req.params.id, body.state as TeamInboxState);
    if (!item) {
      res.status(404).json(errorBody(`Unknown inbox item "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, item });
  });

  router.post('/team-inbox/:id/reply', async (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json(errorBody('text is required'));
      return;
    }
    try {
      const result = await deps.service.relayService.reply({
        itemId: req.params.id,
        text: body.text,
        via: 'inbox',
      });
      deps.audit('people.relay_reply', {
        actor: result.item.personId,
        detail: { itemId: result.item.id, sessionId: result.item.sessionId, via: 'inbox' },
      });
      res.json({ ok: true, item: result.item, delivered: Boolean(result.item.sessionId) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown inbox item') ? 404 : 400;
      res.status(status).json(errorBody('Failed to record reply', message));
    }
  });

  // ---- Relays ---------------------------------------------------------------------

  /**
   * Approval-gated relay send: mints a `relay_to_person` approval (visible
   * in the approvals inbox, addressed to the sending bot's owner), waits
   * for the decision (bounded by waitMs), and only then delivers through
   * RelayService. Denied/expired → 403, nothing is sent — the same
   * deny-by-default pattern as POST /api/messaging/send.
   */
  router.post('/relays', async (req, res) => {
    const body = (req.body ?? {}) as {
      personId?: unknown; message?: unknown; channel?: unknown;
      botId?: unknown; sessionId?: unknown; waitMs?: unknown;
    };
    const personId = typeof body.personId === 'string' ? body.personId : '';
    const person = people.getPerson(personId);
    if (!person) {
      res.status(400).json(errorBody(`Unknown person "${personId}"`));
      return;
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json(errorBody('message is required'));
      return;
    }
    const botId = typeof body.botId === 'string' && body.botId ? body.botId : 'api';
    const bot = bots().find((b) => b.id === botId);
    const addresseePersonId = bot?.ownerId ?? resolvePersonContext(req);
    const waitMs =
      typeof body.waitMs === 'number' && Number.isFinite(body.waitMs)
        ? Math.min(Math.max(Math.floor(body.waitMs), 0), 120_000)
        : 60_000;
    const approvalId = deps.governance.requestApproval(
      'relay_to_person',
      {
        personId,
        personName: person.name,
        message: body.message,
        ...(typeof body.channel === 'string' ? { channel: body.channel } : {}),
      },
      {
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : 'api-relay',
        botId,
        actor: resolvePersonContext(req),
        addresseePersonId,
      },
    );
    const decision = await deps.governance.awaitDecision(approvalId, waitMs);
    if (decision !== 'approved') {
      res.status(403).json({ ok: false, error: 'Relay was not approved', approvalId, decision: 'denied' });
      return;
    }
    try {
      const result = await deps.service.relayService.relay({
        personId,
        message: body.message,
        botId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        channel: typeof body.channel === 'string' ? body.channel : undefined,
      });
      res.json({ ok: true, approvalId, relay: result.item, channel: result.channel, to: result.to });
    } catch (err) {
      res.status(502).json(errorBody('Relay send failed', err instanceof Error ? err.message : String(err)));
    }
  });

  /**
   * Gateway-inbound reply interface: messaging webhook handlers (or an
   * external bridge) hand an inbound provider message here; it is matched
   * to a person by handle/email and to their oldest open relay, then
   * delivered into the origin chat fenced as external content. Unmatched
   * messages return { matched: false } so the caller keeps its normal
   * inbound handling.
   */
  router.post('/relays/inbound', async (req, res) => {
    const body = (req.body ?? {}) as { provider?: unknown; from?: unknown; text?: unknown };
    if (typeof body.provider !== 'string' || typeof body.from !== 'string' || typeof body.text !== 'string') {
      res.status(400).json(errorBody('provider, from, and text are required'));
      return;
    }
    try {
      const result = await deps.service.relayService.handleGatewayReply({
        provider: body.provider,
        from: body.from,
        text: body.text,
      });
      if (!result.matched) {
        res.json({ ok: true, matched: false, reason: result.reason });
        return;
      }
      deps.audit('people.relay_reply', {
        actor: result.item.personId,
        detail: { itemId: result.item.id, sessionId: result.item.sessionId, via: 'gateway', provider: body.provider },
      });
      res.json({ ok: true, matched: true, item: result.item });
    } catch (err) {
      res.status(400).json(errorBody('Failed to handle inbound reply', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
