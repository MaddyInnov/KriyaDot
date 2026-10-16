// SPDX-License-Identifier: Apache-2.0
// User skill lifecycle routes (OpenMausBot parity P1 #20): authoring,
// learning proposals, review queue, enable/disable, scoping, and per-bot
// attachment.
//
//   GET    /skills                    list user skills (+ seed skill names)
//   GET    /skills/review/queue       draft proposals + disabled skills
//   GET    /skills/:name              skill detail
//   POST   /skills                    create (manual authoring) → disabled
//   PATCH  /skills/:name              update description/content/scope/version
//   POST   /skills/:name/enable       disabled → active
//   POST   /skills/:name/disable      active → disabled
//   DELETE /skills/:name              delete (must be disabled first)
//   POST   /skills/proposals/:name/approve   human approves draft → disabled skill
//   POST   /skills/proposals/:name/confirm   check linked approval card → materialize/reject
//   POST   /skills/proposals/:name/discard   reject draft
//   POST   /skills/:name/attach       { botId } → add to bot's skill list
//   DELETE /skills/:name/attach/:botId → remove from bot's skill list
//
// HOST WIRING (index.ts):
//   import { createSkillStoreRouter } from './skill-store-routes.js';
//   app.use('/api/skills', createSkillStoreRouter({
//     store: userSkillStore, // from buildToolRegistry()
//     audit: (action, fields) => governance.audit(action, fields),
//     getApprovalStatus: (id) => governance.getApproval(id)?.status,
//     decideApproval: (id, d) => governance.decide(id, d),
//     getBot: (id) => botsById.get(id),
//     getBotSkills: (id) => getBotSkills(seed.bots, id),
//     setBotSkills: (id, skills) => setBotSkills(config.dataDir, seed.bots, id, skills),
//     seedSkillNames: () => seedSkillLoader.list(),
//   }));

import express, { type Router } from 'express';
import {
  SkillExistsError,
  SkillNameError,
  SkillNotFoundError,
  SkillStateError,
  parseSkillScope,
  serializeUserSkill,
} from '@mvp/agent-runtime';
import type { BotConfig, UserSkillRecord, UserSkillStatus } from '@mvp/agent-runtime';

interface ApiError {
  error: string;
  detail?: string;
}

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

export interface SkillStoreRouterDeps {
  store: import('@mvp/agent-runtime').UserSkillStore;
  audit: (
    action: string,
    fields: { actor?: string; botId?: string; sessionId?: string; decision?: string; detail?: unknown },
  ) => void;
  getApprovalStatus: (approvalId: string) => 'pending' | 'approved' | 'denied' | 'expired' | undefined;
  decideApproval?: (approvalId: string, decision: 'approved' | 'denied') => void;
  getBot: (botId: string) => BotConfig | undefined;
  getBotSkills: (botId: string) => string[];
  setBotSkills: (botId: string, skills: string[]) => string[];
  seedSkillNames: () => string[];
}

const VALID_STATUSES = new Set(['draft', 'active', 'disabled', 'rejected']);

function actorOf(req: { body?: unknown }): string {
  const body = (req.body ?? {}) as { actor?: unknown };
  return typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 64) : 'user';
}

function serialize(rec: UserSkillRecord): Record<string, unknown> {
  return serializeUserSkill(rec, { includeDraft: rec.status === 'draft' });
}

function mapStoreError(err: unknown, res: express.Response, action: string): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SkillNotFoundError) {
    res.status(404).json(errorBody(message));
    return;
  }
  if (err instanceof SkillExistsError) {
    res.status(409).json(errorBody(message));
    return;
  }
  if (err instanceof SkillNameError || err instanceof SkillStateError) {
    res.status(400).json(errorBody(message));
    return;
  }
  res.status(500).json(errorBody(`Failed to ${action}`, message));
}

