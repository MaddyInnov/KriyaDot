// SPDX-License-Identifier: Apache-2.0
// Inbound webhook entry points: workflow triggers (createWebhookRouter) and
// bot-routine triggers (createRoutineWebhookRouter, workstream C).
//
// Workflow: POST /webhooks/:triggerId
//   - 404 when the trigger id is unknown, disabled, or not a webhook trigger
//   - 401 when the `x-webhook-secret` header does not match the stored secret
//     (compared with crypto.timingSafeEqual over SHA-256 digests)
//   - otherwise starts a workflow run and returns { runId }
//
// Routine: POST /webhooks/routines/:triggerId (separate mount)
//   - 404 unknown/disabled trigger or routine; 401 bad secret (same
//     timing-safe secret pattern); 202 enqueues the routine's bot turn.
//
// Mount at boot, e.g. `app.use('/webhooks', createWebhookRouter({ runner, triggerStore }))`
// and `app.use('/webhooks/routines', createRoutineWebhookRouter({ routineStore, triggerStore, agentRuntime, getBots }))`.
// The TriggerStore/WorkflowRunner are constructed in the API boot sequence.

import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WorkflowRunner } from '@mvp/workflows';
// Deep import: TriggerStore lives in @mvp/workflows' triggers module
// (not re-exported from the package index by design of this workstream).
import { TriggerStore } from '@mvp/workflows/dist/triggers.js';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import {
  RoutineStore,
  RoutineWebhookTriggerStore,
} from './bot-routines.js';

export { TriggerStore };
export { RoutineStore, RoutineWebhookTriggerStore };

export interface WebhookRouterOptions {
  runner: WorkflowRunner;
  triggerStore: TriggerStore;
}

function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Render a routine prompt template: `{{payload}}` (alias `{{body}}`) is
 * replaced with the webhook request body serialized as JSON.
 */
export function renderRoutinePrompt(template: string, body: unknown): string {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return template.split('{{payload}}').join(payload).split('{{body}}').join(payload);
}

export interface RoutineWebhookRouterOptions {
  routineStore: RoutineStore;
  triggerStore: RoutineWebhookTriggerStore;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Override prompt rendering (default: {{payload}} substitution). */
  renderPrompt?: (template: string, body: unknown) => string;
  /**
   * Run executor (routine-runs.ts). When set, webhook-triggered turns
   * leave run records (trigger 'webhook'); when omitted, the legacy
   * fire-and-forget path is used.
   */
  runExecutor?: import('./routine-runs.js').RoutineRunExecutor;
}

/**
 * Inbound webhook entry points for bot-routine triggers (workstream C).
 *
 * POST /:triggerId
 *   - 404 when the trigger id is unknown, disabled, or its routine is
 *     unknown/disabled
 *   - 401 when the `x-webhook-secret` header does not match the trigger's
 *     stored secret (same timing-safe HMAC pattern as workflow webhooks)
 *   - 202 otherwise: enqueues the routine's bot turn with the rendered
 *     prompt (fire-and-forget — the turn runs in the background)
 *
 * Mount at e.g. `app.use('/webhooks/routines', createRoutineWebhookRouter({...}))`.
 * The workflow webhook router is untouched; the two mounts do not collide
 * (`/:triggerId` there only matches single-segment paths).
 */
export function createRoutineWebhookRouter(opts: RoutineWebhookRouterOptions): Router {
  const router = Router();
  const render = opts.renderPrompt ?? renderRoutinePrompt;

  router.post('/:triggerId', (req: Request, res: Response) => {
    const triggerId = req.params.triggerId;
    const trigger = opts.triggerStore.get(triggerId);
    if (!trigger || !trigger.enabled || !trigger.secret) {
      res.status(404).json({ error: 'unknown routine webhook trigger' });
      return;
    }
    const provided = req.header('x-webhook-secret');
    if (!secretsMatch(provided, trigger.secret)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }
    const routine = opts.routineStore.get(trigger.routineId);
    if (!routine || !routine.enabled) {
      res.status(404).json({ error: 'unknown routine webhook trigger' });
      return;
    }
    const bot = opts.getBots().find((b) => b.id === routine.botId);
    if (!bot) {
      res.status(500).json({ error: `routine bot "${routine.botId}" no longer exists` });
      return;
    }
    const sessionId = routine.sessionId ?? `routine_${routine.id}`;
    // Fire-and-forget: enqueue the turn and acknowledge immediately.
    // Webhook senders must not wait on a full agent turn.
    void (async () => {
      if (opts.runExecutor) {
        try {
          await opts.runExecutor.execute({
            routine,
            trigger: 'webhook',
            payload: req.body,
            sessionId,
          });
        } catch (err) {
          console.error(
            `[routine-webhook] run failed for routine "${routine.id}":`,
            err instanceof Error ? err.message : err,
          );
        }
        return;
      }
      const message = render(routine.promptTemplate, req.body);
      try {
        await opts.agentRuntime.runTurn({
          bot,
          message,
          sessionId,
          taskType: 'chat',
          // P1 #13: inbound webhooks are untrusted external content — the
          // turn is fenced and its approvals always go to the human.
          provenance: {
            origin: 'webhook',
            relayPath: [`webhook:${routine.id}`],
            relayNames: [`webhook ${routine.id}`],
            timestamp: new Date().toISOString(),
          },
          onEvent: () => {},
        });
      } catch (err) {
        console.error(
          `[routine-webhook] turn failed for routine "${routine.id}":`,
          err instanceof Error ? err.message : err,
        );
      }
    })();
    res.status(202).json({ ok: true, accepted: true, routineId: routine.id, triggerId: trigger.id });
    return;
  });

  return router;
}

export function createWebhookRouter(opts: WebhookRouterOptions): Router {
  const router = Router();

  router.post('/:triggerId', async (req: Request, res: Response) => {
    const triggerId = req.params.triggerId;
    const trigger = opts.triggerStore.get(triggerId);
    if (!trigger || !trigger.enabled || trigger.kind !== 'webhook' || !trigger.secret) {
      res.status(404).json({ error: 'unknown webhook trigger' });
      return;
    }
    const provided = req.header('x-webhook-secret');
    if (!secretsMatch(provided, trigger.secret)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }
    try {
      // Optional idempotency for senders that retry deliveries.
      const idempotencyKey = req.header('x-idempotency-key') || undefined;
      const run = await opts.runner.startRun(
        trigger.workflowId,
        {
          trigger: 'webhook',
          triggerId: trigger.id,
          receivedAt: new Date().toISOString(),
          body: req.body,
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      res.status(200).json({ runId: run.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to start run' });
    }
    return;
  });

  return router;
}
