// SPDX-License-Identifier: Apache-2.0
// DA-5 / DA-6 — Referral invites + code redemption, bound to front-door
// accounts.
//
// An account holder mints an invite code; a NEW account redeems it and the
// redemption is recorded against both accounts (the redeemer is marked
// referred-by the inviter). The hosted tier an invite refers INTO is the
// invitee's own cloud instance, registered through the existing
// workspace link-code flow — this module only owns the invite/redemption
// ledger. No email is sent anywhere: codes are shared by the inviter
// out-of-band, exactly like workspace link codes.
//
// Storage mirrors store.ts discipline: one JSON file, atomic tmp+rename
// writes at mode 0600, and NO chat content / credentials — only account
// ids, codes, and timestamps.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account } from './store.js';

export const REFERRAL_CODE_PREFIX = 'KD-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
export const DEFAULT_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_INVITE_MAX_USES = 10;

export interface ReferralInvite {
  code: string;
  inviterAccountId: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  revokedAt?: string;
}

export interface ReferralRedemption {
  code: string;
  inviterAccountId: string;
  redeemerAccountId: string;
  redeemedAt: string;
}

interface ReferralState {
  invites: ReferralInvite[];
  redemptions: ReferralRedemption[];
}

function emptyState(): ReferralState {
  return { invites: [], redemptions: [] };
}

