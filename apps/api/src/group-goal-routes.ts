// SPDX-License-Identifier: Apache-2.0
// Group goals — HTTP routes + background turn engine (OpenMausBot parity
// P1 #11).
//
//   POST   /                        → { title, description?, coordinatorBotId?,
//                                        workerBotIds[], maxTurns?, groupId? }
//                                      → 202 { ok, goal } (execution starts in background)
//   GET    /                        → { ok, goals }
//   GET    /:id                     → { ok, goal, turns }
//   POST   /:id/stop                → stop a running/paused goal
//   POST   /:id/resume              → { input?, addMaxTurns? } resume a paused goal
//   GET    /:id/stream              → SSE: snapshot | turn_started |
//                                      delegation | turn_done | paused |
//                                      done | failed | stopped
//
// ENGINE: the coordinator works in bounded turns (default max 13). Each
// turn ends with a parsed control decision (see group-goals.ts in
// agent-runtime): completed → done; needs-input → pause + "needs you" push;
// blocked → pause; continue → next turn; turn limit → hard pause.
//
// Delegation flows through the existing machinery: `delegate` goes through
// a peer-approval gate (always-ask via the approval broker — the user
// decides in the approvals inbox); `ask_bot` uses its own built-in peer
// approval. Unattended approvals fail closed via approvalTimeoutMs so a
// background goal can never hang forever on a card nobody sees.

import express, { type Request, type Response, type Router } from 'express';
import {
  buildGoalCoordinatorPrompt,
  clampGoalMaxTurns,
  isGoalId,
  parseControlDecision,
  selectGoalCoordinator,
  validGoalTitle,
  type AgentRuntime,
  type BotConfig,
  type DelegateGate,
  type GoalControlDecision,
  type GoalTurnSummary,
  type StreamEvent,
} from '@mvp/agent-runtime';
import {
  GroupChatStore,
} from './group-chats.js';
import {
  GroupGoalStore,
  RESUMABLE_GOAL_STATUSES,
  type GoalDelegation,
  type GroupGoal,
  type GroupGoalStatus,
} from './group-goals.js';
import type { PushService } from './push.js';
import type { DelegationApprovalBroker } from './teams-routes.js';

export interface GroupGoalRouteDeps {
  dataDir: string;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Approval broker for peer delegation (same shape as teams). Unset → delegations allowed with a warning. */
  delegationBroker?: DelegationApprovalBroker;
  /** "Needs you" push on needs-input / blocked / max-turns pauses. */
  push?: PushService;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  /**
   * Bridge for routine-as-goal: index.ts captures the engine's
   * startRoutineGoal through this holder and passes it to the
   * RoutineRunExecutor.
   */
  groupGoalHooks?: {
    startGroupGoal?: (args: { routine: { id: string; name: string; botId: string }; prompt: string }) => Promise<string>;
  };
}

function errorBody(message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: message, ...(detail !== undefined ? { detail } : {}) };
}

/** Unattended approval timeout for background goal turns (fail-closed). */
const GOAL_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Max chars of coordinator text mirrored into an attached room per turn. */
const ROOM_MIRROR_LIMIT = 2000;

type SseEvent = Record<string, unknown>;

/**
 * Peer-delegation gate for goal runs: every `delegate` call targeting
 * another bot asks the user once via the approval broker ('always-ask'
 * semantics — there is no team policy for ad-hoc goals). Denial aborts the
 * subtask with a clear reason; the coordinator reassigns or proceeds.
 */
