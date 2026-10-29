// SPDX-License-Identifier: Apache-2.0
// Chat UX pack (W8) server helpers: pending sign-in requests settled by
// a "done" message (d), and reactions-as-answers (b).
//
// (d) Sign-in requests: when a bot's chat shows a sign-in request card
// (native CLI driver sign-in — the user was sent to the CLI's OAuth
// page), the request sits pending in this store. A user chat message
// that is exactly "done" in that bot's chat settles it: the server
// re-checks the CLI's sign-in status through the existing cli-auth
// status path; signed in → completed, not signed in → stays pending
// and the user is told it didn't take.
//
// (b) Reactions-as-answers: a 👍/👎 reaction on a bot's question
// (interactive widget) or approval card resolves the pending item
// through the SAME decision paths as clicking the card — governance
// decide() for approvals, WidgetCoordinator.settle() for questions —
// audited with source 'reaction'. Reactions on ordinary messages are
// stored/displayed by the reactions store and resolve nothing (the
// service is only invoked when the client names a pending target).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// ---------------------------------------------------------------------------
// (d) Sign-in requests
// ---------------------------------------------------------------------------

export type SignInRequestStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface SignInRequest {
  id: string;
  botId: string;
  sessionId: string;
  /** Native CLI auth id: 'claude' | 'codex' | 'opencode' | 'antigravity'. */
  cliId: string;
  /** The sign-in URL the user was sent to (never a credential). */
  url?: string;
  status: SignInRequestStatus;
  createdAt: number;
  settledAt?: number;
}

/** CLI auth ids with an in-app sign-in flow (mirrors cli-auth-routes). */
export const SIGN_IN_CLI_IDS = ['claude', 'codex', 'opencode', 'antigravity'] as const;

export function isSignInCliId(v: unknown): v is string {
  return typeof v === 'string' && (SIGN_IN_CLI_IDS as readonly string[]).includes(v);
}

/** In-memory pending sign-in requests, keyed by id. Per-process by design (like cli-auth logins). */
export class SignInRequestStore {
  private readonly requests = new Map<string, SignInRequest>();

