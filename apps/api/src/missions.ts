// SPDX-License-Identifier: Apache-2.0
// Coding-mission pipeline (Timon parity A5) — a task runs as a mission:
// its own git worktree, a DIFFERENT model reviewing the diff, a test-suite
// merge gate behind an approval card, and a Kanban dispatcher that follows
// task chains without a human babysitting the queue.
//
// WHY A FIRST-CLASS SERVICE, NOT A WORKFLOW DEFINITION (honest engine fit):
// The workflow engine (@mvp/workflows, 12 node types) can express the
// bot steps (bot-turn) and a human pause (approval), but it has NO node
// type for git worktree create/remove, diff capture, a shell test command,
// or a merge — and its runs are not board state. Faking those as `code`
// nodes would bury consequential git operations inside a sandbox that
// cannot run them. So: the pipeline below is a service that OWNS the git /
// test / merge steps directly, and USES the engine honestly for what it
// does express — `codingMissionWorkflowTemplate` is a real
// WorkflowDefinition whose bot-turn nodes name the worker/reviewer bots
// and whose approval node documents the gate; the service validates it
// with the engine's own structural validator at construction and takes
// its default bot ids from it. Bot turns themselves run through the
// injectable MissionBotRunner port; the production implementation
// (createRuntimeBotRunner) drives agentRuntime.runTurn with the session
// bound to the mission worktree via SessionStore.attachWorktree — the
// same binding the worktree routes use — so A1's mid-run swap machinery
// (runtime-level) applies to mission turns exactly as to any bot run.
//
// GOVERNANCE / SAFETY:
//   - Landing a branch is consequential: it happens ONLY after the test
//     suite is green AND an approval card (governance requestApproval /
//     awaitDecision, tool name 'mission-land') is approved. No auto-land
//     path exists; a red suite never even mints the card.
//   - On red tests, a rejected review, or a denied approval, the worktree
//     and branch are left INTACT and the mission is marked blocked with
//     the evidence attached — nothing is force-cleaned, nothing is lost.
//   - Review independence is recorded honestly: 'cross-model' only when
//     the reviewer's actual provider+model differ from the worker's;
//     otherwise 'same-model'. Never upgraded after the fact.
//   - The dispatcher consumes the Tasks store ONLY. It imports nothing
//     from parked-ideas.ts: parked ideas (B6) live in a separate store
//     and are structurally invisible here — there is no "skip parked"
//     filter to forget. test/missions.test.ts proves a parked idea whose
//     text looks exactly like a task is never dispatched.
//   - The dispatcher defaults to DISABLED (the automation-starters
//     precedent: new automation persists enabled:false). The merge gate's
//     approval card remains the human checkpoint even when it is on.
//   - Everything the dispatcher starts is labelled provenance:
//     'dispatcher' on the mission, the task mirror, and audit entries.
//
// HONEST LIMITS: one mission per task; merges are --no-ff merges into the
// target branch in the main repo checkout (which must be clean — a dirty
// main checkout blocks the mission rather than risking user work); the
// test command is the project's own configured command, run once, in the
// worktree, via a shell (it is operator configuration, not model output).

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { WorktreeManager } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import { validateWorkflowStructure, type WorkflowDefinition } from '@mvp/workflows';
import { TaskStore, taskBlockersSatisfied, type Task, type TaskMissionStage } from './tasks.js';

export type MissionStage = TaskMissionStage;
export type ReviewIndependence = 'cross-model' | 'same-model';
export type MissionProvenance = 'manual' | 'dispatcher';

export interface MissionBotIdentity {
  botId: string;
  provider: string;
  model: string;
}

