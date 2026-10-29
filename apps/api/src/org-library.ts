// SPDX-License-Identifier: Apache-2.0
// Organization library: org-scoped shared entries (bot templates, teams,
// skills) with CRUD + install. Stored in <dataDir>/org-library.json, always
// filtered by org id — entries from org A are never visible to org B.
// Audience (org|groups|private + allowedGroupIds) follows the tenancy model.
//
// HOST WIRING (index.ts):
//   import { createOrgLibraryRouter } from './org-library.js';
//   app.use('/api/org-library', createOrgLibraryRouter({
//     dataDir: config.dataDir, getBots: () => seed.bots,
//     audit: (a, f) => governance.audit(a, f),
//     // importTeamManifest?: (payload) => ({ teamId }) — hook for team kind
//   }));
//
// Install semantics:
//   - bot-template → creates a bot from the payload (roster imports file)
//   - skill        → returns the payload for the skill-store insert hook
//                    (deps.installSkill) or, without a hook, returns the
//                    payload with a note (stored, not silently dropped)
//   - team         → deps.importTeamManifest hook when provided, else the
//                    payload is returned with a note.

import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';
import { appendRosterImport } from './bot-roster-routes.js';

export type OrgLibraryKind = 'bot-template' | 'team' | 'skill';

export interface OrgLibraryEntry {
  id: string;
  orgId: string;
  kind: OrgLibraryKind;
  name: string;
  payload: unknown;
  author: string;
  visibility: 'org' | 'groups' | 'private';
  allowedGroupIds: string[];
  createdAt: number;
  updatedAt: number;
}

export class OrgLibraryStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'org-library.json');
  }

  private read(): OrgLibraryEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as OrgLibraryEntry[]) : [];
    } catch {
      return [];
    }
  }

  private write(rows: OrgLibraryEntry[]): void {
    fs.mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  create(input: Omit<OrgLibraryEntry, 'id' | 'createdAt' | 'updatedAt'>): OrgLibraryEntry {
    const rows = this.read();
    const now = Date.now();
    const entry: OrgLibraryEntry = { ...input, id: `lib_${randomUUID().replace(/-/g, '').slice(0, 16)}`, createdAt: now, updatedAt: now };
    rows.push(entry);
    this.write(rows);
    return entry;
  }

  get(orgId: string, id: string): OrgLibraryEntry | undefined {
    return this.read().find((r) => r.id === id && r.orgId === orgId);
  }

  list(orgId: string): OrgLibraryEntry[] {
    return this.read().filter((r) => r.orgId === orgId);
  }

  update(orgId: string, id: string, patch: Partial<Pick<OrgLibraryEntry, 'name' | 'payload' | 'visibility' | 'allowedGroupIds'>>): OrgLibraryEntry | undefined {
    const rows = this.read();
    const entry = rows.find((r) => r.id === id && r.orgId === orgId);
    if (!entry) return undefined;
    Object.assign(entry, patch, { updatedAt: Date.now() });
    this.write(rows);
    return entry;
  }

  remove(orgId: string, id: string): boolean {
    const rows = this.read();
    const next = rows.filter((r) => !(r.id === id && r.orgId === orgId));
    if (next.length === rows.length) return false;
    this.write(next);
    return true;
  }
}

export function canViewEntry(entry: OrgLibraryEntry, viewer: { userId: string; groupIds: string[] }): boolean {
  if (entry.author === viewer.userId) return true;
  if (entry.visibility === 'org') return true;
  if (entry.visibility === 'private') return false;
  return viewer.groupIds.some((g) => entry.allowedGroupIds.includes(g));
}

