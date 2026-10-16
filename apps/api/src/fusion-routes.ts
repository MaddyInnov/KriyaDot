// SPDX-License-Identifier: Apache-2.0
// Fusion mode REST API (Atomic Agent parity: planner + parallel workers +
// fused synthesis).
//
//   POST /api/fusion/runs {botId, task, maxSubtasks?, maxConcurrency?, maxBudgetUsd?, providerId?, model?}
//     → 202 { ok, runId } (execution continues in the background)
//   GET  /api/fusion/runs?limit=50 → { ok, runs: FusionRunRecord[] }
//   GET  /api/fusion/runs/:id → { ok, run: FusionRunRecord }
//   GET  /api/fusion/runs/:id/stream → SSE progress events
//
// SSE protocol (JSON data frames):
//   {type:'snapshot', run}      — full current record, sent first
//   {type:'plan_created', plan} | {type:'plan_failed', reason}
//   {type:'worker_started', subtaskId, title}
//   {type:'worker_done', subtaskId, title, ok}
//   {type:'fusion_started', workerCount}
//   {type:'done', result}       — FusionResultSummary (terminal)
//   {type:'error', message}
//
// HOST WIRING (index.ts):
//   import { createFusionRouter } from './fusion-routes.js';
//   import { FusionRunStore } from './fusion.js';
//   const fusionStore = new FusionRunStore(config.dataDir);
//   app.use('/api/fusion', createFusionRouter({
//     store: fusionStore,
//     getBot: (id) => bots.find((b) => b.id === id),
//     agentRuntime,
//   }));
//
// Worker approvals are unattended: approvalTimeoutMs is short so any
// approval-gated tool call in a worker fails closed (denied) quickly
// instead of hanging the run.

import { EventEmitter } from 'node:events';
import express, { type Request, type Response, type Router } from 'express';

/**
 * Requested-limit caps for POST /api/fusion/runs (H2). Clamping is silent
 * (friendlier than 400): unbounded values would spawn unbounded parallel
 * worker turns.
 */
export const MAX_SUBTASKS = 32;
export const MAX_CONCURRENCY = 8;
export function clampFusionLimits(
  maxSubtasks: number | undefined,
  maxConcurrency: number | undefined,
): { maxSubtasks: number | undefined; maxConcurrency: number | undefined } {
  const clamp = (v: number | undefined, lo: number, hi: number): number | undefined =>
    v === undefined ? undefined : Math.min(hi, Math.max(lo, Math.floor(v)));
  return {
    maxSubtasks: clamp(maxSubtasks, 1, MAX_SUBTASKS),
    maxConcurrency: clamp(maxConcurrency, 1, MAX_CONCURRENCY),
  };
}
import {
  FusionOrchestrator,
  buildWorkerMessage,
  costOfUsage,
  createProvider,
  getDefaultModel,
  summarizeResult,
  type AgentRuntime,
  type BotConfig,
  type ChatMessage,
  type FusionPlan,
  type FusionProgressEvent,
  type FusionResultSummary,
  type FusionSubtask,
  type FusionWorkerResult,
  type TokenUsage,
} from '@mvp/agent-runtime';
import { FusionRunStore, isFusionRunId } from './fusion.js';

export interface FusionRouteDeps {
  store: FusionRunStore;
  getBot: (botId: string) => BotConfig | undefined;
  agentRuntime: AgentRuntime;
  /**
   * Injectable LLM call for planner/fusion steps. Defaults to the real
   * provider factory; tests inject a mock (zero network, zero cost).
   */
  callLlm?: FusionLlmCaller;
}

export type FusionLlmCaller = (
  providerId: string,
  model: string,
  messages: ChatMessage[],
) => Promise<{ content: string; usage: TokenUsage }>;

