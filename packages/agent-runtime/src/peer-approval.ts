// SPDX-License-Identifier: Apache-2.0
// Peer approval cards for bot-to-bot interactions (OpenMausBot parity).
//
// When bot A calls `ask_bot` / `message_bot` / `delegate` targeting bot B, a
// dedicated peer-approval card is raised (distinct from generic tool
// approval): it shows the sender bot, the target bot, the action type, and a
// preview of the message/request. The user decides per action:
// Allow (this once), Deny, or Always allow (persists a per-pair grant for
// that action type, revokable).
//
// Cards expire after 15 minutes: an unanswered card auto-expires and the
// bot-to-bot call fails gracefully ("peer approval expired").
// If either bot is deleted, pending cards involving it are dismissed.
//
// The gate (`createPeerApprovalGate`) is consulted by AgentRuntime BEFORE
// governance on bot→bot tool calls. When it allows, the runtime marks the
// call peer-covered so governance does NOT raise a second (generic) tool
// card for the same call — no double-prompting.

import { randomUUID } from 'node:crypto';

import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';

import type { StreamEvent, ToolCall, ToolContext } from './types.js';
import type { ProvenanceNote } from './provenance.js';
import { serializeProvenanceNote, parseProvenanceNote } from './provenance.js';

/** Bot→bot action kinds that go through peer approval. */
export type PeerActionType = 'ask' | 'message' | 'delegate';

export const PEER_ACTION_TYPES: readonly PeerActionType[] = ['ask', 'message', 'delegate'] as const;

export function isPeerActionType(v: unknown): v is PeerActionType {
  return v === 'ask' || v === 'message' || v === 'delegate';
}

/** Card lifecycle states. */
export type PeerCardStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'dismissed';

export type PeerDecision = 'allow' | 'deny' | 'always-allow';

export function isPeerDecision(v: unknown): v is PeerDecision {
  return v === 'allow' || v === 'deny' || v === 'always-allow';
}

export interface PeerApprovalCard {
  id: string;
  senderBotId: string;
  senderBotName: string;
  targetBotId: string;
  targetBotName: string;
  actionType: PeerActionType;
  /** Truncated preview of the message/request text. */
  preview: string;
  sessionId: string;
  status: PeerCardStatus;
  createdAt: number;
  /** Epoch ms expiry, or null when the card never expires (W12). */
  expiresAt: number | null;
  /** W12: true when the card was raised with neverExpire. */
  neverExpire: boolean;
  decidedAt?: number;
  decidedBy?: string;
  /**
   * Provenance of the sender turn that raised this card (P1 #13): the
   * origin chain of the content that led the sender bot to make this peer
   * request. Shown in the UI as a security note. Absent for direct
   * user-driven turns.
   */
  provenance?: ProvenanceNote;
}

export interface PeerApprovalGrant {
  senderBotId: string;
  targetBotId: string;
  actionType: PeerActionType;
  grantedAt: number;
  grantedBy?: string;
}

export interface RaisePeerCardInput {
  senderBotId: string;
  senderBotName: string;
  targetBotId: string;
  targetBotName: string;
  actionType: PeerActionType;
  preview: string;
  sessionId: string;
  /** W12: when true the card never expires (expiresAt = null). */
  neverExpire?: boolean;
  /** Origin chain of the sender's turn (P1 #13) — shown on the card. */
  provenance?: ProvenanceNote;
}

/** Default card time-to-live: 15 minutes (OpenMausBot parity). */
export const PEER_CARD_TTL_MS = 15 * 60 * 1000;

/** Preview cap for the message/request text on a card. */
export const PEER_PREVIEW_MAX = 500;

interface PeerCardRow {
  id: string;
  sender_bot_id: string;
  sender_bot_name: string;
  target_bot_id: string;
  target_bot_name: string;
  action_type: string;
  preview: string;
  session_id: string;
  status: string;
  created_at: number;
  expires_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  provenance_json: string | null;
  never_expire: number | null;
}

interface PeerGrantRow {
  sender_bot_id: string;
  target_bot_id: string;
  action_type: string;
  granted_at: number;
  granted_by: string | null;
}

