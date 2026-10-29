// SPDX-License-Identifier: Apache-2.0
// GatewayOptions.onDecision: the governance leg of the invocation
// decision model — every evaluate() outcome is reported once, and a
// throwing sink never changes the decision.

import { describe, expect, it, vi } from 'vitest';
import { GovernanceGateway, type GovernanceDecisionEvent } from '../src/gateway.js';
import { DEFAULT_POLICY } from '../src/default-policy.js';

const ctx = { sessionId: 's1', botId: 'bot-1', actor: 'user' };

describe('governance onDecision sink', () => {
  it('reports allow, require-approval and deny outcomes with reasons', async () => {
    const events: GovernanceDecisionEvent[] = [];
    const gw = new GovernanceGateway({
      dbPath: ':memory:',
      policy: DEFAULT_POLICY,
      onDecision: (e) => events.push(e),
    });
    const allow = await gw.evaluate('read_file', { path: 'x' }, ctx);
    expect(allow.effect).toBe('allow');
    const ask = await gw.evaluate('write_file', { path: 'x' }, ctx);
    expect(ask.effect).toBe('require-approval');
    expect(ask.approvalId).toBeTruthy();
    const deny = await gw.evaluate('run_command', { command: 'rm -rf /' }, ctx);
    expect(deny.effect).toBe('deny');
    gw.close();

    expect(events.map((e) => [e.toolName, e.effect])).toEqual([
      ['read_file', 'allow'],
      ['write_file', 'require-approval'],
      ['run_command', 'deny'],
    ]);
    expect(events[0]!.ruleId).toBe('allow-reads');
    expect(events[1]!.approvalId).toBe(ask.approvalId);
    expect(events.every((e) => e.botId === 'bot-1' && typeof e.reason === 'string')).toBe(true);
  });

  it('a throwing sink never changes the decision', async () => {
    const gw = new GovernanceGateway({
      dbPath: ':memory:',
      policy: DEFAULT_POLICY,
      onDecision: () => { throw new Error('sink exploded'); },
    });
    await expect(gw.evaluate('read_file', {}, ctx)).resolves.toMatchObject({ effect: 'allow' });
    gw.close();
  });

  it('no sink configured: evaluate behaves exactly as before', async () => {
    const spy = vi.fn();
    void spy;
    const gw = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    await expect(gw.evaluate('read_file', {}, ctx)).resolves.toMatchObject({ effect: 'allow' });
    gw.close();
  });
});
