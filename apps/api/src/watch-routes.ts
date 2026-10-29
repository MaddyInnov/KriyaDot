// SPDX-License-Identifier: Apache-2.0
// Proactive account watching (W5) — HTTP surface.
//
//   GET    /watch-rules                 → { rules: WatchRule[] } (each with state)
//   POST   /watch-rules                 → create (201 { rule })
//   GET    /watch-rules/:id             → { rule, state }
//   PATCH  /watch-rules/:id             → partial update { rule }
//   DELETE /watch-rules/:id             → { ok: true }
//   POST   /watch-rules/:id/run-now     → poll the rule immediately { result }
//   GET    /watch-items?status=&ruleId= → { items: WatchItem[] }  (the inbox)
//   GET    /watch-items/:id             → { item }  (the "Open" context view)
//   POST   /watch-items/:id/dismiss     → { item }  (never resurfaces)
//   POST   /watch-items/:id/draft       → { item }  (draft stored on the item)
//   GET    /watch-runs?ruleId=          → { runs: WatchRun[] }    (Activity)
//
// Mounted at /api by index.ts. Validation lives in watch-rules.ts; the
// connected-account check mirrors the W2 routine routes (the account
// must exist in the local Composio cache and its toolkit must match the
// rule's app). The watcher service is constructed here and returned so
// the host can start its scheduler; tests can inject a mock Composio
// executor + mock triage so no network or paid call ever happens.

import express from 'express';
import type { Request, Response } from 'express';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { readAccountCache } from './composio-accounts.js';
import { createComposioEventExecutor, type ComposioEventExecutor } from './routine-events.js';
import type { PushService } from './push.js';
import {
  validateWatchRuleInput,
  validateWatchRulePatch,
  WatchStore,
  type WatchItemStatus,
  type WatchRule,
} from './watch-rules.js';
import {
  createBotTurnDraftRunner,
  createRoutingTriage,
  WatcherService,
  type WatchDraftRunner,
  type WatchTriageFn,
} from './watch-watcher.js';

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface WatchRouteDeps {
  dataDir: string;
  /** Governance audit sink (Activity trail for rule CRUD + watcher runs). */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Bots, for owner-bot validation + push display names. */
  getBots?: () => BotConfig[];
  /** The Chief bot id — default owner when a rule names no bot. */
  chiefBotId?: string;
  /** Composio execution (mocked in tests; production default below). */
  executor?: ComposioEventExecutor;
  /** Helper-model triage (mocked in tests; production routing triage). */
  triage?: WatchTriageFn;
  /** Existing push path for surfaced items. */
  push?: Pick<PushService, 'notify'>;
  /** Draft runner override (tests). Default: bot-turn runner when agentRuntime is given. */
  draftRunner?: WatchDraftRunner;
  agentRuntime?: AgentRuntime;
  /** Pre-built store (tests share one across "restarts"). */
  store?: WatchStore;
  /** Global pause gate (W14d), forwarded to the watcher service. */
  isPaused?: () => boolean;
  /**
   * Connected-account checker: returns an error message when the account
   * is not usable for the app, null when it is. Defaults to the local
   * Composio account cache (same check as the W2 routine routes).
   */
  accountChecker?: (input: { accountId: string; app: string; userId: string }) => string | null;
}

export interface WatchRoutesResult {
  store: WatchStore;
  watcher: WatcherService;
}

