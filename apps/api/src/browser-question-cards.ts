// SPDX-License-Identifier: Apache-2.0
// BR-10 — Browser-task question cards returned to the originating chat
// (Muse parity audit §4.11).
//
// When a browser task needs a human decision ("this site asks for an
// OTP / which address should I ship to? / the price changed — proceed?")
// the question must surface in the chat the task CAME from — not in a
// global inbox the user has to go hunting for. This module is that
// bridge:
//
//   - ask() records a card bound to (originating sessionId, botId,
//     browser profile, task) and, when the host wired the chat widget
//     surface, raises a REAL interactive widget in that session via
//     the WidgetCoordinator — so the card renders in the originating
//     chat and the existing widget answer route
//     (POST /widgets/:id/answer) answers it.
//   - The browser runner awaits awaitAnswer(cardId): answered → the
//     value; expired/cancelled → fail-closed { answered: false }.
//   - Without a widget surface (headless hosts, tests) the card is
//     answered through this module's own route; the waiter mechanics
//     are identical.
//
// Card kinds map to widget kinds: confirm → 'confirm', choice →
// 'buttons' (options), text → 'input'. Answering through EITHER surface
// settles the card exactly once; the two surfaces are kept in sync by
// settling the widget when the card route answers, and by reading the
// widget's state when the runner polls/awaits.

import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import type { WidgetCoordinator, WidgetPayload, WidgetRecord } from '@mvp/agent-runtime';

export type BrowserQuestionKind = 'confirm' | 'choice' | 'text';
export type BrowserQuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface BrowserQuestionCard {
  id: string;
  /** Originating chat session — the card returns its answer here. */
  sessionId: string;
  botId: string;
  profileId: string;
  taskId?: string;
  kind: BrowserQuestionKind;
  question: string;
  options?: string[];
  /** Widget raised in the originating chat, when the surface is wired. */
  widgetId?: string;
  status: BrowserQuestionStatus;
  value?: unknown;
  createdAt: number;
  expiresAt: number;
  answeredAt?: number;
  answeredBy?: string;
}

export interface BrowserQuestionAnswer {
  answered: boolean;
  value?: unknown;
  expired?: boolean;
  cancelled?: boolean;
}

/** The slice of WidgetCoordinator this module uses (structural). */
export interface BrowserQuestionWidgetSurface {
  raise(input: {
    sessionId: string;
    botId: string;
    kind: 'confirm' | 'buttons' | 'input';
    payload: WidgetPayload;
    title?: string;
    interactive: boolean;
    ttlMs?: number;
  }): Promise<WidgetRecord>;
  settle(widgetId: string, input: { answered: boolean; value?: unknown; expired?: boolean }): WidgetRecord;
  awaitAnswer(widgetId: string, timeoutMs: number): Promise<{ answered: boolean; value?: unknown; expired?: boolean }>;
  widgetStore: { get(id: string): WidgetRecord | undefined };
}

export const DEFAULT_QUESTION_TTL_MS = 15 * 60 * 1000;
const MAX_CARDS = 500;