interface ActiveRun {
  emitter: EventEmitter;
  log: FusionProgressEvent[];
  finished: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

/** For index.ts shutdown: drop listeners so the process can exit. */
export function shutdownFusionRuns(): void {
  for (const active of activeRuns.values()) active.emitter.removeAllListeners();
  activeRuns.clear();
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function writeSse(res: Response, payload: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // A poisoned payload must not kill the stream.
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to serialize event' })}\n\n`);
  }
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

async function defaultCallLlm(
  providerId: string,
  model: string,
  messages: ChatMessage[],
): Promise<{ content: string; usage: TokenUsage }> {
  const provider = createProvider(providerId);
  const res = await provider.chat(messages, [], { model });
  return { content: res.content, usage: res.usage };
}

export function createFusionRouter(deps: FusionRouteDeps): Router {
  const router = express.Router();
  const { store, getBot, agentRuntime } = deps;
  const callLlm: FusionLlmCaller = deps.callLlm ?? defaultCallLlm;

  router.post('/runs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const botId = typeof body.botId === 'string' ? body.botId : '';
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (!task) {
      res.status(400).json(errorBody('task is required'));
      return;
    }
    if (task.length > 20000) {
      res.status(400).json(errorBody('task is too long (max 20000 chars)'));
      return;
    }
    const bot = getBot(botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    // Captured in closures below, where TS resets narrowing of `bot`.
    const fusionBot: BotConfig = bot;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    // Clamp silently (see clampFusionLimits): unbounded values would spawn
    // unbounded parallel worker turns.
    const { maxSubtasks, maxConcurrency } = clampFusionLimits(num(body.maxSubtasks), num(body.maxConcurrency));
    const maxBudgetUsd = num(body.maxBudgetUsd);
    const providerId =
      typeof body.providerId === 'string' && body.providerId ? body.providerId : (bot.provider ?? 'groq');
    const model =
      typeof body.model === 'string' && body.model
        ? body.model
        : (bot.model ?? getDefaultModel(providerId) ?? 'default');

    const record = store.createRun({ botId: bot.id, botName: bot.name, task });
    const runId = record.runId;
    const active: ActiveRun = { emitter: new EventEmitter(), log: [], finished: false };
    activeRuns.set(runId, active);

    // Background execution — the 202 below returns immediately.
    void executeFusionRun(runId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        store.failRun(runId, message);
      } catch {
        // ignore
      }
      finishActive(runId, { type: 'error', message });
    });

    async function executeFusionRun(id: string): Promise<void> {
      const controller = new AbortController();
      const planTitles = new Map<string, string>();
      const emit = async (e: FusionProgressEvent): Promise<void> => {
        const a = activeRuns.get(id);
        if (a) {
          a.log.push(e);
          a.emitter.emit('event', e);
        }
        // Persist milestones so polling clients see progress too.
        try {
          if (e.type === 'plan_created') {
            store.setPlan(id, e.plan);
            planTitles.clear();
            for (const s of e.plan.subtasks) planTitles.set(s.id, s.title);
          } else if (e.type === 'done') {
            store.completeRun(id, e.result);
          }
        } catch {
          // persistence must never break the run
        }
      };

      const orchestrator = new FusionOrchestrator({
        planLlm: (messages) => callLlm(providerId, model, messages),
        fuseLlm: (messages) => callLlm(providerId, model, messages),
        costOf: (usage) => costOfUsage(providerId, model, usage).total,
        runWorkerTurn: async (input) => {
          const workerBot: BotConfig = {
            ...fusionBot,
            name: `${fusionBot.name} (fusion worker)`,
          };
          const titleMap = new Map<string, FusionSubtask>();
          for (const [subId, title] of planTitles) {
            titleMap.set(subId, { id: subId, title, description: '', dependencies: [] });
          }
          let output = '';
          const usage = await agentRuntime.runTurn({
            bot: workerBot,
            message: buildWorkerMessage(
              input.subtask,
              input.sharedContext,
              input.dependencyOutputs,
              titleMap,
            ),
            sessionId: `fusion_${id}_${input.subtask.id}`,
            onEvent: (e) => {
              if (e.type === 'token') output += e.content;
            },
            // Unattended workers: approvals fail closed quickly.
            approvalTimeoutMs: 5000,
            maxBudgetUsd: input.maxBudgetUsd,
            signal: input.signal ?? controller.signal,
          });
          return { output: output.trim(), usage };
        },
      });

      try {
        await orchestrator.run(
          { task, maxSubtasks, maxConcurrency, maxBudgetUsd, signal: controller.signal },
          emit,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          store.failRun(id, message);
        } catch {
          // ignore
        }
        await emit({ type: 'error', message });
        const rec = store.getRun(id);
        if (rec) {
          await emit({
            type: 'done',
            result: {
              task,
              status: 'failed',
              plan: rec.plan,
              workerResults: rec.workerResults,
              fused: rec.fused ?? '',
              fallbackSingleAgent: rec.fallbackSingleAgent,
              usage: rec.usage ?? { ...ZERO_USAGE },
              error: message,
            },
          });
        }
      } finally {
        finishActive(id);
      }
    }

    res.status(202).json({ ok: true, runId });
  });

  router.get('/runs', (req: Request, res: Response) => {
    try {
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
      res.json({ ok: true, runs: store.listRuns(Number.isFinite(limit) ? limit : 50) });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'Failed to list runs'));
    }
  });

  router.get('/runs/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!isFusionRunId(id)) {
      res.status(400).json(errorBody('Invalid run id'));
      return;
    }
    const rec = store.getRun(id);
    if (!rec) {
      res.status(404).json(errorBody('Unknown fusion run'));
      return;
    }
    res.json({ ok: true, run: rec });
  });

  router.get('/runs/:id/stream', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!isFusionRunId(id)) {
      res.status(400).json(errorBody('Invalid run id'));
      return;
    }
    const rec = store.getRun(id);
    if (!rec) {
      res.status(404).json(errorBody('Unknown fusion run'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);
    const finish = (): void => {
      clearInterval(heartbeat);
      if (!closed) {
        closed = true;
        res.end();
      }
    };
    req.on('close', finish);

    // Snapshot first so the client has full state even if it missed events.
    writeSse(res, { type: 'snapshot', run: store.getRun(id) });

    const active = activeRuns.get(id);
    if (!active || active.finished) {
      // Run already terminal — snapshot is the whole story.
      finish();
      return;
    }
    // Replay the in-memory log (events since run start) then go live.
    for (const e of active.log) writeSse(res, e);
    const onEvent = (e: FusionProgressEvent): void => {
      if (closed) return;
      writeSse(res, e);
      if (e.type === 'done' || e.type === 'error') {
        // Give the frame a tick to flush, then close.
        setTimeout(finish, 50);
      }
    };
    active.emitter.on('event', onEvent);
    req.on('close', () => active.emitter.off('event', onEvent));
  });

  return router;
}

function finishActive(runId: string, finalEvent?: FusionProgressEvent): void {
  const active = activeRuns.get(runId);
  if (!active) return;
  active.finished = true;
  if (finalEvent) {
    active.log.push(finalEvent);
    active.emitter.emit('event', finalEvent);
  }
  // Keep the entry briefly so late subscribers still get the terminal
  // event, then drop it (the DB is the durable record).
  setTimeout(() => {
    active.emitter.removeAllListeners();
    if (activeRuns.get(runId) === active) activeRuns.delete(runId);
  }, 60_000).unref?.();
}

// Re-exported for tests.
export type { FusionPlan, FusionProgressEvent, FusionResultSummary, FusionWorkerResult };