export interface Mission {
  id: string;
  taskId: string;
  repoPath: string;
  /** Branch created for this mission (in its worktree). */
  branch: string;
  /** Branch the work lands on after the gate. */
  targetBranch: string;
  /** Project test command, run once in the worktree at the gate. */
  testCommand: string;
  worker: MissionBotIdentity;
  reviewer: MissionBotIdentity;
  stage: MissionStage;
  provenance: MissionProvenance;
  worktreePath?: string;
  reviewIndependence?: ReviewIndependence;
  review?: { verdict: 'approve' | 'reject'; text: string; provider: string; model: string };
  testResult?: { exitCode: number; output: string };
  approvalId?: string;
  /** Human-readable evidence for the current stage / blocking reason. */
  evidence?: string;
  landedSha?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMissionInput {
  taskId: string;
  repoPath: string;
  branch?: string;
  targetBranch?: string;
  testCommand: string;
  workerBotId?: string;
  reviewerBotId?: string;
  provenance?: MissionProvenance;
}

// ---------------------------------------------------------------------------
// Workflow-engine template (the engine-expressible slice of the pipeline)
// ---------------------------------------------------------------------------

/**
 * The mission as a workflow definition: trigger → worker bot-turn →
 * reviewer bot-turn → approval → summary. The git/test/merge steps are
 * deliberately NOT nodes (no such node types exist — see header); the
 * service executes them around these steps. Bot ids here are the
 * defaults the service resolves identities from.
 */
export const codingMissionWorkflowTemplate: WorkflowDefinition = {
  id: 'template-coding-mission',
  name: 'Coding mission',
  description:
    'Worktree coding mission: a worker bot implements the task, a different model reviews the diff, and landing requires a green test suite plus approval.',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Mission task', config: {} },
    {
      id: 'work',
      type: 'bot-turn',
      name: 'Worker implements the task',
      config: { botId: 'coder', prompt: '{{input.prompt}}' },
    },
    {
      id: 'review',
      type: 'bot-turn',
      name: 'Reviewer reviews the diff',
      config: { botId: 'code-reviewer', prompt: 'Review this diff:\n{{input.diff}}' },
    },
    {
      id: 'land-approval',
      type: 'approval',
      name: 'Approve landing',
      config: { message: 'Tests are green. Land this mission branch?' },
    },
    {
      id: 'summary',
      type: 'set',
      name: 'Mission summary',
      config: { assignments: { landed: true, review: '{{nodes.review.output}}' } },
    },
  ],
  edges: [
    ['trigger', 'work'],
    ['work', 'review'],
    ['review', 'land-approval'],
    ['land-approval', 'summary'],
  ],
};

function templateBotId(nodeId: string): string {
  const node = codingMissionWorkflowTemplate.nodes.find((n) => n.id === nodeId);
  const botId = node?.config['botId'];
  return typeof botId === 'string' && botId ? botId : 'coder';
}

// ---------------------------------------------------------------------------
// Injectable ports (tests use fakes — zero paid APIs, zero real CLIs)
// ---------------------------------------------------------------------------

export interface MissionBotRunRequest {
  missionId: string;
  taskId: string;
  role: 'worker' | 'reviewer';
  botId: string;
  provider: string;
  model: string;
  prompt: string;
  worktreePath: string;
  /** Reviewer only: the diff under review. */
  diff?: string;
}

export interface MissionBotRunResult {
  text: string;
  provider: string;
  model: string;
  /** Reviewer only: explicit verdict when the runner can supply one. */
  verdict?: 'approve' | 'reject';
}

export type MissionBotRunner = (req: MissionBotRunRequest) => Promise<MissionBotRunResult>;

export type MissionTestRunner = (
  worktreePath: string,
  command: string,
) => Promise<{ exitCode: number; output: string }>;

export interface MissionApprovalGate {
  request(mission: Mission, summary: string): Promise<string>;
  awaitDecision(approvalId: string): Promise<'approved' | 'denied'>;
}

export type MissionAudit = (action: string, fields: Record<string, unknown>) => void;

export interface MissionServiceDeps {
  taskStore: TaskStore;
  missionStore: MissionStore;
  /** Root new worktrees are created under (WorktreeManager root). */
  worktreeRoot: string;
  botRunner: MissionBotRunner;
  testRunner?: MissionTestRunner;
  approvalGate: MissionApprovalGate;
  audit?: MissionAudit;
  /** Fired after a mission lands + its task completes (B6 outcome loop). */
  onTaskCompleted?: (task: Task) => void;
  /** Resolve a bot id to its provider/model (seed bots + model overlay). */
  getBot?: (botId: string) => { provider: string; model: string } | undefined;
}