  create(input: { botId: string; sessionId: string; cliId: string; url?: string }): SignInRequest {
    const req: SignInRequest = {
      id: `signin_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      botId: input.botId,
      sessionId: input.sessionId,
      cliId: input.cliId,
      url: input.url,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.requests.set(req.id, req);
    return req;
  }

  get(id: string): SignInRequest | undefined {
    return this.requests.get(id);
  }

  /** Pending requests, optionally filtered by bot and/or session. */
  listPending(filter: { botId?: string; sessionId?: string } = {}): SignInRequest[] {
    return [...this.requests.values()].filter(
      (r) =>
        r.status === 'pending' &&
        (filter.botId === undefined || r.botId === filter.botId) &&
        (filter.sessionId === undefined || r.sessionId === filter.sessionId),
    );
  }

  /** The pending request a "done" message in this chat would settle (oldest first). */
  pendingFor(botId: string, sessionId: string): SignInRequest | undefined {
    return this.listPending({ botId, sessionId }).sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  settle(id: string, status: 'completed' | 'failed' | 'cancelled'): SignInRequest | undefined {
    const req = this.requests.get(id);
    if (!req || req.status !== 'pending') return undefined;
    req.status = status;
    req.settledAt = Date.now();
    return req;
  }
}

/** True when a chat message is exactly "done" (case-insensitive, trimmed). */
export function isDoneMessage(message: unknown): boolean {
  return typeof message === 'string' && message.trim().toLowerCase() === 'done';
}

export interface SignInStatusCheck {
  signedIn: boolean;
}

/**
 * Settle a pending sign-in request after a "done" message: re-check the
 * CLI sign-in status via the existing status path. Signed in → the
 * request completes. Not signed in → the request STAYS pending and the
 * outcome says it didn't take (the user can finish signing in and say
 * "done" again).
 */
export async function settleSignInOnDone(input: {
  store: SignInRequestStore;
  request: SignInRequest;
  checkStatus: (cliId: string) => Promise<SignInStatusCheck>;
}): Promise<{ settled: boolean; signedIn: boolean; request: SignInRequest }> {
  const status = await input.checkStatus(input.request.cliId);
  if (!status.signedIn) {
    return { settled: false, signedIn: false, request: input.request };
  }
  const updated = input.store.settle(input.request.id, 'completed') ?? input.request;
  return { settled: true, signedIn: true, request: updated };
}

// ---------------------------------------------------------------------------
// (b) Reactions-as-answers
// ---------------------------------------------------------------------------

export type ReactionVerdict = 'approved' | 'denied';

/** Map a reaction emoji to a yes/no verdict. Anything else → null (stored only). */
export function mapReactionVerdict(emoji: unknown): ReactionVerdict | null {
  if (emoji === '👍') return 'approved';
  if (emoji === '👎') return 'denied';
  return null;
}

export interface ReactionResolution {
  kind: 'approval' | 'widget';
  id: string;
  verdict: ReactionVerdict;
  source: 'reaction';
}

export interface ReactionAnswerDeps {
  /** Pending check + decision for approvals — the governance card path. */
  getApprovalStatus: (approvalId: string) => string | undefined;
  decideApproval: (approvalId: string, decision: 'approved' | 'denied', opts?: { note?: string }) => void | Promise<void>;
  /** Pending check + settle for interactive question widgets. */
  getWidget: (widgetId: string) => { status: string; kind: string; interactive: boolean } | undefined;
  settleWidget: (widgetId: string, value: unknown) => void | Promise<void>;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

/**
 * Resolves 👍/👎 reactions against pending approvals / question
 * widgets. Returns the resolution when something was decided, or null
 * when the reaction resolves nothing (non-verdict emoji, no target, or
 * the target is no longer pending).
 */
export class ReactionAnswerService {
  constructor(private readonly deps: ReactionAnswerDeps) {}

  async resolve(input: {
    sessionId: string;
    messageId: string;
    emoji: string;
    approvalId?: string;
    widgetId?: string;
  }): Promise<ReactionResolution | null> {
    const verdict = mapReactionVerdict(input.emoji);
    if (!verdict) return null;

    if (input.approvalId) {
      const status = this.deps.getApprovalStatus(input.approvalId);
      if (status !== 'pending') return null;
      await this.deps.decideApproval(input.approvalId, verdict, {
        note: `Decided via ${input.emoji} reaction`,
      });
      this.deps.audit?.('chat.reaction_answer', {
        detail: {
          kind: 'approval',
          approvalId: input.approvalId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          emoji: input.emoji,
          verdict,
          source: 'reaction',
        },
      });
      return { kind: 'approval', id: input.approvalId, verdict, source: 'reaction' };
    }

    if (input.widgetId) {
      const widget = this.deps.getWidget(input.widgetId);
      if (!widget || widget.status !== 'pending' || !widget.interactive) return null;
      // Confirm widgets take {confirmed}; other question kinds receive
      // the same affirmative/negative marker the ask_user_question tool
      // passes through to the model.
      const value =
        widget.kind === 'confirm'
          ? { confirmed: verdict === 'approved' }
          : { confirmed: verdict === 'approved', reaction: input.emoji };
      await this.deps.settleWidget(input.widgetId, value);
      this.deps.audit?.('chat.reaction_answer', {
        detail: {
          kind: 'widget',
          widgetId: input.widgetId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          emoji: input.emoji,
          verdict,
          source: 'reaction',
        },
      });
      return { kind: 'widget', id: input.widgetId, verdict, source: 'reaction' };
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Chat polish (OpenMausBot §1.1/§1.2/§2.6): message pinning, general
// reactions breadth, and the spoiler content convention.
// ---------------------------------------------------------------------------

/** Emojis allowed for GENERAL message reactions (any message, any user). */
export const GENERAL_REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '🎉', '👀'] as const;

export function isGeneralReactionEmoji(v: unknown): v is string {
  return typeof v === 'string' && (GENERAL_REACTION_EMOJIS as readonly string[]).includes(v);
}

/**
 * Spoiler convention (server side): a span wrapped in ||double pipes||
 * is a spoiler. Message content is stored and returned VERBATIM — the
 * convention is only parsed, never rewritten — so the web client can
 * render those spans blurred until clicked.
 */
export interface SpoilerSegment { text: string; spoiler: boolean }

export function parseSpoilerSegments(content: string): SpoilerSegment[] {
  const out: SpoilerSegment[] = [];
  const re = /\|\|([\s\S]+?)\|\|/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) out.push({ text: content.slice(last, m.index), spoiler: false });
    out.push({ text: m[1] ?? '', spoiler: true });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last), spoiler: false });
  return out.length > 0 ? out : [{ text: content, spoiler: false }];
}

export function hasSpoiler(content: string): boolean {
  return /\|\|[\s\S]+?\|\|/.test(content);
}

// --- Message pinning --------------------------------------------------------

export interface PinnedMessage {
  threadId: string;
  messageId: string;
  /** Optional snapshot so the banner can render without a thread fetch. */
  text?: string;
  role?: string;
  pinnedAt: number;
  pinnedBy: string;
}

type PinsFile = Record<string, PinnedMessage[]>;

/** Persisted pinned messages, keyed by thread id. JSON file under dataDir (in-memory when omitted). */
export class PinnedMessageStore {
  private pins: PinsFile = {};
  constructor(private readonly dataDir?: string) {
    if (dataDir) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-pins.json'), 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.pins = parsed as PinsFile;
      } catch { /* missing/corrupt → start empty */ }
    }
  }
  private save(): void {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, 'chat-pins.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this.pins, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(this.dataDir, 'chat-pins.json'));
  }
  pin(threadId: string, input: { messageId: string; text?: string; role?: string; pinnedBy?: string }): PinnedMessage {
    const list = this.pins[threadId] ?? [];
    const existing = list.find((p) => p.messageId === input.messageId);
    if (existing) return existing;
    const pin: PinnedMessage = {
      threadId, messageId: input.messageId,
      ...(input.text ? { text: input.text.slice(0, 2000) } : {}),
      ...(input.role ? { role: input.role } : {}),
      pinnedAt: Date.now(), pinnedBy: input.pinnedBy ?? 'user',
    };
    this.pins[threadId] = [...list, pin];
    this.save();
    return pin;
  }
  unpin(threadId: string, messageId: string): boolean {
    const list = this.pins[threadId] ?? [];
    const next = list.filter((p) => p.messageId !== messageId);
    if (next.length === list.length) return false;
    if (next.length === 0) delete this.pins[threadId]; else this.pins[threadId] = next;
    this.save();
    return true;
  }
  list(threadId: string): PinnedMessage[] { return [...(this.pins[threadId] ?? [])]; }
  isPinned(threadId: string, messageId: string): boolean {
    return (this.pins[threadId] ?? []).some((p) => p.messageId === messageId);
  }
}

/** Structural subset of MessageReactionStore used for general reactions. */
export interface GeneralReactionStoreLike {
  toggle(sessionId: string, messageId: string, emoji: string, userId: string): { reactions: unknown[]; added: boolean };
  listForMessages(sessionId: string, ids: string[]): Map<string, unknown[]>;
}

export interface ChatUxRouterDeps {
  dataDir?: string;
  pins?: PinnedMessageStore;
  /** Existing MessageReactionStore — general reactions delegate to it. */
  reactionStore?: GeneralReactionStoreLike;
  /** Optional: verbatim thread messages, enriched with reactions + pinned flags. */
  listThreadMessages?: (threadId: string) => Array<Record<string, unknown> & { id: unknown }> | Promise<Array<Record<string, unknown> & { id: unknown }>>;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

function err(res: express.Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/**
 * Chat-UX router factory. HOST WIRING (parent):
 *   app.use('/api/chat-ux', createChatUxRouter({ dataDir: config.dataDir,
 *     reactionStore: messageReactionStore,
 *     listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
 *     audit: (a, f) => governance.audit(a, f) }));
 * Routes:
 *   GET    /threads/:threadId/pins
 *   POST   /threads/:threadId/pins            { messageId, text?, role? }
 *   DELETE /threads/:threadId/pins/:messageId
 *   POST   /threads/:threadId/messages/:messageId/reactions  { emoji, userId? }
 *          — general reactions only: emoji must be in GENERAL_REACTION_EMOJIS;
 *            the approval/widget reaction path in message-reactions-routes
 *            is untouched and remains the only verdict path.
 *   GET    /threads/:threadId/messages        — only when listThreadMessages
 *          is injected: messages enriched with `reactions` + `pinned`.
 */
export function createChatUxRouter(deps: ChatUxRouterDeps = {}): express.Router {
  const router = express.Router();
  const pins = deps.pins ?? new PinnedMessageStore(deps.dataDir);

  router.get('/threads/:threadId/pins', (req, res) => {
    res.json({ ok: true, threadId: req.params.threadId, pins: pins.list(req.params.threadId) });
  });
  router.post('/threads/:threadId/pins', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.messageId !== 'string' && typeof body.messageId !== 'number') { err(res, 400, 'messageId is required'); return; }
    const pin = pins.pin(req.params.threadId, {
      messageId: String(body.messageId),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(typeof body.role === 'string' ? { role: body.role } : {}),
      ...(typeof body.pinnedBy === 'string' ? { pinnedBy: body.pinnedBy } : {}),
    });
    deps.audit?.('chat.message_pin', { detail: { threadId: req.params.threadId, messageId: pin.messageId } });
    res.status(201).json({ ok: true, pin });
  });
  router.delete('/threads/:threadId/pins/:messageId', (req, res) => {
    const removed = pins.unpin(req.params.threadId, req.params.messageId);
    if (!removed) { err(res, 404, 'pin not found'); return; }
    deps.audit?.('chat.message_unpin', { detail: { threadId: req.params.threadId, messageId: req.params.messageId } });
    res.json({ ok: true, removed: true });
  });

  router.post('/threads/:threadId/messages/:messageId/reactions', (req, res) => {
    if (!deps.reactionStore) { err(res, 503, 'reaction store not configured'); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isGeneralReactionEmoji(body.emoji)) {
      err(res, 400, `emoji must be one of: ${GENERAL_REACTION_EMOJIS.join(' ')}`);
      return;
    }
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : 'user';
    try {
      const out = deps.reactionStore.toggle(req.params.threadId, req.params.messageId, body.emoji, userId);
      res.json({ ok: true, reactions: out.reactions, added: out.added });
    } catch (e) { err(res, 400, e instanceof Error ? e.message : String(e)); }
  });

  if (deps.listThreadMessages) {
    router.get('/threads/:threadId/messages', async (req, res) => {
      const messages = await deps.listThreadMessages!(req.params.threadId);
      const ids = messages.map((m) => String(m.id));
      const byId = deps.reactionStore?.listForMessages(req.params.threadId, ids) ?? new Map<string, unknown[]>();
      res.json({
        ok: true, threadId: req.params.threadId,
        messages: messages.map((m) => ({
          ...m,
          reactions: byId.get(String(m.id)) ?? [],
          pinned: pins.isPinned(req.params.threadId, String(m.id)),
        })),
      });
    });
  }
  return router;
}
