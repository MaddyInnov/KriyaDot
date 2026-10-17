// SPDX-License-Identifier: Apache-2.0
// Tests for guarded external messages (governance):
// - decide() throws fail-closed when approving a relayed approval
// - denying a relayed approval is allowed
// - non-relayed approvals approve normally

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GovernanceGateway } from '../src/gateway.js';
import { DEFAULT_POLICY } from '../src/default-policy.js';

const CTX = { sessionId: 's1', botId: 'b1', actor: 'b1' };

describe('relayed approval gating', () => {
  let dir: string;
  let gw: GovernanceGateway;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'govrelayed-'));
    gw = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
  });
  afterEach(() => {
    gw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws fail-closed when approving a relayed approval', () => {
    const id = gw.requestApproval('send_email', {}, CTX, { relayed: true });
    expect(gw.getApproval(id)?.relayed).toBe(true);
    expect(() => gw.decide(id, 'approved', { decidedBy: 'user' })).toThrow(/relayed external message/);
    // Still pending — the operator can deny it explicitly.
    expect(gw.getApproval(id)?.status).toBe('pending');
  });

  it('allows denying a relayed approval', () => {
    const id = gw.requestApproval('send_email', {}, CTX, { relayed: true });
    const decided = gw.decide(id, 'denied', { decidedBy: 'user' });
    expect(decided.status).toBe('denied');
  });

  it('approves a non-relayed approval normally', () => {
    const id = gw.requestApproval('send_email', {}, CTX);
    const decided = gw.decide(id, 'approved', { decidedBy: 'user' });
    expect(decided.status).toBe('approved');
  });
});
