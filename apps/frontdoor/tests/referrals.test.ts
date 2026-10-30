// SPDX-License-Identifier: Apache-2.0
// DA-5 / DA-6 — Referral invites + redemption: store lifecycle (mint,
// redeem, expiry, exhaustion, self-referral, replay, revoke) and the
// HTTP handler with a stubbed session resolver. No email is sent; codes
// are shared out-of-band like workspace link codes.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  ReferralStore,
  generateReferralCode,
  handleReferralRequest,
} from '../src/referrals.js';
import type { Account } from '../src/store.js';

function tempStore(): ReferralStore {
  return new ReferralStore(mkdtempSync(join(tmpdir(), 'frontdoor-referrals-')));
}

const ALICE: Account = { id: 'sub-alice', email: 'alice@example.com', name: 'Alice', createdAt: '', lastLoginAt: '' };
const BOB: Account = { id: 'sub-bob', email: 'bob@example.com', name: 'Bob', createdAt: '', lastLoginAt: '' };
const CAROL: Account = { id: 'sub-carol', email: 'carol@example.com', name: 'Carol', createdAt: '', lastLoginAt: '' };

describe('ReferralStore', () => {
  it('mints codes in the KD-XXXXXX shape', () => {
    expect(generateReferralCode()).toMatch(/^KD-[A-Z2-9]{6}$/);
    const store = tempStore();
    const invite = store.createInvite(ALICE.id);
    expect(invite.code).toMatch(/^KD-[A-Z2-9]{6}$/);
    expect(invite.maxUses).toBe(10);
  });

  it('redeems a code once and binds redeemer → inviter', () => {
    const store = tempStore();
    const invite = store.createInvite(ALICE.id);
    const result = store.redeem(invite.code.toLowerCase(), BOB.id); // case-insensitive
    expect(result.ok).toBe(true);
    expect(store.referredBy(BOB.id)?.inviterAccountId).toBe(ALICE.id);
    expect(store.referralsOf(ALICE.id)).toHaveLength(1);
  });

  it('rejects self-referral, replay, and a second referral for the same account', () => {
    const store = tempStore();
    const invite = store.createInvite(ALICE.id);
    expect(store.redeem(invite.code, ALICE.id)).toEqual({ ok: false, reason: 'self-referral' });
    expect(store.redeem(invite.code, BOB.id).ok).toBe(true);
    expect(store.redeem(invite.code, BOB.id)).toEqual({ ok: false, reason: 'already-referred' });
    const invite2 = store.createInvite(CAROL.id);
    expect(store.redeem(invite2.code, BOB.id)).toEqual({ ok: false, reason: 'already-referred' });
  });

  it('rejects unknown, expired, exhausted, and revoked codes', () => {
    const store = tempStore();
    expect(store.redeem('KD-NOPE99', BOB.id)).toEqual({ ok: false, reason: 'unknown-code' });

    const short = store.createInvite(ALICE.id, { ttlMs: 1_000, now: new Date('2026-01-01T00:00:00Z') });
    expect(store.redeem(short.code, BOB.id, new Date('2026-01-02T00:00:00Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });

    const single = store.createInvite(ALICE.id, { maxUses: 1 });
    expect(store.redeem(single.code, BOB.id).ok).toBe(true);
    expect(store.redeem(single.code, CAROL.id)).toEqual({ ok: false, reason: 'exhausted' });

    const store2 = tempStore();
    const doomed = store2.createInvite(ALICE.id);
    expect(store2.revokeInvite(doomed.code, BOB.id)).toBe(false); // not the owner
    expect(store2.revokeInvite(doomed.code, ALICE.id)).toBe(true);
    expect(store2.redeem(doomed.code, BOB.id)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('persists across store instances on the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frontdoor-referrals-persist-'));
    const first = new ReferralStore(dir);
    const invite = first.createInvite(ALICE.id);
    first.redeem(invite.code, BOB.id);
    const second = new ReferralStore(dir);
    expect(second.referredBy(BOB.id)?.code).toBe(invite.code);
    expect(second.listInvites(ALICE.id)).toHaveLength(1);
  });
});

// --- HTTP handler -----------------------------------------------------------

interface FakeRes {
  status: number;
  body: string;
  res: ServerResponse;
}

function fakeRes(): FakeRes {
  const out: FakeRes = {
    status: 0,
    body: '',
    res: null as unknown as ServerResponse,
  };
  out.res = {
    writeHead(status: number) {
      out.status = status;
      return out.res;
    },
    end(payload?: string) {
      out.body = payload ?? '';
      return out.res;
    },
  } as unknown as ServerResponse;
  return out;
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload, 'utf8');
    },
  } as unknown as IncomingMessage;
}

describe('handleReferralRequest', () => {
  it('401s without a signed-in account and ignores non-referral paths', async () => {
    const store = tempStore();
    const anon = fakeRes();
    const handled = await handleReferralRequest(fakeReq('GET', '/api/referrals/mine'), anon.res, {
      store,
      accountFor: () => null,
    });
    expect(handled).toBe(true);
    expect(anon.status).toBe(401);

    const other = fakeRes();
    const notHandled = await handleReferralRequest(fakeReq('GET', '/dashboard'), other.res, {
      store,
      accountFor: () => ALICE,
    });
    expect(notHandled).toBe(false);
  });

  it('mint → redeem → mine round-trip over HTTP', async () => {
    const store = tempStore();
    const asAlice = { store, accountFor: () => ALICE };
    const asBob = { store, accountFor: () => BOB };

    const mintRes = fakeRes();
    await handleReferralRequest(fakeReq('POST', '/api/referrals/invites', {}), mintRes.res, asAlice);
    expect(mintRes.status).toBe(201);
    const { invite } = JSON.parse(mintRes.body) as { invite: { code: string } };

    const redeemRes = fakeRes();
    await handleReferralRequest(
      fakeReq('POST', '/api/referrals/redeem', { code: invite.code }),
      redeemRes.res,
      asBob,
    );
    expect(redeemRes.status).toBe(200);
    expect(JSON.parse(redeemRes.body).redemption.inviterAccountId).toBe(ALICE.id);

    const mineRes = fakeRes();
    await handleReferralRequest(fakeReq('GET', '/api/referrals/mine'), mineRes.res, asAlice);
    const mine = JSON.parse(mineRes.body) as {
      invites: Array<{ code: string; uses: number }>;
      referrals: unknown[];
    };
    expect(mine.invites[0]?.uses).toBe(1);
    expect(mine.referrals).toHaveLength(1);

    const badRes = fakeRes();
    await handleReferralRequest(fakeReq('POST', '/api/referrals/redeem', {}), badRes.res, asBob);
    expect(badRes.status).toBe(400);
  });
});
