// SPDX-License-Identifier: Apache-2.0
// Eval harnesses REST API (Atomic Agent parity: score bot quality with
// rubric-based test suites).
//
//   GET  /api/evals                    → { ok, suites: EvalSuite[] }
//   POST /api/evals  {suite}           → { ok, suite } (create/update, validated)
//   DELETE /api/evals/:id             → { ok, deleted }
//   POST /api/evals/:id/run {botId, maxConcurrency?, maxBudgetUsd?, providerId?, model?, judgeProviderId?, judgeModel?}
//     → 202 { ok, runId } (execution continues in the background)
//   GET  /api/evals/runs?limit=50&suiteId= → { ok, runs: EvalRunRecord[] }
//   GET  /api/evals/runs/:id          → { ok, run: EvalRunRecord }
//   GET  /api/evals/runs/:id/stream   → SSE progress events
//
// SSE protocol (JSON data frames):
//   {type:'snapshot', run}      — full current record, sent first
//   {type:'run_started', suiteId, suiteName, caseCount}
//   {type:'case_started', caseId, name, index, total}
//   {type:'case_done', result}
//   {type:'done', report}       — EvalRunReportSummary (terminal)
//   {type:'error', message}
//
// HOST WIRING (index.ts):
//   import { createEvalRouter, shutdownEvalRuns } from './eval-routes.js';
//   import { EvalRunStore, EvalSuiteStore } from './evals.js';
//   const evalRunStore = new EvalRunStore(config.dataDir);
//   const evalSuiteStore = new EvalSuiteStore(config.dataDir);
//   app.use('/api/evals', createEvalRouter({
//     runStore: evalRunStore,
//     suiteStore: evalSuiteStore,
//     getBot: (id) => bots.find((b) => b.id === id),
//     agentRuntime,
//     memoryStore: tieredMemoryStore,
//   }));
//
// Eval turns are unattended: approvalTimeoutMs is short so any approval-gated
// tool call fails closed (denied) instead of hanging the run. Memory-recall
// cases seed atoms directly into the bot's durable memory before running.

import { EventEmitter } from 'node:events';
import express, { type Request, type Response, type Router } from 'express';
import {
  EvalRunner,
  buildJudgeMessages,
  costOfUsage,
  createProvider,
  getDefaultModel,
  parseJudgeScore,
  type AgentRuntime,
  type BotConfig,
  type ChatMessage,
  type EvalCaseResultSummary,
  type EvalProgressEvent,
  type EvalRunReportSummary,
  type EvalSuite,
  type EvalTurnOutput,
  type TieredMemoryStore,
  type TokenUsage,
} from '@mvp/agent-runtime';
import { EvalRunStore, EvalSuiteStore, isEvalRunId } from './evals.js';

export interface EvalRouteDeps {
  runStore: EvalRunStore;
  suiteStore: EvalSuiteStore;
  getBot: (botId: string) => BotConfig | undefined;
  agentRuntime: AgentRuntime;
  /**
   * Durable memory store for memory-recall case setup (atoms are seeded
   * directly, tagged with the eval session id).
   */
  memoryStore: TieredMemoryStore;
  /**
   * Injectable LLM call for llm_judge rubrics. Defaults to the real
   * provider factory; tests inject a mock (zero network, zero cost).
   */
  callLlm?: EvalLlmCaller;
}

export type EvalLlmCaller = (
  providerId: string,
  model: string,
  messages: ChatMessage[],
) => Promise<{ content: string; usage: TokenUsage }>;

interface ActiveRun {
  emitter: EventEmitter;
  log: EvalProgressEvent[];
  finished: boolean;
  abort: () => void;
}

const activeRuns = new Map<string, ActiveRun>();

/** For index.ts shutdown: abort runs and drop listeners so the process can exit. */
export function shutdownEvalRuns(): void {
  for (const active of activeRuns.values()) {
    try {
      active.abort();
    } catch {
      // ignore
    }
    active.emitter.removeAllListeners();
  }
  activeRuns.clear();
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function writeSse(res: Response, payload: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to serialize event' })}\n\n`);
  }
}

async function defaultCallLlm(
  providerId: string,
  model: string,
  messages: ChatMessage[],
): Promise<{ content: string; usage: TokenUsage }> {
  const provider = createProvider(providerId);
  const res = await provider.chat(messages, [], { model });
  return { content: res.content, usage: res.usage };
}

