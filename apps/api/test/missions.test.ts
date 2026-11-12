// SPDX-License-Identifier: Apache-2.0
// A5 coding missions: end-to-end over a temp git repo with FAKE bot
// runners, a FAKE test command and a FAKE approval gate — zero paid APIs.
// Covers: chained dispatch A→B with landing + worktree cleanup, red suite
// (no landing, worktree preserved, no approval minted), rejected approval,
// rejected review, same-model review flagged honestly, cycle rejection at
// declaration time, dispatcher default-off + concurrency cap, and the B6
// structural property: a parked idea is never dispatched.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { validateWorkflowStructure } from '@mvp/workflows';
import { TaskStore } from '../src/tasks.js';
import { ParkedIdeaStore } from '../src/parked-ideas.js';
import {
  MissionDispatcher,
  MissionService,
  MissionStore,
  codingMissionWorkflowTemplate,
  registerMissionRoutes,
  type MissionApprovalGate,
  type MissionBotRunner,
  type MissionTestRunner,
} from '../src/missions.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(dir: string): string {
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  git(repo, ['config', 'user.email', 'test@kriyadot.local']);
  git(repo, ['config', 'user.name', 'Mission Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

interface Harness {
  dir: string;
  repo: string;
  taskStore: TaskStore;
  missionStore: MissionStore;
  service: MissionService;
  gate: { requests: number; decision: 'approved' | 'denied' };
  tests: { calls: number; pass: boolean };
  audits: Array<{ action: string; fields: Record<string, unknown> }>;
}

function makeHarness(opts: { sameModel?: boolean; reviewVerdict?: 'approve' | 'reject' } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-mission-'));
  const repo = makeRepo(dir);
  const taskStore = new TaskStore(dir);
  const missionStore = new MissionStore(dir);
  const gateState = { requests: 0, decision: 'approved' as 'approved' | 'denied' };
  const testState = { calls: 0, pass: true };
  const audits: Harness['audits'] = [];

  const botRunner: MissionBotRunner = async (req) => {
    if (req.role === 'worker') {
      writeFileSync(join(req.worktreePath, `feature-${req.taskId.slice(0, 8)}.txt`), `work for ${req.taskId}\n`);
      return { text: 'implemented', provider: 'groq', model: 'model-a' };
    }
    return {
      text: opts.reviewVerdict === 'reject' ? 'REJECT: needs work' : 'APPROVE: looks good',
      verdict: opts.reviewVerdict ?? 'approve',
      provider: opts.sameModel ? 'groq' : 'anthropic',
      model: opts.sameModel ? 'model-a' : 'model-b',
    };
  };
  const testRunner: MissionTestRunner = async () => {
    testState.calls += 1;
    return testState.pass
      ? { exitCode: 0, output: 'all green' }
      : { exitCode: 1, output: '1 failing test: boom' };
  };
  const approvalGate: MissionApprovalGate = {
    request: async () => {
      gateState.requests += 1;
      return `approval-${gateState.requests}`;
    },
    awaitDecision: async () => gateState.decision,
  };
  const service = new MissionService({
    taskStore,
    missionStore,
    worktreeRoot: join(dir, 'worktrees'),
    botRunner,
    testRunner,
    approvalGate,
    audit: (action, fields) => audits.push({ action, fields }),
    getBot: (botId) =>
      botId === 'code-reviewer' ? { provider: 'anthropic', model: 'model-b' } : { provider: 'groq', model: 'model-a' },
  });
  return { dir, repo, taskStore, missionStore, service, gate: gateState, tests: testState, audits };
}

function missionFor(h: Harness, taskId: string, repo = h.repo) {
  return h.service.createMission({ taskId, repoPath: repo, testCommand: 'run-tests' });
}

describe('mission workflow template (engine slice)', () => {
  it('is a structurally valid workflow definition with worker/reviewer/approval nodes', () => {
    expect(() => validateWorkflowStructure(codingMissionWorkflowTemplate)).not.toThrow();
    const types = codingMissionWorkflowTemplate.nodes.map((n) => n.type);
    expect(types).toContain('approval');
    expect(types.filter((t) => t === 'bot-turn')).toHaveLength(2);
  });
});

describe('task chains (tasks.ts)', () => {
  it('rejects cycles, self-blocks and unknown blockers at declaration time', () => {
    const h = makeHarness();
    const a = h.taskStore.create({ title: 'A' });
    const b = h.taskStore.create({ title: 'B', blockedBy: [a.id] });
    expect(b.blockedBy).toEqual([a.id]);
    expect(() => h.taskStore.update(a.id, { blockedBy: [b.id] })).toThrow(/cycle/);
    expect(() => h.taskStore.update(a.id, { blockedBy: [a.id] })).toThrow(/itself|cycle/);
    expect(() => h.taskStore.create({ title: 'C', blockedBy: ['nope'] })).toThrow(/unknown task/);
    // The failed declarations persisted nothing.
    expect(h.taskStore.get(a.id)?.blockedBy).toBeUndefined();
  });
});

describe('dispatcher + chained missions end-to-end', () => {
  it('runs A, lands it, then unblocks and lands B; dispatcher is off by default', async () => {
    const h = makeHarness();
    const a = h.taskStore.create({ title: 'Task A' });
    const b = h.taskStore.create({ title: 'Task B', blockedBy: [a.id] });
    const ma = missionFor(h, a.id);
    const mb = missionFor(h, b.id);
    const dispatcher = new MissionDispatcher(h.service, h.taskStore, h.missionStore, { maxConcurrent: 2 });

    // Default OFF: a tick starts nothing (automation must not surprise).
    expect(dispatcher.isEnabled()).toBe(false);
    expect(await dispatcher.tick()).toEqual([]);
    expect(h.missionStore.get(ma.id)?.stage).toBe('queued');

    dispatcher.setEnabled(true);
    // B is chain-blocked; only A is runnable.
    expect(dispatcher.runnableMissions().map((m) => m.id)).toEqual([ma.id]);
    expect(await dispatcher.tick()).toEqual([ma.id]);
    await dispatcher.drain();

    const landedA = h.missionStore.get(ma.id);
    expect(landedA?.stage).toBe('landed');
    expect(landedA?.provenance).toBe('dispatcher');
    expect(landedA?.reviewIndependence).toBe('cross-model');
    expect(landedA?.review?.verdict).toBe('approve');
    expect(landedA?.testResult?.exitCode).toBe(0);
    expect(landedA?.approvalId).toBe('approval-1');
    expect(h.taskStore.get(a.id)?.done).toBe(true);
    expect(h.taskStore.get(a.id)?.missionStage).toBe('landed');
    // Landed means: file is on main in the repo, worktree is cleaned up.
    expect(existsSync(join(h.repo, `feature-${a.id.slice(0, 8)}.txt`))).toBe(true);
    expect(landedA?.worktreePath && existsSync(landedA.worktreePath)).toBe(false);
    expect(git(h.repo, ['log', '--oneline']).includes('Land mission: Task A')).toBe(true);
    // Dispatcher provenance reached the audit trail.
    expect(h.audits.some((e) => e.action === 'mission.landed' && e.fields.provenance === 'dispatcher')).toBe(true);

    // B unblocked by A's completion.
    expect(dispatcher.runnableMissions().map((m) => m.id)).toEqual([mb.id]);
    expect(await dispatcher.tick()).toEqual([mb.id]);
    await dispatcher.drain();
    expect(h.missionStore.get(mb.id)?.stage).toBe('landed');
    expect(h.taskStore.get(b.id)?.done).toBe(true);
    expect(h.gate.requests).toBe(2);
    expect(h.tests.calls).toBe(2);
  });

  it('respects the concurrency cap', async () => {
    const h = makeHarness();
    const t1 = h.taskStore.create({ title: 'one' });
    const t2 = h.taskStore.create({ title: 'two' });
    missionFor(h, t1.id);
    missionFor(h, t2.id);
    const dispatcher = new MissionDispatcher(h.service, h.taskStore, h.missionStore, {
      maxConcurrent: 1,
      enabled: true,
    });
    expect(await dispatcher.tick()).toHaveLength(1);
    await dispatcher.drain();
    expect(await dispatcher.tick()).toHaveLength(1);
    await dispatcher.drain();
  });
});

describe('merge gate negatives', () => {
  it('red suite: no approval minted, no landing, worktree + branch preserved, mission blocked', async () => {
    const h = makeHarness();
    h.tests.pass = false;
    const t = h.taskStore.create({ title: 'Failing work' });
    const m = missionFor(h, t.id);
    const done = await h.service.runMission(m.id);
    expect(done.stage).toBe('blocked');
    expect(done.evidence).toMatch(/test suite failed/);
    expect(h.gate.requests).toBe(0);
    expect(done.worktreePath && existsSync(done.worktreePath)).toBe(true);
    expect(git(h.repo, ['branch', '--list', done.branch]).trim()).toContain(done.branch);
    expect(existsSync(join(h.repo, `feature-${t.id.slice(0, 8)}.txt`))).toBe(false);
    expect(h.taskStore.get(t.id)?.done).toBe(false);
    expect(h.taskStore.get(t.id)?.missionStage).toBe('blocked');
  });

  it('rejected approval: no landing, worktree preserved', async () => {
    const h = makeHarness();
    h.gate.decision = 'denied';
    const t = h.taskStore.create({ title: 'Unapproved work' });
    const m = missionFor(h, t.id);
    const done = await h.service.runMission(m.id);
    expect(done.stage).toBe('blocked');
    expect(done.evidence).toMatch(/approval denied/);
    expect(h.gate.requests).toBe(1);
    expect(done.worktreePath && existsSync(done.worktreePath)).toBe(true);
    expect(existsSync(join(h.repo, `feature-${t.id.slice(0, 8)}.txt`))).toBe(false);
  });

  it('rejected review: gate never runs (no tests, no approval), worktree preserved', async () => {
    const h = makeHarness({ reviewVerdict: 'reject' });
    const t = h.taskStore.create({ title: 'Bad work' });
    const m = missionFor(h, t.id);
    const done = await h.service.runMission(m.id);
    expect(done.stage).toBe('blocked');
    expect(done.evidence).toMatch(/review rejected/);
    expect(h.tests.calls).toBe(0);
    expect(h.gate.requests).toBe(0);
    expect(done.worktreePath && existsSync(done.worktreePath)).toBe(true);
  });

  it('same-model review is recorded honestly as same-model (and can still land)', async () => {
    const h = makeHarness({ sameModel: true });
    const t = h.taskStore.create({ title: 'Solo-model work' });
    const m = missionFor(h, t.id);
    const done = await h.service.runMission(m.id);
    expect(done.stage).toBe('landed');
    expect(done.reviewIndependence).toBe('same-model');
  });
});

describe('B6 structural exclusion', () => {
  it('a parked idea that looks exactly like a task is never dispatched', async () => {
    const h = makeHarness();
    const ideas = new ParkedIdeaStore(h.dir);
    ideas.create({ title: 'URGENT: implement the flux capacitor refactor now', body: 'do it immediately' });
    const dispatcher = new MissionDispatcher(h.service, h.taskStore, h.missionStore, { enabled: true });
    expect(dispatcher.runnableMissions()).toEqual([]);
    expect(await dispatcher.tick()).toEqual([]);
    await dispatcher.drain();
    // Nothing leaked into work: no tasks, no missions, idea untouched.
    expect(h.taskStore.list()).toEqual([]);
    expect(h.missionStore.list()).toEqual([]);
    expect(ideas.list()[0]?.state).toBe('parked');
  });
});

describe('mission routes', () => {
  it('creates, runs and reports a mission over HTTP; dispatcher defaults disabled', async () => {
    const h = makeHarness();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const dispatcher = new MissionDispatcher(h.service, h.taskStore, h.missionStore);
    registerMissionRoutes(router, {
      dataDir: h.dir,
      service: h.service,
      dispatcher,
      missionStore: h.missionStore,
    });
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      const disp = await (await fetch(`${base}/missions/dispatcher`)).json() as { enabled: boolean };
      expect(disp.enabled).toBe(false);
      const t = h.taskStore.create({ title: 'HTTP mission' });
      const created = await fetch(`${base}/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: t.id, repoPath: h.repo, testCommand: 'run-tests' }),
      });
      expect(created.status).toBe(201);
      const mission = (await created.json()) as { id: string; stage: string };
      expect(mission.stage).toBe('queued');
      const ran = await fetch(`${base}/missions/${mission.id}/run`, { method: 'POST' });
      expect(ran.status).toBe(200);
      expect(((await ran.json()) as { stage: string }).stage).toBe('landed');
      const bad = await fetch(`${base}/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'nope', repoPath: h.repo, testCommand: 'x' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
