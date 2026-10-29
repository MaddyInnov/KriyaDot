// SPDX-License-Identifier: Apache-2.0
/**
 * Profile/credential proposal cards (OpenMausBot parity).
 *
 * When a bot needs a credential or profile value it doesn't have, it calls
 * the `request_credential` agent tool instead of failing. The tool raises a
 * structured proposal card (same UX family as the peer-approval cards):
 * the user sees what the bot needs and why, supplies the value (or denies),
 * the value lands in the SecureVault, and the turn resumes.
 *
 * Security contract:
 * - The card stores metadata only (key name, label, reason) — NEVER the
 *   value. Values travel from the user's API call straight into the vault;
 *   they are never written to the proposals DB, logs, or audit detail.
 * - Cards expire after 15 minutes (same TTL as peer-approval cards).
 * - A denied/expired proposal resolves the tool with { ok: false } so the
 *   bot can explain and continue — the turn never hard-fails on a missing
 *   credential.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './sqlite.js';
import type { ToolDefinition } from './types.js';

export type CredentialProposalStatus = 'pending' | 'fulfilled' | 'denied' | 'expired';

export const CREDENTIAL_PROPOSAL_TTL_MS = 15 * 60 * 1000;

export interface CredentialProposal {
  id: string;
  botId: string;
  sessionId: string;
  /** Vault secret name the value will be stored under. */
  key: string;
  /** Human label shown on the card ("API key for Acme CRM"). */
  label: string;
  /** Why the bot needs it (shown on the card). */
  reason: string;
  status: CredentialProposalStatus;
  createdAt: number;
  /** Epoch ms expiry, or null when the card never expires (W12). */
  expiresAt: number | null;
  /** W12: true when the card was raised with neverExpire. */
  neverExpire: boolean;
  decidedAt: number | null;
}

export interface ProposeCredentialInput {
  botId: string;
  sessionId: string;
  key: string;
  label?: string;
  reason?: string;
  /** W12: when true the card never expires (expiresAt = null). */
  neverExpire?: boolean;
}

function sanitizeKey(key: string): string {
  const clean = key.trim().slice(0, 120);
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(clean)) {
    throw new Error('key must be 1-120 chars of letters, digits, and _ . -');
  }
  return clean;
}

