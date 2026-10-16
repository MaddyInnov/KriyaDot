// SPDX-License-Identifier: Apache-2.0
// Chief of Staff — REST API (mounted at /api/teams).
//
//   GET  /chief                        → { chiefBotId, managedSections }
//   PUT  /chief        { botId|null }   → set/unset the chief (demotes old)
//   GET  /sections                     → { sections }
//   PUT  /sections     { sections[] }   → set managed sections (max 8, ≤60ch)
//   GET  /proposals?status=            → team-setup proposals
//   POST /proposals/:id/approve        → apply ops (create/update/delete)
//   POST /proposals/:id/reject {note?}
//   GET  /incidents?status=&kind=       → incidents + escalations inbox
//   POST /incidents/:id/resolve {note?}
//   POST /incidents/:id/retry           → re-run the failed delegation's
//                                        stored brief (retry_thread path)
//
// Approving a create op appends the new bot to the roster imports file
// (survives restarts); update ops on seed bots persist via
// bot_field_overrides; delete ops on seed bots persist via deleted_bot_ids.
// The one-chief-per-team rule is enforced on approve as well as at proposal
// time. Every route audit-logs.
//
// HOST WIRING (index.ts):
//   import { createChiefRouter, type ChiefRoutesDeps } from './chief-routes.js';
//   app.use('/api/teams', createChiefRouter({
//     dataDir: config.dataDir,
//     getBots: () => seed.bots,
//     store: chiefStore, // returned by registerChiefToolsWiring
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';
import { validateProposalOps } from '@mvp/agent-runtime';
import { ChiefTeamsStore } from './chief-teams.js';
import {
  appendRosterImport,
  isRosterImport,
  removeRosterImport,
  updateRosterImport,
} from './bot-roster-routes.js';
import type { ChiefProposal, ChiefProposalOp } from '@mvp/agent-runtime';

export interface ChiefRoutesDeps {
  dataDir: string;
  /** Live bot list (seed roster + imports). */
  getBots: () => BotConfig[];
  /** Chief state store (created by registerChiefToolsWiring). */
  store: ChiefTeamsStore;
  /** Retry hook from registerChiefToolsWiring (re-runs a stored brief). */
  retryDelegation: (
    threadId: string,
  ) => Promise<{ incidentId: string; attempts: number; text?: string; exhausted?: boolean } | undefined>;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: message, ...(detail !== undefined ? { detail } : {}) };
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function slugifyKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Chief tool names granted to (and revoked from) the chief's in-memory config. */
const CHIEF_ONLY_TOOLS = [
  'coordinate_bots',
  'propose_team_setup',
  'create_bot',
  'propose_bot_deletion',
  'raise_escalation',
  'retry_thread',
];

/** Bot fields a team-setup proposal may create or update. */
const MUTABLE_BOT_FIELDS = new Set([
  'name',
  'description',
  'systemPrompt',
  'provider',
  'model',
  'skills',
  'tools',
  'mcpServers',
  'persona',
  'sandboxMode',
  'notifications',
  'approvalMode',
  'workspace',
  'routeKeywords',
  'managedSections',
  'chiefOfStaff',
]);

function cleanString(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, maxLen) : undefined;
}

function cleanStringArray(v: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return undefined;
    const t = item.trim();
    if (!t) return undefined;
    out.push(t.slice(0, maxLen));
    if (out.length > maxItems) return undefined;
  }
  return out;
}

/**
 * Build a BotConfig from an approved create op. Returns the bot or error
 * strings. Defaults mirror the roster import validator (name/description/
 * systemPrompt required; provider/model/skills/tools/mcpServers defaulted).
 */
function buildBotFromOp(op: ChiefProposalOp): { bot?: BotConfig; errors: string[] } {
  const errors: string[] = [];
  if (op.action !== 'create') return { errors: ['not a create op'] };
  const id = slugifyKey(op.key ?? '');
  if (!id || !VALID_ID_RE.test(id)) errors.push('create op key must slugify to a valid bot id');
  const fields = (op.fields ?? {}) as Record<string, unknown>;
  const name = cleanString(fields.name, 120);
  const description = cleanString(fields.description, 1000) ?? '';
  const systemPrompt = cleanString(fields.systemPrompt, 8000) ?? '';
  if (!name || !systemPrompt) {
    if (!name) errors.push('create op fields.name is required');
    if (!systemPrompt) errors.push('create op fields.systemPrompt is required');
    return { errors };
  }

  const bot: BotConfig = {
    id,
    name,
    description,
    systemPrompt,
    provider: cleanString(fields.provider, 64) ?? 'groq',
    model: cleanString(fields.model, 128) ?? 'gpt-oss-120b',
    skills: cleanStringArray(fields.skills, 50, 64) ?? [],
    tools: cleanStringArray(fields.tools, 100, 64) ?? ['list_bots', 'ask_bot', 'message_bot'],
    mcpServers: cleanStringArray(fields.mcpServers, 50, 64) ?? [],
  };
  if (fields.chiefOfStaff === true) bot.chiefOfStaff = true;
  if (Array.isArray(fields.managedSections)) {
    const sections = cleanStringArray(fields.managedSections, 8, 60);
    if (sections) bot.managedSections = sections;
  }
  return { bot, errors: [] };
}

