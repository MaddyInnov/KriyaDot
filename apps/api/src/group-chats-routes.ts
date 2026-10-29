// SPDX-License-Identifier: Apache-2.0
// Group chats (multi-bot rooms) — REST API.
//
//   POST   /api/groups                 { name, memberBotIds[], description? } → { group, created }
//   GET    /api/groups                                                  → { groups }
//   GET    /api/groups/:id                                              → { group }
//   PATCH  /api/groups/:id             { name?, description?, memberBotIds? }
//   DELETE /api/groups/:id
//   POST   /api/groups/:id/members     { add?: string[], remove?: string[] }
//   GET    /api/groups/:id/messages    ?limit=
//   POST   /api/groups/:id/messages    { text }[?queue=1][?timeoutMin=] → user message + room turn
//   POST   /api/groups/:id/stop        → cancel an in-flight room turn
//   GET    /api/groups/:id/status      → hold/queue/breaker/locks/settings snapshot
//   GET    /api/groups/:id/settings    → robustness settings (resolved + overrides)
//   PUT    /api/groups/:id/settings    { turnTimeoutMin?, maxPostsPerMemberPerTurn?,
//                                        postsPerMinute?, duplicateRepeatLimit?, maxHeld? }
//   DELETE /api/groups/:id/settings    → reset overrides to global defaults
//   POST   /api/groups/:id/hold        → pause (new messages queue)
//   POST   /api/groups/:id/halt        → stop the in-flight turn now + pause
//   POST   /api/groups/:id/release     → resume + drain the queue in order
//   GET    /api/groups/:id/queue       → queued messages
//   DELETE /api/groups/:id/queue       → clear the queue
//   GET    /api/groups/:id/failures    → failed member turns
//   POST   /api/groups/:id/failures/:failureId/retry → re-run a failed member turn
//
// POST /messages persists the user message, then runs the room turn
// (group-room-turn.ts, orchestrated by GroupRoomManager in group-rooms.ts):
// @-mentioned members (or all members) reply in turn, up to 3 rounds / 10
// replies, guarded by per-room turn timeouts, anti-spam budgets, member
// locks, and failure recording. The response includes all replies; clients
// that want streaming can poll GET /messages instead.
//
// Queueing: POST /messages?queue=1 while a turn is in flight persists the
// message and queues it behind the current turn instead of cancelling it.
// Queued messages dispatch in order when the turn completes. A held/halted
// room always queues (up to maxHeld, default 20; 429 when full).
//
// Per-message threads: a group message can anchor a reply thread via the
// message-threads infra — POST /api/groups/:id/messages/:msgId/thread
// creates the thread (forks a session), and the client drives the turn
// through the normal POST /api/chat SSE stream with the thread session id.
//
// HOST WIRING (index.ts):
//   import { createGroupChatsRouter, type GroupChatsDeps } from './group-chats-routes.js';
//   app.use('/api/groups', createGroupChatsRouter({
//     dataDir: config.dataDir,
//     getBots: () => seed.bots,
//     runMemberTurn: async (bot, prompt) => { ... agentRuntime.runTurn ... },
//     audit: (action, fields) => governance.audit(action, fields),
//   }));
//
// API CONTRACT NOTES (for future tasks):
// - Group ids: `grp_<base36time>_<rand>`; message ids: `gmsg_<base36time>_<rand>`.
// - Room turn: sequential replies, each member in its OWN session via
//   runMemberTurn. A reply of exactly `(pass)` is silent.
// - Only one room turn runs per group at a time. POST /messages while one
//   is in flight cancels it first — unless ?queue=1 (queues behind) or the
//   room is held/halted (always queues).
// - create is idempotent on exact member sets: returns the existing group
//   with created:false (Codync's createBot behavior).
// - System notices (timeouts, breaker, hold/halt/release) are persisted as
//   messages with authorType 'system'.

import express, { type Router } from 'express';
import type { BotConfig, StreamEvent, TokenUsage } from '@mvp/agent-runtime';
import {
  GroupChatStore,
  validBotIdList,
  validGroupName,
  type GroupChat,
  type GroupMessage,
} from './group-chats.js';
import { MAX_ROOM_REPLIES, MAX_ROOM_ROUNDS } from './group-room-turn.js';
import {
  GroupRoomManager,
  parseTimeoutOverride,
  sanitizeRoomSettingsPatch,
} from './group-rooms.js';