interface Waiter {
  resolve: (a: BrowserQuestionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserQuestionCards {
  private readonly widgets?: BrowserQuestionWidgetSurface;
  private readonly audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  private readonly nowFn: () => number;
  private readonly cards = new Map<string, BrowserQuestionCard>();
  private readonly waiters = new Map<string, Waiter>();

  constructor(deps: {
    widgets?: WidgetCoordinator;
    audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
    now?: () => number;
  } = {}) {
    this.widgets = deps.widgets as unknown as BrowserQuestionWidgetSurface | undefined;
    this.audit = deps.audit;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /** Raise a question card in the originating chat. Returns the pending card. */
  async ask(input: {
    sessionId: string;
    botId: string;
    profileId: string;
    taskId?: string;
    kind: BrowserQuestionKind;
    question: string;
    options?: string[];
    ttlMs?: number;
  }): Promise<BrowserQuestionCard> {
    if (!input.sessionId) throw new Error('sessionId (originating chat) is required');
    if (!input.botId) throw new Error('botId is required');
    if (!input.profileId) throw new Error('profileId is required');
    if (!input.question?.trim()) throw new Error('question is required');
    if (input.kind === 'choice' && (!input.options || input.options.length < 2)) {
      throw new Error('choice cards need at least two options');
    }
    const ttlMs = input.ttlMs ?? DEFAULT_QUESTION_TTL_MS;
    const now = this.nowFn();
    const card: BrowserQuestionCard = {
      id: randomUUID(),
      sessionId: input.sessionId,
      botId: input.botId,
      profileId: input.profileId,
      taskId: input.taskId,
      kind: input.kind,
      question: input.question.slice(0, 1000),
      options: input.options?.slice(0, 12).map((o) => String(o).slice(0, 200)),
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    if (this.widgets) {
      const payload: WidgetPayload =
        input.kind === 'confirm'
          ? { kind: 'confirm', question: card.question }
          : input.kind === 'choice'
            ? {
                kind: 'buttons',
                question: card.question,
                options: (card.options ?? []).map((label, i) => ({ id: `o${i + 1}`, label })),
              }
            : { kind: 'input', label: card.question };
      const widget = await this.widgets.raise({
        sessionId: input.sessionId,
        botId: input.botId,
        kind: input.kind === 'confirm' ? 'confirm' : input.kind === 'choice' ? 'buttons' : 'input',
        payload,
        title: 'Browser task question',
        interactive: true,
        ttlMs,
      });
      card.widgetId = widget.id;
    }

    this.cards.set(card.id, card);
    if (this.cards.size > MAX_CARDS) {
      // Drop the oldest closed cards first; never drop a pending one silently.
      for (const [id, c] of this.cards) {
        if (this.cards.size <= MAX_CARDS) break;
        if (c.status !== 'pending') this.cards.delete(id);
      }
    }
    this.audit?.('browser.question_asked', {
      detail: { cardId: card.id, sessionId: card.sessionId, botId: card.botId, profileId: card.profileId, kind: card.kind, widgetId: card.widgetId },
    });
    return card;
  }

  get(cardId: string): BrowserQuestionCard | undefined {
    const card = this.cards.get(cardId);
    if (!card) return undefined;
    this.syncFromWidget(card);
    if (card.status === 'pending' && this.nowFn() >= card.expiresAt) {
      this.finish(card, 'expired');
    }
    return card;
  }

  list(filter: { sessionId?: string; profileId?: string; status?: BrowserQuestionStatus } = {}): BrowserQuestionCard[] {
    return [...this.cards.values()]
      .map((c) => this.get(c.id) as BrowserQuestionCard)
      .filter(
        (c) =>
          (!filter.sessionId || c.sessionId === filter.sessionId) &&
          (!filter.profileId || c.profileId === filter.profileId) &&
          (!filter.status || c.status === filter.status),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Sync card state from its widget (the chat-side answer path writes there). */
  private syncFromWidget(card: BrowserQuestionCard): void {
    if (!card.widgetId || !this.widgets || card.status !== 'pending') return;
    const widget = this.widgets.widgetStore.get(card.widgetId);
    if (!widget) return;
    if (widget.status === 'answered') {
      card.status = 'answered';
      card.value = widget.value;
      card.answeredAt = widget.answeredAt ?? this.nowFn();
      this.resolveWaiter(card, { answered: true, value: widget.value });
    } else if (widget.status === 'expired') {
      this.finish(card, 'expired');
    }
  }

  private resolveWaiter(card: BrowserQuestionCard, answer: BrowserQuestionAnswer): void {
    const waiter = this.waiters.get(card.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(card.id);
      waiter.resolve(answer);
    }
  }

  private finish(card: BrowserQuestionCard, status: 'expired' | 'cancelled'): void {
    if (card.status !== 'pending') return;
    card.status = status;
    this.resolveWaiter(card, { answered: false, expired: status === 'expired', cancelled: status === 'cancelled' });
    this.audit?.(`browser.question_${status}`, { detail: { cardId: card.id, sessionId: card.sessionId } });
  }

  /**
   * Answer a card (this module's route; the chat widget route answering
   * the widget is the other surface — both settle exactly once).
   */
  answer(cardId: string, input: { value: unknown; answeredBy?: string }): BrowserQuestionCard {
    const card = this.get(cardId);
    if (!card) throw new Error(`unknown question card: ${cardId}`);
    if (card.status !== 'pending') throw new Error(`question card ${cardId} is already ${card.status}`);
    card.status = 'answered';
    card.value = input.value;
    card.answeredAt = this.nowFn();
    card.answeredBy = input.answeredBy;
    if (card.widgetId && this.widgets) {
      try {
        this.widgets.settle(card.widgetId, { answered: true, value: input.value });
      } catch {
        // Widget already settled/expired on its side — the card's own
        // record is authoritative for the runner; do not fail the answer.
      }
    }
    this.resolveWaiter(card, { answered: true, value: input.value });
    this.audit?.('browser.question_answered', {
      actor: input.answeredBy,
      detail: { cardId: card.id, sessionId: card.sessionId, kind: card.kind },
    });
    return card;
  }

  cancel(cardId: string): BrowserQuestionCard {
    const card = this.get(cardId);
    if (!card) throw new Error(`unknown question card: ${cardId}`);
    this.finish(card, 'cancelled');
    return card;
  }

  /**
   * The runner's wait. With a widget surface, delegates to the
   * coordinator's awaitAnswer (which fails closed on expiry) and syncs
   * the card; otherwise uses the internal waiter. Timeout is capped at
   * the card's own expiry.
   */
  async awaitAnswer(cardId: string, timeoutMs = DEFAULT_QUESTION_TTL_MS): Promise<BrowserQuestionAnswer> {
    const card = this.get(cardId);
    if (!card) throw new Error(`unknown question card: ${cardId}`);
    if (card.status === 'answered') return { answered: true, value: card.value };
    if (card.status === 'expired') return { answered: false, expired: true };
    if (card.status === 'cancelled') return { answered: false, cancelled: true };

    if (card.widgetId && this.widgets) {
      const res = await this.widgets.awaitAnswer(card.widgetId, timeoutMs);
      const fresh = this.get(cardId);
      if (res.answered && fresh) {
        if (fresh.status === 'pending') {
          fresh.status = 'answered';
          fresh.value = res.value;
          fresh.answeredAt = this.nowFn();
        }
        return { answered: true, value: res.value };
      }
      return { answered: false, expired: res.expired ?? fresh?.status === 'expired' };
    }

    const remaining = Math.min(Math.max(timeoutMs, 1), Math.max(card.expiresAt - this.nowFn(), 1));
    return new Promise<BrowserQuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(cardId);
        const fresh = this.cards.get(cardId);
        if (fresh && fresh.status === 'pending') this.finish(fresh, 'expired');
        resolve({ answered: false, expired: true });
      }, remaining);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.set(cardId, { resolve, timer });
    });
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /questions…)
// ---------------------------------------------------------------------------

export function registerBrowserQuestionRoutes(router: Router, deps: { cards: BrowserQuestionCards }): void {
  const { cards } = deps;

  router.post('/questions', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const card = await cards.ask({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        botId: typeof body.botId === 'string' ? body.botId : '',
        profileId: typeof body.profileId === 'string' ? body.profileId : '',
        taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
        kind: (body.kind as BrowserQuestionKind) ?? 'confirm',
        question: typeof body.question === 'string' ? body.question : '',
        options: Array.isArray(body.options) ? body.options.map(String) : undefined,
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
      });
      res.status(201).json({ ok: true, card });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/questions', (req, res) => {
    res.json({
      ok: true,
      cards: cards.list({
        sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
        profileId: typeof req.query.profileId === 'string' ? req.query.profileId : undefined,
        status: typeof req.query.status === 'string' ? (req.query.status as BrowserQuestionStatus) : undefined,
      }),
    });
  });

  router.get('/questions/:id', (req, res) => {
    const card = cards.get(req.params.id);
    if (!card) {
      res.status(404).json({ error: `unknown question card: ${req.params.id}` });
      return;
    }
    res.json({ ok: true, card });
  });

  router.post('/questions/:id/answer', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const card = cards.answer(req.params.id, {
        value: body.value,
        answeredBy: typeof body.answeredBy === 'string' ? body.answeredBy : undefined,
      });
      res.json({ ok: true, card });
    } catch (err) {
      const status = /unknown/.test(err instanceof Error ? err.message : '') ? 404 : 409;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/questions/:id/cancel', (req, res) => {
    try {
      res.json({ ok: true, card: cards.cancel(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function createBrowserQuestionRouter(deps: { cards: BrowserQuestionCards }): Router {
  const router = express.Router();
  registerBrowserQuestionRoutes(router, deps);
  return router;
}
