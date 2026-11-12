// SPDX-License-Identifier: Apache-2.0
// A15 fleet: TWO full instances over real HTTP on ephemeral ports —
// separate data dirs, separate federation identities, separate mission
// services with FAKE bot runners and per-instance approval gates.
// Covers: (a) fleet registry advertisement + liveness online→offline
// under a short test threshold, forgery rejection (record signed by the
// wrong key / tampered record), capability denial; (b) dispatch from A
// executing on B with B's OWN governance gate deciding the landing
// (approved → landed on B's repo + provenance mirror on A; denied →
// blocked everywhere, nothing landed); (c) resume-by-transfer: a mission
// blocked mid-flight on A (review rejected, worktree preserved) moves
// to B as a diff bundle, resumes AT REVIEW on B, lands there, carries
// the transferred label + reconstructed SessionStore transcript, and
// A's local copy is closed as transferred. Zero paid APIs.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, type BotConfig } from '@mvp/agent-runtime';
import { FederationService } from '@mvp/agent-runtime/dist/federation.js';
import { createFederationRouter } from '../src/federation-routes.js';
import { TaskStore } from '../src/tasks.js';
import {
  MissionService,
  MissionStore,
  type MissionApprovalGate,
  type MissionBotRunner,
  type MissionTestRunner,
} from '../src/missions.js';
import {
  FleetCoordinator,
  FleetRegistry,
  registerFleetRoutes,
  signFleetAdvertisement,
  verifyFleetAdvertisement,
  type FleetRecord,
} from '../src/fleet.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  git(repo, ['config', 'user.email', 'test@kriyadot.local']);
  git(repo, ['config', 'user.name', 'Fleet Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function bot(id: string, provider: string, model: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: `desc ${id}`,
    systemPrompt: 'p',
    provider,
    model,
    skills: [],
    tools: [],
    mcpServers: [],
  } as BotConfig;
}

const BOTS = [bot('coder', 'groq', 'model-a'), bot('code-reviewer', 'anthropic', 'model-b')];

interface Instance {
  name: string;
  dir: string;
  dataDir: string;
  base: string;
  fedBase: string;
  federation: FederationService;
  registry: FleetRegistry;
  coordinator: FleetCoordinator;
  taskStore: TaskStore;
  missionStore: MissionStore;
  service: MissionService;
  sessions: SessionStore;
  gate: { requests: number; decision: 'approved' | 'denied' };
  close: () => Promise<void>;
}

let root: string;
let A: Instance;
let B: Instance;
let repoShared: string;
let nowB = Date.now();