export function createSkillStoreRouter(deps: SkillStoreRouterDeps): Router {
  const router = express.Router();
  const { store, audit } = deps;

  // ---- List ---------------------------------------------------------------
  router.get('/', (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      let status: UserSkillStatus | UserSkillStatus[] | undefined;
      if (statusParam) {
        const parts = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.some((p) => !VALID_STATUSES.has(p))) {
          res.status(400).json(errorBody(`Invalid status "${statusParam}" — expected draft|active|disabled|rejected`));
          return;
        }
        status = (parts.length === 1 ? parts[0] : parts) as UserSkillStatus | UserSkillStatus[];
      }
      const skills = store.list(status ? { status } : {});
      let seedSkills: string[] = [];
      try {
        seedSkills = deps.seedSkillNames();
      } catch {
        seedSkills = [];
      }
      res.json({ ok: true, skills: skills.map((s) => serialize(s)), seedSkills });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list skills', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Review queue (drafts + disabled), with approval-card reconciliation
  router.get('/review/queue', (req, res) => {
    try {
      const reconciled = store.reconcileDrafts(deps.getApprovalStatus, 'system');
      for (const name of reconciled.materialized) {
        audit('skill.proposal_approved', { decision: 'approved', detail: { name, via: 'approval-card' } });
      }
      for (const name of reconciled.rejected) {
        audit('skill.proposal_rejected', { decision: 'denied', detail: { name, via: 'approval-card' } });
      }
      const queue = store.reviewQueue();
      res.json({
        ok: true,
        proposals: queue.proposals.map((s) => serialize(s)),
        disabled: queue.disabled.map((s) => serialize(s)),
        reconciled,
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load review queue', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Detail ---------------------------------------------------------------
  router.get('/:name', (req, res) => {
    try {
      const rec = store.get(req.params.name);
      if (!rec) {
        res.status(404).json(errorBody(`Unknown skill: "${req.params.name}"`));
        return;
      }
      let content: string | undefined;
      if (rec.status !== 'draft') {
        try {
          content = store.readSkillFileContent(rec.name).instructions;
        } catch {
          content = undefined;
        }
      }
      res.json({ ok: true, skill: { ...serialize(rec), ...(content ? { content } : {}) } });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load skill', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Create (manual authoring) --------------------------------------------
  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const rec = store.createSkill({
        name: body['name'] as string,
        description: body['description'] as string,
        instructions: body['instructions'] as string,
        examples: body['examples'] as string | undefined,
        version: body['version'] as string | undefined,
        scope: body['scope'] === undefined ? undefined : parseSkillScope(body['scope']),
        source: 'manual',
        createdByBot: undefined,
      });
      audit('skill.created', { actor: actorOf(req), detail: { name: rec.name, source: 'manual' } });
      res.status(201).json({
        ok: true,
        skill: serialize(rec),
        message: `Skill "${rec.name}" created DISABLED — enable it before any bot can use it.`,
      });
    } catch (err) {
      mapStoreError(err, res, 'create skill');
    }
  });

  // ---- Update -----------------------------------------------------------------
  router.patch('/:name', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const patch: {
        description?: string;
        instructions?: string;
        examples?: string;
        version?: string;
        scope?: import('@mvp/agent-runtime').SkillScope;
      } = {};
      if (body['description'] !== undefined) patch.description = body['description'] as string;
      if (body['instructions'] !== undefined) patch.instructions = body['instructions'] as string;
      if (body['examples'] !== undefined) patch.examples = body['examples'] as string;
      if (body['version'] !== undefined) patch.version = body['version'] as string;
      if (body['scope'] !== undefined) patch.scope = parseSkillScope(body['scope']);
      const rec = store.updateSkill(req.params.name, patch);
      audit('skill.updated', { actor: actorOf(req), detail: { name: rec.name, fields: Object.keys(patch) } });
      res.json({ ok: true, skill: serialize(rec) });
    } catch (err) {
      mapStoreError(err, res, 'update skill');
    }
  });

  // ---- Enable / disable ---------------------------------------------------------
  router.post('/:name/enable', (req, res) => {
    try {
      const rec = store.enable(req.params.name, actorOf(req));
      audit('skill.enabled', { actor: actorOf(req), decision: 'enabled', detail: { name: rec.name } });
      res.json({ ok: true, skill: serialize(rec) });
    } catch (err) {
      mapStoreError(err, res, 'enable skill');
    }
  });

  router.post('/:name/disable', (req, res) => {
    try {
      const rec = store.disable(req.params.name, actorOf(req));
      audit('skill.disabled', { actor: actorOf(req), decision: 'disabled', detail: { name: rec.name } });
      res.json({ ok: true, skill: serialize(rec) });
    } catch (err) {
      mapStoreError(err, res, 'disable skill');
    }
  });

  // ---- Delete ---------------------------------------------------------------------
  router.delete('/:name', (req, res) => {
    try {
      store.deleteSkill(req.params.name, actorOf(req));
      audit('skill.deleted', { actor: actorOf(req), detail: { name: req.params.name } });
      res.json({ ok: true, deleted: req.params.name });
    } catch (err) {
      mapStoreError(err, res, 'delete skill');
    }
  });

  // ---- Proposals --------------------------------------------------------------------
  // NOTE: /proposals/* routes are registered before /:name so "proposals"
  // is not captured as a skill name.
  router.post('/proposals/:name/approve', (req, res) => {
    try {
      const actor = actorOf(req);
      const before = store.get(req.params.name);
      const rec = store.materializeProposal(req.params.name, actor);
      // Resolve the linked approval card so the inbox doesn't dangle.
      if (before?.approvalId && deps.decideApproval) {
        try {
          deps.decideApproval(before.approvalId, 'approved');
        } catch {
          // Card may already be decided; not fatal.
        }
      }
      audit('skill.proposal_approved', { actor, decision: 'approved', detail: { name: rec.name, via: 'review-queue' } });
      res.json({
        ok: true,
        skill: serialize(rec),
        message: `Proposal approved and saved as DISABLED skill "${rec.name}". Enable it before any bot can use it.`,
      });
    } catch (err) {
      mapStoreError(err, res, 'approve proposal');
    }
  });

  router.post('/proposals/:name/confirm', (req, res) => {
    try {
      const rec = store.get(req.params.name);
      if (!rec) {
        res.status(404).json(errorBody(`Unknown skill: "${req.params.name}"`));
        return;
      }
      if (rec.status !== 'draft') {
        res.status(409).json(errorBody(`Proposal "${req.params.name}" is ${rec.status}, not a draft.`));
        return;
      }
      if (!rec.approvalId) {
        res.status(409).json(errorBody(`Proposal "${req.params.name}" has no linked approval card. Approve it directly instead.`));
        return;
      }
      const status = deps.getApprovalStatus(rec.approvalId);
      if (status === 'approved') {
        const done = store.materializeProposal(rec.name, actorOf(req));
        res.json({ ok: true, skill: serialize(done) });
        return;
      }
      if (status === 'denied' || status === 'expired') {
        const done = store.rejectProposal(rec.name, actorOf(req));
        res.status(403).json(errorBody(`Proposal "${rec.name}" was ${status} on its approval card.`, JSON.stringify(serialize(done))));
        return;
      }
      res.status(409).json(errorBody(`Approval card is still ${status ?? 'pending'} — approve it in the inbox first.`));
    } catch (err) {
      mapStoreError(err, res, 'confirm proposal');
    }
  });

  router.post('/proposals/:name/discard', (req, res) => {
    try {
      const actor = actorOf(req);
      const before = store.get(req.params.name);
      const rec = store.rejectProposal(req.params.name, actor);
      if (before?.approvalId && deps.decideApproval) {
        try {
          deps.decideApproval(before.approvalId, 'denied');
        } catch {
          // ignore
        }
      }
      audit('skill.proposal_rejected', { actor, decision: 'denied', detail: { name: rec.name, via: 'review-queue' } });
      res.json({ ok: true, skill: serialize(rec) });
    } catch (err) {
      mapStoreError(err, res, 'discard proposal');
    }
  });

  // ---- Per-bot attach / detach ----------------------------------------------------------
  router.post('/:name/attach', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown };
    try {
      const rec = store.get(req.params.name);
      if (!rec) {
        res.status(404).json(errorBody(`Unknown skill: "${req.params.name}"`));
        return;
      }
      if (rec.status === 'draft' || rec.status === 'rejected') {
        res.status(400).json(errorBody(`Cannot attach a ${rec.status} proposal — approve it first.`));
        return;
      }
      const botId = typeof body.botId === 'string' ? body.botId : '';
      const bot = deps.getBot(botId);
      if (!bot) {
        res.status(404).json(errorBody(`Unknown bot: "${botId}"`));
        return;
      }
      const current = deps.getBotSkills(botId);
      const next = current.includes(rec.name) ? current : [...current, rec.name];
      deps.setBotSkills(botId, next);
      audit('skill.attached', { actor: actorOf(req), botId, detail: { skill: rec.name } });
      res.json({ ok: true, botId, skills: next });
    } catch (err) {
      mapStoreError(err, res, 'attach skill');
    }
  });

  router.delete('/:name/attach/:botId', (req, res) => {
    try {
      const bot = deps.getBot(req.params.botId);
      if (!bot) {
        res.status(404).json(errorBody(`Unknown bot: "${req.params.botId}"`));
        return;
      }
      const next = deps.getBotSkills(req.params.botId).filter((s) => s !== req.params.name);
      deps.setBotSkills(req.params.botId, next);
      audit('skill.detached', { actor: actorOf(req), botId: req.params.botId, detail: { skill: req.params.name } });
      res.json({ ok: true, botId: req.params.botId, skills: next });
    } catch (err) {
      mapStoreError(err, res, 'detach skill');
    }
  });

  return router;
}