export function registerWatchRoutes(router: express.Router, deps: WatchRouteDeps): WatchRoutesResult {
  const store = deps.store ?? new WatchStore(deps.dataDir);
  const watcher = new WatcherService({
    store,
    executor: deps.executor ?? createComposioEventExecutor({ dataDir: deps.dataDir }),
    triage: deps.triage ?? createRoutingTriage(),
    push: deps.push,
    draftRunner:
      deps.draftRunner ??
      (deps.agentRuntime && deps.getBots
        ? createBotTurnDraftRunner({ agentRuntime: deps.agentRuntime, getBots: deps.getBots })
        : undefined),
    getBotName: deps.getBots
      ? (botId) => deps.getBots!().find((b) => b.id === botId)?.name
      : undefined,
    audit: deps.audit,
    isPaused: deps.isPaused,
  });

  const audit = (action: string, detail: unknown): void => {
    try {
      deps.audit?.(action, { actor: 'user', detail });
    } catch {
      // Audit must never break the API.
    }
  };

  const accountError = (rule: { accountId: string; app: string; userId: string }): string | null => {
    if (deps.accountChecker) return deps.accountChecker(rule);
    const record = readAccountCache(deps.dataDir, rule.userId)[rule.accountId];
    if (!record) {
      return `unknown connected account "${rule.accountId}" — connect it in Accounts → Composio first`;
    }
    if (record.toolkitSlug !== rule.app) {
      return `connected account "${rule.accountId}" is a ${record.toolkitSlug} account, not ${rule.app}`;
    }
    return null;
  };

  const botError = (botId: string): string | null => {
    if (!deps.getBots) return null;
    return deps.getBots().some((b) => b.id === botId) ? null : `unknown bot "${botId}"`;
  };

  const withState = (rule: WatchRule) => ({ ...rule, state: store.getState(rule.id) ?? null });

  const r = express.Router();

  r.get('/watch-rules', (_req: Request, res: Response) => {
    res.json({ rules: store.listRules().map(withState) });
  });

  r.post('/watch-rules', (req: Request, res: Response) => {
    try {
      const input = validateWatchRuleInput(req.body ?? {}, { defaultBotId: deps.chiefBotId });
      const aErr = accountError(input);
      if (aErr) {
        res.status(400).json(errorBody(aErr));
        return;
      }
      const bErr = botError(input.botId ?? deps.chiefBotId ?? 'chief');
      if (bErr) {
        res.status(400).json(errorBody(bErr));
        return;
      }
      const rule = store.createRule(input);
      audit('watch.rule_created', { ruleId: rule.id, app: rule.app, kind: rule.kind });
      res.status(201).json({ rule: withState(rule) });
    } catch (err) {
      res.status(400).json(errorBody('invalid watch rule', errMessage(err)));
    }
  });

  r.get('/watch-rules/:id', (req: Request, res: Response) => {
    const rule = store.getRule(req.params.id);
    if (!rule) {
      res.status(404).json(errorBody(`unknown watch rule: ${req.params.id}`));
      return;
    }
    res.json({ rule: withState(rule) });
  });

  r.patch('/watch-rules/:id', (req: Request, res: Response) => {
    const existing = store.getRule(req.params.id);
    if (!existing) {
      res.status(404).json(errorBody(`unknown watch rule: ${req.params.id}`));
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Fast path: a bare enable/disable toggle skips full revalidation
      // (an unrelated patch must not fail on a since-disconnected account).
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      if (keys.length === 1 && keys[0] === 'enabled' && typeof body.enabled === 'boolean') {
        const updated = store.setEnabled(existing.id, body.enabled);
        audit('watch.rule_updated', { ruleId: existing.id, enabled: body.enabled });
        res.json({ rule: updated ? withState(updated) : null });
        return;
      }
      const input = validateWatchRulePatch(existing, body);
      if (input.accountId !== existing.accountId || input.app !== existing.app) {
        const aErr = accountError(input);
        if (aErr) {
          res.status(400).json(errorBody(aErr));
          return;
        }
      }
      if (input.botId && input.botId !== existing.botId) {
        const bErr = botError(input.botId);
        if (bErr) {
          res.status(400).json(errorBody(bErr));
          return;
        }
      }
      const updated = store.updateRule(existing.id, input);
      audit('watch.rule_updated', { ruleId: existing.id });
      res.json({ rule: updated ? withState(updated) : null });
    } catch (err) {
      res.status(400).json(errorBody('invalid watch rule patch', errMessage(err)));
    }
  });

  r.delete('/watch-rules/:id', (req: Request, res: Response) => {
    if (!store.deleteRule(req.params.id)) {
      res.status(404).json(errorBody(`unknown watch rule: ${req.params.id}`));
      return;
    }
    audit('watch.rule_deleted', { ruleId: req.params.id });
    res.json({ ok: true, deleted: req.params.id });
  });

  r.post('/watch-rules/:id/run-now', async (req: Request, res: Response) => {
    const rule = store.getRule(req.params.id);
    if (!rule) {
      res.status(404).json(errorBody(`unknown watch rule: ${req.params.id}`));
      return;
    }
    try {
      const result = await watcher.pollRule(rule);
      res.json({ result });
    } catch (err) {
      res.status(500).json(errorBody('watch poll failed', errMessage(err)));
    }
  });

  // ---- Inbox items -----------------------------------------------------------

  r.get('/watch-items', (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? (req.query.status as WatchItemStatus) : undefined;
    if (status !== undefined && status !== 'new' && status !== 'actioned' && status !== 'dismissed') {
      res.status(400).json(errorBody('status must be one of: new, actioned, dismissed'));
      return;
    }
    const ruleId = typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json({ items: store.listItems({ status, ruleId, limit: Number.isFinite(limit) ? limit : undefined }) });
  });

  r.get('/watch-items/:id', (req: Request, res: Response) => {
    const item = store.getItem(req.params.id);
    if (!item) {
      res.status(404).json(errorBody(`unknown watch item: ${req.params.id}`));
      return;
    }
    const rule = store.getRule(item.ruleId);
    res.json({ item, rule: rule ?? null });
  });

  r.post('/watch-items/:id/dismiss', (req: Request, res: Response) => {
    const item = watcher.dismissItem(req.params.id);
    if (!item) {
      res.status(404).json(errorBody(`unknown watch item: ${req.params.id}`));
      return;
    }
    res.json({ item });
  });

  r.post('/watch-items/:id/draft', async (req: Request, res: Response) => {
    const existing = store.getItem(req.params.id);
    if (!existing) {
      res.status(404).json(errorBody(`unknown watch item: ${req.params.id}`));
      return;
    }
    try {
      const item = await watcher.draftItem(req.params.id);
      res.json({ item });
    } catch (err) {
      res.status(502).json(errorBody('draft failed', errMessage(err)));
    }
  });

  // ---- Runs (Activity) ---------------------------------------------------------

  r.get('/watch-runs', (req: Request, res: Response) => {
    const ruleId = typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json({ runs: store.listRuns({ ruleId, limit: Number.isFinite(limit) ? limit : undefined }) });
  });

  router.use(r);
  return { store, watcher };
}
