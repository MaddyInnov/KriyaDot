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
