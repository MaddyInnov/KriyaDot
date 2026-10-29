// SPDX-License-Identifier: Apache-2.0
// Invocation decision model: unified log, producer adapters (routing,
// semantic discovery, governance sink shape, delegation), stats over
// judged records only, retention cap shared with the routing log.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvocationDecisionLog,
  RouterDecisionLog,
  computeInvocationStats,
  createDelegationDecisionSink,
  createGovernanceDecisionSink,
  createInvocationSink,
  routeMessageLogged,
  DEFAULT_ROUTER_WEIGHTS,
} from '../src/routing-decisions.js';
import {
  decideAutoActivation,
  registerDiscoveryDecisionSink,
  type DiscoveryHit,
} from '../src/discovery.js';
import { createDelegateTools } from '../src/tools/delegate.js';

const BOTS = [
  { id: 'support', name: 'Support', description: 'customer support bot', keywords: ['refund', 'ticket'] },
  { id: 'dev', name: 'Dev', description: 'code bot', keywords: ['deploy', 'bug'] },
];

describe('invocation decision model', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'invdec-')); });
  afterEach(() => {
    registerDiscoveryDecisionSink(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('routing producer: routeMessageLogged also records kind=routing', () => {
    const log = new RouterDecisionLog(dir);
    routeMessageLogged('I need a refund for my ticket', BOTS, log, DEFAULT_ROUTER_WEIGHTS);
    const inv = new InvocationDecisionLog(dir);
    const entries = inv.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'routing', subject: 'support', outcome: 'routed' });
    expect(entries[0]!.rationale.length).toBeGreaterThan(0);
    // The routing log itself is unchanged in shape.
    expect(log.list(1)[0]!.winner).toBe('support');
  });

  it('skill-activation producer: decideAutoActivation notifies the registered sink', () => {
    const inv = new InvocationDecisionLog(dir);
    registerDiscoveryDecisionSink(createInvocationSink(inv));
    const hits: DiscoveryHit[] = [
      { item: { kind: 'skill', id: 'web-research', name: 'Web', description: 'd' }, score: 0.9 },
      { item: { kind: 'skill', id: 'other', name: 'Other', description: 'd' }, score: 0.2 },
    ];
    const decision = decideAutoActivation(hits, { threshold: 0.3, margin: 0.04 });
    expect(decision.abstained).toBe(false);
    let entries = inv.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'skill-activation', subject: 'web-research', outcome: 'activated' });
    expect(entries[0]!.confidence).toBeCloseTo(0.9);

    // Abstention is recorded too, with confidence in the abstention.
    decideAutoActivation([], {});
    entries = inv.all();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ kind: 'skill-activation', outcome: 'abstained' });
  });

  it('tool-invocation producer: governance sink maps allow/deny/require-approval → allow/deny/ask', () => {
    const inv = new InvocationDecisionLog(dir);
    const sink = createGovernanceDecisionSink(inv);
    sink({ toolName: 'read_file', effect: 'allow', botId: 'b1', actor: 'u', sessionId: 's', reason: 'Read-only', ruleId: 'allow-reads' });
    sink({ toolName: 'run_command', effect: 'deny', botId: 'b1', actor: 'u', sessionId: 's', reason: 'denylist: destructive command pattern' });
    sink({ toolName: 'write_file', effect: 'require-approval', botId: 'b1', actor: 'u', sessionId: 's', reason: 'default policy', approvalId: 'ap1' });
    const entries = inv.all();
    expect(entries.map((e) => e.outcome)).toEqual(['allow', 'deny', 'ask']);
    expect(entries[0]!.confidence).toBe(1); // explicit rule
    expect(entries[2]!.confidence).toBe(0.6); // policy default
    expect(entries.every((e) => e.kind === 'tool-invocation')).toBe(true);
  });

  it('delegation producer: delegate tool records success + failure, task hashed never raw', async () => {
    const inv = new InvocationDecisionLog(dir);
    const sink = createDelegationDecisionSink(inv);
    const [tool] = createDelegateTools({
      spawn: async () => ({ result: 'done', usage: null }),
      recordDecision: sink,
    });
    const ctx = { botId: 'chief', sessionId: 's1' } as never;
    await tool!.handler({ task: 'Investigate the secret launch plan' }, ctx);
    const failing = createDelegateTools({
      spawn: async () => { throw new Error('child exploded'); },
      recordDecision: sink,
    });
    await expect(failing[0]!.handler({ task: 'Investigate the secret launch plan' }, ctx)).rejects.toThrow('child exploded');
    const entries = inv.all();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'delegation', outcome: 'success', subject: 'chief' });
    expect(entries[1]).toMatchObject({ kind: 'delegation', outcome: 'failed' });
    expect(JSON.stringify(entries)).not.toContain('secret launch plan');
    expect((entries[0]!.metadata as { taskHash: string }).taskHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stats: per-kind totals, outcomes, avg confidence, agreement only over judged', () => {
    const inv = new InvocationDecisionLog(dir);
    const a = inv.record({ kind: 'routing', subject: 'support', outcome: 'routed', confidence: 0.8, rationale: 'r' });
    const b = inv.record({ kind: 'routing', subject: 'dev', outcome: 'routed', confidence: 0.6, rationale: 'r' });
    inv.record({ kind: 'tool-invocation', subject: 'read_file', outcome: 'allow', confidence: 1, rationale: 'r' });
    inv.markJudged(a.id, true);
    inv.markJudged(b.id, false);
    const stats = computeInvocationStats(dir);
    expect(stats.total).toBe(3);
    expect(stats.judged).toBe(2);
    expect(stats.agreementRate).toBe(0.5);
    expect(stats.perKind.routing.agreementRate).toBe(0.5);
    expect(stats.perKind.routing.avgConfidence).toBeCloseTo(0.7);
    expect(stats.perKind['tool-invocation'].agreementRate).toBeNull();
    expect(stats.perKind['tool-invocation'].outcomes).toEqual({ allow: 1 });
    expect(stats.perKind.delegation.total).toBe(0);
  });

  it('retention: invocation log file is bounded and list() is newest-first', () => {
    const inv = new InvocationDecisionLog(dir);
    for (let i = 0; i < 5; i++) {
      inv.record({ kind: 'routing', subject: `b${i}`, outcome: 'routed', confidence: 0.5, rationale: 'r' });
    }
    const lines = readFileSync(join(dir, 'invocation-decisions.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(5);
    expect(inv.list(2).map((e) => e.subject)).toEqual(['b4', 'b3']);
    expect(inv.list(10, 'delegation')).toEqual([]);
  });
});
