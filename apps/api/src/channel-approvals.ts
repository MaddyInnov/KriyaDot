// SPDX-License-Identifier: Apache-2.0
// Structured channel approvals + action cards (Muse parity §4.6: CH-8/CH-10).
//
// HARD RULE (CH-10): a channel message can resolve a governance approval
// ONLY when it is a structured interactive reply (a button tap / list pick)
// whose reply id exactly matches a prompt this service issued. Free text —
// "yes", "ok", "approve", anything typed — NEVER resolves an approval and
// is never inspected for intent. This module deliberately exposes no
// text-to-decision path.
//
// Prompt lifecycle:
//   createApprovalPrompt() binds {promptId → approvalId, providerId,
//   chatId} and mints the two structured reply ids
//     kap:<promptId>:approved   kap:<promptId>:denied
//   handleInteractiveReply() is the single decision entry point. It checks,
//   in order: id shape → prompt exists → not consumed → not expired →
//   the reply came from the SAME chat the prompt was sent to (origin-bound)
//   → the governance approval is still pending — then calls
//   governance.decide() exactly once and consumes the prompt. A relayed
//   approval still cannot be approved: governance.decide() throws and the
//   prompt stays unconsumed so the operator can deny it in-app.
//
// Action cards (CH-8): generic tappable cards — connect / approve / open
// artifact — are built the same way (structured ids `kac:<cardId>:<action>`)
// and dispatched to host callbacks; unknown, expired, or wrong-chat taps
// are rejected, never guessed at.

import { randomUUID } from 'node:crypto';
import type { GovernanceGateway } from '@mvp/governance';

export const APPROVAL_REPLY_PREFIX = 'kap:';
export const ACTION_REPLY_PREFIX = 'kac:';
export const DEFAULT_PROMPT_TTL_MS = 15 * 60 * 1000;

export type ChannelDecision = 'approved' | 'denied';

export interface ApprovalPrompt {
  promptId: string;
  approvalId: string;
  providerId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export function approvalReplyId(promptId: string, decision: ChannelDecision): string {
  return `${APPROVAL_REPLY_PREFIX}${promptId}:${decision}`;
}

/** Parse a structured approval reply id. Returns null for anything else — including all free text. */
export function parseApprovalReplyId(replyId: unknown): { promptId: string; decision: ChannelDecision } | null {
  if (typeof replyId !== 'string') return null;
  if (!replyId.startsWith(APPROVAL_REPLY_PREFIX)) return null;
  const rest = replyId.slice(APPROVAL_REPLY_PREFIX.length);
  const idx = rest.lastIndexOf(':');
  if (idx <= 0) return null;
  const promptId = rest.slice(0, idx);
  const decision = rest.slice(idx + 1);
  if (decision !== 'approved' && decision !== 'denied') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(promptId)) return null;
  return { promptId, decision };
}

export type InteractiveReplyOutcome =
  | { handled: true; promptId: string; approvalId: string; decision: ChannelDecision }
  | {
      handled: false;
      reason:
        | 'not-a-structured-approval-reply'
        | 'unknown-prompt'
        | 'already-consumed'
        | 'expired'
        | 'wrong-chat'
        | 'approval-not-pending'
        | 'governance-refused';
      detail?: string;
    };

export interface ChannelApprovalServiceDeps {
  governance: GovernanceGateway;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Injectable clock for tests. */
  now?: () => number;
  promptTtlMs?: number;
}

export class ChannelApprovalService {
  private readonly governance: GovernanceGateway;
  private readonly audit?: ChannelApprovalServiceDeps['audit'];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly prompts = new Map<string, ApprovalPrompt>();

  constructor(deps: ChannelApprovalServiceDeps) {
    this.governance = deps.governance;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.promptTtlMs ?? DEFAULT_PROMPT_TTL_MS;
  }

