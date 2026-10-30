// SPDX-License-Identifier: Apache-2.0
// Processing rules + firing log HTTP API (Laya-inspired, adapted).
// Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerProcessingRuleRoutes } from './processing-rules-routes.js';
//   registerProcessingRuleRoutes(router, {
//     dataDir: config.dataDir,
//     governance,
//   });
//
// Routes (mounted at /api):
//   GET    /processing-rules            → ProcessingRule[]
//   POST   /processing-rules            → { name, match?, actions, enabled? } → 201 ProcessingRule
//   GET    /processing-rules/firing-log → FiringLogEntry[] (?ruleId=, ?status=, ?since=, ?until=, ?limit=)
//   GET    /processing-rules/:id        → ProcessingRule
//   PATCH  /processing-rules/:id        → { name?, match?, actions?, enabled? } → ProcessingRule
//   DELETE /processing-rules/:id        → { ok: true }
//   POST   /processing-rules/:id/fire   → { item: { id, kind, source?, text?, meta? }, actor? } → FiringReport

import { Router } from 'express';
import type { Request, Response } from 'express';
import { ProcessingRuleStore } from '@mvp/governance';
import { join } from 'node:path';
import type { GovernanceGateway } from '@mvp/governance';
import { resolvePrincipal } from './principal.js';

export interface ProcessingRuleDeps {
  dataDir: string;
  governance: GovernanceGateway;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function numQuery(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function actorOf(req: Request): string {
  // Audit actor = the verified principal (principal.ts, OPEN-1 fix), never a raw header.
  return resolvePrincipal(req, {})?.userId ?? 'api';
}

export function registerProcessingRuleRoutes(router: Router, deps: ProcessingRuleDeps): void {
  const { governance } = deps;
  const ruleStore = new ProcessingRuleStore(join(deps.dataDir, 'processing-rules.db'));

  // (firing-log is registered before :id so it is not captured as an id)
  router.get('/processing-rules/firing-log', (req: Request, res: Response) => {
    try {
      res.json(
        ruleStore.queryFiringLog({
          ruleId: typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined,
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          since: numQuery(req.query.since),
          until: numQuery(req.query.until),
          limit: numQuery(req.query.limit),
        }),
      );
    } catch (err) {
      res.status(500).json(errorBody('failed to query firing log', errMessage(err)));
    }
  });

  router.get('/processing-rules', (_req: Request, res: Response) => {
    try {
      res.json(ruleStore.listRules());
    } catch (err) {
      res.status(500).json(errorBody('failed to list processing rules', errMessage(err)));
    }
  });

  router.post('/processing-rules', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown; match?: unknown; actions?: unknown; enabled?: unknown };
      if (body.name === undefined || body.actions === undefined) {
        res.status(400).json(errorBody('invalid processing rule', 'body must include "name" and "actions"'));
        return;
      }
      const rule = ruleStore.createRule({
        name: body.name,
        match: body.match,
        actions: body.actions,
        enabled: body.enabled,
      });
      governance.audit('processing_rule.created', {
        actor: actorOf(req),
        detail: { ruleId: rule.id, name: rule.name },
      });
      res.status(201).json(rule);
    } catch (err) {
      res.status(400).json(errorBody('invalid processing rule', errMessage(err)));
    }
  });

  router.get('/processing-rules/:id', (req: Request, res: Response) => {
    try {
      const rule = ruleStore.getRule(req.params.id);
      if (!rule) {
        res.status(404).json(errorBody(`unknown processing rule: ${req.params.id}`));
        return;
      }
      res.json(rule);
    } catch (err) {
      res.status(500).json(errorBody('failed to read processing rule', errMessage(err)));
    }
  });

  router.patch('/processing-rules/:id', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown; match?: unknown; actions?: unknown; enabled?: unknown };
      res.json(ruleStore.updateRule(req.params.id, body));
    } catch (err) {
      const message = errMessage(err);
      res
        .status(message.startsWith('unknown processing rule') ? 404 : 400)
        .json(errorBody('failed to update processing rule', message));
    }
  });

  router.delete('/processing-rules/:id', (req: Request, res: Response) => {
    try {
      if (!ruleStore.deleteRule(req.params.id)) {
        res.status(404).json(errorBody(`unknown processing rule: ${req.params.id}`));
        return;
      }
      governance.audit('processing_rule.deleted', {
        actor: actorOf(req),
        detail: { ruleId: req.params.id },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('failed to delete processing rule', errMessage(err)));
    }
  });

  router.post('/processing-rules/:id/fire', async (req: Request, res: Response) => {
    try {
      const rule = ruleStore.getRule(req.params.id);
      if (!rule) {
        res.status(404).json(errorBody(`unknown processing rule: ${req.params.id}`));
        return;
      }
      const body = (req.body ?? {}) as { item?: unknown; actor?: unknown };
      const item = body.item as { id?: unknown; kind?: unknown; source?: unknown; text?: unknown; meta?: unknown };
      if (typeof item?.id !== 'string' || typeof item?.kind !== 'string') {
        res.status(400).json(errorBody('body.item must include string "id" and "kind"'));
        return;
      }
      // Fire exactly this rule (no side effects on other rules).
      const report = await ruleStore.fireRule(
        rule.id,
        {
          id: item.id,
          kind: item.kind,
          source: typeof item.source === 'string' ? item.source : undefined,
          text: typeof item.text === 'string' ? item.text : undefined,
          meta:
            typeof item.meta === 'object' && item.meta !== null
              ? (item.meta as Record<string, unknown>)
              : undefined,
        },
        { actor: typeof body.actor === 'string' ? body.actor : actorOf(req) },
      );
      res.json(report);
    } catch (err) {
      res.status(500).json(errorBody('failed to fire processing rule', errMessage(err)));
    }
  });
}
