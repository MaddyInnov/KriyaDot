// SPDX-License-Identifier: Apache-2.0
// CA-34: Folder-session surface — "Open folder as agent workspace".
//
// A folder session bundles, as ONE shareable unit on the existing
// marketplace bundle shape (SkillBundle-compatible):
//   a bot + a workspace folder + routines + an execution placement.
// Export produces a plain JSON unit (the marketplace bundle format with
// a `folderSession` extension payload); import validates it, refuses
// path traversal / absolute paths outside an injected allowed root, and
// returns the materialization plan the host executes (bot install,
// workspace registration, routine creation — all through existing
// stores, wired in index.ts per the Wave-6 wiring note).

import { Router } from 'express';
import type { Request, Response } from 'express';
import { isAbsolute, resolve, sep } from 'node:path';

export interface FolderSessionRoutine {
  id: string;
  name: string;
  promptTemplate: string;
  enabled: boolean;
}

export interface FolderSession {
  kind: 'folder-session';
  version: 1;
  id: string;
  name: string;
  description: string;
  /** Workspace folder, relative to the share root (never absolute). */
  folder: string;
  bot: { id: string; name: string; systemPrompt: string; tools: string[]; skills: string[] };
  routines: FolderSessionRoutine[];
  /** Execution placement, matching the front-door placement vocabulary. */
  placement: 'local' | 'cloud-report' | 'cloud-only';
  entryIds: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export function validateFolderSession(raw: unknown): FolderSession {
  if (typeof raw !== 'object' || raw === null) throw new Error('folder session must be an object');
  const s = raw as Record<string, any>;
  if (s.kind !== 'folder-session' || s.version !== 1) throw new Error('folder session needs kind "folder-session" and version 1');
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) throw new Error('folder session id is invalid');
  if (typeof s.name !== 'string' || !s.name.trim()) throw new Error('folder session needs a name');
  if (typeof s.folder !== 'string' || !s.folder || isAbsolute(s.folder) || s.folder.split(/[\\/]/).some((x: string) => x === '..')) {
    throw new Error('folder session folder must be a safe relative path');
  }
  if (!s.bot || typeof s.bot.id !== 'string' || !ID_RE.test(s.bot.id) || typeof s.bot.systemPrompt !== 'string') {
    throw new Error('folder session needs a bot { id, systemPrompt }');
  }
  if (!Array.isArray(s.routines)) throw new Error('folder session routines must be an array');
  for (const r of s.routines) {
    if (!r || typeof r.id !== 'string' || typeof r.promptTemplate !== 'string') throw new Error('folder session routines need { id, promptTemplate }');
  }
  if (!['local', 'cloud-report', 'cloud-only'].includes(s.placement)) throw new Error('folder session placement must be local | cloud-report | cloud-only');
  return {
    kind: 'folder-session', version: 1, id: s.id, name: s.name,
    description: typeof s.description === 'string' ? s.description : '',
    folder: s.folder,
    bot: {
      id: s.bot.id, name: typeof s.bot.name === 'string' ? s.bot.name : s.bot.id,
      systemPrompt: s.bot.systemPrompt,
      tools: Array.isArray(s.bot.tools) ? s.bot.tools.filter((t: unknown) => typeof t === 'string') : [],
      skills: Array.isArray(s.bot.skills) ? s.bot.skills.filter((t: unknown) => typeof t === 'string') : [],
    },
    routines: s.routines.map((r: any) => ({ id: r.id, name: typeof r.name === 'string' ? r.name : r.id, promptTemplate: r.promptTemplate, enabled: r.enabled !== false })),
    placement: s.placement,
    entryIds: Array.isArray(s.entryIds) ? s.entryIds.filter((t: unknown) => typeof t === 'string') : [],
  };
}

/** Build a shareable folder-session unit from live parts. */
export function exportFolderSession(input: Omit<FolderSession, 'kind' | 'version'>): FolderSession {
  return validateFolderSession({ ...input, kind: 'folder-session', version: 1 });
}

/** Convert to the existing marketplace bundle shape for listing/sharing. */
export function folderSessionToBundle(s: FolderSession): { id: string; name: string; description: string; entryIds: string[]; folderSession: FolderSession } {
  return { id: s.id, name: s.name, description: s.description, entryIds: s.entryIds, folderSession: s };
}

export interface FolderSessionPlan {
  workspacePath: string;
  botId: string;
  routineIds: string[];
  placement: FolderSession['placement'];
}

/** Resolve an import into a materialization plan, confined to `allowedRoot`. */
export function planFolderSessionImport(s: FolderSession, allowedRoot: string): FolderSessionPlan {
  const root = resolve(allowedRoot);
  const ws = resolve(root, s.folder);
  if (ws !== root && !ws.startsWith(root + sep)) throw new Error('folder session folder escapes the allowed root');
  return { workspacePath: ws, botId: s.bot.id, routineIds: s.routines.map((r) => r.id), placement: s.placement };
}

export interface FolderSessionDeps {
  allowedRoot: string;
  /** Host materializes the plan (bot/workspace/routine stores). Optional for export/validate-only mounts. */
  materialize?: (session: FolderSession, plan: FolderSessionPlan) => Promise<{ ok: true }> | { ok: true };
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

/** Register-style routes. Mount under /api/folder-sessions (wiring note). */
export function registerFolderSessionRoutes(router: Router, deps: FolderSessionDeps): void {
  router.post('/validate', (req: Request, res: Response) => {
    try {
      const s = validateFolderSession(req.body);
      res.status(200).json({ ok: true, session: s, bundle: folderSessionToBundle(s) });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'invalid folder session' }); }
  });
  router.post('/import', async (req: Request, res: Response) => {
    try {
      const s = validateFolderSession(req.body);
      const plan = planFolderSessionImport(s, deps.allowedRoot);
      if (deps.materialize) await deps.materialize(s, plan);
      deps.audit?.('folder-session.import', { id: s.id, botId: plan.botId, routines: plan.routineIds.length, placement: plan.placement });
      res.status(201).json({ ok: true, plan });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'folder session import failed' }); }
  });
}
