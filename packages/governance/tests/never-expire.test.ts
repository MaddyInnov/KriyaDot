// SPDX-License-Identifier: Apache-2.0
// W12b never-expire approvals: an approval created with neverExpire has
// expiresAt=null, is skipped by expireStaleApprovals, and its
// awaitDecision never marks it expired — while normal approvals keep
// the existing expiry behaviour.

import { describe, expect, it } from 'vitest';
import { GovernanceGateway } from '../src/gateway.js';
import { DEFAULT_POLICY } from '../src/default-policy.js';

function gateway(approvalTimeoutMs = 50): GovernanceGateway {
  return new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY, approvalTimeoutMs });
}

const CTX = { sessionId: 's1', botId: 'bot1', actor: 'bot1' };

describe('never-expire approvals (W12b)', () => {
  it('requestApproval with neverExpire stores expiresAt=null + the flag', () => {
    const gw = gateway();
    const id = gw.requestApproval('write_file', { path: 'x' }, CTX, { neverExpire: true });
    const rec = gw.getApproval(id);
    expect(rec?.neverExpire).toBe(true);
    expect(rec?.expiresAt).toBeNull();
    gw.close();
  });

  it('normal approvals carry a concrete expiry and are swept after it', () => {
    const gw = gateway();
    const id = gw.requestApproval('write_file', { path: 'x' }, CTX);
    const rec = gw.getApproval(id);
    expect(rec?.neverExpire).toBeUndefined();
    expect(typeof rec?.expiresAt).toBe('number');
    const expired = gw.expireStaleApprovals(Date.now() + 60 * 60 * 1000);
    expect(expired).toContain(id);
    expect(gw.getApproval(id)?.status).toBe('expired');
    gw.close();
  });

  it('never-expire approvals survive the sweep far past the default window', () => {
    const gw = gateway();
    const id = gw.requestApproval('write_file', { path: 'x' }, CTX, { neverExpire: true });
    expect(gw.expireStaleApprovals(Date.now() + 365 * 24 * 60 * 60 * 1000)).toEqual([]);
    expect(gw.getApproval(id)?.status).toBe('pending');
    gw.close();
  });

  it('awaitDecision on a never-expire approval resolves on decide, never expires it', async () => {
    const gw = gateway(20);
    const id = gw.requestApproval('write_file', { path: 'x' }, CTX, { neverExpire: true });
    const waiting = gw.awaitDecision(id); // no explicit timeout → unbounded
    // Give any (non-existent) expiry timer a chance to fire.
    await new Promise((r) => setTimeout(r, 60));
    expect(gw.getApproval(id)?.status).toBe('pending');
    gw.decide(id, 'approved');
    await expect(waiting).resolves.toBe('approved');
    gw.close();
  });

  it('awaitDecision with an explicit timeout ends the wait but leaves a never-expire approval pending', async () => {
    const gw = gateway();
    const id = gw.requestApproval('write_file', { path: 'x' }, CTX, { neverExpire: true });
    await expect(gw.awaitDecision(id, 20)).resolves.toBe('denied');
    expect(gw.getApproval(id)?.status).toBe('pending'); // NOT expired
    // Still decidable afterwards.
    gw.decide(id, 'approved');
    expect(gw.getApproval(id)?.status).toBe('approved');
    gw.close();
  });

  it('normal approvals still expire via awaitDecision timeout (default behaviour unchanged)', async () => {
    const gw = gateway(20);
    const id = gw.requestApproval('write_file', { path: 'x' }, CTX);
    await expect(gw.awaitDecision(id)).resolves.toBe('denied');
    expect(gw.getApproval(id)?.status).toBe('expired');
    gw.close();
  });

  it('EvalContext.neverExpire flows through evaluate()', async () => {
    const gw = new GovernanceGateway({
      dbPath: ':memory:',
      policy: { defaultEffect: 'require-approval', rules: [] },
      approvalTimeoutMs: 1000,
    });
    const res = await gw.evaluate('write_file', { path: 'x' }, { ...CTX, neverExpire: true });
    expect(res.effect).toBe('require-approval');
    const rec = gw.getApproval(res.approvalId!);
    expect(rec?.neverExpire).toBe(true);
    expect(rec?.expiresAt).toBeNull();
    gw.close();
  });
});