export class CredentialProposalStore {
  private readonly db: DatabaseSync;
  /** proposalId → waiter for the in-flight tool call. */
  private readonly waiters = new Map<string, (fulfilled: boolean) => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'credential-proposals.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credential_proposals (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_credprop_status ON credential_proposals (status, expires_at);
    `);
    // W12: never-expire flag for existing databases (legacy tables keep
    // expires_at NOT NULL; propose() stores a far-future sentinel there).
    try {
      this.db.exec('ALTER TABLE credential_proposals ADD COLUMN never_expire INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists.
    }
  }

  private rowToProposal(row: {
    id: string; bot_id: string; session_id: string; key: string; label: string;
    reason: string; status: string; created_at: number; expires_at: number | null; decided_at: number | null;
    never_expire?: number | null;
  }): CredentialProposal {
    return {
      id: row.id,
      botId: row.bot_id,
      sessionId: row.session_id,
      key: row.key,
      label: row.label,
      reason: row.reason,
      status: row.status as CredentialProposalStatus,
      createdAt: row.created_at,
      expiresAt: row.never_expire === 1 ? null : (row.expires_at ?? null),
      neverExpire: row.never_expire === 1 || row.expires_at === null,
      decidedAt: row.decided_at,
    };
  }

  /** Mint a proposal card. Reuses the pending card for the same (bot, key). */
  propose(input: ProposeCredentialInput): CredentialProposal {
    const key = sanitizeKey(input.key);
    const existing = this.db
      .prepare(
        'SELECT * FROM credential_proposals WHERE bot_id = ? AND key = ? AND status = ? LIMIT 1',
      )
      .get(input.botId, key, 'pending') as Parameters<CredentialProposalStore['rowToProposal']>[0] | undefined;
    if (existing) return this.rowToProposal(existing);
    const now = Date.now();
    const neverExpire = input.neverExpire === true;
    const proposal: CredentialProposal = {
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId,
      key,
      label: (input.label ?? key).slice(0, 200),
      reason: (input.reason ?? '').slice(0, 1000),
      status: 'pending',
      createdAt: now,
      expiresAt: neverExpire ? null : now + CREDENTIAL_PROPOSAL_TTL_MS,
      neverExpire,
      decidedAt: null,
    };
    const insert = this.db.prepare(
      'INSERT INTO credential_proposals (id, bot_id, session_id, key, label, reason, status, created_at, expires_at, decided_at, never_expire) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    try {
      insert.run(
        proposal.id, proposal.botId, proposal.sessionId, proposal.key, proposal.label,
        proposal.reason, proposal.status, proposal.createdAt, proposal.expiresAt, null, neverExpire ? 1 : 0,
      );
    } catch (err) {
      if (!neverExpire) throw err;
      // Legacy NOT NULL expires_at: far-future sentinel (see widgets.ts).
      insert.run(
        proposal.id, proposal.botId, proposal.sessionId, proposal.key, proposal.label,
        proposal.reason, proposal.status, proposal.createdAt, 253402300799999, null, 1,
      );
    }
    return proposal;
  }

  get(id: string): CredentialProposal | undefined {
    const row = this.db.prepare('SELECT * FROM credential_proposals WHERE id = ?').get(id) as
      | Parameters<CredentialProposalStore['rowToProposal']>[0]
      | undefined;
    return row ? this.rowToProposal(row) : undefined;
  }

  list(status?: CredentialProposalStatus): CredentialProposal[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM credential_proposals WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM credential_proposals ORDER BY created_at DESC').all()) as Array<
      Parameters<CredentialProposalStore['rowToProposal']>[0]
    >;
    return rows.map((r) => this.rowToProposal(r));
  }

  /**
   * User supplies the value: the card is fulfilled and the waiting tool
   * call is released. The VALUE IS NOT STORED HERE — the caller (host)
   * writes it to the vault before/after calling this. Returns false when
   * the card is not pending.
   */
  fulfill(id: string): CredentialProposal | null {
    return this.settle(id, 'fulfilled');
  }

  deny(id: string): CredentialProposal | null {
    return this.settle(id, 'denied');
  }

  private settle(id: string, status: 'fulfilled' | 'denied'): CredentialProposal | null {
    const proposal = this.get(id);
    if (!proposal || proposal.status !== 'pending') return null;
    const now = Date.now();
    this.db
      .prepare('UPDATE credential_proposals SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, now, id);
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(status === 'fulfilled');
    }
    return { ...proposal, status, decidedAt: now };
  }

  /** Transition past-TTL pending cards to 'expired'. Returns the expired ids. */
  expireStale(now = Date.now()): string[] {
    // W12: never-expire cards never match (NULL expiry / flag guard).
    const rows = this.db
      .prepare(
        "SELECT id FROM credential_proposals WHERE status = 'pending' AND expires_at IS NOT NULL AND COALESCE(never_expire, 0) = 0 AND expires_at <= ?",
      )
      .all(now) as Array<{ id: string }>;
    for (const r of rows) {
      this.db.prepare("UPDATE credential_proposals SET status = 'expired', decided_at = ? WHERE id = ?").run(now, r.id);
      const waiter = this.waiters.get(r.id);
      if (waiter) {
        this.waiters.delete(r.id);
        waiter(false);
      }
    }
    return rows.map((r) => r.id);
  }

  /**
   * Wait for the user to fulfill/deny the proposal. Resolves true on
   * fulfill, false on deny/expire/timeout. The tool call awaits this.
   */
  awaitDecision(id: string, timeoutMs = CREDENTIAL_PROPOSAL_TTL_MS): Promise<boolean> {
    const proposal = this.get(id);
    if (!proposal) return Promise.resolve(false);
    if (proposal.status === 'fulfilled') return Promise.resolve(true);
    if (proposal.status !== 'pending') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiters.set(id, (fulfilled) => {
        clearTimeout(timer);
        resolve(fulfilled);
      });
    });
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Per-turn host for the `request_credential` tool. The API wires this to a
 * CredentialProposalStore + SecureVault: mint the card, wait for the user,
 * store the supplied value in the vault, and let the turn continue.
 */
export interface CredentialProposer {
  requestCredential(input: ProposeCredentialInput): Promise<{ ok: boolean; reason?: string }>;
}

/** Tool definition for `request_credential` (registered by the host wiring). */
export function createRequestCredentialTool(): ToolDefinition {
  return {
    name: 'request_credential',
    description:
      'Ask the user to provide a credential or profile value the bot needs (API key, username, preference). ' +
      'Raises a proposal card in the approvals inbox; the turn pauses until the user supplies the value or denies. ' +
      'On approval the value is stored in the vault under `key` — call this BEFORE failing for a missing credential. ' +
      'Never ask the user to paste secrets into chat; always use this tool.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Vault secret name to store the value under (e.g. "acme_api_key").' },
        label: { type: 'string', description: 'Human label for the card (e.g. "API key for Acme CRM").' },
        reason: { type: 'string', description: 'Why the bot needs it (shown on the card).' },
        neverExpire: { type: 'boolean', description: 'When true, the proposal card never expires (shown as "No expiry").' },
      },
      required: ['key'],
    },
    handler: async (args, ctx) => {
      const key = typeof args.key === 'string' ? args.key : '';
      if (!key.trim()) return { ok: false, reason: 'key is required' };
      const proposer = ctx.credentialProposer;
      if (!proposer) {
        return {
          ok: false,
          reason: 'No credential UI is attached to this turn (headless/CI). Ask the user to add the credential in Settings → Vault.',
        };
      }
      const result = await proposer.requestCredential({
        botId: ctx.botId,
        sessionId: ctx.sessionId,
        key: key.trim(),
        label: typeof args.label === 'string' ? args.label : undefined,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        neverExpire: args.neverExpire === true ? true : undefined,
      });
      if (result.ok) {
        return { ok: true, stored: true, key: key.trim(), note: 'Credential stored in the vault. Proceed.' };
      }
      return { ok: false, reason: result.reason ?? 'The user did not provide the credential.' };
    },
  };
}
