// SPDX-License-Identifier: Apache-2.0
// Representative assistant — HTTP routes (router factory; mount at /api).
//
//   GET  /people/:id/representative-policy   → { ok, policy }
//   PUT  /people/:id/representative-policy   → { enabled?, allowedFactTypes?,
//                                                allowedAskers?, requireOwnerNotify? }
//   GET  /people/:id/status                  → { ok, status | null }
//   PUT  /people/:id/status                  → { state, until?, note?, workingHours? }
//   GET  /people/:id/representative-audit    → { ok, audit }
//   POST /representative/ask                 → { personId, askerId, question }
//                                              → { ok, answer } (fenced or refusal)
//
// HOST WIRING (index.ts merge): build a RepresentativeService with the
// people store, a RepresentativeStore, the team inbox, the live
// TurnStateRegistry for bot activity, and a shared-notes provider backed
// by PageStore.listSharedWithTeam() filtered to pages whose createdBy is
// the person's id or name (pages record creators as free strings), then
//   app.use('/api', createRepresentativeRouter({ ... }))
// and register the answer_for_person Chief tool (tools/representative.ts)
// in the chief wiring with the same service.

import express, { type Router } from 'express';
import {
  TurnStateRegistry,
  botOwnerPersonId,
  type BotConfig,
  type PeopleStore,
  type RepresentativeService,
  type RepresentativeStore,
  type SharedNoteFact,
} from '@mvp/agent-runtime';
import type { PageStore } from './pages.js';

export interface RepresentativeRouteDeps {
  people: Pick<PeopleStore, 'getPerson'>;
  store: RepresentativeStore;
  service: RepresentativeService;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

export function createRepresentativeRouter(deps: RepresentativeRouteDeps): Router {
  const router = express.Router();
  const { people, store } = deps;

  router.get('/people/:id/representative-policy', (req, res) => {
    if (!people.getPerson(req.params.id)) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, policy: store.getPolicy(req.params.id) });
  });

  router.put('/people/:id/representative-policy', (req, res) => {
    if (!people.getPerson(req.params.id)) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    try {
      const policy = store.setPolicy(req.params.id, req.body ?? {});
      deps.audit('representative.policy_updated', {
        actor: 'user',
        detail: { personId: req.params.id, enabled: policy.enabled, allowedFactTypes: policy.allowedFactTypes },
      });
      res.json({ ok: true, policy });
    } catch (err) {
      res.status(400).json(errorBody('Failed to update representative policy', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/people/:id/status', (req, res) => {
    if (!people.getPerson(req.params.id)) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, status: store.getStatus(req.params.id) ?? null });
  });

  router.put('/people/:id/status', (req, res) => {
    if (!people.getPerson(req.params.id)) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    try {
      const body = (req.body ?? {}) as { state?: unknown; until?: unknown; note?: unknown; workingHours?: unknown };
      const status = store.setStatus(req.params.id, {
        state: body.state,
        until: body.until,
        note: body.note,
        workingHours: body.workingHours,
      });
      deps.audit('representative.status_updated', {
        actor: 'user',
        detail: { personId: req.params.id, state: status.state },
      });
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json(errorBody('Failed to update status', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/people/:id/representative-audit', (req, res) => {
    if (!people.getPerson(req.params.id)) {
      res.status(404).json(errorBody(`Unknown person "${req.params.id}"`));
      return;
    }
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    res.json({ ok: true, audit: store.listAudit(req.params.id, Number.isFinite(limit) ? limit : 50) });
  });

  router.post('/representative/ask', async (req, res) => {
    const body = (req.body ?? {}) as { personId?: unknown; askerId?: unknown; question?: unknown };
    if (typeof body.personId !== 'string' || typeof body.askerId !== 'string' || typeof body.question !== 'string') {
      res.status(400).json(errorBody('Body must be { personId, askerId, question }'));
      return;
    }
    const answer = await deps.service.answer({
      personId: body.personId,
      askerId: body.askerId,
      question: body.question,
    });
    res.json({ ok: true, answer });
  });

  return router;
}

/**
 * Production shared-notes provider for the representative service: pages
 * the person explicitly marked shared-with-team. Pages record `createdBy`
 * as a free string, so a page counts as the person's when createdBy is
 * their id or their exact name (documented, conservative matching).
 */
export function sharedNotesFromPages(
  pageStore: Pick<PageStore, 'listSharedWithTeam'>,
  person: { id: string; name: string },
): SharedNoteFact[] {
  const mine = new Set([person.id, person.name]);
  return pageStore
    .listSharedWithTeam()
    .filter((pg) => mine.has(pg.createdBy))
    .map((pg) => ({
      id: pg.id,
      title: pg.title,
      excerpt: pg.content.replace(/\s+/g, ' ').trim().slice(0, 400),
      updatedAt: pg.updatedAt,
    }));
}

/** Production bot-activity provider: live TurnStateRegistry entries. */
export function botActivityFromTurnState(
  registry: TurnStateRegistry,
  bots: Array<Pick<BotConfig, 'id' | 'name' | 'ownerId'>>,
  personId: string,
): Array<{ botId: string; botName: string; summary: string }> {
  const live = new Map(registry.list().map((s) => [s.botId, s]));
  return bots
    .filter((b) => botOwnerPersonId(b) === personId)
    .map((b) => {
      const s = live.get(b.id);
      return {
        botId: b.id,
        botName: b.name,
        summary: s ? `${s.step} (running for ${Math.round(s.elapsedMs / 1000)}s)` : 'Idle — no turn in flight.',
      };
    });
}