/** Mint a human-shareable invite code, e.g. `KD-7F3K9Q`. */
export function generateReferralCode(): string {
  const bytes = randomBytes(6);
  let body = '';
  for (let i = 0; i < 6; i++) body += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${REFERRAL_CODE_PREFIX}${body}`;
}

export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export class ReferralStore {
  private readonly file: string;
  private state: ReferralState;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'frontdoor-referrals.json');
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ReferralState>;
        this.state = {
          invites: parsed.invites ?? [],
          redemptions: parsed.redemptions ?? [],
        };
      } catch {
        this.state = emptyState();
      }
    } else {
      this.state = emptyState();
    }
  }

  /** Atomic persist: sibling tmp file (0600), then rename over. */
  save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  createInvite(
    inviterAccountId: string,
    opts: { ttlMs?: number; maxUses?: number; now?: Date } = {},
  ): ReferralInvite {
    const now = opts.now ?? new Date();
    let code = generateReferralCode();
    while (this.state.invites.some((i) => i.code === code)) code = generateReferralCode();
    const invite: ReferralInvite = {
      code,
      inviterAccountId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? DEFAULT_INVITE_TTL_MS)).toISOString(),
      maxUses: Math.max(1, Math.floor(opts.maxUses ?? DEFAULT_INVITE_MAX_USES)),
    };
    this.state.invites.push(invite);
    this.save();
    return invite;
  }

  getInvite(code: string): ReferralInvite | undefined {
    return this.state.invites.find((i) => i.code === normalizeReferralCode(code));
  }

  listInvites(inviterAccountId: string): ReferralInvite[] {
    return this.state.invites.filter((i) => i.inviterAccountId === inviterAccountId);
  }

  revokeInvite(code: string, inviterAccountId: string): boolean {
    const invite = this.getInvite(code);
    if (!invite || invite.inviterAccountId !== inviterAccountId || invite.revokedAt) return false;
    invite.revokedAt = new Date().toISOString();
    this.save();
    return true;
  }

  redemptionsFor(code: string): ReferralRedemption[] {
    const normalized = normalizeReferralCode(code);
    return this.state.redemptions.filter((r) => r.code === normalized);
  }

  /** Accounts this account has successfully referred (as redeemer ids). */
  referralsOf(inviterAccountId: string): ReferralRedemption[] {
    return this.state.redemptions.filter((r) => r.inviterAccountId === inviterAccountId);
  }

  /** The redemption record for an account that joined via an invite, if any. */
  referredBy(redeemerAccountId: string): ReferralRedemption | undefined {
    return this.state.redemptions.find((r) => r.redeemerAccountId === redeemerAccountId);
  }

  /**
   * Redeem a code for an account. Fail-closed with a specific reason:
   * unknown / revoked / expired / exhausted / self-referral / replay.
   */
  redeem(
    code: string,
    redeemerAccountId: string,
    now: Date = new Date(),
  ): { ok: true; redemption: ReferralRedemption } | { ok: false; reason: string } {
    const invite = this.getInvite(code);
    if (!invite) return { ok: false, reason: 'unknown-code' };
    if (invite.revokedAt) return { ok: false, reason: 'revoked' };
    if (now.getTime() > Date.parse(invite.expiresAt)) return { ok: false, reason: 'expired' };
    if (invite.inviterAccountId === redeemerAccountId) return { ok: false, reason: 'self-referral' };
    if (this.referredBy(redeemerAccountId)) return { ok: false, reason: 'already-referred' };
    const prior = this.redemptionsFor(invite.code);
    if (prior.some((r) => r.redeemerAccountId === redeemerAccountId)) {
      return { ok: false, reason: 'already-redeemed' };
    }
    if (prior.length >= invite.maxUses) return { ok: false, reason: 'exhausted' };
    const redemption: ReferralRedemption = {
      code: invite.code,
      inviterAccountId: invite.inviterAccountId,
      redeemerAccountId,
      redeemedAt: now.toISOString(),
    };
    this.state.redemptions.push(redemption);
    this.save();
    return { ok: true, redemption };
  }
}

// ---------------------------------------------------------------------------
// HTTP surface (raw node:http, matching server.ts style).
//
// The front-door server wires this in with one delegation:
//   if (await handleReferralRequest(req, res, { store, accountFor })) return;
// `accountFor` resolves the signed-in account from the request (session
// cookie) — the same resolver the dashboard routes use. Unauthenticated
// requests get 401; nothing here sends email or touches instances.
// ---------------------------------------------------------------------------

export interface ReferralHttpDeps {
  store: ReferralStore;
  accountFor: (req: IncomingMessage) => Account | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Returns true when the request was a referral route (handled). */
export async function handleReferralRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReferralHttpDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://frontdoor.local');
  const path = url.pathname;
  const isReferralPath =
    path === '/api/referrals/invites' || path === '/api/referrals/redeem' || path === '/api/referrals/mine';
  if (!isReferralPath) return false;

  const account = deps.accountFor(req);
  if (!account) {
    sendJson(res, 401, { ok: false, error: 'sign-in required' });
    return true;
  }

  if (req.method === 'POST' && path === '/api/referrals/invites') {
    const body = await readJsonBody(req);
    const invite = deps.store.createInvite(account.id, {
      ...(typeof body['ttlDays'] === 'number' ? { ttlMs: body['ttlDays'] * 24 * 60 * 60 * 1000 } : {}),
      ...(typeof body['maxUses'] === 'number' ? { maxUses: body['maxUses'] } : {}),
    });
    sendJson(res, 201, { ok: true, invite });
    return true;
  }

  if (req.method === 'POST' && path === '/api/referrals/redeem') {
    const body = await readJsonBody(req);
    const code = typeof body['code'] === 'string' ? body['code'] : '';
    if (!code) {
      sendJson(res, 400, { ok: false, error: 'code is required' });
      return true;
    }
    const result = deps.store.redeem(code, account.id);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.reason });
      return true;
    }
    sendJson(res, 200, { ok: true, redemption: result.redemption });
    return true;
  }

  if (req.method === 'GET' && path === '/api/referrals/mine') {
    sendJson(res, 200, {
      ok: true,
      invites: deps.store.listInvites(account.id).map((invite) => ({
        ...invite,
        uses: deps.store.redemptionsFor(invite.code).length,
      })),
      referrals: deps.store.referralsOf(account.id),
      referredBy: deps.store.referredBy(account.id) ?? null,
    });
    return true;
  }

  sendJson(res, 405, { ok: false, error: 'method not allowed' });
  return true;
}