function rowToCard(r: PeerCardRow): PeerApprovalCard {
  let provenance: ProvenanceNote | undefined;
  if (r.provenance_json) {
    try {
      provenance = parseProvenanceNote(JSON.parse(r.provenance_json));
    } catch {
      provenance = undefined;
    }
  }
  return {
    id: r.id,
    senderBotId: r.sender_bot_id,
    senderBotName: r.sender_bot_name,
    targetBotId: r.target_bot_id,
    targetBotName: r.target_bot_name,
    actionType: r.action_type as PeerActionType,
    preview: r.preview,
    sessionId: r.session_id,
    status: r.status as PeerCardStatus,
    createdAt: r.created_at,
    expiresAt: r.never_expire === 1 ? null : (r.expires_at ?? null),
    neverExpire: r.never_expire === 1 || r.expires_at === null,
    decidedAt: r.decided_at ?? undefined,
    decidedBy: r.decided_by ?? undefined,
    provenance,
  };
}

function rowToGrant(r: PeerGrantRow): PeerApprovalGrant {
  return {
    senderBotId: r.sender_bot_id,
    targetBotId: r.target_bot_id,
    actionType: r.action_type as PeerActionType,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by ?? undefined,
  };
}

/**
 * SQLite-backed store for peer-approval cards and per-pair always-allow
 * grants. Cards and grants live in `peer-approval.db` under the data dir.
 */