async function makeInstance(
  name: string,
  opts: { reviewVerdict?: 'approve' | 'reject'; transferRepoPath?: string } = {},
): Promise<Instance> {
  const dir = join(root, name);
  const dataDir = join(dir, 'data');
  execFileSync('mkdir', ['-p', dataDir]);
  const federation = new FederationService({ storePath: join(dataDir, 'federation.json'), name });
  const taskStore = new TaskStore(dataDir);
  const missionStore = new MissionStore(dataDir);
  const sessions = new SessionStore(join(dataDir, 'sessions.db'));
  const gate = { requests: 0, decision: 'approved' as 'approved' | 'denied' };

  const botRunner: MissionBotRunner = async (req) => {
    if (req.role === 'worker') {
      writeFileSync(join(req.worktreePath, `feature-${req.taskId.slice(0, 8)}.txt`), `work by ${name} for ${req.taskId}\n`);
      return { text: 'implemented', provider: 'groq', model: 'model-a' };
    }
    return {
      text: opts.reviewVerdict === 'reject' ? 'REJECT: needs work' : 'APPROVE: looks good',
      verdict: opts.reviewVerdict ?? 'approve',
      provider: 'anthropic',
      model: 'model-b',
    };
  };
  const testRunner: MissionTestRunner = async () => ({ exitCode: 0, output: 'all green' });
  const approvalGate: MissionApprovalGate = {
    request: async () => {
      gate.requests += 1;
      return `approval-${name}-${gate.requests}`;
    },
    awaitDecision: async () => gate.decision,
  };
  const service = new MissionService({
    taskStore,
    missionStore,
    worktreeRoot: join(dir, 'worktrees'),
    botRunner,
    testRunner,
    approvalGate,
    getBot: (botId) =>
      botId === 'code-reviewer' ? { provider: 'anthropic', model: 'model-b' } : { provider: 'groq', model: 'model-a' },
  });
  // Short liveness thresholds for the test (documented production
  // defaults are 45s/120s — see fleet.ts).
  const registry = new FleetRegistry(dataDir, {
    staleAfterMs: 300,
    offlineAfterMs: 800,
    ...(name === 'B' ? { now: () => nowB } : {}),
  });
  const coordinator = new FleetCoordinator({
    federation,
    registry,
    missionService: service,
    missionStore,
    taskStore,
    displayName: name,
    version: '0.1.0',
    capabilities: { bridges: ['claude'], sandboxBackend: null, gitAvailable: true },
    worktreeRoot: join(dir, 'worktrees'),
    transcripts: {
      list: (sessionId) => sessions.listThreadMessages(sessionId).map((m) => ({ role: m.role, content: m.content })),
      append: (sessionId, messages) => {
        for (const m of messages) sessions.appendMessage(sessionId, { role: m.role as 'user', content: m.content });
      },
    },
  });

  const app = express();
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { federationRawBody?: string }).federationRawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(
    '/api/federation',
    createFederationRouter({
      service: federation,
      getBots: () => BOTS,
      executePeerTurn: async ({ bot: b, message }) => ({ text: `${name}/${b.id} echo: ${message}`, deniedTools: [] }),
      audit: () => undefined,
    }),
  );
  const apiRouter = express.Router();
  registerFleetRoutes(apiRouter, {
    federation,
    coordinator,
    registry,
    ...(opts.transferRepoPath ? { transferRepoPath: opts.transferRepoPath } : {}),
  });
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const fedBase = `http://127.0.0.1:${port}/api/federation`;
  federation.setPublicUrl(fedBase);
  return {
    name,
    dir,
    dataDir,
    base: `http://127.0.0.1:${port}/api`,
    fedBase,
    federation,
    registry,
    coordinator,
    taskStore,
    missionStore,
    service,
    sessions,
    gate,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function api(inst: Instance, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, never> }> {
  const res = await fetch(`${inst.base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, never> };
}

async function fedApi(inst: Instance, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, never> }> {
  const res = await fetch(`${inst.fedBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, never> };
}

const FLEET_POLICY = { capabilities: ['chat', 'fleet', 'mission-dispatch'] };

async function link(): Promise<void> {
  const inv = await fedApi(A, '/invites', {
    method: 'POST',
    body: JSON.stringify({ policyForPeer: FLEET_POLICY }),
  });
  expect(inv.status).toBe(200);
  const acc = await fedApi(B, '/accept', {
    method: 'POST',
    body: JSON.stringify({ payload: inv.body.payload, policy: FLEET_POLICY }),
  });
  expect(acc.status).toBe(200);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kriyadot-fleet-'));
  nowB = Date.now();
  repoShared = makeRepo(root, 'repo-shared');
  A = await makeInstance('A');
  B = await makeInstance('B', { transferRepoPath: join(root, 'repo-b') });
  await link();
});

afterEach(async () => {
  await A.close();
  await B.close();
  rmSync(root, { recursive: true, force: true });
});

describe('fleet registry + liveness (proof leg a)', () => {
  it('both machines appear in each other\'s fleet view; a silent machine goes stale then offline but is never dropped', async () => {
    expect((await api(A, '/fleet/advertise', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await api(B, '/fleet/advertise', { method: 'POST', body: '{}' })).status).toBe(200);

    const fleetA = (await api(A, '/fleet')).body as unknown as {
      machines: Array<{ instanceId: string; displayName: string; liveness: string; isSelf: boolean; capabilities: { gitAvailable: boolean } }>;
    };
    const fleetB = (await api(B, '/fleet')).body as unknown as typeof fleetA;
    expect(fleetA.machines).toHaveLength(2);
    expect(fleetB.machines).toHaveLength(2);
    const bOnA = fleetA.machines.find((m) => !m.isSelf)!;
    expect(bOnA.displayName).toBe('B');
    expect(bOnA.liveness).toBe('online');
    expect(bOnA.capabilities.gitAvailable).toBe(true);
    expect(fleetA.machines.find((m) => m.isSelf)?.displayName).toBe('A');

    // B stops advertising (simulated by advancing B-side registry clock
    // via A's view of time is not possible — instead advance the shared
    // threshold clock on B's registry, which holds A's record).
    nowB = Date.now() + 400; // past stale (300ms), before offline (800ms)
    const staleView = B.registry.listEntries(nowB).find((e) => !e.isSelf);
    expect(staleView?.liveness).toBe('stale');
    nowB = Date.now() + 5_000; // past offline
    const offlineView = B.registry.listEntries(nowB);
    expect(offlineView.find((e) => !e.isSelf)?.liveness).toBe('offline');
    expect(offlineView).toHaveLength(2); // never silently dropped
  });

  it('a forged fleet record is rejected: wrong-key signature and tampered body both fail closed', async () => {
    const recordA = A.coordinator.refreshSelf();
    const envelope = signFleetAdvertisement(A.federation, recordA);
    const peerAonB = B.federation.getPeer(A.federation.identity().instanceId)!;
    // Genuine record verifies against A's stored key on B.
    expect(verifyFleetAdvertisement(B.federation, envelope, peerAonB)?.instanceId).toBe(A.federation.identity().instanceId);
    // Tampered record (name changed after signing) fails.
    const tampered = {
      ...envelope,
      body: { ...(envelope.body as object), record: { ...(recordA as FleetRecord), displayName: 'EVIL' } },
    };
    expect(verifyFleetAdvertisement(B.federation, tampered as never, peerAonB)).toBeNull();
    // B signing a record that CLAIMS to be A fails against A's key.
    const forged = signFleetAdvertisement(B.federation, { ...recordA });
    expect(verifyFleetAdvertisement(B.federation, forged, peerAonB)).toBeNull();
    // And over HTTP: a bad transport signature on the advertise inbound → 401.
    const headers = A.federation.signRequestHeaders('POST', '/api/federation/inbound/fleet/advertise', JSON.stringify({ envelope }));
    const bad = await fetch(`${B.base}/federation/inbound/fleet/advertise`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-kriyadot-fed-sig': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
      body: JSON.stringify({ envelope }),
    });
    expect(bad.status).toBe(401);
    expect(B.registry.getPeer(A.federation.identity().instanceId)).toBeUndefined();
  });

  it('capability gate: without mission-dispatch in the receiver policy, dispatch is refused 403', async () => {
    const aId = A.federation.identity().instanceId;
    B.federation.updatePeerPolicy(aId, { capabilities: ['chat', 'fleet'] });
    const t = A.taskStore.create({ title: 'Should not run' });
    const m = A.service.createMission({ taskId: t.id, repoPath: repoShared, testCommand: 'run-tests' });
    const r = await api(A, '/fleet/dispatch', {
      method: 'POST',
      body: JSON.stringify({ missionId: m.id, targetInstanceId: B.federation.identity().instanceId }),
    });
    expect(r.status).toBe(403);
    expect(B.missionStore.list()).toHaveLength(0);
    expect(A.missionStore.get(m.id)?.stage).toBe('blocked'); // mirror records the refusal honestly
  });
});

describe('cross-machine dispatch (proof leg b)', () => {
  it('a mission dispatched from A executes on B; B\'s gate lands it; A\'s board shows the result with provenance', async () => {
    const t = A.taskStore.create({ title: 'Dispatched feature' });
    const m = A.service.createMission({ taskId: t.id, repoPath: repoShared, testCommand: 'run-tests' });
    const r = await api(A, '/fleet/dispatch', {
      method: 'POST',
      body: JSON.stringify({ missionId: m.id, targetInstanceId: B.federation.identity().instanceId }),
    });
    expect(r.status).toBe(200);
    const mirror = A.missionStore.get(m.id)!;
    expect(mirror.stage).toBe('landed');
    expect(mirror.placement).toBe('fleet');
    expect(mirror.executedOnInstanceId).toBe(B.federation.identity().instanceId);
    expect(mirror.evidence).toMatch(/Ran on B/);
    expect(mirror.remoteMissionId).toBeTruthy();
    // Executed on B: B has the mission, B's gate was consulted exactly once,
    // A's gate never was; the file landed in the repo via B's merge.
    const remote = B.missionStore.get(mirror.remoteMissionId!)!;
    expect(remote.stage).toBe('landed');
    expect(remote.originInstanceId).toBe(A.federation.identity().instanceId);
    expect(B.gate.requests).toBe(1);
    expect(A.gate.requests).toBe(0);
    expect(existsSync(join(repoShared, `feature-${remote.taskId.slice(0, 8)}.txt`))).toBe(true);
    expect(A.taskStore.get(t.id)?.done).toBe(true);
  });

  it('B\'s governance denial blocks the landing: nothing lands, A\'s mirror shows blocked with provenance', async () => {
    B.gate.decision = 'denied';
    const t = A.taskStore.create({ title: 'Denied feature' });
    const m = A.service.createMission({ taskId: t.id, repoPath: repoShared, testCommand: 'run-tests' });
    const r = await api(A, '/fleet/dispatch', {
      method: 'POST',
      body: JSON.stringify({ missionId: m.id, targetInstanceId: B.federation.identity().instanceId }),
    });
    expect(r.status).toBe(200); // dispatch completed; the RESULT is blocked
    const mirror = A.missionStore.get(m.id)!;
    expect(mirror.stage).toBe('blocked');
    expect(mirror.evidence).toMatch(/Ran on B/);
    const remote = B.missionStore.get(mirror.remoteMissionId!)!;
    expect(remote.stage).toBe('blocked');
    expect(remote.evidence).toMatch(/approval denied/);
    expect(existsSync(join(repoShared, `feature-${remote.taskId.slice(0, 8)}.txt`))).toBe(false);
    expect(A.taskStore.get(t.id)?.done).toBe(false);
  });
});

describe('resume-by-transfer (proof leg c)', () => {
  it('a mission blocked mid-flight on A transfers to B, resumes at review, lands on B with the transferred label and its transcript', async () => {
    // A's own instance rejects reviews in this scenario, so run A's
    // mission on a dedicated A-side service? No — A's harness approves.
    // Instead: build the mid-flight state directly — run a mission on A
    // whose reviewer rejects (A2 instance not needed: create a second
    // service over A's stores with a rejecting reviewer).
    const rejectingRunner: MissionBotRunner = async (req) => {
      if (req.role === 'worker') {
        writeFileSync(join(req.worktreePath, `feature-${req.taskId.slice(0, 8)}.txt`), `work by A for ${req.taskId}\n`);
        return { text: 'implemented on A', provider: 'groq', model: 'model-a' };
      }
      return { text: 'REJECT: not ready', verdict: 'reject' as const, provider: 'anthropic', model: 'model-b' };
    };
    const rejectingService = new MissionService({
      taskStore: A.taskStore,
      missionStore: A.missionStore,
      worktreeRoot: join(A.dir, 'worktrees'),
      botRunner: rejectingRunner,
      testRunner: async () => ({ exitCode: 0, output: 'green' }),
      approvalGate: {
        request: async () => 'approval-a-x',
        awaitDecision: async () => 'approved' as const,
      },
      getBot: (botId) =>
        botId === 'code-reviewer' ? { provider: 'anthropic', model: 'model-b' } : { provider: 'groq', model: 'model-a' },
    });
    const repoA = makeRepo(root, 'repo-a');
    const t = A.taskStore.create({ title: 'Transfer me' });
    const m = rejectingService.createMission({ taskId: t.id, repoPath: repoA, testCommand: 'run-tests' });
    // Seed the durable worker transcript under the REAL mission session id.
    A.sessions.appendMessage(`mission:${m.id}:worker`, { role: 'user', content: 'implement the thing' });
    A.sessions.appendMessage(`mission:${m.id}:worker`, { role: 'assistant', content: 'implemented on A' });
    const blocked = await rejectingService.runMission(m.id);
    expect(blocked.stage).toBe('blocked');
    expect(blocked.worktreePath && existsSync(blocked.worktreePath)).toBe(true);

    // B's clone of the repo (its own path, wired as transferRepoPath).
    const repoB = join(root, 'repo-b');
    execFileSync('git', ['clone', repoA, repoB], { encoding: 'utf8' });
    git(repoB, ['config', 'user.email', 'test@kriyadot.local']);
    git(repoB, ['config', 'user.name', 'Fleet Test']);

    const r = await api(A, '/fleet/transfer', {
      method: 'POST',
      body: JSON.stringify({ missionId: m.id, targetInstanceId: B.federation.identity().instanceId }),
    });
    expect(r.status).toBe(200);

    // A's local copy is closed as transferred — never silently live in two places.
    const localAfter = A.missionStore.get(m.id)!;
    expect(localAfter.stage).toBe('blocked');
    expect(localAfter.evidence).toMatch(/Transferred to B/);

    // B's resumed mission: landed, labelled transferred, resumed via diff.
    const remote = B.missionStore.list().find((x) => x.transferredFromInstanceId === A.federation.identity().instanceId)!;
    expect(remote).toBeTruthy();
    expect(remote.stage).toBe('landed');
    expect(remote.transferMode).toBe('diff');
    expect(remote.stageAtTransfer).toBe('blocked');
    expect(remote.transferredTranscriptCount).toBe(2);
    expect(remote.review?.verdict).toBe('approve'); // B's reviewer re-reviewed the transferred diff
    // The transferred work itself landed in B's repo — under the ORIGIN
    // task's filename, because the diff transfers file contents verbatim.
    const landed = git(repoB, ['log', '--oneline']);
    expect(landed).toContain('transferred work from A');
    expect(existsSync(join(repoB, `feature-${t.id.slice(0, 8)}.txt`))).toBe(true);
    // Transcript reconstructed in B's durable session store.
    const msgs = B.sessions.listThreadMessages(`mission:${remote.id}:worker`);
    expect(msgs.map((x) => x.content)).toEqual(['implement the thing', 'implemented on A']);
    // B's own gate decided the landing.
    expect(B.gate.requests).toBe(1);
  });
});