export interface GroupChatsDeps {
  dataDir: string;
  /** Live bot list (seed roster + imports). */
  getBots: () => BotConfig[];
  /**
   * Run one member's turn and return its final text. Wire to
   * agentRuntime.runTurn({ bot, message: prompt, taskType: 'chat', onEvent })
   * collecting token events — the same pattern as the delegate tool.
   */
  runMemberTurn: (bot: BotConfig, prompt: string) => Promise<{ text: string; usage?: TokenUsage }>;
  /** Create a reply thread anchored to a group message; returns thread info. */
  createMessageThread?: (groupId: string, messageId: string) => Promise<{ threadId: string; threadSessionId: string } | null>;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /**
   * W7 (optional): fired after a user message is persisted in the room —
   * the people layer turns @mentions of PEOPLE into inbox items + push
   * for exactly the mentioned people. Fire-and-forget; errors are the
   * handler's own concern and never fail the room post.
   */
  onPersonMentions?: (args: { group: GroupChat; text: string; req: express.Request }) => Promise<void> | void;
}

function errorBody(message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: message, ...(detail !== undefined ? { detail } : {}) };
}

function botById(bots: BotConfig[], id: string): BotConfig | undefined {
  return bots.find((b) => b.id === id);
}

export function createGroupChatsRouter(deps: GroupChatsDeps): Router {
  const router = express.Router();
  const store = new GroupChatStore(deps.dataDir);
  const rooms = new GroupRoomManager({
    store,
    getBots: deps.getBots,
    runMemberTurn: deps.runMemberTurn,
    audit: deps.audit,
  });

  const groupOf = (req: express.Request, res: express.Response): GroupChat | null => {
    const id = req.params.id as string;
    if (!store.isValidGroupId(id)) {
      res.status(400).json(errorBody('Invalid group id format'));
      return null;
    }
    const group = store.getGroup(id);
    if (!group) {
      res.status(404).json(errorBody('Group not found'));
      return null;
    }
    return group;
  };

  /** Validate member ids against the roster; returns { bots } or sends 400. */
  const resolveMembers = (
    res: express.Response,
    memberBotIds: string[],
  ): BotConfig[] | null => {
    const bots = deps.getBots();
    const resolved: BotConfig[] = [];
    for (const id of memberBotIds) {
      const bot = botById(bots, id);
      if (!bot) {
        res.status(400).json(errorBody(`Unknown bot id: ${id}`));
        return null;
      }
      resolved.push(bot);
    }
    return resolved;
  };

  /** Create a group. Idempotent on exact member sets (returns existing). */
  router.post('/', (req, res) => {
    const { name, memberBotIds, description } = (req.body ?? {}) as {
      name?: unknown;
      memberBotIds?: unknown;
      description?: unknown;
    };
    if (!validGroupName(name)) {
      res.status(400).json(errorBody('name (1-80 chars) is required'));
      return;
    }
    if (!validBotIdList(memberBotIds)) {
      res.status(400).json(errorBody('memberBotIds (1-20 distinct bot ids) is required'));
      return;
    }
    if (description !== undefined && typeof description !== 'string') {
      res.status(400).json(errorBody('description must be a string'));
      return;
    }
    const members = resolveMembers(res, memberBotIds);
    if (!members) return;

    const existing = store.findByMembers(memberBotIds);
    if (existing) {
      res.json({ ok: true, group: existing, created: false });
      return;
    }
    const group = store.createGroup(name, memberBotIds, description);
    deps.audit('group.create', { detail: { groupId: group.id, name, members: memberBotIds } });
    res.status(201).json({ ok: true, group, created: true });
  });

  /** List groups, newest first. */
  router.get('/', (_req, res) => {
    res.json({ ok: true, groups: store.listGroups() });
  });

  /** Get one group. */
  router.get('/:id', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, group });
  });

  /** Rename / update description / replace members. */
  router.patch('/:id', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const { name, description, memberBotIds } = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      memberBotIds?: unknown;
    };
    const updates: { name?: string; description?: string | null; memberBotIds?: string[] } = {};
    if (name !== undefined) {
      if (!validGroupName(name)) {
        res.status(400).json(errorBody('name must be 1-80 chars'));
        return;
      }
      updates.name = name;
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== 'string') {
        res.status(400).json(errorBody('description must be a string or null'));
        return;
      }
      updates.description = description;
    }
    if (memberBotIds !== undefined) {
      if (!validBotIdList(memberBotIds)) {
        res.status(400).json(errorBody('memberBotIds must be 1-20 distinct bot ids'));
        return;
      }
      if (!resolveMembers(res, memberBotIds)) return;
      updates.memberBotIds = memberBotIds;
    }
    const updated = store.updateGroup(group.id, updates);
    deps.audit('group.update', { detail: { groupId: group.id, updates: Object.keys(updates) } });
    res.json({ ok: true, group: updated });
  });

  /** Delete a group (its transcript goes with it). */
  router.delete('/:id', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    rooms.deleteRoom(group.id);
    store.deleteGroup(group.id);
    deps.audit('group.delete', { detail: { groupId: group.id } });
    res.json({ ok: true });
  });

  /** Add/remove members. */
  router.post('/:id/members', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const { add, remove } = (req.body ?? {}) as { add?: unknown; remove?: unknown };
    let memberBotIds = [...group.memberBotIds];
    if (add !== undefined) {
      if (!Array.isArray(add) || !add.every((id) => typeof id === 'string')) {
        res.status(400).json(errorBody('add must be an array of bot ids'));
        return;
      }
      for (const id of add as string[]) {
        if (!botById(deps.getBots(), id)) {
          res.status(400).json(errorBody(`Unknown bot id: ${id}`));
          return;
        }
        if (!memberBotIds.includes(id)) memberBotIds.push(id);
      }
    }
    if (remove !== undefined) {
      if (!Array.isArray(remove) || !remove.every((id) => typeof id === 'string')) {
        res.status(400).json(errorBody('remove must be an array of bot ids'));
        return;
      }
      memberBotIds = memberBotIds.filter((id) => !(remove as string[]).includes(id));
    }
    if (!validBotIdList(memberBotIds)) {
      res.status(400).json(errorBody('Group must keep 1-20 distinct members'));
      return;
    }
    const updated = store.updateGroup(group.id, { memberBotIds });
    deps.audit('group.members', { detail: { groupId: group.id, add, remove } });
    res.json({ ok: true, group: updated });
  });

  /** List a group's messages (the room transcript). */
  router.get('/:id/messages', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === 'string' ? Math.min(Math.max(parseInt(limitRaw, 10) || 200, 1), 1000) : 200;
    res.json({ ok: true, messages: store.listMessages(group.id, limit) });
  });

  /**
   * Send a user message → starts a room turn (or queues it).
   *
   * Query/body options:
   *   ?queue=1      — when a turn is in flight, queue behind it instead of
   *                   cancelling it. Queued messages dispatch in order.
   *   ?timeoutMin=  — per-message turn deadline override (1–1440 min).
   *
   * A held/halted room always queues (up to maxHeld; 429 when full).
   */
  router.post('/:id/messages', async (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const { text, timeoutMin: bodyTimeout } = (req.body ?? {}) as {
      text?: unknown;
      timeoutMin?: unknown;
    };
    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json(errorBody('text (non-empty string) is required'));
      return;
    }
    if (text.length > 20000) {
      res.status(400).json(errorBody('text is too long (max 20000 chars)'));
      return;
    }
    const queue = req.query.queue === '1' || req.query.queue === 'true';
    const timeoutOverride = parseTimeoutOverride(
      req.query.timeoutMin !== undefined ? req.query.timeoutMin : bodyTimeout,
    );
    if (timeoutOverride === 'invalid') {
      res.status(400).json(errorBody('timeoutMin must be an integer 1–1440'));
      return;
    }

    const posted = await rooms.postMessage(group.id, group, text.trim(), {
      queue,
      timeoutMin: timeoutOverride,
    });
    if (posted.ok && deps.onPersonMentions) {
      // W7: @mentions of people → inbox items for exactly those people.
      try {
        await deps.onPersonMentions({ group, text: text.trim(), req });
      } catch {
        // Mention fan-out must never fail the room post.
      }
    }
    if (!posted.ok) {
      res.status(posted.status).json(
        errorBody(posted.error, {
          retryAfterMs: posted.retryAfterMs,
          maxHeld: posted.maxHeld,
          queueDepth: posted.queueDepth,
        }),
      );
      return;
    }
    if (posted.queued) {
      res.status(202).json({
        ok: true,
        queued: true,
        position: posted.position,
        userMessage: posted.message,
      });
      return;
    }
    const result = posted.result;
    res.json({
      ok: true,
      queued: false,
      userMessage: posted.userMessage,
      replies: result.replies,
      roundsCompleted: result.roundsCompleted,
      stoppedEarly: result.stoppedEarly,
      timedOut: result.timedOut,
      failures: result.failures,
      skipped: result.skipped,
      breakerTripped: result.breakerTripped,
      limits: { maxRounds: MAX_ROOM_ROUNDS, maxReplies: MAX_ROOM_REPLIES },
    });
  });

  /** Cancel an in-flight room turn. */
  router.post('/:id/stop', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const stopped = rooms.stopTurn(group.id);
    deps.audit('group.stop', { detail: { groupId: group.id } });
    res.json({ ok: true, stopped });
  });

  // ---- room robustness --------------------------------------------------------

  /** Full room snapshot: hold state, in-flight turn, queue, breaker, locks, settings. */
  router.get('/:id/status', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, status: rooms.getStatus(group.id) });
  });

  /** Resolved robustness settings + per-room overrides. */
  router.get('/:id/settings', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const status = rooms.getStatus(group.id);
    res.json({ ok: true, settings: status.settings, overrides: status.overrides });
  });

  /** Update per-room robustness settings (validated ranges). */
  router.put('/:id/settings', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const parsed = sanitizeRoomSettingsPatch(req.body);
    if (!parsed.ok) {
      res.status(400).json(errorBody(parsed.error));
      return;
    }
    const settings = rooms.updateSettings(group.id, parsed.patch);
    res.json({ ok: true, settings });
  });

  /** Reset per-room overrides to global defaults. */
  router.delete('/:id/settings', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    const settings = rooms.resetSettings(group.id);
    res.json({ ok: true, settings });
  });

  /** Pause the room: no new turns start; posted messages queue. */
  router.post('/:id/hold', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, status: rooms.hold(group.id) });
  });

  /** Stop everything now: cancel the in-flight turn and pause the room. */
  router.post('/:id/halt', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, status: rooms.halt(group.id) });
  });

  /** Resume the room (clears any breaker) and drain the queue in order. */
  router.post('/:id/release', async (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, status: await rooms.release(group.id) });
  });

  /** Queued messages (visible queue). */
  router.get('/:id/queue', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, queue: rooms.getQueue(group.id) });
  });

  /** Clear the queue without dispatching. */
  router.delete('/:id/queue', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, cleared: rooms.clearQueue(group.id) });
  });

  /** Failed member turns (retryable). */
  router.get('/:id/failures', (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    res.json({ ok: true, failures: rooms.listFailures(group.id) });
  });

  /** Re-run a failed member turn with its original prompt. */
  router.post('/:id/failures/:failureId/retry', async (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    try {
      const message = await rooms.retryFailure(group.id, req.params.failureId as string);
      res.json({ ok: true, message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'failure-not-found') {
        res.status(404).json(errorBody('Failure not found'));
        return;
      }
      if (msg === 'bot-not-found') {
        res.status(400).json(errorBody('The failed member bot no longer exists'));
        return;
      }
      res.status(500).json(errorBody('Retry failed', msg));
    }
  });

  /**
   * Create a reply thread anchored to a group message. Reuses the
   * message-threads infra: the client drives the turn via POST /api/chat
   * with the returned threadSessionId.
   */
  router.post('/:id/messages/:msgId/thread', async (req, res) => {
    const group = groupOf(req, res);
    if (!group) return;
    if (!deps.createMessageThread) {
      res.status(501).json(errorBody('Thread creation not wired for groups'));
      return;
    }
    const msg = store.getMessage(req.params.msgId as string);
    if (!msg || msg.groupId !== group.id) {
      res.status(404).json(errorBody('Message not found'));
      return;
    }
    if (msg.threadId) {
      res.json({ ok: true, threadId: msg.threadId, created: false });
      return;
    }
    const created = await deps.createMessageThread(group.id, msg.id);
    if (!created) {
      res.status(500).json(errorBody('Failed to create thread'));
      return;
    }
    store.setMessageThread(msg.id, created.threadId);
    deps.audit('group.thread', { detail: { groupId: group.id, messageId: msg.id, threadId: created.threadId } });
    res.status(201).json({ ok: true, threadId: created.threadId, threadSessionId: created.threadSessionId, created: true });
  });

  return router;
}

/** Remove a deleted bot from all groups (call from bot deletion paths). */
export function groupChatsRemoveBot(dataDir: string, botId: string): string[] {
  const store = new GroupChatStore(dataDir);
  try {
    return store.removeBotFromGroups(botId);
  } finally {
    store.close();
  }
}
