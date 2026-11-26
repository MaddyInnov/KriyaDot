// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent, TokenUsage, ToolDefinition } from '@mvp/agent-runtime';
import type { EvalContext, EvaluateResult, GovernanceGateway } from '@mvp/governance';
import { WorkflowRunner } from '../src/runner.js';
import { Scheduler, TriggerStore, matchesCron, parseCron, publicTrigger } from '../src/triggers.js';
import { hashWorkflowSecret, isHashedWorkflowSecret } from '../src/webhook-secrets.js';
import type { Trigger, WorkflowDefinition } from '../src/triggers.js';

// ---------------------------------------------------------------------------
// cron matcher
// ---------------------------------------------------------------------------

describe('cron matcher', () => {
  // 2026-10-09 is a Friday (dow 5), the 9th of October.
  const FRI = new Date(2026, 9, 9, 12, 34, 0);
  const MON_9AM = new Date(2026, 9, 12, 9, 0, 0); // Monday 09:00

  it('matches * * * * * at any time', () => {
    expect(matchesCron('* * * * *', FRI)).toBe(true);
    expect(matchesCron('* * * * *', new Date(2026, 0, 1, 0, 0, 0))).toBe(true);
  });

  it('matches */15 minute steps', () => {
    expect(matchesCron('*/15 * * * *', new Date(2026, 9, 9, 12, 30, 0))).toBe(true);
    expect(matchesCron('*/15 * * * *', new Date(2026, 9, 9, 12, 45, 0))).toBe(true);
    expect(matchesCron('*/15 * * * *', FRI)).toBe(false); // :34
    expect(matchesCron('0,30 * * * *', FRI)).toBe(false);
    expect(matchesCron('0,30,34 * * * *', FRI)).toBe(true);
  });

  it('matches ranges, hours, names', () => {
    expect(matchesCron('0 9-17 * * *', new Date(2026, 9, 9, 12, 0, 0))).toBe(true);
    expect(matchesCron('0 9-17 * * *', new Date(2026, 9, 9, 18, 0, 0))).toBe(false);
    expect(matchesCron('0 9 * * mon', MON_9AM)).toBe(true);
    expect(matchesCron('0 9 * * mon', FRI)).toBe(false);
    const FRI_MIDNIGHT = new Date(2026, 9, 9, 0, 0, 0); // Friday the 9th, 00:00
    expect(matchesCron('0 0 9 oct *', FRI_MIDNIGHT)).toBe(true);
    expect(matchesCron('0 0 * * fri', FRI_MIDNIGHT)).toBe(true);
    expect(matchesCron('0 0 * * sun', FRI_MIDNIGHT)).toBe(false);
    expect(matchesCron('0 0 * * 7', new Date(2026, 9, 11, 0, 0, 0))).toBe(true); // 7 == Sunday
  });

  it('uses classic OR semantics when both dom and dow are restricted', () => {
    const FRI_MIDNIGHT = new Date(2026, 9, 9, 0, 0, 0); // Friday the 9th
    const MON_MIDNIGHT = new Date(2026, 9, 12, 0, 0, 0); // Monday the 12th
    expect(matchesCron('0 0 9 * mon', FRI_MIDNIGHT)).toBe(true); // dom=9 matches
    expect(matchesCron('0 0 12 * mon', MON_MIDNIGHT)).toBe(true); // dow=mon matches (dom 12)
    expect(matchesCron('0 0 10 * tue', FRI_MIDNIGHT)).toBe(false); // neither matches
    expect(matchesCron('0 0 9 * *', FRI_MIDNIGHT)).toBe(true); // only dom restricted
    expect(matchesCron('0 0 10 * *', FRI_MIDNIGHT)).toBe(false);
  });

  it('rejects invalid expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('* * * * * *')).toThrow(/5 fields/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('61 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('5-1 * * * *')).toThrow(/range/);
    expect(() => parseCron('nope * * * *')).toThrow();
    expect(() => parseCron('0 0 0 * *')).toThrow(/out of range/); // dom starts at 1
  });
});