function createGoalDelegationGate(
  goalId: string,
  broker?: DelegationApprovalBroker,
): DelegateGate {
  return async (call, ctx) => {
    const targetBotId =
      typeof call.args?.bot === 'string' && call.args.bot ? call.args.bot : ctx.botId;
    if (targetBotId === ctx.botId) return { decision: 'allow' };
    if (!broker) {
      console.warn(`[group-goals] no delegation broker; allowing peer delegation in goal "${goalId}" without approval`);
      return { decision: 'allow' };
    }
    const taskText = typeof call.args?.task === 'string' ? call.args.task : '';
    let approvalId: string;
    try {
      approvalId = await broker.requestPeerDelegationApproval({
        sessionId: ctx.sessionId,
        botId: ctx.botId,
        fromBotId: ctx.botId,
        toBotId: targetBotId,
        task: taskText,
        policy: 'always-ask',
      });
    } catch (err) {
      return { decision: 'deny', reason: `could not request delegation approval: ${err instanceof Error ? err.message : String(err)}` };
    }
    let verdict: 'approved' | 'denied';
    try {
      verdict = await broker.awaitDecision(approvalId, { timeoutMs: GOAL_APPROVAL_TIMEOUT_MS });
    } catch (err) {
      return { decision: 'deny', reason: `delegation approval timed out / failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (verdict !== 'approved') {
      return {
        decision: 'deny',
        reason: `the delegation to bot "${targetBotId}" was not approved: the subtask was not started. Reassign it or proceed without it.`,
      };
    }
    return { decision: 'allow' };
  };
}

function summarizeDelegationResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return text.slice(0, 300);
}

export class GroupGoalEngine {
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private readonly subscribers = new Map<string, Set<Response>>();

  constructor(
    private readonly store: GroupGoalStore,
    private readonly deps: GroupGoalRouteDeps,
  ) {}

  // ---- SSE ---------------------------------------------------------------

  private publish(goalId: string, event: SseEvent): void {
    const subs = this.subscribers.get(goalId);
    if (!subs || subs.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subs) {
      try {
        res.write(frame);
      } catch {
        // Dead subscriber; cleaned up on close.
      }
    }
  }

  subscribe(goalId: string, res: Response): void {
    let set = this.subscribers.get(goalId);
    if (!set) {
      set = new Set();
      this.subscribers.set(goalId, set);
    }
    set.add(res);
    res.on('close', () => {
      set!.delete(res);
      if (set!.size === 0) this.subscribers.delete(goalId);
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  /** True while the goal's pump loop is active. */
  isActive(goalId: string): boolean {
    return this.running.has(goalId);
  }

  /** Start (or restart) the background pump for a goal. Idempotent per goal. */
  start(goalId: string, resumeInput?: string): void {
    if (this.running.has(goalId)) return;
    this.running.add(goalId);
    this.cancelled.delete(goalId);
    void this.pump(goalId, resumeInput).finally(() => {
      this.running.delete(goalId);
      this.controllers.delete(goalId);
    });
  }

  /** Stop a goal: abort the in-flight turn, mark stopped unless terminal. */
  stop(goalId: string): boolean {
    const goal = this.store.getGoal(goalId);
    if (!goal) return false;
    this.cancelled.add(goalId);
    this.controllers.get(goalId)?.abort();
    const g = this.store.getGoal(goalId);
    if (g && (g.status === 'running' || (RESUMABLE_GOAL_STATUSES as readonly string[]).includes(g.status))) {
      this.store.updateGoal(goalId, { status: 'stopped', summary: 'Stopped by the user.' });
      this.publish(goalId, { type: 'stopped' });
      this.deps.audit?.('group-goal.stopped', { goalId });
    }
    return true;
  }

  /**
   * Create + start a goal from a routine (routine-as-goal). The routine's
   * bot becomes a worker; the coordinator is auto-selected (chief
   * preferred). Returns the goal id.
   */
  async startRoutineGoal(
    routine: { id: string; name: string; botId: string },
    prompt: string,
  ): Promise<string> {
    const bots = this.deps.getBots();
    const routineBot = bots.find((b) => b.id === routine.botId);
    if (!routineBot) throw new Error(`routine bot "${routine.botId}" no longer exists`);
    let coordinator = selectGoalCoordinator(bots);
    if (!coordinator) throw new Error('no bots available for goal coordination');
    const workerBotIds = routineBot.id === coordinator.id ? [] : [routineBot.id];
    const goal = this.store.createGoal({
      title: `Routine: ${routine.name}`.slice(0, 140),
      description: prompt.slice(0, 4000),
      coordinatorBotId: coordinator.id,
      workerBotIds,
      routineId: routine.id,
    });
    this.deps.audit?.('group-goal.routine-started', { goalId: goal.id, routineId: routine.id });
    this.start(goal.id);
    return goal.id;
  }

  // ---- the turn pump -------------------------------------------------------

  private async pump(goalId: string, resumeInput?: string): Promise<void> {
    const { store, deps } = this;
    let pendingResumeInput = resumeInput;
    try {
      for (;;) {
        const goal = store.getGoal(goalId);
        if (!goal) return;
        if (this.cancelled.has(goalId)) return;
        if (goal.status !== 'running') return;

        const turnNumber = store.turnCount(goalId) + 1;
        if (turnNumber > goal.maxTurns) {
          // Hard pause at the turn bound (never silently die).
          store.updateGoal(goalId, {
            status: 'max-turns',
            summary: `Paused after ${goal.maxTurns} turns without a "completed" decision. Resume to continue.`,
          });
          this.publish(goalId, { type: 'paused', reason: 'max-turns', maxTurns: goal.maxTurns });
          await this.pushPause(goal, 'max-turns', `Goal "${goal.title}" hit its ${goal.maxTurns}-turn limit. Open KriyaDot to resume or close it.`);
          deps.audit?.('group-goal.max-turns', { goalId, maxTurns: goal.maxTurns });
          return;
        }

        await this.runOneTurn(goal, turnNumber, pendingResumeInput);
        pendingResumeInput = undefined;

        const after = store.getGoal(goalId);
        if (!after || after.status !== 'running') return; // paused / completed / stopped / failed
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const goal = store.getGoal(goalId);
      if (goal && goal.status === 'running') {
        store.updateGoal(goalId, { status: 'failed', summary: message });
      }
      this.publish(goalId, { type: 'failed', error: message });
      deps.audit?.('group-goal.failed', { goalId, error: message });
    }
  }

  private async runOneTurn(goal: GroupGoal, turnNumber: number, resumeInput?: string): Promise<void> {
    const { store, deps } = this;
    const bots = deps.getBots();
    const coordinator = bots.find((b) => b.id === goal.coordinatorBotId);
    if (!coordinator) {
      store.updateGoal(goal.id, { status: 'failed', summary: `Coordinator bot "${goal.coordinatorBotId}" no longer exists.` });
      this.publish(goal.id, { type: 'failed', error: 'coordinator bot missing' });
      return;
    }
    const workers = goal.workerBotIds
      .map((id) => bots.find((b) => b.id === id))
      .filter((b): b is BotConfig => Boolean(b));

    const history: GoalTurnSummary[] = store.listTurns(goal.id).map((t) => ({
      turn: t.turnNumber,
      decision: t.decision,
      nextStep: t.nextStep ?? undefined,
      summary: t.summary ?? undefined,
      delegations: t.delegations.map((d) => `${d.botName}: ${d.task.slice(0, 80)}${d.done ? ' (done)' : ''}`),
    }));

    let roomName: string | undefined;
    if (goal.groupId) {
      try {
        roomName = new GroupChatStore(deps.dataDir).getGroup(goal.groupId)?.name;
      } catch {
        roomName = undefined;
      }
    }

    const prompt = buildGoalCoordinatorPrompt({
      goalTitle: goal.title,
      goalDescription: goal.description ?? undefined,
      coordinatorName: coordinator.name,
      workers: workers.map((w) => ({ id: w.id, name: w.name, description: w.description ?? '' })),
      turnNumber,
      maxTurns: goal.maxTurns,
      history,
      resumeInput,
      roomName,
    });

    this.publish(goal.id, { type: 'turn_started', turn: turnNumber });
    const controller = new AbortController();
    this.controllers.set(goal.id, controller);

    let text = '';
    const delegations: GoalDelegation[] = [];
    const delegationByCallId = new Map<string, number>();
    let turnError: string | null = null;
    let interrupted = false;

    try {
      await deps.agentRuntime.runTurn({
        bot: coordinator,
        message: prompt,
        sessionId: `goal_${goal.id}`,
        taskType: 'chat',
        signal: controller.signal,
        approvalTimeoutMs: GOAL_APPROVAL_TIMEOUT_MS,
        delegateGate: createGoalDelegationGate(goal.id, deps.delegationBroker),
        onEvent: async (e: StreamEvent) => {
          if (e.type === 'token') {
            text += e.content;
          } else if (e.type === 'tool_call' && (e.call.name === 'delegate' || e.call.name === 'ask_bot')) {
            const targetId = typeof e.call.args?.bot === 'string' && e.call.args.bot ? e.call.args.bot : coordinator.id;
            const target = bots.find((b) => b.id === targetId);
            const taskArg = typeof e.call.args?.task === 'string' ? e.call.args.task : typeof e.call.args?.message === 'string' ? e.call.args.message : '';
            const d: GoalDelegation = {
              botId: targetId,
              botName: target?.name ?? targetId,
              task: taskArg.slice(0, 500),
              done: false,
            };
            delegations.push(d);
            delegationByCallId.set(e.call.id, delegations.length - 1);
            this.publish(goal.id, { type: 'delegation', turn: turnNumber, tool: e.call.name, delegation: d });
          } else if (e.type === 'tool_result' && (e.call.name === 'delegate' || e.call.name === 'ask_bot')) {
            const idx = delegationByCallId.get(e.call.id);
            if (idx !== undefined && delegations[idx]) {
              delegations[idx] = { ...delegations[idx], done: true, summary: summarizeDelegationResult(e.result) };
              this.publish(goal.id, { type: 'delegation_done', turn: turnNumber, index: idx, delegation: delegations[idx] });
            }
          } else if (e.type === 'error') {
            turnError = e.message;
          } else if (e.type === 'interrupted') {
            interrupted = true;
            turnError = `interrupted: ${e.reason}`;
          }
        },
      });
    } catch (err) {
      turnError = err instanceof Error ? err.message : String(err);
    } finally {
      this.controllers.delete(goal.id);
    }

    if (this.cancelled.has(goal.id)) return;

    const coordinatorText = text.trim();
    const parsed = parseControlDecision(coordinatorText);
    const turn = store.addTurn(goal.id, {
      turnNumber,
      decision: turnError ? 'blocked' : parsed.decision,
      coordinatorText,
      nextStep: parsed.nextStep ?? null,
      summary: parsed.summary ?? null,
      delegations,
    });
    this.publish(goal.id, { type: 'turn_done', turn: turnNumber, decision: turn.decision, nextStep: turn.nextStep });

    // Mirror the turn into the attached room so it's visible there.
    if (goal.groupId && coordinatorText) {
      try {
        new GroupChatStore(deps.dataDir).addMessage(
          goal.groupId,
          'bot',
          `🎯 Goal "${goal.title}" — turn ${turnNumber}/${goal.maxTurns} (${turn.decision}):\n${coordinatorText.slice(0, ROOM_MIRROR_LIMIT)}`,
          coordinator.id,
        );
      } catch {
        // Room mirroring is best-effort; the goal record is authoritative.
      }
    }

    if (turnError && !interrupted) {
      store.updateGoal(goal.id, { status: 'blocked', summary: `Turn ${turnNumber} errored: ${turnError}` });
      this.publish(goal.id, { type: 'paused', reason: 'blocked', error: turnError });
      await this.pushPause(goal, 'blocked', `Goal "${goal.title}" hit an error on turn ${turnNumber}: ${turnError.slice(0, 200)}`);
      deps.audit?.('group-goal.blocked', { goalId: goal.id, turn: turnNumber, error: turnError });
      return;
    }
    if (interrupted) {
      // Stop/abort path handles the status; nothing more to do.
      return;
    }

    switch (turn.decision) {
      case 'completed': {
        const summary = turn.summary || coordinatorText.slice(0, 4000) || 'Goal completed.';
        store.updateGoal(goal.id, { status: 'completed', summary });
        this.publish(goal.id, { type: 'done', summary });
        deps.audit?.('group-goal.completed', { goalId: goal.id, turns: turnNumber });
        break;
      }
      case 'needs-input': {
        store.updateGoal(goal.id, {
          status: 'needs-input',
          summary: turn.nextStep ? `Needs your input: ${turn.nextStep}` : 'The coordinator asked for your input.',
        });
        this.publish(goal.id, { type: 'paused', reason: 'needs-input', nextStep: turn.nextStep });
        await this.pushPause(goal, 'needs-input', `Goal "${goal.title}" needs your input: ${(turn.nextStep ?? '').slice(0, 200) || 'open KriyaDot to respond.'}`);
        deps.audit?.('group-goal.needs-input', { goalId: goal.id, turn: turnNumber });
        break;
      }
      case 'blocked': {
        store.updateGoal(goal.id, {
          status: 'blocked',
          summary: turn.nextStep ? `Blocked: ${turn.nextStep}` : 'The coordinator reported being blocked.',
        });
        this.publish(goal.id, { type: 'paused', reason: 'blocked', nextStep: turn.nextStep });
        await this.pushPause(goal, 'blocked', `Goal "${goal.title}" is blocked: ${(turn.nextStep ?? '').slice(0, 200) || 'open KriyaDot for details.'}`);
        deps.audit?.('group-goal.blocked', { goalId: goal.id, turn: turnNumber });
        break;
      }
      case 'continue':
        // Loop continues; the pump re-checks the turn bound.
        break;
    }
  }

  /** Best-effort "needs you" push when a goal pauses. Never throws. */
  private async pushPause(goal: GroupGoal, _reason: string, body: string): Promise<void> {
    const push = this.deps.push;
    if (!push) return;
    const bots = this.deps.getBots();
    const coordinator = bots.find((b) => b.id === goal.coordinatorBotId);
    try {
      await push.notify({
        kind: 'needsInput',
        botId: goal.coordinatorBotId,
        botName: coordinator?.name ?? 'KriyaDot',
        title: `Goal paused — ${goal.title}`.slice(0, 80),
        body: body.slice(0, 400),
      });
    } catch {
      // Push is best-effort; the goal record + SSE are authoritative.
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerGroupGoalRoutes(router: Router, deps: GroupGoalRouteDeps): { store: GroupGoalStore; engine: GroupGoalEngine } {
  const store = new GroupGoalStore(deps.dataDir);
  const engine = new GroupGoalEngine(store, deps);
  if (deps.groupGoalHooks) {
    deps.groupGoalHooks.startGroupGoal = (args) => engine.startRoutineGoal(args.routine, args.prompt);
  }

  const goalOf = (req: Request, res: Response): GroupGoal | null => {
    const id = req.params.id as string;
    if (!isGoalId(id)) {
      res.status(400).json(errorBody('Invalid goal id format'));
      return null;
    }
    const goal = store.getGoal(id);
    if (!goal) {
      res.status(404).json(errorBody('Goal not found'));
      return null;
    }
    return goal;
  };

  /** Create + start a goal. The coordinator auto-selects (chief preferred) when omitted. */
  router.post('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!validGoalTitle(body.title)) {
      res.status(400).json(errorBody('title is required (max 140 chars)'));
      return;
    }
    const bots = deps.getBots();
    if (bots.length === 0) {
      res.status(400).json(errorBody('No bots available'));
      return;
    }
    const workerBotIds = Array.isArray(body.workerBotIds)
      ? (body.workerBotIds.filter((id): id is string => typeof id === 'string'))
      : [];
    for (const id of workerBotIds) {
      if (!bots.some((b) => b.id === id)) {
        res.status(400).json(errorBody(`Unknown worker bot id: ${id}`));
        return;
      }
    }
    let coordinatorBotId = typeof body.coordinatorBotId === 'string' ? body.coordinatorBotId : undefined;
    if (coordinatorBotId) {
      if (!bots.some((b) => b.id === coordinatorBotId)) {
        res.status(400).json(errorBody(`Unknown coordinator bot id: ${coordinatorBotId}`));
        return;
      }
    } else {
      coordinatorBotId = selectGoalCoordinator(bots)?.id;
      if (!coordinatorBotId) {
        res.status(400).json(errorBody('No bots available'));
        return;
      }
    }
    let groupId: string | undefined;
    if (body.groupId !== undefined && body.groupId !== null) {
      if (typeof body.groupId !== 'string') {
        res.status(400).json(errorBody('groupId must be a string'));
        return;
      }
      try {
        const group = new GroupChatStore(deps.dataDir).getGroup(body.groupId);
        if (!group) {
          res.status(404).json(errorBody('Group not found'));
          return;
        }
        groupId = group.id;
      } catch {
        res.status(400).json(errorBody('Invalid groupId'));
        return;
      }
    }
    const goal = store.createGoal({
      title: body.title as string,
      description: typeof body.description === 'string' ? body.description : undefined,
      coordinatorBotId,
      workerBotIds: workerBotIds,
      maxTurns: clampGoalMaxTurns(body.maxTurns),
      groupId,
    });
    deps.audit?.('group-goal.created', {
      goalId: goal.id,
      coordinatorBotId,
      workerCount: workerBotIds.length,
      groupId: groupId ?? null,
    });
    engine.start(goal.id);
    res.status(202).json({ ok: true, goal });
  });

  router.get('/', (req: Request, res: Response) => {
    const limit = 50;
    // W8f: a 1:1 chat lists just its own `/goal` runs.
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined;
    res.json({ ok: true, goals: store.listGoals(limit, sessionId ? { sessionId } : {}) });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const goal = goalOf(req, res);
    if (!goal) return;
    res.json({ ok: true, goal, turns: store.listTurns(goal.id) });
  });

  router.post('/:id/stop', (req: Request, res: Response) => {
    const goal = goalOf(req, res);
    if (!goal) return;
    engine.stop(goal.id);
    res.json({ ok: true, goal: store.getGoal(goal.id) });
  });

  router.post('/:id/resume', (req: Request, res: Response) => {
    const goal = goalOf(req, res);
    if (!goal) return;
    if (!(RESUMABLE_GOAL_STATUSES as readonly string[]).includes(goal.status)) {
      res.status(409).json(errorBody(`Goal is ${goal.status}; only paused goals (needs-input, blocked, max-turns) can resume`));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = typeof body.input === 'string' ? body.input.slice(0, 4000) : undefined;
    const addMaxTurns = typeof body.addMaxTurns === 'number' && Number.isFinite(body.addMaxTurns)
      ? Math.min(30, Math.max(0, Math.floor(body.addMaxTurns)))
      : 0;
    const updated = store.updateGoal(goal.id, {
      status: 'running',
      summary: null,
      maxTurns: addMaxTurns > 0 ? goal.maxTurns + addMaxTurns : goal.maxTurns,
    });
    deps.audit?.('group-goal.resumed', { goalId: goal.id, addMaxTurns });
    engine.start(goal.id, input);
    res.json({ ok: true, goal: updated });
  });

  /** SSE progress stream for a goal. */
  router.get('/:id/stream', (req: Request, res: Response) => {
    const goal = goalOf(req, res);
    if (!goal) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event: SseEvent): void => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // ignore
      }
    };
    send({ type: 'snapshot', goal: store.getGoal(goal.id), turns: store.listTurns(goal.id) });
    engine.subscribe(goal.id, res);
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15_000);
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === 'function') {
      (heartbeat as unknown as { unref: () => void }).unref();
    }
    req.on('close', () => clearInterval(heartbeat));
  });

  return { store, engine };
}