/**
 * Apply update-op fields to an in-memory bot (whitelisted fields only).
 * Returns error strings for values that fail basic shape checks.
 */
function applyUpdateFields(bot: BotConfig, fields: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!MUTABLE_BOT_FIELDS.has(key)) {
      errors.push(`field "${key}" cannot be changed by a team-setup proposal`);
      continue;
    }
    if (['name', 'description', 'systemPrompt', 'provider', 'model', 'workspace'].includes(key)) {
      const s = cleanString(value, key === 'systemPrompt' ? 8000 : 1000);
      if (s === undefined) {
        errors.push(`field "${key}" must be a non-empty string`);
        continue;
      }
      (bot as unknown as Record<string, unknown>)[key] = s;
    } else if (['skills', 'tools', 'mcpServers', 'routeKeywords', 'managedSections'].includes(key)) {
      const arr = cleanStringArray(value, 100, 64);
      if (arr === undefined) {
        errors.push(`field "${key}" must be an array of non-empty strings`);
        continue;
      }
      (bot as unknown as Record<string, unknown>)[key] = arr;
    } else if (key === 'chiefOfStaff') {
      if (typeof value !== 'boolean') {
        errors.push('field "chiefOfStaff" must be a boolean');
        continue;
      }
      bot.chiefOfStaff = value;
    } else {
      (bot as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return errors;
}

export function createChiefRouter(deps: ChiefRoutesDeps): Router {
  const router = express.Router();
  const store = deps.store;

  const botById = (id: string): BotConfig | undefined => deps.getBots().find((b) => b.id === id);

  /** Count chiefs after applying the proposal's ops to a copy of the flags. */
  function chiefCountAfter(proposal: ChiefProposal): number {
    const flags = new Map(deps.getBots().map((b) => [b.id, b.chiefOfStaff === true]));
    for (const op of proposal.operations) {
      if (op.action === 'create') {
        const id = slugifyKey(op.key ?? '');
        flags.set(id, (op.fields as Record<string, unknown> | undefined)?.chiefOfStaff === true);
      } else if (op.action === 'update' && op.botId) {
        const f = (op.fields ?? {}) as Record<string, unknown>;
        if (f.chiefOfStaff !== undefined) flags.set(op.botId, f.chiefOfStaff === true);
      } else if (op.action === 'delete' && op.botId) {
        flags.delete(op.botId);
      }
    }
    return [...flags.values()].filter(Boolean).length;
  }

  // ---- Chief assignment ----------------------------------------------------

  router.get('/chief', (_req, res) => {
    const config = store.getChiefConfig();
    deps.audit('chief.get', { actor: 'api', detail: config });
    res.json({ ok: true, chiefBotId: config.chiefBotId, managedSections: config.managedSections });
  });

  router.put('/chief', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown };
    let botId: string | null;
    if (body.botId === null) {
      botId = null;
    } else {
      const cleaned = cleanString(body.botId, 64);
      if (cleaned === undefined || !VALID_ID_RE.test(cleaned)) {
        res.status(400).json(errorBody('body.botId must be a valid bot id or null'));
        return;
      }
      botId = cleaned;
    }
    if (botId !== null && !botById(botId)) {
      res.status(404).json(errorBody(`unknown bot "${botId}"`));
      return;
    }

    const previous = store.getChiefConfig().chiefBotId;
    if (previous && previous !== botId) {
      const old = botById(previous);
      if (old) {
        old.chiefOfStaff = false;
        old.tools = old.tools.filter((t) => !CHIEF_ONLY_TOOLS.includes(t));
      }
      deps.audit('chief.removed', { actor: 'api', detail: { botId: previous } });
    }

    if (botId === null) {
      store.setChiefConfig(null, []);
      res.json({ ok: true, chiefBotId: null, managedSections: [] });
      return;
    }

    const sections = store.getChiefConfig().managedSections;
    store.setChiefConfig(botId, sections);
    const chief = botById(botId)!;
    chief.chiefOfStaff = true;
    chief.managedSections = sections;
    for (const name of [...CHIEF_ONLY_TOOLS, 'list_bots', 'ask_bot', 'message_bot']) {
      if (!chief.tools.includes(name)) chief.tools.push(name);
    }
    deps.audit('chief.assigned', { actor: 'api', detail: { botId, previous: previous ?? undefined } });
    res.json({ ok: true, chiefBotId: botId, managedSections: sections });
  });

  // ---- Managed sections ----------------------------------------------------

  router.get('/sections', (_req, res) => {
    const config = store.getChiefConfig();
    deps.audit('chief.sections.get', { actor: 'api', detail: config.managedSections });
    res.json({ ok: true, sections: config.managedSections });
  });

  router.put('/sections', (req, res) => {
    const body = (req.body ?? {}) as { sections?: unknown };
    const raw = body.sections;
    const valid =
      Array.isArray(raw) &&
      raw.length <= 8 &&
      raw.every((s) => typeof s === 'string' && s.trim() && s.trim().length <= 60);
    if (!valid) {
      res
        .status(400)
        .json(errorBody('body.sections must be an array of 0-8 non-empty strings (≤60 chars each)'));
      return;
    }
    const sections = (raw as string[]).map((s) => s.trim());
    const config = store.getChiefConfig();
    store.setChiefConfig(config.chiefBotId, sections);
    const chief = config.chiefBotId ? botById(config.chiefBotId) : undefined;
    if (chief) chief.managedSections = sections;
    deps.audit('chief.sections.set', { actor: 'api', detail: { sections } });
    res.json({ ok: true, sections });
  });

  // ---- Proposals -----------------------------------------------------------

  router.get('/proposals', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
      res.status(400).json(errorBody('query.status must be pending|approved|rejected'));
      return;
    }
    const proposals = store.listProposals(status as 'pending' | 'approved' | 'rejected' | undefined);
    deps.audit('chief.proposals.list', { actor: 'api', detail: { status, count: proposals.length } });
    res.json({ ok: true, proposals });
  });

  router.post('/proposals/:id/approve', async (req, res) => {
    const proposal = store.getProposal(req.params.id);
    if (!proposal) {
      res.status(404).json(errorBody(`unknown proposal "${req.params.id}"`));
      return;
    }
    if (proposal.status !== 'pending') {
      res.status(400).json(errorBody(`proposal is already ${proposal.status}`));
      return;
    }
    const opErrors = validateProposalOps(proposal.operations);
    if (opErrors.length > 0) {
      res.status(400).json(errorBody('Proposal operations are invalid', opErrors));
      return;
    }
    // One-chief rule, enforced on approve as well as at proposal time.
    if (chiefCountAfter(proposal) > 1) {
      res
        .status(400)
        .json(
          errorBody(
            'Approve rejected: this proposal would leave more than one chief of staff. Demote the current chief in the same proposal first.',
          ),
        );
      return;
    }

    const bots = deps.getBots();
    const applied: string[] = [];
    const errors: string[] = [];

    for (const op of proposal.operations) {
      if (op.action === 'create') {
        const { bot, errors: buildErrors } = buildBotFromOp(op);
        if (!bot) {
          errors.push(...buildErrors);
          continue;
        }
        if (bots.some((b) => b.id === bot.id)) {
          errors.push(`bot id "${bot.id}" already exists`);
          continue;
        }
        try {
          const { allocateBotWorkspace } = await import('./bot-workspace-alloc.js');
          allocateBotWorkspace(bot, deps.dataDir);
        } catch {
          // Workspace allocation is best-effort; the bot is still created.
        }
        appendRosterImport(bot, deps.dataDir);
        bots.push(bot);
        applied.push(`create ${bot.id}`);
      } else if (op.action === 'update') {
        const target = op.botId ? botById(op.botId) : undefined;
        if (!target) {
          errors.push(`unknown bot "${op.botId}"`);
          continue;
        }
        const fieldErrors = applyUpdateFields(target, (op.fields ?? {}) as Record<string, unknown>);
        if (fieldErrors.length > 0) {
          errors.push(...fieldErrors);
          continue;
        }
        const persistedFields = Object.fromEntries(
          Object.entries((op.fields ?? {}) as Record<string, unknown>).filter(([k]) => MUTABLE_BOT_FIELDS.has(k)),
        );
        if (isRosterImport(target.id, deps.dataDir)) {
          updateRosterImport(target, deps.dataDir);
        } else {
          store.setBotOverride(target.id, persistedFields);
        }
        applied.push(`update ${target.id}`);
      } else if (op.action === 'delete') {
        const target = op.botId ? botById(op.botId) : undefined;
        if (!target) {
          errors.push(`unknown bot "${op.botId}"`);
          continue;
        }
        if (target.chiefOfStaff === true) {
          errors.push(`cannot delete the chief of staff ("${target.id}") — remove the chief first`);
          continue;
        }
        // Defensive: if the configured chief flag drifted out of sync, the
        // store config must not dangle on a deleted bot.
        if (store.getChiefConfig().chiefBotId === target.id) {
          store.setChiefConfig(null, []);
        }
        const idx = bots.findIndex((b) => b.id === target.id);
        if (idx !== -1) bots.splice(idx, 1);
        if (!removeRosterImport(target.id, deps.dataDir)) {
          // Seed bot (or otherwise not from imports): record the deletion.
          store.addDeletedBotId(target.id);
        }
        applied.push(`delete ${target.id}`);
      }
    }

    if (errors.length > 0) {
      res.status(400).json(errorBody('Some operations could not be applied; nothing was approved', errors));
      return;
    }

    // Reconcile chief state: the proposal may have promoted or demoted the
    // chief. The tool gate reads the store config, so keep it in sync.
    const chiefs = bots.filter((b) => b.chiefOfStaff === true);
    if (chiefs.length === 1) {
      const newChief = chiefs[0];
      const prev = store.getChiefConfig().chiefBotId;
      if (prev !== newChief.id) {
        if (prev) {
          const old = botById(prev);
          if (old) old.tools = old.tools.filter((t) => !CHIEF_ONLY_TOOLS.includes(t));
        }
        store.setChiefConfig(newChief.id, store.getChiefConfig().managedSections);
        for (const name of [...CHIEF_ONLY_TOOLS, 'list_bots', 'ask_bot', 'message_bot']) {
          if (!newChief.tools.includes(name)) newChief.tools.push(name);
        }
      }
    } else if (chiefs.length === 0 && store.getChiefConfig().chiefBotId) {
      store.setChiefConfig(null, []);
    }

    const decided = store.decideProposal(proposal.id, 'approved');
    deps.audit('chief.proposal.approved', {
      actor: 'api',
      detail: { id: proposal.id, kind: proposal.kind, applied },
    });
    res.json({ ok: true, proposal: decided, applied });
  });

  router.post('/proposals/:id/reject', (req, res) => {
    const proposal = store.getProposal(req.params.id);
    if (!proposal) {
      res.status(404).json(errorBody(`unknown proposal "${req.params.id}"`));
      return;
    }
    if (proposal.status !== 'pending') {
      res.status(400).json(errorBody(`proposal is already ${proposal.status}`));
      return;
    }
    const body = (req.body ?? {}) as { note?: unknown };
    const decided = store.decideProposal(proposal.id, 'rejected');
    deps.audit('chief.proposal.rejected', {
      actor: 'api',
      detail: { id: proposal.id, note: cleanString(body.note, 500) },
    });
    res.json({ ok: true, proposal: decided });
  });

  // ---- Incidents -----------------------------------------------------------

  router.get('/incidents', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (status !== undefined && !['open', 'triaged', 'resolved'].includes(status)) {
      res.status(400).json(errorBody('query.status must be open|triaged|resolved'));
      return;
    }
    if (kind !== undefined && !['incident', 'escalation'].includes(kind)) {
      res.status(400).json(errorBody('query.kind must be incident|escalation'));
      return;
    }
    const incidents = store.listIncidents({
      status: status as 'open' | 'triaged' | 'resolved' | undefined,
      kind: kind as 'incident' | 'escalation' | undefined,
    });
    deps.audit('chief.incidents.list', {
      actor: 'api',
      detail: { status, kind, count: incidents.length },
    });
    res.json({ ok: true, incidents });
  });

  router.post('/incidents/:id/resolve', (req, res) => {
    const incident = store.getIncident(req.params.id);
    if (!incident) {
      res.status(404).json(errorBody(`unknown incident "${req.params.id}"`));
      return;
    }
    const body = (req.body ?? {}) as { note?: unknown };
    const resolved = store.resolveIncident(incident.id);
    deps.audit('chief.incident.resolved', {
      actor: 'api',
      detail: { id: incident.id, note: cleanString(body.note, 500) },
    });
    res.json({ ok: true, incident: resolved });
  });

  /**
   * Retry a failed delegation: re-runs the incident's stored brief as a
   * new attempt linked to the original thread id (the retry_thread tool
   * path). Awaits the attempt and returns the updated incident.
   */
  router.post('/incidents/:id/retry', async (req, res) => {
    const incident = store.getIncident(req.params.id);
    if (!incident) {
      res.status(404).json(errorBody(`unknown incident "${req.params.id}"`));
      return;
    }
    if (!incident.threadId) {
      res.status(400).json(errorBody('this incident has no thread id to retry'));
      return;
    }
    const result = await deps.retryDelegation(incident.threadId);
    if (!result) {
      res.status(404).json(errorBody(`no retryable delegation for thread "${incident.threadId}"`));
      return;
    }
    deps.audit('chief.incident.retry', {
      actor: 'api',
      detail: { id: incident.id, attempts: result.attempts, exhausted: result.exhausted ?? false },
    });
    res.json({ ok: true, ...result, incident: store.getIncident(incident.id) });
  });

  return router;
}