export function createEvalRouter(deps: EvalRouteDeps): Router {
  const router = express.Router();
  const { runStore, suiteStore, getBot, agentRuntime, memoryStore } = deps;
  const callLlm: EvalLlmCaller = deps.callLlm ?? defaultCallLlm;

  // -- Suites -----------------------------------------------------------

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, suites: suiteStore.listSuites() });
  });

  router.post('/', (req: Request, res: Response) => {
    const saved = suiteStore.saveSuite(req.body);
    if (!saved.ok) {
      res.status(400).json({ ok: false, errors: saved.errors });
      return;
    }
    res.json({ ok: true, suite: saved.suite });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      res.status(400).json(errorBody('Invalid suite id'));
      return;
    }
    res.json({ ok: true, deleted: suiteStore.deleteSuite(id) });
  });

  // -- Runs -------------------------------------------------------------

  router.post('/:id/run', async (req: Request, res: Response) => {
    const suite = suiteStore.getSuite(req.params.id);
    if (!suite) {
      res.status(404).json(errorBody(`Unknown eval suite "${req.params.id}"`));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const botId = typeof body.botId === 'string' ? body.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    const bot = getBot(botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    const evalBot: BotConfig = bot;
    // Captured in closures below, where TS resets narrowing of `suite`.
    const evalSuite: EvalSuite = suite;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    const maxConcurrency = num(body.maxConcurrency);
    const maxBudgetUsd = num(body.maxBudgetUsd);
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v ? v : undefined;
    const providerId = str(body.providerId) ?? evalBot.provider ?? 'groq';
    const model = str(body.model) ?? evalBot.model ?? getDefaultModel(providerId) ?? 'default';
    // Judge: configurable and cheap — defaults to the run's own model.
    const judgeProviderId = str(body.judgeProviderId) ?? providerId;
    const judgeModel = str(body.judgeModel) ?? model;

    const record = runStore.createRun({
      suiteId: suite.id,
      suiteName: suite.name,
      botId: evalBot.id,
      botName: evalBot.name,
    });
    const runId = record.runId;
    const controller = new AbortController();
    const active: ActiveRun = {
      emitter: new EventEmitter(),
      log: [],
      finished: false,
      abort: () => controller.abort(),
    };
    activeRuns.set(runId, active);

    // Background execution — the 202 below returns immediately.
    void executeEvalRun(runId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        runStore.failRun(runId, message);
      } catch {
        // ignore
      }
      finishActive(runId, { type: 'error', message });
    });

    async function executeEvalRun(id: string): Promise<void> {
      const emit = async (e: EvalProgressEvent): Promise<void> => {
        const a = activeRuns.get(id);
        if (a) {
          a.log.push(e);
          a.emitter.emit('event', e);
        }
        try {
          if (e.type === 'done') {
            runStore.completeRun(id, e.report);
          }
        } catch {
          // persistence must never break the run
        }
      };

      const runner = new EvalRunner({
        runTurn: async (b, turnReq): Promise<EvalTurnOutput> => {
          let response = '';
          const toolsUsed: string[] = [];
          const timeout = setTimeout(() => controller.abort(), turnReq.timeoutMs);
          try {
            const usage = await agentRuntime.runTurn({
              bot: b,
              message: turnReq.input,
              sessionId: `eval_${id}_${turnReq.caseId}`,
              providerId,
              model,
              onEvent: (e) => {
                if (e.type === 'token') response += e.content;
                else if (e.type === 'tool_call' && !toolsUsed.includes(e.call.name)) {
                  toolsUsed.push(e.call.name);
                }
              },
              // Unattended: approvals fail closed quickly.
              approvalTimeoutMs: 5000,
              maxBudgetUsd,
              signal: controller.signal,
            });
            return { response: response.trim(), toolsUsed, usage };
          } finally {
            clearTimeout(timeout);
          }
        },
        judge: async (criteria, judgeResponse) => {
          const { content } = await callLlm(
            judgeProviderId,
            judgeModel,
            buildJudgeMessages(criteria, judgeResponse),
          );
          return parseJudgeScore(content);
        },
        storeMemory: async (targetBotId, text) => {
          // Seed atoms for memory-recall cases (eval session namespace).
          memoryStore.storeAtom(
            targetBotId,
            { fact: text, entities: [], confidence: 1 },
            `eval_${id}`,
            undefined,
            { category: 'fact' },
          );
        },
        costOf: (usage) => costOfUsage(providerId, model, usage).total,
      });

      try {
        await runner.run(evalSuite, evalBot, {
          maxConcurrency,
          maxBudgetUsd,
          signal: controller.signal,
          onEvent: emit,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          runStore.failRun(id, message);
        } catch {
          // ignore
        }
        await emit({ type: 'error', message });
      } finally {
        finishActive(id, null);
      }
    }

    res.status(202).json({ ok: true, runId });
  });

  router.get('/runs', (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const suiteId = typeof req.query.suiteId === 'string' ? req.query.suiteId : undefined;
    res.json({ ok: true, runs: runStore.listRuns(Number.isFinite(limit) ? limit : 50, suiteId) });
  });

  router.get('/runs/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!isEvalRunId(id)) {
      res.status(400).json(errorBody('Invalid run id'));
      return;
    }
    const run = runStore.getRun(id);
    if (!run) {
      res.status(404).json(errorBody(`Unknown eval run "${id}"`));
      return;
    }
    res.json({ ok: true, run });
  });

  router.get('/runs/:id/stream', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!isEvalRunId(id)) {
      res.status(400).json(errorBody('Invalid run id'));
      return;
    }
    const run = runStore.getRun(id);
    if (!run) {
      res.status(404).json(errorBody(`Unknown eval run "${id}"`));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    writeSse(res, { type: 'snapshot', run });

    const active = activeRuns.get(id);
    if (!active || active.finished) {
      // Already finished — the snapshot carries the final record.
      res.end();
      return;
    }
    // Replay the log so late joiners see progress so far.
    for (const e of active.log) writeSse(res, e);

    const onEvent = (e: EvalProgressEvent): void => {
      writeSse(res, e);
      if (e.type === 'done' || e.type === 'error') {
        cleanup();
        res.end();
      }
    };
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 15000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      active.emitter.removeListener('event', onEvent);
    };
    req.on('close', cleanup);
    active.emitter.on('event', onEvent);
  });

  return router;
}

function finishActive(runId: string, terminal: EvalProgressEvent | null): void {
  const active = activeRuns.get(runId);
  if (!active) return;
  active.finished = true;
  if (terminal) {
    active.log.push(terminal);
    active.emitter.emit('event', terminal);
  }
  // Keep the record briefly for late SSE joins, then drop listeners.
  setTimeout(() => {
    const a = activeRuns.get(runId);
    if (a) {
      a.emitter.removeAllListeners();
      activeRuns.delete(runId);
    }
  }, 60_000).unref?.();
}
