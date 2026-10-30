// SPDX-License-Identifier: Apache-2.0
// P-13: opaque verification-code handoff — issue under an opaque
// reference, ~10-minute hold, approval-gated single-use delivery, and
// resend-once semantics. The code value must appear NOWHERE in any
// returned object or audit entry (asserted by scanning serializations).

import { describe, expect, it, vi } from 'vitest';
import { MockOSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import {
  createSignInCodeHandoffService,
  DEFAULT_CODE_HANDOFF_HOLD_MS,
  type SignInMessageSearcher,
} from '../src/sign-in-code-tools.js';

const CODE = '481516';
const T0 = Date.parse('2026-10-30T10:00:00Z');

function makeSearcher(): SignInMessageSearcher {
  return async () => ({
    sourcesSearched: ['gmail'],
    messages: [
      {
        subject: 'Your GitHub verification code',
        body: `Your verification code is ${CODE}. It expires in 10 minutes.`,
        sender: 'noreply@github.com',
        receivedAtMs: T0 - 30_000,
        source: 'gmail',
      },
    ],
  });
}

function makeService(nowRef: { now: number }) {
  const os = new MockOSScreenLayer();
  const typed: string[] = [];
  const originalType = os.type.bind(os);
  os.type = async (text: string) => {
    typed.push(text);
    return originalType(text);
  };
  const audit = vi.fn();
  const service = createSignInCodeHandoffService({
    searcher: makeSearcher(),
    now: () => nowRef.now,
    resolveOS: () => os,
    audit,
  });
  return { service, typed, audit };
}

const ISSUE = { botId: 'bot-1', userId: 'default-user', site: 'github.com' };

describe('opaque code handoff (P-13)', () => {
  it('issues an opaque reference that never contains the code', async () => {
    const nowRef = { now: T0 };
    const { service, audit } = makeService(nowRef);
    const issued = await service.issue(ISSUE);
    expect(issued.status).toBe('held');
    if (issued.status !== 'held') throw new Error('expected held');
    expect(issued.ref).not.toContain(CODE);
    expect(JSON.stringify(issued)).not.toContain(CODE);
    expect(issued.expiresAt - T0).toBe(DEFAULT_CODE_HANDOFF_HOLD_MS);
    const status = service.status(issued.ref);
    expect(status?.state).toBe('awaiting-approval');
    expect(JSON.stringify(status)).not.toContain(CODE);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(CODE);
  });

  it('delivery requires approval, types exactly once, and is single-use', async () => {
    const nowRef = { now: T0 };
    const { service, typed } = makeService(nowRef);
    const issued = await service.issue(ISSUE);
    if (issued.status !== 'held') throw new Error('expected held');

    const unapproved = await service.deliver(issued.ref, { approved: false });
    expect(unapproved.status).toBe('approval-required');
    expect(typed).toHaveLength(0);
    expect(service.status(issued.ref)?.state).toBe('awaiting-approval');

    const delivered = await service.deliver(issued.ref, { approved: true });
    expect(delivered.status).toBe('delivered');
    expect(JSON.stringify(delivered)).not.toContain(CODE);
    expect(typed).toEqual([CODE]);

    const again = await service.deliver(issued.ref, { approved: true });
    expect(again.status).toBe('already-delivered');
    expect(typed).toEqual([CODE]);
  });

  it('holds expire after ~10 minutes and an expired reference cannot be delivered or resent', async () => {
    const nowRef = { now: T0 };
    const { service, typed } = makeService(nowRef);
    const issued = await service.issue(ISSUE);
    if (issued.status !== 'held') throw new Error('expected held');

    nowRef.now = T0 + DEFAULT_CODE_HANDOFF_HOLD_MS + 1;
    expect(service.status(issued.ref)?.state).toBe('expired');
    expect((await service.deliver(issued.ref, { approved: true })).status).toBe('expired');
    expect((await service.resend(issued.ref)).status).toBe('expired');
    expect(typed).toHaveLength(0);
  });

  it('resend-once: first resend issues a NEW reference needing fresh approval; second invalidates the lineage', async () => {
    const nowRef = { now: T0 };
    const { service, typed } = makeService(nowRef);
    const issued = await service.issue(ISSUE);
    if (issued.status !== 'held') throw new Error('expected held');

    const resent = await service.resend(issued.ref);
    expect(resent.status).toBe('held');
    if (resent.status !== 'held') throw new Error('expected held');
    expect(resent.ref).not.toBe(issued.ref);
    expect(resent.resendCount).toBe(1);
    expect(JSON.stringify(resent)).not.toContain(CODE);

    // The old reference is dead.
    expect(service.status(issued.ref)?.state).toBe('invalidated');
    expect((await service.deliver(issued.ref, { approved: true })).status).toBe('invalidated');

    // The resent reference does NOT inherit the original approval.
    expect((await service.deliver(resent.ref, { approved: false })).status).toBe('approval-required');
    expect(typed).toHaveLength(0);

    // A second resend exhausts the lineage and kills the live reference.
    const second = await service.resend(resent.ref);
    expect(second.status).toBe('resend-exhausted');
    expect(service.status(resent.ref)?.state).toBe('invalidated');
    expect((await service.deliver(resent.ref, { approved: true })).status).toBe('invalidated');
    expect(typed).toHaveLength(0);
  });

  it('unknown references are reported, never guessed', async () => {
    const nowRef = { now: T0 };
    const { service } = makeService(nowRef);
    expect(service.status('no-such-ref')).toBeUndefined();
    expect((await service.deliver('no-such-ref', { approved: true })).status).toBe('unknown');
    expect((await service.resend('no-such-ref')).status).toBe('unknown');
  });
});