export interface OrgLibraryDeps {
  dataDir: string;
  getBots: () => BotConfig[];
  /** Optional team-manifest import hook (returns created team id). */
  importTeamManifest?: (payload: unknown, orgId: string) => { teamId: string } | Promise<{ teamId: string }>;
  /** Optional skill-store insert hook. */
  installSkill?: (payload: unknown, orgId: string) => { skillId: string } | Promise<{ skillId: string }>;
  /** Group membership resolver for 'groups' visibility (default: none). */
  groupsForUser?: (orgId: string, userId: string) => string[];
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function callerOf(req: express.Request): string {
  const h = req.header('x-user-id');
  return typeof h === 'string' && h ? h : 'default-user';
}

function err(res: express.Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

const KINDS: OrgLibraryKind[] = ['bot-template', 'team', 'skill'];

export function createOrgLibraryRouter(deps: OrgLibraryDeps): Router {
  const router = express.Router();
  const store = new OrgLibraryStore(deps.dataDir);

  function orgOf(req: express.Request): string {
    return req.header('x-org-id') || (typeof req.query.orgId === 'string' ? req.query.orgId : '') || 'default-org';
  }
  function viewerOf(req: express.Request, orgId: string) {
    const userId = callerOf(req);
    return { userId, groupIds: deps.groupsForUser?.(orgId, userId) ?? [] };
  }

  router.post('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orgId = typeof body.orgId === 'string' && body.orgId ? body.orgId : orgOf(req);
    if (!KINDS.includes(body.kind as OrgLibraryKind)) return err(res, 400, 'kind must be bot-template|team|skill');
    if (typeof body.name !== 'string' || !body.name.trim()) return err(res, 400, 'name is required');
    if (body.payload === undefined) return err(res, 400, 'payload is required');
    const entry = store.create({
      orgId,
      kind: body.kind as OrgLibraryKind,
      name: body.name.trim().slice(0, 120),
      payload: body.payload,
      author: callerOf(req),
      visibility: ['org', 'groups', 'private'].includes(String(body.visibility)) ? (body.visibility as OrgLibraryEntry['visibility']) : 'org',
      allowedGroupIds: Array.isArray(body.allowedGroupIds) ? (body.allowedGroupIds as string[]) : [],
    });
    deps.audit?.('org_library.created', { actor: entry.author, detail: { orgId, entryId: entry.id, kind: entry.kind } });
    res.status(201).json({ ok: true, entry });
  });

  router.get('/', (req, res) => {
    const orgId = orgOf(req);
    const v = viewerOf(req, orgId);
    res.json({ ok: true, entries: store.list(orgId).filter((e) => canViewEntry(e, v)) });
  });

  router.get('/:id', (req, res) => {
    const orgId = orgOf(req);
    const entry = store.get(orgId, req.params.id);
    if (!entry) return err(res, 404, 'unknown library entry');
    if (!canViewEntry(entry, viewerOf(req, orgId))) return err(res, 403, 'entry is not visible to you');
    res.json({ ok: true, entry });
  });

  router.put('/:id', (req, res) => {
    const orgId = orgOf(req);
    const entry = store.get(orgId, req.params.id);
    if (!entry) return err(res, 404, 'unknown library entry');
    if (entry.author !== callerOf(req)) return err(res, 403, 'only the author can edit this entry');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = store.update(orgId, entry.id, {
      ...(typeof body.name === 'string' ? { name: body.name.trim().slice(0, 120) } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(['org', 'groups', 'private'].includes(String(body.visibility)) ? { visibility: body.visibility as OrgLibraryEntry['visibility'] } : {}),
      ...(Array.isArray(body.allowedGroupIds) ? { allowedGroupIds: body.allowedGroupIds as string[] } : {}),
    });
    res.json({ ok: true, entry: updated });
  });

  router.delete('/:id', (req, res) => {
    const orgId = orgOf(req);
    const entry = store.get(orgId, req.params.id);
    if (!entry) return err(res, 404, 'unknown library entry');
    if (entry.author !== callerOf(req)) return err(res, 403, 'only the author can delete this entry');
    store.remove(orgId, entry.id);
    res.json({ ok: true });
  });

  router.post('/:id/install', async (req, res) => {
    const orgId = orgOf(req);
    const entry = store.get(orgId, req.params.id);
    if (!entry) return err(res, 404, 'unknown library entry');
    if (!canViewEntry(entry, viewerOf(req, orgId))) return err(res, 403, 'entry is not visible to you');
    try {
      if (entry.kind === 'bot-template') {
        const payload = entry.payload as BotConfig;
        if (typeof payload !== 'object' || payload === null || typeof payload.id !== 'string') {
          return err(res, 400, 'bot-template payload must be a bot config object');
        }
        const bots = deps.getBots();
        let id = payload.id;
        if (bots.some((b) => b.id === id)) {
          let n = 2;
          while (bots.some((b) => b.id === `${payload.id}-lib-${n}`)) n += 1;
          id = `${payload.id}-lib-${n}`;
        }
        const bot: BotConfig = { ...(JSON.parse(JSON.stringify(payload)) as BotConfig), id };
        bots.push(bot);
        appendRosterImport(bot, deps.dataDir);
        deps.audit?.('org_library.installed', { actor: callerOf(req), detail: { orgId, entryId: entry.id, kind: entry.kind, botId: id } });
        res.status(201).json({ ok: true, installed: { kind: entry.kind, bot } });
        return;
      }
      if (entry.kind === 'skill') {
        if (deps.installSkill) {
          const out = await deps.installSkill(entry.payload, orgId);
          res.status(201).json({ ok: true, installed: { kind: entry.kind, skillId: out.skillId } });
        } else {
          res.status(201).json({ ok: true, installed: { kind: entry.kind, payload: entry.payload }, note: 'no skill-store hook wired; payload returned for manual import' });
        }
        return;
      }
      // team
      if (deps.importTeamManifest) {
        const out = await deps.importTeamManifest(entry.payload, orgId);
        res.status(201).json({ ok: true, installed: { kind: entry.kind, teamId: out.teamId } });
      } else {
        res.status(201).json({ ok: true, installed: { kind: entry.kind, payload: entry.payload }, note: 'no team-import hook wired; payload returned for manual import' });
      }
    } catch (e) {
      err(res, 400, e instanceof Error ? e.message : 'install failed');
    }
  });

  return router;
}