// ---------------------------------------------------------------------------
// TriggerStore CRUD
// ---------------------------------------------------------------------------

describe('TriggerStore', () => {
  let dir: string;
  let store: TriggerStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triggers-'));
    store = new TriggerStore(join(dir, 'triggers.db'));
  });

  it('creates and reads cron and webhook triggers', () => {
    const cron = store.create({ workflowId: 'w1', kind: 'cron', cron: '*/5 * * * *' });
    const wh = store.create({ workflowId: 'w2', kind: 'webhook', secret: 's3cr3t-s3cr3t-1234' });
    expect(cron.id).toBeTruthy();
    expect(cron.enabled).toBe(true);
    expect(store.get(cron.id)).toMatchObject({ workflowId: 'w1', kind: 'cron', cron: '*/5 * * * *' });
    // A-12: create() returns the plaintext once; get() exposes only the hash.
    expect(wh.secret).toBe('s3cr3t-s3cr3t-1234');
    expect(store.get(wh.id)?.secret).toBe(hashWorkflowSecret('s3cr3t-s3cr3t-1234'));
    expect(store.list()).toHaveLength(2);
  });

  it('validates trigger fields eagerly', () => {
    expect(() => store.create({ workflowId: 'w', kind: 'cron', cron: 'bogus' })).toThrow();
    expect(() => store.create({ workflowId: 'w', kind: 'cron' })).toThrow(/cron expression/);
    expect(() => store.create({ workflowId: 'w', kind: 'webhook', secret: 'short' })).toThrow(/at least 16/);
    expect(() => store.create({ workflowId: 'w', kind: 'webhook' })).toThrow(/secret/);
  });

  it('enables/disables and removes triggers', () => {
    const t: Trigger = store.create({ workflowId: 'w1', kind: 'cron', cron: '* * * * *' });
    expect(store.listEnabled('cron')).toHaveLength(1);
    store.setEnabled(t.id, false);
    expect(store.listEnabled('cron')).toHaveLength(0);
    expect(store.get(t.id)?.enabled).toBe(false);
    expect(() => store.setEnabled('nope', true)).toThrow(/unknown trigger/);
    store.remove(t.id);
    expect(store.get(t.id)).toBeUndefined();
    expect(() => store.remove(t.id)).toThrow(/unknown trigger/);
  });

  it('persists across reopen', () => {
    const t = store.create({ workflowId: 'w9', kind: 'cron', cron: '0 6 * * *' });
    store.close();
    const reopened = new TriggerStore(join(dir, 'triggers.db'));
    expect(reopened.get(t.id)).toMatchObject({ workflowId: 'w9', cron: '0 6 * * *' });
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// A-12: webhook secret hash-at-rest (mirrors A-1 for routine triggers)
// ---------------------------------------------------------------------------

describe('TriggerStore webhook secret hash-at-rest (A-12)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triggers-hash-'));
  });

  function rawSecret(store: TriggerStore, id: string): string | null {
    const db = (store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
    const row = db.prepare('SELECT secret FROM triggers WHERE id = ?').get(id) as { secret: string | null };
    return row.secret;
  }

  it('creation stores hashed; the plaintext is returned once and still authenticates', () => {
    const store = new TriggerStore(join(dir, 'triggers.db'));
    const plain = 'workflow-secret-1234567890';
    const t = store.create({ workflowId: 'w1', kind: 'webhook', secret: plain });
    expect(t.secret).toBe(plain); // shown once, at creation
    expect(rawSecret(store, t.id)).toBe(hashWorkflowSecret(plain));
    expect(rawSecret(store, t.id)).not.toContain(plain);
    expect(isHashedWorkflowSecret(store.get(t.id)?.secret)).toBe(true);
    expect(store.verifySecret(t.id, plain)).toBe(true);
    expect(store.verifySecret(t.id, 'wrong-secret-value!!')).toBe(false);
    expect(store.verifySecret(t.id, undefined)).toBe(false);
    store.close();
  });

  it('migrates a planted plaintext row at open, idempotently, and the original secret still authenticates', () => {
    const plain = 'legacy-plaintext-secret-42';
    const first = new TriggerStore(join(dir, 'triggers.db'));
    // Plant a PRE-migration plaintext row exactly as a legacy DB held it.
    const db = (first as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare(
      'INSERT INTO triggers (id, workflow_id, kind, cron, secret, enabled, created_at) VALUES (?, ?, ?, NULL, ?, 1, ?)',
    ).run('t-legacy', 'w-legacy', 'webhook', plain, 1);
    first.close();

    // Reopen: the constructor migration runs.
    const migrated = new TriggerStore(join(dir, 'triggers.db'));
    expect(rawSecret(migrated, 't-legacy')).toBe(hashWorkflowSecret(plain));
    expect(rawSecret(migrated, 't-legacy')).not.toContain(plain);
    expect(migrated.verifySecret('t-legacy', plain)).toBe(true);
    expect(migrated.verifySecret('t-legacy', 'nope-nope-nope-nope')).toBe(false);
    migrated.close();

    // Idempotent: another open changes nothing.
    const again = new TriggerStore(join(dir, 'triggers.db'));
    expect(rawSecret(again, 't-legacy')).toBe(hashWorkflowSecret(plain));
    expect(again.verifySecret('t-legacy', plain)).toBe(true);
    again.close();
  });

  it('listings redact the secret and its hash', () => {
    const store = new TriggerStore(join(dir, 'triggers.db'));
    const t = store.create({ workflowId: 'w1', kind: 'webhook', secret: 'listing-secret-123456' });
    const pub = store.getPublic(t.id)!;
    expect('secret' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('listing-secret-123456');
    expect(JSON.stringify(pub)).not.toContain(hashWorkflowSecret('listing-secret-123456'));
    expect(store.listPublic().every((x) => !('secret' in x))).toBe(true);
    expect(publicTrigger(store.get(t.id)!)).not.toHaveProperty('secret');
    store.close();
  });

  it('rotation returns a new plaintext once; the old secret dies immediately', () => {
    const store = new TriggerStore(join(dir, 'triggers.db'));
    const t = store.create({ workflowId: 'w1', kind: 'webhook', secret: 'rotate-me-secret-1234' });
    const rotated = store.rotateSecret(t.id)!;
    expect(rotated.secret).toBeTruthy();
    expect(rotated.secret).not.toBe('rotate-me-secret-1234');
    expect(rawSecret(store, t.id)).toBe(hashWorkflowSecret(rotated.secret!));
    expect(store.verifySecret(t.id, 'rotate-me-secret-1234')).toBe(false);
    expect(store.verifySecret(t.id, rotated.secret)).toBe(true);
    expect(store.rotateSecret('does-not-exist')).toBeUndefined();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const TEST_BOT: BotConfig = {
  id: 'bot-1', name: 'Test Bot', description: 't', systemPrompt: 't',
  provider: 'groq', model: 'gpt-oss-20b', skills: [], tools: [], mcpServers: [],
};
const TEST_USAGE: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeFakeRuntime(): AgentRuntime {
  return {
    runTurn: async (options: { onEvent?: (e: StreamEvent) => void | Promise<void> }) => {
      await options.onEvent?.({ type: 'done', usage: TEST_USAGE } as StreamEvent);
      return TEST_USAGE;
    },
  } as AgentRuntime;
}

class AllowGovernance {
  async evaluate(_t: string, _a: Record<string, unknown>, _c: EvalContext): Promise<EvaluateResult> {
    return { effect: 'allow' };
  }
  asGateway(): GovernanceGateway {
    return this as unknown as GovernanceGateway;
  }
}

function toolDef(name: string, calls: string[], impl?: () => unknown): ToolDefinition {
  return {
    name,
    description: 'test tool',
    parameters: {},
    handler: async () => {
      calls.push(name);
      return impl ? impl() : { ok: name };
    },
  };
}

function makeTwoStepDef(): WorkflowDefinition {
  return {
    id: 'two-step',
    name: 'two step',
    nodes: [
      { id: 't', type: 'trigger', name: 'start', config: {} },
      { id: 's1', type: 'tool', name: 'step 1', config: { tool: 'step1' } },
      { id: 's2', type: 'tool', name: 'step 2', config: { tool: 'step2' } },
    ],
    edges: [['t', 's1'], ['s1', 's2']],
  };
}

function makeRunner(dbPath: string, tools: Map<string, ToolDefinition>): WorkflowRunner {
  return new WorkflowRunner({
    dbPath,
    agentRuntime: makeFakeRuntime(),
    governance: new AllowGovernance().asGateway(),
    tools,
    bots: new Map([['bot-1', TEST_BOT]]),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(25);
  }
}

describe('Scheduler', () => {
  it('fires due cron triggers once per minute and reports run ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-'));
    const calls: string[] = [];
    const runner = makeRunner(join(dir, 'w.db'), new Map([['step1', toolDef('step1', calls)], ['step2', toolDef('step2', calls)]]));
    runner.register(makeTwoStepDef());
    const tstore = new TriggerStore(join(dir, 'triggers.db'));
    tstore.create({ id: 'trig-1', workflowId: 'two-step', kind: 'cron', cron: '* * * * *' });
    tstore.create({ id: 'trig-off', workflowId: 'two-step', kind: 'cron', cron: '* * * * *', enabled: false });
    // Webhook triggers are never fired by the scheduler.
    tstore.create({ id: 'trig-wh', workflowId: 'two-step', kind: 'webhook', secret: 'x'.repeat(16) });

    let now = new Date(2026, 9, 9, 12, 34, 10);
    const fired: { trigger: Trigger; runId: string }[] = [];
    const sched = new Scheduler({ now: () => now });

    const first = await sched.tick(runner, tstore, (t, runId) => fired.push({ trigger: t, runId }));
    expect(first).toHaveLength(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].trigger.id).toBe('trig-1');

    // Same minute again: no double fire (in-memory dedup + idempotency key).
    now = new Date(2026, 9, 9, 12, 34, 50);
    expect(await sched.tick(runner, tstore)).toHaveLength(0);

    // Next minute: fires again.
    now = new Date(2026, 9, 9, 12, 35, 5);
    const second = await sched.tick(runner, tstore);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);

    // A fresh scheduler in the same minute as an already-fired trigger does
    // not double-start (idempotency key lookup).
    const sched2 = new Scheduler({ now: () => now });
    expect(await sched2.tick(runner, tstore)).toHaveLength(0);

    await runner.awaitRun(first[0], 10000);
    expect(calls.filter((c) => c === 'step1').length).toBeGreaterThanOrEqual(1);
    runner.close();
    tstore.close();
  });

  it('does not fire triggers whose schedule does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-'));
    const runner = makeRunner(join(dir, 'w.db'), new Map());
    runner.register(makeTwoStepDef());
    const tstore = new TriggerStore(join(dir, 'triggers.db'));
    tstore.create({ id: 't-midnight', workflowId: 'two-step', kind: 'cron', cron: '0 0 * * *' });
    const sched = new Scheduler({ now: () => new Date(2026, 9, 9, 12, 0, 0) });
    expect(await sched.tick(runner, tstore)).toHaveLength(0);
    runner.close();
    tstore.close();
  });
});