  /**
   * Bind a pending governance approval to a channel chat and mint its
   * structured reply ids. Throws when the approval does not exist or is
   * not pending — a prompt for a decided approval is meaningless.
   */
  createApprovalPrompt(input: { approvalId: string; providerId: string; chatId: string }): {
    prompt: ApprovalPrompt;
    approveReplyId: string;
    denyReplyId: string;
  } {
    const rec = this.governance.getApproval(input.approvalId);
    if (!rec) throw new Error(`approval not found: ${input.approvalId}`);
    if (rec.status !== 'pending') throw new Error(`approval ${input.approvalId} is ${rec.status}, not pending`);
    if (!input.providerId || !input.chatId) throw new Error('providerId and chatId are required');
    const promptId = randomUUID();
    const createdAt = this.now();
    const prompt: ApprovalPrompt = {
      promptId,
      approvalId: input.approvalId,
      providerId: input.providerId,
      chatId: input.chatId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      consumed: false,
    };
    this.prompts.set(promptId, prompt);
    return {
      prompt,
      approveReplyId: approvalReplyId(promptId, 'approved'),
      denyReplyId: approvalReplyId(promptId, 'denied'),
    };
  }

  getPrompt(promptId: string): ApprovalPrompt | undefined {
    return this.prompts.get(promptId);
  }

  /**
   * THE decision entry point for channel input. Only structured reply ids
   * issued by createApprovalPrompt() can decide; every other input —
   * including any free text a caller mistakenly routes here — is refused
   * without touching governance.
   */
  handleInteractiveReply(input: {
    providerId: string;
    chatId: string;
    replyId: unknown;
    actor?: string;
  }): InteractiveReplyOutcome {
    const parsed = parseApprovalReplyId(input.replyId);
    if (!parsed) return { handled: false, reason: 'not-a-structured-approval-reply' };
    const prompt = this.prompts.get(parsed.promptId);
    if (!prompt) return { handled: false, reason: 'unknown-prompt' };
    if (prompt.consumed) return { handled: false, reason: 'already-consumed' };
    if (this.now() > prompt.expiresAt) return { handled: false, reason: 'expired' };
    if (prompt.providerId !== input.providerId || prompt.chatId !== input.chatId) {
      this.audit?.('channel.approval_wrong_chat', {
        actor: input.actor,
        detail: { promptId: prompt.promptId, expectedChat: prompt.chatId, gotChat: input.chatId },
      });
      return { handled: false, reason: 'wrong-chat' };
    }
    const rec = this.governance.getApproval(prompt.approvalId);
    if (!rec || rec.status !== 'pending') return { handled: false, reason: 'approval-not-pending' };
    try {
      this.governance.decide(prompt.approvalId, parsed.decision, {
        decidedBy: input.actor ?? `channel:${input.providerId}`,
        note: `structured ${input.providerId} button reply (prompt ${prompt.promptId})`,
      });
    } catch (err) {
      // Includes the relayed-approval hard refusal: prompt stays usable for
      // a deny tap / in-app handling; nothing was decided.
      this.audit?.('channel.approval_refused', {
        actor: input.actor,
        detail: { promptId: prompt.promptId, approvalId: prompt.approvalId, error: err instanceof Error ? err.message : String(err) },
      });
      return { handled: false, reason: 'governance-refused', detail: err instanceof Error ? err.message : String(err) };
    }
    prompt.consumed = true;
    this.audit?.('channel.approval_decided', {
      actor: input.actor,
      detail: { promptId: prompt.promptId, approvalId: prompt.approvalId, decision: parsed.decision, providerId: input.providerId },
    });
    return { handled: true, promptId: prompt.promptId, approvalId: prompt.approvalId, decision: parsed.decision };
  }

  /**
   * Explicit non-path, kept for call-site clarity (CH-10): channel free
   * text is NEVER a decision channel. Always refuses; never inspects the
   * text for approval-like words.
   */
  handleFreeText(_input: { providerId: string; chatId: string; text?: string }): { handled: false; reason: 'free-text-never-decides' } {
    return { handled: false, reason: 'free-text-never-decides' };
  }
}