export class PeerApprovalStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;

  constructor(dataDir: string, opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? PEER_CARD_TTL_MS;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'peer-approval.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peer_cards (
        id TEXT PRIMARY KEY,
        sender_bot_id TEXT NOT NULL,
        sender_bot_name TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        target_bot_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        preview TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        decided_at INTEGER,
        decided_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_peer_cards_status ON peer_cards (status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_peer_cards_bots ON peer_cards (sender_bot_id, target_bot_id);
      CREATE TABLE IF NOT EXISTS peer_grants (
        sender_bot_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        granted_by TEXT,
        PRIMARY KEY (sender_bot_id, target_bot_id, action_type)
      );
    `);
    // P1 #13: provenance column for existing databases.
    try {
      this.db.exec('ALTER TABLE peer_cards ADD COLUMN provenance_json TEXT');
    } catch {
      // Column already exists (or DB is read-only in a test) — safe to ignore.
    }
    // W12: never-expire flag. Legacy tables keep expires_at NOT NULL, so
    // raiseCard stores a far-future sentinel for never-expire cards on
    // those DBs (reads map it back to null via this flag).
    try {
      this.db.exec('ALTER TABLE peer_cards ADD COLUMN never_expire INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — safe to ignore.
    }
  }

  /** Card TTL in ms (for the broker's await timeout). */
  get cardTtlMs(): number {
    return this.ttlMs;
  }

  raiseCard(input: RaisePeerCardInput): PeerApprovalCard {
    const now = Date.now();
    const neverExpire = input.neverExpire === true;
    const card: PeerApprovalCard = {
      id: randomUUID(),
      senderBotId: input.senderBotId,
      senderBotName: input.senderBotName,
      targetBotId: input.targetBotId,
      targetBotName: input.targetBotName,
      actionType: input.actionType,
      preview: input.preview.slice(0, PEER_PREVIEW_MAX),
      sessionId: input.sessionId,
      status: 'pending',
      createdAt: now,
      expiresAt: neverExpire ? null : now + this.ttlMs,
      neverExpire,
      provenance: input.provenance,
    };
    const insert = this.db.prepare(
      `INSERT INTO peer_cards
         (id, sender_bot_id, sender_bot_name, target_bot_id, target_bot_name,
          action_type, preview, session_id, status, created_at, expires_at, provenance_json, never_expire)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const values = [
      card.id,
      card.senderBotId,
      card.senderBotName,
      card.targetBotId,
      card.targetBotName,
      card.actionType,
      card.preview,
      card.sessionId,
      card.status,
      card.createdAt,
      card.expiresAt,
      input.provenance ? serializeProvenanceNote(input.provenance) : null,
      neverExpire ? 1 : 0,
    ] as const;
    try {
      insert.run(...values);
    } catch (err) {
      if (!neverExpire) throw err;
      // Legacy NOT NULL expires_at: far-future sentinel (see widgets.ts).
      insert.run(...values.slice(0, 10), 253402300799999, values[11], values[12]);
    }
    return card;
  }

  getCard(id: string): PeerApprovalCard | undefined {
    const row = this.db.prepare('SELECT * FROM peer_cards WHERE id = ?').get(id) as unknown as
      | PeerCardRow
      | undefined;
    return row ? rowToCard(row) : undefined;
  }

  listCards(status?: PeerCardStatus): PeerApprovalCard[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM peer_cards WHERE status = ? ORDER BY created_at DESC').all(status)
        : this.db.prepare('SELECT * FROM peer_cards ORDER BY created_at DESC').all()
    ) as unknown as PeerCardRow[];
    return rows.map(rowToCard);
  }

  /**
   * Decide a pending card. 'always-allow' allows the card AND records a
   * per-pair grant for the action type. Throws when the card is missing or
   * no longer pending.
   */
  decideCard(id: string, decision: PeerDecision, decidedBy?: string): PeerApprovalCard {
    const card = this.getCard(id);
    if (!card) throw new Error(`peer approval card not found: ${id}`);
    if (card.status !== 'pending') {
      throw new Error(`peer approval card ${id} is ${card.status}, not pending`);
    }
    const now = Date.now();
    const status: PeerCardStatus = decision === 'deny' ? 'denied' : 'allowed';
    this.db
      .prepare('UPDATE peer_cards SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(status, now, decidedBy ?? null, id);
    if (decision === 'always-allow') {
      this.addGrant(card.senderBotId, card.targetBotId, card.actionType, decidedBy);
    }
    const updated = this.getCard(id);
    if (!updated) throw new Error(`peer approval card vanished after decision: ${id}`);
    return updated;
  }

  /**
   * Mark pending cards past their expiry as 'expired'. Returns the ids
   * that transitioned (so the host can settle in-flight waiters).
   */
  expireStale(now = Date.now()): string[] {
    // W12: never-expire cards never match (NULL expiry / flag guard).
    const rows = this.db
      .prepare(
        "SELECT id FROM peer_cards WHERE status = 'pending' AND expires_at IS NOT NULL AND COALESCE(never_expire, 0) = 0 AND expires_at <= ?",
      )
      .all(now) as unknown as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const stmt = this.db.prepare(
      "UPDATE peer_cards SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
    );
    const expired: string[] = [];
    for (const r of rows) {
      const res = stmt.run(now, r.id);
      if (res.changes > 0) expired.push(r.id);
    }
    return expired;
  }

  /**
   * Dismiss pending cards involving a deleted bot (sender or target).
   * Returns the number of cards dismissed.
   */
  dismissBotCards(botId: string): number {
    const res = this.db
      .prepare(
        `UPDATE peer_cards SET status = 'dismissed', decided_at = ?
         WHERE status = 'pending' AND (sender_bot_id = ? OR target_bot_id = ?)`,
      )
      .run(Date.now(), botId, botId);
    return Number(res.changes);
  }

  /** Per-pair always-allow grant lookup. */
  hasGrant(senderBotId: string, targetBotId: string, actionType: PeerActionType): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS one FROM peer_grants WHERE sender_bot_id = ? AND target_bot_id = ? AND action_type = ?',
      )
      .get(senderBotId, targetBotId, actionType) as unknown as { one: number } | undefined;
    return Boolean(row);
  }

  addGrant(senderBotId: string, targetBotId: string, actionType: PeerActionType, grantedBy?: string): PeerApprovalGrant {
    const grant: PeerApprovalGrant = {
      senderBotId,
      targetBotId,
      actionType,
      grantedAt: Date.now(),
      grantedBy,
    };
    this.db
      .prepare(
        `INSERT INTO peer_grants (sender_bot_id, target_bot_id, action_type, granted_at, granted_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sender_bot_id, target_bot_id, action_type)
         DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by`,
      )
      .run(grant.senderBotId, grant.targetBotId, grant.actionType, grant.grantedAt, grant.grantedBy ?? null);
    return grant;
  }

  listGrants(): PeerApprovalGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM peer_grants ORDER BY granted_at DESC')
      .all() as unknown as PeerGrantRow[];
    return rows.map(rowToGrant);
  }

  revokeGrant(senderBotId: string, targetBotId: string, actionType: PeerActionType): boolean {
    const res = this.db
      .prepare(
        'DELETE FROM peer_grants WHERE sender_bot_id = ? AND target_bot_id = ? AND action_type = ?',
      )
      .run(senderBotId, targetBotId, actionType);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Broker + gate
// ---------------------------------------------------------------------------

/**
 * Host-implemented broker: the runtime asks it to mint a card and then
 * awaits the human decision. The host (API layer) resolves in-flight
 * waiters when the user decides via HTTP, and fails cards closed on expiry.
 */
export interface PeerApprovalBroker {
  requestCard(input: RaisePeerCardInput): Promise<PeerApprovalCard>;
  awaitDecision(cardId: string, timeoutMs: number): Promise<'allowed' | 'denied' | 'expired'>;
  /** Resolve an in-flight awaitDecision waiter (HTTP decide path). */
  settle(cardId: string, decision: 'allowed' | 'denied' | 'expired'): void;
}

export type PeerGateAllowVia = 'not-peer' | 'self' | 'grant' | 'card' | 'bypass';

export type PeerGateVerdict =
  | { decision: 'allow'; via: PeerGateAllowVia; cardId?: string }
  | { decision: 'deny'; reason: string; cardId?: string; expired?: boolean };

/** Per-call options for the peer-approval gate. */
export interface PeerGateCallOpts {
  /** Event sink for peer_approval_required / peer_approval_decided. */
  onEvent?: (e: StreamEvent) => void | Promise<void>;
  /**
   * AbortSignal for mid-turn interruption. When aborted while a card is
   * pending, the wait ends and the gate denies fail-closed (the card
   * itself stays pending in the inbox until it expires or is decided).
   */
  signal?: AbortSignal;
}

/**
 * Peer-approval gate: consulted BEFORE governance on bot→bot tool calls.
 * The runtime only ever sees allow/deny; card minting, waiting, and expiry
 * live behind the broker.
 */
export type PeerApprovalGate = (
  call: ToolCall,
  ctx: ToolContext,
  gateOpts?: PeerGateCallOpts,
) => Promise<PeerGateVerdict>;

export interface PeerApprovalGateOpts {
  store: PeerApprovalStore;
  broker: PeerApprovalBroker;
  /** Resolve a bot id to a display name for card rendering. */
  getBotName?: (botId: string) => string | undefined;
  /** When true for the sender bot, the gate is skipped (bypass approval mode). */
  isBypassMode?: (botId: string) => boolean;
  /** Fallback event sink when the caller does not pass onEvent. */
  onEvent?: (e: StreamEvent) => void | Promise<void>;
  /** Optional audit sink for gate decisions. */
  audit?: (type: string, detail: Record<string, unknown>) => void;
}

interface ParsedPeerCall {
  targetBotId: string;
  action: PeerActionType;
  preview: string;
  selfCall: boolean;
}

/**
 * Recognize a bot→bot tool call. Returns null when the call is not a peer
 * call (or its target is missing/invalid — the tool handler itself will
 * produce the user-facing error for that).
 */
export function parsePeerCall(call: ToolCall, senderBotId: string): ParsedPeerCall | null {
  if (call.name === 'ask_bot' || call.name === 'message_bot') {
    const target = typeof call.args?.bot_id === 'string' ? call.args.bot_id.trim() : '';
    if (!target) return null;
    const message = typeof call.args?.message === 'string' ? call.args.message : '';
    return {
      targetBotId: target,
      action: call.name === 'ask_bot' ? 'ask' : 'message',
      preview: message.trim().slice(0, PEER_PREVIEW_MAX),
      selfCall: target === senderBotId,
    };
  }
  if (call.name === 'delegate') {
    const target = typeof call.args?.bot === 'string' ? call.args.bot.trim() : '';
    if (!target) return null; // plain subagent spawn, not peer delegation
    const task = typeof call.args?.task === 'string' ? call.args.task : '';
    return {
      targetBotId: target,
      action: 'delegate',
      preview: task.trim().slice(0, PEER_PREVIEW_MAX),
      selfCall: target === senderBotId,
    };
  }
  return null;
}

/** Human-readable framing for a peer action ("wants to ask", ...). */
export function describePeerAction(action: PeerActionType): string {
  return action === 'ask' ? 'ask' : action === 'message' ? 'message' : 'delegate a subtask to';
}

/**
 * Await a broker decision, abortable via an AbortSignal (mirrors the
 * runtime's awaitDecisionAbortable for generic approvals). On abort the
 * promise rejects and the caller fails closed; the card itself stays
 * pending in the store until it expires or is decided in the inbox.
 */
function awaitDecisionAbortable(
  broker: PeerApprovalBroker,
  cardId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<'allowed' | 'denied' | 'expired'> {
  if (!signal) return broker.awaitDecision(cardId, timeoutMs);
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<'allowed' | 'denied' | 'expired'>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    broker.awaitDecision(cardId, timeoutMs).then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export function createPeerApprovalGate(opts: PeerApprovalGateOpts): PeerApprovalGate {
  const nameOf = (botId: string): string => opts.getBotName?.(botId) ?? botId;

  return async (call, ctx, gateOpts) => {
    const emit = gateOpts?.onEvent ?? opts.onEvent;
    const parsed = parsePeerCall(call, ctx.botId);
    if (!parsed) return { decision: 'allow', via: 'not-peer' };
    if (parsed.selfCall) return { decision: 'allow', via: 'self' };

    const senderName = nameOf(ctx.botId);
    const targetName = nameOf(parsed.targetBotId);

    if (opts.isBypassMode?.(ctx.botId)) {
      opts.audit?.('tool.peer_approval_bypassed', {
        sessionId: ctx.sessionId,
        senderBotId: ctx.botId,
        targetBotId: parsed.targetBotId,
        action: parsed.action,
        warning: 'Peer approval auto-granted: sender bot is in bypass mode.',
      });
      return { decision: 'allow', via: 'bypass' };
    }

    if (opts.store.hasGrant(ctx.botId, parsed.targetBotId, parsed.action)) {
      opts.audit?.('tool.peer_approval_granted', {
        sessionId: ctx.sessionId,
        senderBotId: ctx.botId,
        targetBotId: parsed.targetBotId,
        action: parsed.action,
      });
      return { decision: 'allow', via: 'grant' };
    }

    let card: PeerApprovalCard;
    try {
      card = await opts.broker.requestCard({
        senderBotId: ctx.botId,
        senderBotName: senderName,
        targetBotId: parsed.targetBotId,
        targetBotName: targetName,
        actionType: parsed.action,
        preview: parsed.preview,
        sessionId: ctx.sessionId,
        // P1 #13: the origin chain of the sender's turn rides on the card
        // so the human sees WHY the sender is asking (user → A → B…).
        provenance: ctx.provenance,
      });
    } catch (err) {
      return {
        decision: 'deny',
        reason: `peer approval could not be requested: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Sender activity state: while the card is pending the bot is "waiting
    // on user". The host forwards this over SSE; the UI shows it inline.
    try {
      await emit?.({
        type: 'peer_approval_required',
        cardId: card.id,
        senderBotId: card.senderBotId,
        senderBotName: card.senderBotName,
        targetBotId: card.targetBotId,
        targetBotName: card.targetBotName,
        actionType: card.actionType,
        preview: card.preview,
        provenance: card.provenance,
      });
    } catch {
      // Event sinks must never break the gate.
    }

    // W12: never-expire cards wait on the broker's own long default; the
    // card itself never times out in the store.
    const remaining =
      card.expiresAt === null ? 24 * 60 * 60 * 1000 : Math.max(1000, card.expiresAt - Date.now());
    let verdict: 'allowed' | 'denied' | 'expired';
    try {
      verdict = await awaitDecisionAbortable(opts.broker, card.id, remaining, gateOpts?.signal);
    } catch {
      verdict = 'denied';
    }

    try {
      await emit?.({ type: 'peer_approval_decided', cardId: card.id, decision: verdict });
    } catch {
      // Event sinks must never break the gate.
    }

    opts.audit?.('tool.peer_approval_decided', {
      sessionId: ctx.sessionId,
      cardId: card.id,
      senderBotId: ctx.botId,
      targetBotId: parsed.targetBotId,
      action: parsed.action,
      verdict,
    });

    if (verdict === 'allowed') {
      return { decision: 'allow', via: 'card', cardId: card.id };
    }
    if (verdict === 'expired') {
      return {
        decision: 'deny',
        cardId: card.id,
        expired: true,
        reason:
          `peer approval expired (15 min): ${senderName} → ${targetName} ` +
          `(${describePeerAction(parsed.action)}) was not approved in time. ` +
          `Ask the user to approve sooner, or proceed without the peer.`,
      };
    }
    return {
      decision: 'deny',
      cardId: card.id,
      reason:
        `peer request denied: ${senderName} → ${targetName} ` +
        `(${describePeerAction(parsed.action)}) was not approved. ` +
        `Proceed without the peer or ask the user to allow it.`,
    };
  };
}
