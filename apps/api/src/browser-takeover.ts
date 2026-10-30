// SPDX-License-Identifier: Apache-2.0
// BR-9 — Defined user-takeover + handback flow for a bot's browser
// session (Muse parity audit §4.11).
//
// The raw hold (§1.4, agent-runtime BrowserHoldRegistry) is a switch:
// while a person holds a profile, bot actions block. This module is
// the FLOW around that switch — the states both sides move through so
// a takeover is a conversation, not a yank:
//
//   agent-control
//     └─ requestTakeover(person) ──► takeover-requested
//                                      │  the runner acknowledges at its
//                                      │  next safe point (acknowledge()),
//                                      │  or the requester begins it now
//                                      │  (begin()) — either places the
//                                      │  §1.4 hold, so bot actions block
//                                      ▼
//                                   user-control  (hold placed)
//                                      │  the person drives the browser
//                                      │  (checkout, CAPTCHA, inspection)
//                                      ▼
//     ┌─ completeHandback() ── handback-requested
//     │    the runner confirms it has resumed (or the person forces
//     │    release) — the hold is released and the session closes
//     ▼
//   agent-control   (session recorded in history with its full trail)
//
// Rules that keep this safe:
//   - One live session per profile. A second request while one is live
//     is refused with the live session's state (no silent preemption).
//   - The hold is placed exactly at the takeover-requested →
//     user-control transition and released exactly at handback
//     completion; while in user-control / handback-requested the
//     profile is held, so the bot cannot race the person.
//   - `takeover-requested` sessions that nobody acknowledges expire
//     (default 2 min) and return the profile to agent-control untouched.
//   - `user-control` sessions NEVER auto-release: a person mid-checkout
//     must not have the browser yanked back by a timer. They can be
//     force-released explicitly (audited as forced).
//   - Every transition is audit-logged through the injected hook.
//
// In-memory by design, matching the hold registry it wraps (holds are
// runtime state, not records). History is capped.

import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import {
  BrowserHeldError,
  defaultBrowserHoldRegistry,
  type BrowserHold,
  type BrowserHoldRegistry,
} from '@mvp/agent-runtime';

export type TakeoverState =
  | 'takeover-requested'
  | 'user-control'
  | 'handback-requested'
  | 'agent-control'; // terminal state of a closed session

export interface TakeoverTransition {
  from: TakeoverState | 'none';
  to: TakeoverState;
  at: number;
  by: string;
  note?: string;
}

export interface TakeoverSession {
  id: string;
  profileId: string;
  personId: string;
  personName?: string;
  reason?: string;
  state: TakeoverState;
  createdAt: number;
  updatedAt: number;
  /** When the §1.4 hold was placed (user-control began). */
  holdPlacedAt?: number;
  closedAt?: number;
  forced?: boolean;
  transitions: TakeoverTransition[];
}

export const DEFAULT_TAKEOVER_REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_HISTORY = 200;

export class TakeoverConflictError extends Error {
  readonly session: TakeoverSession;
  constructor(session: TakeoverSession) {
    super(
      `profile "${session.profileId}" already has a live takeover session (${session.state}) by ${session.personName ?? session.personId}`,
    );
    this.name = 'TakeoverConflictError';
    this.session = session;
  }
}

export class TakeoverStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TakeoverStateError';
  }
}

export interface BrowserTakeoverDeps {
  registry?: BrowserHoldRegistry;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  now?: () => number;
  requestTtlMs?: number;
}

export class BrowserTakeoverManager {
  private readonly registry: BrowserHoldRegistry;
  private readonly audit?: BrowserTakeoverDeps['audit'];
  private readonly nowFn: () => number;
  private readonly requestTtlMs: number;
  private readonly live = new Map<string, TakeoverSession>(); // by profileId
  private readonly byId = new Map<string, TakeoverSession>();
  private readonly history: TakeoverSession[] = [];

  constructor(deps: BrowserTakeoverDeps = {}) {
    this.registry = deps.registry ?? defaultBrowserHoldRegistry;
    this.audit = deps.audit;
    this.nowFn = deps.now ?? (() => Date.now());
    this.requestTtlMs = deps.requestTtlMs ?? DEFAULT_TAKEOVER_REQUEST_TTL_MS;
  }