// ---------------------------------------------------------------------------
// Action cards (CH-8): connect / approve / open artifact
// ---------------------------------------------------------------------------

export type ActionCardKind = 'connect' | 'approve' | 'open-artifact' | 'custom';

export interface ActionCard {
  cardId: string;
  kind: ActionCardKind;
  providerId: string;
  chatId: string;
  /** Structured reply id the tap will carry for the given action verb. */
  replyIdFor: (action: string) => string;
  expiresAt: number;
}

export function actionReplyId(cardId: string, action: string): string {
  return `${ACTION_REPLY_PREFIX}${cardId}:${action}`;
}

export function parseActionReplyId(replyId: unknown): { cardId: string; action: string } | null {
  if (typeof replyId !== 'string' || !replyId.startsWith(ACTION_REPLY_PREFIX)) return null;
  const rest = replyId.slice(ACTION_REPLY_PREFIX.length);
  const idx = rest.lastIndexOf(':');
  if (idx <= 0) return null;
  const cardId = rest.slice(0, idx);
  const action = rest.slice(idx + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(cardId) || !/^[a-z0-9-]+$/.test(action)) return null;
  return { cardId, action };
}

export interface ActionCardRegistryDeps {
  now?: () => number;
  cardTtlMs?: number;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Host callbacks keyed by card kind; invoked only for validated taps. */
  handlers: Partial<Record<ActionCardKind, (card: ActionCard, action: string, actor?: string) => void | Promise<void>>>;
}

export class ActionCardRegistry {
  private readonly cards = new Map<string, ActionCard & { consumed: boolean }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly deps: ActionCardRegistryDeps;

  constructor(deps: ActionCardRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.cardTtlMs ?? DEFAULT_PROMPT_TTL_MS;
  }

  createCard(input: { kind: ActionCardKind; providerId: string; chatId: string; actions?: string[] }): ActionCard {
    const cardId = randomUUID();
    const card: ActionCard & { consumed: boolean } = {
      cardId,
      kind: input.kind,
      providerId: input.providerId,
      chatId: input.chatId,
      replyIdFor: (action: string) => actionReplyId(cardId, action),
      expiresAt: this.now() + this.ttlMs,
      consumed: false,
    };
    this.cards.set(cardId, card);
    return card;
  }

  async handleInteractiveReply(input: {
    providerId: string;
    chatId: string;
    replyId: unknown;
    actor?: string;
  }): Promise<{ handled: boolean; reason?: string; cardId?: string; action?: string }> {
    const parsed = parseActionReplyId(input.replyId);
    if (!parsed) return { handled: false, reason: 'not-a-structured-action-reply' };
    const card = this.cards.get(parsed.cardId);
    if (!card) return { handled: false, reason: 'unknown-card' };
    if (card.consumed) return { handled: false, reason: 'already-consumed' };
    if (this.now() > card.expiresAt) return { handled: false, reason: 'expired' };
    if (card.providerId !== input.providerId || card.chatId !== input.chatId) {
      return { handled: false, reason: 'wrong-chat' };
    }
    const handler = this.deps.handlers[card.kind];
    if (!handler) return { handled: false, reason: 'no-handler-for-kind' };
    card.consumed = true;
    await handler(card, parsed.action, input.actor);
    this.deps.audit?.('channel.action_card_tapped', {
      actor: input.actor,
      detail: { cardId: card.cardId, kind: card.kind, action: parsed.action },
    });
    return { handled: true, cardId: card.cardId, action: parsed.action };
  }
}

/**
 * WhatsApp button specs for an approval prompt (CH-8 + CH-10 combined):
 * two reply buttons whose ids are the structured approval reply ids.
 * Titles respect the Cloud API 20-char button limit.
 */
export function approvalButtonSpecs(approveReplyId: string, denyReplyId: string): Array<{ id: string; title: string }> {
  return [
    { id: approveReplyId, title: '✅ Approve' },
    { id: denyReplyId, title: '⛔ Deny' },
  ];
}
