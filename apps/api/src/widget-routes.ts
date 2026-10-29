// SPDX-License-Identifier: Apache-2.0
// Interactive widget routes (OpenMausBot parity P1 #15): answer and list
// widgets raised by the `ask_user_question` tool (interactive) or by tool
// result `widget` attachments (display-only).
//
//   POST   /widgets/:id/answer   { value: unknown } → answer a pending widget
//   GET    /widgets?sessionId=&status= → list widgets (sweeps expired first)
//
// HOST WIRING (index.ts):
//   const widgetStore = new WidgetStore(config.dataDir);
//   const widgetCoordinator = new WidgetCoordinator(widgetStore, { audit });
//   app.use('/api', createWidgetRouter({ store: widgetStore, coordinator: widgetCoordinator, audit }));
//   // chat route deps: widgetCoordinator (RouteDeps), passed into runTurn.

import express, { type Router } from 'express';
import {
  WidgetNotFoundError,
  WidgetNotPendingError,
  isWidgetKind,
} from '@mvp/agent-runtime';
import type {
  WidgetCoordinator,
  WidgetRecord,
  WidgetStatus,
  WidgetStore,
} from '@mvp/agent-runtime';

interface ApiError {
  error: string;
  detail?: string;
}

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

export interface WidgetRouterDeps {
  store: WidgetStore;
  coordinator: WidgetCoordinator;
  audit: (
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ) => void;
}

const VALID_WIDGET_STATUSES = new Set(['pending', 'answered', 'expired']);

/** Serialize a record for the API (value is already parsed JSON). */
function serializeWidget(record: WidgetRecord): Record<string, unknown> {
  return {
    id: record.id,
    sessionId: record.sessionId,
    botId: record.botId,
    kind: record.kind,
    payload: record.payload,
    title: record.title,
    interactive: record.interactive,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    neverExpire: record.neverExpire,
    ...(record.value !== undefined ? { value: record.value } : {}),
    ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
  };
}

export function createWidgetRouter(deps: WidgetRouterDeps): Router {
  const router = express.Router();
  const { store, coordinator, audit } = deps;

  // Backstop expiry sweep on every list: widgets whose TTL passed while no
  // waiter was watching still transition to 'expired', and in-flight
  // waiters fail closed with {answered:false, expired:true}.
  router.get('/widgets', (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined;
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusParam && !VALID_WIDGET_STATUSES.has(statusParam)) {
        res
          .status(400)
          .json(errorBody(`Invalid status "${statusParam}" — expected pending|answered|expired`));
        return;
      }
      const kindParam = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      if (kindParam && !isWidgetKind(kindParam)) {
        res.status(400).json(errorBody(`Invalid kind "${kindParam}"`));
        return;
      }
      for (const id of coordinator.sweepExpired()) {
        audit('widget.expired', { detail: { widgetId: id } });
      }
      let widgets = store.list(sessionId, statusParam as WidgetStatus | undefined);
      if (kindParam) widgets = widgets.filter((w) => w.kind === kindParam);
      res.json({ ok: true, widgets: widgets.map(serializeWidget) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list widgets', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/widgets/:id/answer', (req, res) => {
    const body = (req.body ?? {}) as { value?: unknown };
    try {
      const record = coordinator.settle(req.params.id, { answered: true, value: body.value });
      audit('widget.answered', {
        sessionId: record.sessionId,
        decision: 'answered',
        detail: { widgetId: record.id, botId: record.botId, kind: record.kind, interactive: record.interactive },
      });
      res.json({ ok: true, widget: serializeWidget(record) });
    } catch (err) {
      if (err instanceof WidgetNotFoundError) {
        res.status(404).json(errorBody(err.message));
        return;
      }
      if (err instanceof WidgetNotPendingError) {
        res.status(409).json(errorBody(err.message));
        return;
      }
      res.status(500).json(errorBody('Failed to answer widget', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}

/**
 * Backstop expiry sweep for index.ts's interval timer: expires stale
 * widgets, fails in-flight waiters closed, and audits each transition.
 * Mirrors the peer-approval sweep.
 */
export function sweepWidgets(
  coordinator: WidgetCoordinator,
  audit: (action: string, fields: { detail?: unknown }) => void,
): string[] {
  const expired = coordinator.sweepExpired();
  for (const id of expired) {
    try {
      audit('widget.expired', { detail: { widgetId: id } });
    } catch {
      // Audits must never break the sweep.
    }
  }
  return expired;
}