  private transition(session: TakeoverSession, to: TakeoverState, by: string, note?: string): void {
    const from = session.state;
    session.state = to;
    session.updatedAt = this.nowFn();
    session.transitions.push({ from, to, at: session.updatedAt, by, ...(note ? { note } : {}) });
    this.audit?.(`browser.takeover_${to.replace(/-/g, '_')}`, {
      actor: by,
      detail: { sessionId: session.id, profileId: session.profileId, from, to, ...(note ? { note } : {}) },
    });
  }

  private close(session: TakeoverSession, by: string, forced: boolean, note?: string): TakeoverSession {
    session.forced = forced || session.forced;
    session.closedAt = this.nowFn();
    this.transition(session, 'agent-control', by, note ?? (forced ? 'forced release' : 'handback complete'));
    this.live.delete(session.profileId);
    this.history.unshift(session);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    return session;
  }

  /** Expire stale takeover-requested sessions. Returns the expired ones. */
  sweepExpired(): TakeoverSession[] {
    const now = this.nowFn();
    const expired: TakeoverSession[] = [];
    for (const session of [...this.live.values()]) {
      if (session.state === 'takeover-requested' && now - session.createdAt > this.requestTtlMs) {
        expired.push(this.close(session, 'system', false, 'takeover request expired unacknowledged'));
      }
    }
    return expired;
  }