// ---------------------------------------------------------------------------
// Crash-resume
// ---------------------------------------------------------------------------

describe('crash-resume', () => {
  it('recovers a crashed run without re-executing completed steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-'));
    const dbPath = join(dir, 'w.db');
    const calls: string[] = [];

    // Runner 1: step2's handler never resolves -> the run is stuck mid-step2.
    let releaseStep2: (() => void) | null = null;
    const step2Gate = new Promise<void>((resolve) => {
      releaseStep2 = resolve;
    });
    const tools1 = new Map<string, ToolDefinition>([
      ['step1', toolDef('step1', calls, () => ({ n: 1 }))],
      ['step2', { name: 'step2', description: 't', parameters: {}, handler: async () => { calls.push('step2'); await step2Gate; return { n: 2 }; } }],
    ]);
    const runner1 = makeRunner(dbPath, tools1);
    runner1.register(makeTwoStepDef());
    const run = await runner1.startRun('two-step', {});

    // Wait until step1 is durably done and step2 is in-flight, then "crash".
    await waitFor(() => {
      const r = runner1.getRun(run.id)!;
      return r.nodeStates['s1']?.status === 'succeeded' && r.nodeStates['s2']?.status === 'running';
    });
    const preCrash = runner1.getRun(run.id)!;
    expect(preCrash.status).toBe('running');
    expect(preCrash.nodeStates['s1'].output).toEqual({ n: 1 });
    runner1.close(); // process dies here; step2's gate never opens in this "process"

    // Runner 2 boots on the same DB: step2 now resolves immediately.
    const tools2 = new Map<string, ToolDefinition>([
      ['step1', toolDef('step1', calls, () => ({ n: 1 }))],
      ['step2', toolDef('step2', calls, () => ({ n: 2 }))],
    ]);
    const runner2 = makeRunner(dbPath, tools2);
    const resumed = await runner2.recover();
    expect(resumed).toEqual([run.id]);

    const final = await runner2.awaitRun(run.id, 10000);
    expect(final.status).toBe('succeeded');
    expect(final.nodeStates['s2'].output).toEqual({ n: 2 });
    // Idempotency: the COMPLETED step1 ran exactly once across the crash and
    // was never re-executed. Step2 was interrupted mid-flight (never
    // completed), so resume re-ran it to completion: 1 interrupted attempt +
    // 1 completing attempt.
    expect(calls.filter((c) => c === 'step1')).toHaveLength(1);
    expect(calls.filter((c) => c === 'step2')).toHaveLength(2);
    // Checkpoint row was written.
    expect(final.currentStepIndex).toBe(3); // trigger + s1 + s2
    expect(final.stepOutputs?.['s1']).toEqual({ n: 1 });

    // recover() is idempotent: nothing left to resume.
    expect(await runner2.recover()).toEqual([]);
    runner2.close();
    expect(releaseStep2).not.toBeNull();
  });

  it('leaves paused-for-approval runs paused and terminal runs alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-'));
    const calls: string[] = [];
    // Governance fake that requires approval for the approval node.
    const approvals = new Map<string, (d: 'approved' | 'denied') => void>();
    const gov = {
      async evaluate(): Promise<EvaluateResult> {
        return { effect: 'allow' };
      },
      requestApproval(): string {
        const id = `appr-${approvals.size}`;
        return id;
      },
      awaitDecision(approvalId: string): Promise<'approved' | 'denied'> {
        return new Promise((resolve) => approvals.set(approvalId, resolve));
      },
    } as unknown as GovernanceGateway;
    const runner = new WorkflowRunner({
      dbPath: join(dir, 'w.db'),
      agentRuntime: makeFakeRuntime(),
      governance: gov,
      tools: new Map([['step1', toolDef('step1', calls)]]),
      bots: new Map([['bot-1', TEST_BOT]]),
    });
    runner.register({
      id: 'needs-approval',
      name: 'approval flow',
      nodes: [
        { id: 't', type: 'trigger', name: 'start', config: {} },
        { id: 'a', type: 'approval', name: 'human check', config: { message: 'ok?' } },
        { id: 's1', type: 'tool', name: 'step 1', config: { tool: 'step1' } },
      ],
      edges: [['t', 'a'], ['a', 's1']],
    });
    const run = await runner.startRun('needs-approval', {});
    await waitFor(() => runner.getRun(run.id)?.status === 'paused');

    // Recovery must not touch the paused run.
    expect(await runner.recover()).toEqual([]);
    expect(runner.getRun(run.id)?.status).toBe('paused');
    // A checkpoint was written on pause.
    expect(runner.getRun(run.id)?.currentStepIndex).toBe(1); // trigger done

    // Human approves -> run completes normally.
    const approvalId = runner.getRun(run.id)?.nodeStates['a']?.approvalId!;
    approvals.get(approvalId)!('approved');
    const final = await runner.awaitRun(run.id, 10000);
    expect(final.status).toBe('succeeded');
    expect(await runner.recover()).toEqual([]); // terminal: untouched
    runner.close();
  });
});