/** Default test runner: the project's own command, once, via a shell. */
export const defaultTestRunner: MissionTestRunner = async (worktreePath, command) => {
  const r = spawnSync(command, {
    cwd: worktreePath,
    shell: true,
    encoding: 'utf8',
    timeout: 10 * 60_000,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000);
  return { exitCode: typeof r.status === 'number' ? r.status : 1, output };
};

/**
 * Production bot runner: drives the agent runtime. The turn's session is
 * bound to the mission worktree first (SessionStore.attachWorktree), so
 * the bot's coding tools operate in the worktree — and runtime features
 * (A1 cooldown swap, governance, hooks) apply unchanged. Text is
 * collected from 'token' stream events.
 */
export function createRuntimeBotRunner(deps: {
  getBot: (botId: string) => BotConfig | undefined;
  runTurn: (opts: {
    bot: BotConfig;
    message: string;
    sessionId: string;
    onEvent: (e: { type: string; content?: string }) => void;
  }) => Promise<unknown>;
  attachWorktree?: (sessionId: string, worktreePath: string) => void;
}): MissionBotRunner {
  return async (req) => {
    const bot = deps.getBot(req.botId);
    if (!bot) throw new Error(`mission bot not found: ${req.botId}`);
    const effective: BotConfig = { ...bot, provider: req.provider, model: req.model };
    const sessionId = `mission:${req.missionId}:${req.role}`;
    deps.attachWorktree?.(sessionId, req.worktreePath);
    let text = '';
    await deps.runTurn({
      bot: effective,
      message: req.prompt,
      sessionId,
      onEvent: (e) => {
        if (e.type === 'token' && typeof e.content === 'string') text += e.content;
      },
    });
    return { text, provider: effective.provider, model: effective.model };
  };
}

// ---------------------------------------------------------------------------
// Mission store (JSON file, tasks.ts conventions)
// ---------------------------------------------------------------------------

export class MissionStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'missions.json');
  }

  path(): string {
    return this.file;
  }

  private readRows(): unknown[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private writeRows(rows: unknown[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2), 'utf8');
  }

  list(): Mission[] {
    return this.readRows().filter(isMission).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Mission | undefined {
    return this.readRows().filter(isMission).find((m) => m.id === id);
  }

  getByTaskId(taskId: string): Mission | undefined {
    return this.readRows().filter(isMission).find((m) => m.taskId === taskId);
  }

  insert(mission: Mission): Mission {
    const rows = this.readRows();
    rows.push(mission);
    this.writeRows(rows);
    return mission;
  }

  update(id: string, patch: Partial<Mission>): Mission {
    const rows = this.readRows();
    const idx = rows.findIndex((r) => isMission(r) && r.id === id);
    if (idx === -1) throw storeNotFound(id);
    const current = rows[idx] as Mission;
    const next: Mission = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeRows(rows);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Mission service — the pipeline itself
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 500)}`);
  }
  return r.stdout ?? '';
}

export class MissionService {
  private readonly deps: MissionServiceDeps;
  private readonly testRunner: MissionTestRunner;
  private readonly running = new Set<string>();

  constructor(deps: MissionServiceDeps) {
    // Honest engine use: the template the service derives its bot steps
    // from must be a structurally valid workflow definition.
    validateWorkflowStructure(codingMissionWorkflowTemplate); // throws when invalid
    this.deps = deps;
    this.testRunner = deps.testRunner ?? defaultTestRunner;
  }

  isRunning(missionId: string): boolean {
    return this.running.has(missionId);
  }

  createMission(input: CreateMissionInput): Mission {
    const task = this.deps.taskStore.get(input.taskId);
    if (!task) throw validationError(`unknown task: ${input.taskId}`);
    if (task.done) throw validationError(`task is already done: ${input.taskId}`);
    if (this.deps.missionStore.getByTaskId(input.taskId)) {
      throw conflictError(`task ${input.taskId} already has a mission`);
    }
    if (typeof input.testCommand !== 'string' || !input.testCommand.trim()) {
      throw validationError('mission "testCommand" must be a non-empty string');
    }
    if (typeof input.repoPath !== 'string' || !input.repoPath.trim()) {
      throw validationError('mission "repoPath" must be a non-empty string');
    }
    const workerBotId = input.workerBotId ?? templateBotId('work');
    const reviewerBotId = input.reviewerBotId ?? templateBotId('review');
    const mission: Mission = {
      id: randomUUID(),
      taskId: task.id,
      repoPath: resolve(input.repoPath),
      branch: input.branch ?? `mission/${task.id.slice(0, 8)}`,
      targetBranch: input.targetBranch ?? 'main',
      testCommand: input.testCommand.trim(),
      worker: this.identity(workerBotId),
      reviewer: this.identity(reviewerBotId),
      stage: 'queued',
      provenance: input.provenance ?? 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.deps.missionStore.insert(mission);
    this.syncTaskStage(mission);
    this.audit('mission.created', mission);
    return mission;
  }

  private identity(botId: string): MissionBotIdentity {
    const bot = this.deps.getBot?.(botId);
    return { botId, provider: bot?.provider ?? 'unknown', model: bot?.model ?? 'unknown' };
  }

  private audit(action: string, mission: Mission, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.audit?.(action, {
        actor: mission.provenance === 'dispatcher' ? 'mission-dispatcher' : 'mission-service',
        missionId: mission.id,
        taskId: mission.taskId,
        stage: mission.stage,
        provenance: mission.provenance,
        ...extra,
      });
    } catch {
      // Audit must never break the pipeline.
    }
  }

  private setStage(mission: Mission, stage: MissionStage, patch: Partial<Mission> = {}): Mission {
    const next = this.deps.missionStore.update(mission.id, { ...patch, stage });
    this.syncTaskStage(next);
    return next;
  }

  private syncTaskStage(mission: Mission): void {
    try {
      this.deps.taskStore.update(mission.taskId, { missionStage: mission.stage });
    } catch {
      // The task may have been deleted mid-mission; the mission record
      // remains the source of truth.
    }
  }

  private block(mission: Mission, evidence: string, patch: Partial<Mission> = {}): Mission {
    const next = this.setStage(mission, 'blocked', { ...patch, evidence });
    this.audit('mission.blocked', next, { evidence });
    return next;
  }

  /**
   * Run the full pipeline for one mission. Never throws for pipeline
   * failures — they land on the mission as stage 'blocked' + evidence,
   * with worktree and branch preserved. Throws only for unknown ids /
   * a mission that is already running or landed.
   */
  async runMission(missionId: string): Promise<Mission> {
    const found = this.deps.missionStore.get(missionId);
    if (!found) throw storeNotFound(missionId);
    if (found.stage === 'landed') throw conflictError(`mission ${missionId} already landed`);
    if (this.running.has(missionId)) throw conflictError(`mission ${missionId} is already running`);
    this.running.add(missionId);
    let mission = found;
    try {
      mission = await this.execute(mission);
      return mission;
    } finally {
      this.running.delete(missionId);
    }
  }

  private async execute(mission: Mission): Promise<Mission> {
    const task = this.deps.taskStore.get(mission.taskId);
    if (!task) return this.block(mission, `task ${mission.taskId} no longer exists`);
    const mgr = new WorktreeManager(this.deps.worktreeRoot);

    // (1) Worktree for the mission branch.
    let worktreePath = mission.worktreePath;
    try {
      if (!worktreePath || !mgr.list(mission.repoPath).some((w) => w.path === worktreePath)) {
        const info = mgr.create(mission.repoPath, {
          branch: mission.branch,
          base: mission.targetBranch,
        });
        worktreePath = info.path;
      }
    } catch (err) {
      return this.block(mission, `worktree creation failed: ${errMessage(err)}`);
    }
    mission = this.setStage(mission, 'working', { worktreePath });
    this.audit('mission.worktree_created', mission, { worktreePath, branch: mission.branch });

    // (2) Worker bot run in the worktree.
    let workerResult: MissionBotRunResult;
    try {
      workerResult = await this.deps.botRunner({
        missionId: mission.id,
        taskId: mission.taskId,
        role: 'worker',
        botId: mission.worker.botId,
        provider: mission.worker.provider,
        model: mission.worker.model,
        prompt: `Implement this task in the current worktree:\n\n${task.title}\n${task.notes ?? ''}`.trim(),
        worktreePath,
      });
    } catch (err) {
      return this.block(mission, `worker run failed: ${errMessage(err)}`, { worktreePath });
    }

    // Commit whatever the worker produced so the diff/merge are real.
    try {
      git(worktreePath, ['add', '-A']);
      const dirty = git(worktreePath, ['status', '--porcelain']).trim();
      if (!dirty) {
        return this.block(mission, 'worker produced no changes in the worktree', { worktreePath });
      }
      git(worktreePath, [
        '-c', 'user.email=mission@kriyadot.local',
        '-c', 'user.name=KriyaDot Mission',
        'commit', '-m', `mission: ${task.title}`.slice(0, 200),
      ]);
    } catch (err) {
      return this.block(mission, `committing worker changes failed: ${errMessage(err)}`, { worktreePath });
    }

    // (3) Cross-model review of the diff.
    mission = this.setStage(mission, 'review', { worktreePath });
    let diff = '';
    try {
      diff = git(worktreePath, ['diff', `${mission.targetBranch}...HEAD`]);
    } catch (err) {
      return this.block(mission, `diff capture failed: ${errMessage(err)}`, { worktreePath });
    }
    let reviewResult: MissionBotRunResult;
    try {
      reviewResult = await this.deps.botRunner({
        missionId: mission.id,
        taskId: mission.taskId,
        role: 'reviewer',
        botId: mission.reviewer.botId,
        provider: mission.reviewer.provider,
        model: mission.reviewer.model,
        prompt: `Review the diff for task "${task.title}". Reply with a verdict.`,
        worktreePath,
        diff,
      });
    } catch (err) {
      return this.block(mission, `review run failed: ${errMessage(err)}`, { worktreePath });
    }
    const independence: ReviewIndependence =
      reviewResult.provider !== workerResult.provider || reviewResult.model !== workerResult.model
        ? 'cross-model'
        : 'same-model';
    const verdict = reviewResult.verdict ?? parseVerdict(reviewResult.text);
    mission = this.deps.missionStore.update(mission.id, {
      reviewIndependence: independence,
      review: {
        verdict,
        text: reviewResult.text.slice(0, 4000),
        provider: reviewResult.provider,
        model: reviewResult.model,
      },
    });
    this.audit('mission.reviewed', mission, { reviewIndependence: independence, verdict });
    if (verdict === 'reject') {
      return this.block(mission, `review rejected (${independence}): ${reviewResult.text.slice(0, 500)}`, {
        worktreePath,
      });
    }

    // (4) Merge gate: the project's test command, once, in the worktree.
    mission = this.setStage(mission, 'gate', { worktreePath });
    const testResult = await this.testRunner(worktreePath, mission.testCommand);
    mission = this.deps.missionStore.update(mission.id, {
      testResult: { exitCode: testResult.exitCode, output: testResult.output.slice(-4000) },
    });
    this.audit('mission.gate_tests', mission, { exitCode: testResult.exitCode });
    if (testResult.exitCode !== 0) {
      return this.block(
        mission,
        `test suite failed (exit ${testResult.exitCode}): ${testResult.output.slice(-500)}`,
        { worktreePath },
      );
    }

    // Green → approval card. Landing NEVER happens without it.
    let approvalId: string;
    try {
      approvalId = await this.deps.approvalGate.request(
        mission,
        `Mission "${task.title}" on branch ${mission.branch}: review approved (${independence}), tests green. Land into ${mission.targetBranch}?`,
      );
    } catch (err) {
      return this.block(mission, `approval request failed: ${errMessage(err)}`, { worktreePath });
    }
    mission = this.deps.missionStore.update(mission.id, { approvalId });
    const decision = await this.deps.approvalGate.awaitDecision(approvalId);
    if (decision !== 'approved') {
      return this.block(mission, `landing approval denied (approval ${approvalId})`, { worktreePath });
    }

    // Approved → land: merge into the target branch in the main checkout.
    try {
      const dirtyMain = git(mission.repoPath, ['status', '--porcelain']).trim();
      if (dirtyMain) {
        return this.block(mission, 'main checkout has uncommitted changes; refusing to merge', {
          worktreePath,
        });
      }
      const current = git(mission.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      if (current !== mission.targetBranch) git(mission.repoPath, ['checkout', mission.targetBranch]);
      git(mission.repoPath, ['merge', '--no-ff', '-m', `Land mission: ${task.title}`.slice(0, 200), mission.branch]);
    } catch (err) {
      try {
        git(mission.repoPath, ['merge', '--abort']);
      } catch {
        /* no merge in progress */
      }
      return this.block(mission, `merge failed: ${errMessage(err)}`, { worktreePath });
    }
    const landedSha = git(mission.repoPath, ['rev-parse', 'HEAD']).trim();

    // Clean up the worktree (branch stays landed in history; the mission
    // branch ref is kept for provenance). Worktree is clean post-commit,
    // so removal needs no force; a failure is noted, not fatal.
    let cleanupNote = '';
    try {
      mgr.remove(mission.repoPath, worktreePath);
    } catch (err) {
      cleanupNote = ` Worktree cleanup failed (kept at ${worktreePath}): ${errMessage(err)}`;
    }
    mission = this.setStage(mission, 'landed', {
      landedSha,
      evidence: `Landed ${mission.branch} into ${mission.targetBranch} at ${landedSha}.${cleanupNote}`,
    });
    this.audit('mission.landed', mission, { landedSha });

    // Complete the task (chain unblocking + B6 outcome hook via callback).
    try {
      const before = this.deps.taskStore.get(mission.taskId);
      const done = this.deps.taskStore.update(mission.taskId, { done: true });
      if (before && !before.done) this.deps.onTaskCompleted?.(done);
    } catch {
      // Landing already happened; a bookkeeping failure must not unland it.
    }
    return mission;
  }
}

/** Fail-closed verdict parsing for text-only reviewer runners. */
function parseVerdict(text: string): 'approve' | 'reject' {
  if (/\breject(ed)?\b/i.test(text)) return 'reject';
  if (/\bapprove(d)?\b/i.test(text)) return 'approve';
  return 'reject';
}

// ---------------------------------------------------------------------------
// Dispatcher — scans the Tasks store ONLY (see header: B6 separation)
// ---------------------------------------------------------------------------

export interface MissionDispatcherOptions {
  maxConcurrent?: number;
  /** Default false — see header (automation-starters precedent). */
  enabled?: boolean;
}

export class MissionDispatcher {
  private readonly service: MissionService;
  private readonly taskStore: TaskStore;
  private readonly missionStore: MissionStore;
  private readonly maxConcurrent: number;
  private enabled: boolean;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    service: MissionService,
    taskStore: TaskStore,
    missionStore: MissionStore,
    opts: MissionDispatcherOptions = {},
  ) {
    this.service = service;
    this.taskStore = taskStore;
    this.missionStore = missionStore;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2);
    this.enabled = opts.enabled ?? false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Queued missions whose task chains are fully satisfied. Tasks ONLY. */
  runnableMissions(): Mission[] {
    const tasks = this.taskStore.list();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return this.missionStore
      .list()
      .filter((m) => m.stage === 'queued')
      .filter((m) => {
        const task = byId.get(m.taskId);
        return task !== undefined && !task.done && taskBlockersSatisfied(task, tasks);
      });
  }

  /**
   * One dispatcher pass: start runnable missions up to the concurrency
   * cap. Returns the mission ids started by THIS pass. A no-op while
   * disabled. Started runs are tracked; drain() awaits them in tests.
   */
  async tick(): Promise<string[]> {
    if (!this.enabled) return [];
    const slots = this.maxConcurrent - this.inFlight.size;
    if (slots <= 0) return [];
    const started: string[] = [];
    for (const mission of this.runnableMissions().slice(0, slots)) {
      // Provenance: work the dispatcher starts is labelled as such on the
      // mission record (and thereby in audit), whoever queued it.
      if (mission.provenance !== 'dispatcher') {
        this.missionStore.update(mission.id, { provenance: 'dispatcher' });
      }
      const run = this.service
        .runMission(mission.id)
        .catch(() => undefined)
        .finally(() => this.inFlight.delete(run));
      this.inFlight.add(run);
      started.push(mission.id);
    }
    return started;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}

// ---------------------------------------------------------------------------
// Routes: /missions + /missions/dispatcher (mounted beside tasks routes)
// ---------------------------------------------------------------------------

export interface MissionRouteDeps {
  dataDir: string;
  service: MissionService;
  dispatcher: MissionDispatcher;
  missionStore: MissionStore;
}

export function registerMissionRoutes(router: Router, deps: MissionRouteDeps): void {
  router.get('/missions', (_req: Request, res: Response) => {
    try {
      res.json(deps.missionStore.list());
    } catch (err) {
      res.status(500).json({ error: errMessage(err) });
    }
  });

  router.post('/missions', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const mission = deps.service.createMission({
        taskId: b.taskId as string,
        repoPath: b.repoPath as string,
        branch: b.branch as string | undefined,
        targetBranch: b.targetBranch as string | undefined,
        testCommand: b.testCommand as string,
        workerBotId: b.workerBotId as string | undefined,
        reviewerBotId: b.reviewerBotId as string | undefined,
      });
      res.status(201).json(mission);
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err) });
    }
  });

  router.get('/missions/dispatcher', (_req: Request, res: Response) => {
    res.json({
      enabled: deps.dispatcher.isEnabled(),
      runnable: deps.dispatcher.runnableMissions().map((m) => m.id),
    });
  });

  router.post('/missions/dispatcher', (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.enabled === 'boolean') deps.dispatcher.setEnabled(b.enabled);
    res.json({ enabled: deps.dispatcher.isEnabled() });
  });

  router.post('/missions/dispatcher/tick', async (_req: Request, res: Response) => {
    try {
      const started = await deps.dispatcher.tick();
      res.json({ started });
    } catch (err) {
      res.status(500).json({ error: errMessage(err) });
    }
  });

  router.get('/missions/:id', (req: Request, res: Response) => {
    const mission = deps.missionStore.get(req.params.id);
    if (!mission) {
      res.status(404).json({ error: `unknown mission: ${req.params.id}` });
      return;
    }
    res.json(mission);
  });

  router.post('/missions/:id/run', async (req: Request, res: Response) => {
    try {
      const mission = await deps.service.runMission(req.params.id);
      res.json(mission);
    } catch (err) {
      res.status(statusFor(err)).json({ error: errMessage(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Validation helpers (tasks.ts conventions, local copies)
// ---------------------------------------------------------------------------

function isMission(v: unknown): v is Mission {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.taskId === 'string' &&
    typeof o.repoPath === 'string' &&
    typeof o.branch === 'string' &&
    typeof o.stage === 'string' &&
    typeof o.createdAt === 'number'
  );
}

const NOT_FOUND_MARK = '__missions_not_found__';
const VALIDATION_MARK = '__missions_validation__';
const CONFLICT_MARK = '__missions_conflict__';

function storeNotFound(id: string): Error {
  const err = new Error(`unknown mission: ${id}`);
  (err as Error & { code?: string }).code = NOT_FOUND_MARK;
  return err;
}

function validationError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VALIDATION_MARK;
  return err;
}

function conflictError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = CONFLICT_MARK;
  return err;
}

function statusFor(err: unknown): number {
  if (!(err instanceof Error)) return 500;
  const code = (err as Error & { code?: string }).code;
  if (code === NOT_FOUND_MARK) return 404;
  if (code === VALIDATION_MARK) return 400;
  if (code === CONFLICT_MARK) return 409;
  return 500;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
