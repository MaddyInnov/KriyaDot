// SPDX-License-Identifier: Apache-2.0
// W7 multiplayer: approvals record the addressee person (the bot owner),
// listApprovals filters by person, and the relay tool stays
// approval-governed under the default policy.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GovernanceGateway } from '../src/gateway.js';
import { DEFAULT_POLICY } from '../src/default-policy.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function gateway(): GovernanceGateway {
  dir = mkdtempSync(join(tmpdir(), 'kriyadot-gov-addr-'));
  return new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
}

describe('approval addressee (W7)', () => {
  it('evaluate() records ctx.addresseePersonId on the pending approval', async () => {
    const gw = gateway();
    const res = await gw.evaluate(
      'run_command',
      { command: 'ls' },
      { sessionId: 's1', botId: 'bot-a', actor: 'bot-a', addresseePersonId: 'per_ana' },
    );
    expect(res.effect).toBe('require-approval');
    const rec = gw.getApproval(res.approvalId!);
    expect(rec?.addresseePersonId).toBe('per_ana');
    expect(rec?.botId).toBe('bot-a');
    gw.close();
  });

  it('requestApproval opts.addresseePersonId wins over ctx; listApprovals filters by person', () => {
    const gw = gateway();
    const a = gw.requestApproval(
      'message.send',
      { text: 'hi' },
      { sessionId: 's', botId: 'b1', actor: 'b1', addresseePersonId: 'per_ctx' },
      { addresseePersonId: 'per_opt' },
    );
    gw.requestApproval(
      'message.send',
      { text: 'yo' },
      { sessionId: 's', botId: 'b2', actor: 'b2', addresseePersonId: 'per_ben' },
    );
    expect(gw.getApproval(a)?.addresseePersonId).toBe('per_opt');
    expect(gw.listApprovals(undefined, { addresseePersonId: 'per_ben' })).toHaveLength(1);
    expect(gw.listApprovals('pending', { addresseePersonId: 'per_opt' })[0]?.id).toBe(a);
    expect(gw.listApprovals()).toHaveLength(2);
    gw.close();
  });

  it('relay_to_person is approval-governed under the default policy (no allow rule)', async () => {
    const gw = gateway();
    const sim = await gw.simulate('relay_to_person', { person: 'per_ana', message: 'hi' });
    expect(sim.effect).toBe('require-approval');
    expect(sim.wouldCreateApproval).toBe(true);
    const res = await gw.evaluate(
      'relay_to_person',
      { person: 'per_ana', message: 'hi' },
      { sessionId: 's', botId: 'bot-a', actor: 'bot-a', addresseePersonId: 'per_ana' },
    );
    expect(res.effect).toBe('require-approval');
    expect(gw.getApproval(res.approvalId!)?.addresseePersonId).toBe('per_ana');
    gw.close();
  });

  it('addressee survives a reopen (persisted column, migrated)', async () => {
    const gw = gateway();
    const id = gw.requestApproval(
      'write_file',
      { path: 'x' },
      { sessionId: 's', botId: 'b', actor: 'b', addresseePersonId: 'per_ana' },
    );
    gw.close();
    const gw2 = new GovernanceGateway({ dbPath: join(dir!, 'gov.db'), policy: DEFAULT_POLICY });
    expect(gw2.getApproval(id)?.addresseePersonId).toBe('per_ana');
    gw2.close();
  });
});