  /**
   * Step 1 — a person asks to take over. Does NOT place the hold yet:
   * the bot keeps control until the request is acknowledged/begun, so
   * an abandoned request never strands the profile.
   */
  requestTakeover(input: {
    profileId: string;
    personId: string;
    personName?: string;
    reason?: string;
  }): TakeoverSession {
    if (!input.profileId) throw new Error('profileId is required');
    if (!input.personId) throw new Error('personId is required');
    this.sweepExpired();
    const existing = this.live.get(input.profileId);
    if (existing) throw new TakeoverConflictError(existing);
    // A raw hold placed outside this flow (legacy §1.4 route) also blocks.
    const rawHold = this.registry.get(input.profileId);
    if (rawHold && rawHold.personId !== input.personId) throw new BrowserHeldError(rawHold);
    const session: TakeoverSession = {
      id: randomUUID(),
      profileId: input.profileId,
      personId: input.personId,
      ...(input.personName ? { personName: input.personName } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      state: 'takeover-requested',
      createdAt: this.nowFn(),
      updatedAt: this.nowFn(),
      transitions: [],
    };
    session.transitions.push({ from: 'none', to: 'takeover-requested', at: session.createdAt, by: input.personId });
    this.audit?.('browser.takeover_takeover_requested', {
      actor: input.personId,
      detail: { sessionId: session.id, profileId: session.profileId, reason: session.reason },
    });
    this.live.set(input.profileId, session);
    this.byId.set(session.id, session);
    return session;
  }

  /**
   * Step 2 — control passes to the person: places the §1.4 hold (bot
   * actions block from this instant). Called by the runner at its safe
   * point (`by: 'runner'`) or by the requester to begin immediately.
   */
  begin(sessionId: string, opts: { by?: string } = {}): TakeoverSession {
    const session = this.mustGet(sessionId);
    if (session.state !== 'takeover-requested') {
      throw new TakeoverStateError(`takeover session ${sessionId} is ${session.state}, not takeover-requested`);
    }
    const hold: BrowserHold = this.registry.hold({
      profileId: session.profileId,
      personId: session.personId,
      ...(session.personName ? { personName: session.personName } : {}),
      reason: session.reason ?? 'user takeover',
    });
    session.holdPlacedAt = hold.heldAt;
    this.transition(session, 'user-control', opts.by ?? session.personId);
    return session;
  }

  /** Convenience: request + begin in one call (the common UI path). */
  takeOverNow(input: {
    profileId: string;
    personId: string;
    personName?: string;
    reason?: string;
  }): TakeoverSession {
    const session = this.requestTakeover(input);
    return this.begin(session.id, { by: input.personId });
  }

  /**
   * Step 3 — the person offers control back. The hold STAYS placed:
   * the person still owns the browser until the runner confirms the
   * handback, so nothing races in the gap.
   */
  requestHandback(sessionId: string, opts: { by?: string } = {}): TakeoverSession {
    const session = this.mustGet(sessionId);
    if (session.state !== 'user-control') {
      throw new TakeoverStateError(`takeover session ${sessionId} is ${session.state}, not user-control`);
    }
    this.transition(session, 'handback-requested', opts.by ?? session.personId);
    return session;
  }

  /**
   * Step 4 — handback completes: the hold is released and the bot may
   * act again. `by` is the runner confirming resumption, or the person
   * themselves. With `force: true` any live session is closed and the
   * hold force-released (audited).
   */
  completeHandback(sessionId: string, opts: { by?: string; force?: boolean } = {}): TakeoverSession {
    const session = this.mustGet(sessionId);
    if (session.state === 'takeover-requested') {
      // Nothing was ever handed over — completing is just cancelling.
      return this.close(session, opts.by ?? session.personId, opts.force === true, 'takeover request cancelled');
    }
    if (session.state !== 'handback-requested' && session.state !== 'user-control') {
      throw new TakeoverStateError(`takeover session ${sessionId} is already ${session.state}`);
    }
    if (session.state === 'user-control' && !opts.force) {
      throw new TakeoverStateError(
        'handback must be requested before it completes (or pass force: true) — the person still controls this browser',
      );
    }
    this.registry.release(session.profileId, { personId: session.personId, force: true });
    return this.close(session, opts.by ?? 'runner', opts.force === true);
  }

  /** Cancel a pending (not yet begun) takeover request. */
  cancel(sessionId: string, opts: { by?: string } = {}): TakeoverSession {
    const session = this.mustGet(sessionId);
    if (session.state !== 'takeover-requested') {
      throw new TakeoverStateError(`only a takeover-requested session can be cancelled (this one is ${session.state})`);
    }
    return this.close(session, opts.by ?? session.personId, false, 'takeover request cancelled');
  }

  get(sessionId: string): TakeoverSession | undefined {
    return this.byId.get(sessionId);
  }

  liveFor(profileId: string): TakeoverSession | undefined {
    this.sweepExpired();
    return this.live.get(profileId);
  }

  listLive(): TakeoverSession[] {
    this.sweepExpired();
    return [...this.live.values()];
  }

  listHistory(limit = 50): TakeoverSession[] {
    return this.history.slice(0, limit);
  }

  private mustGet(sessionId: string): TakeoverSession {
    const session = this.byId.get(sessionId);
    if (!session) throw new TakeoverStateError(`unknown takeover session: ${sessionId}`);
    if (session.state === 'agent-control') {
      throw new TakeoverStateError(`takeover session ${sessionId} is already closed`);
    }
    return session;
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /takeover…)
// ---------------------------------------------------------------------------

export function registerBrowserTakeoverRoutes(router: Router, deps: { manager: BrowserTakeoverManager }): void {
  const { manager } = deps;

  router.get('/takeover', (_req, res) => {
    res.json({ ok: true, live: manager.listLive(), history: manager.listHistory(20) });
  });

  router.get('/takeover/:profileId', (req, res) => {
    res.json({ ok: true, profileId: req.params.profileId, session: manager.liveFor(req.params.profileId) ?? null });
  });

  router.post('/takeover/:profileId', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.personId !== 'string' || !body.personId.trim()) {
      res.status(400).json({ error: 'personId is required' });
      return;
    }
    try {
      const input = {
        profileId: req.params.profileId,
        personId: body.personId.trim(),
        ...(typeof body.personName === 'string' ? { personName: body.personName } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      };
      const session = body.beginImmediately === true ? manager.takeOverNow(input) : manager.requestTakeover(input);
      res.status(201).json({ ok: true, session });
    } catch (err) {
      const status = err instanceof TakeoverConflictError || err instanceof BrowserHeldError ? 409 : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const step =
    (fn: (m: BrowserTakeoverManager, id: string, body: Record<string, unknown>) => TakeoverSession) =>
    (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json({ ok: true, session: fn(manager, req.params.sessionId, body) });
      } catch (err) {
        res.status(err instanceof TakeoverStateError && /unknown|already closed/.test(err.message) ? 404 : 409).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

  router.post('/takeover/session/:sessionId/begin', step((m, id) => m.begin(id)));
  router.post('/takeover/session/:sessionId/handback', step((m, id, body) =>
    m.requestHandback(id, { ...(typeof body.by === 'string' ? { by: body.by } : {}) }),
  ));
  router.post(
    '/takeover/session/:sessionId/complete',
    step((m, id, body) =>
      m.completeHandback(id, {
        ...(typeof body.by === 'string' ? { by: body.by } : {}),
        force: body.force === true,
      }),
    ),
  );
  router.post('/takeover/session/:sessionId/cancel', step((m, id) => m.cancel(id)));
}

export function createBrowserTakeoverRouter(deps: { manager: BrowserTakeoverManager }): Router {
  const router = express.Router();
  registerBrowserTakeoverRoutes(router, deps);
  return router;
}
