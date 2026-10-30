// SPDX-License-Identifier: Apache-2.0
// Project entity (CA-31, coding-apps parity audit): a Project groups
// chat sessions under one shared context — knowledge-file references,
// per-project instructions, and a project-scoped memory flag.
//
// HOST WIRING (coordinator — see the wave-6 WIRING note):
//   app.use('/api/projects', createProjectsRouter({
//     dataDir: config.dataDir,
//     bindSession: (sessionId, projectId) =>
//       runtime.sessionStore.setSessionProject(sessionId, projectId),
//   }));
// The runtime session store carries the binding itself
// (SessionRecord.projectId, CA-31 in sessions.ts); bindSession keeps
// the two in sync when a session is bound through these routes. The
// store in this module (projects.db) owns the entity + the binding
// record, so the routes work even before the runtime hook is wired.
//
// Routes (router mounted at /api/projects):
//   GET    /                       list projects
//   POST   /                       create { name, description?, instructions?,
//                                  knowledgeRefs?, memoryScoped? } → 201
//   GET    /:id                    one project (404 unknown)
//   PATCH  /:id                    partial update
//   DELETE /:id                    delete (bindings removed; sessions survive)
//   GET    /:id/sessions           session ids bound to the project
//   POST   /:id/sessions           bind { sessionId }
//   DELETE /:id/sessions/:sessionId  unbind
//   GET    /:id/context            the turn-context payload for a project:
//                                  { instructions, knowledgeRefs, memoryScoped,
//                                    memoryScope: 'project' | 'global' }

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { openDb } from '@mvp/agent-runtime';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Per-project instructions, injected into turns of bound sessions by the host. */
  instructions: string;
  /** Shared knowledge-file references (KB ids / file refs), shared by all bound sessions. */
  knowledgeRefs: string[];
  /**
   * Project-scoped memory flag: when true, memory recall/writes for
   * bound sessions are scoped to this project; when false, the
   * session uses the global memory scope as before.
   */
  memoryScoped: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectContext {
  projectId: string;
  instructions: string;
  knowledgeRefs: string[];
  memoryScoped: boolean;
  /** Derived scope label hosts pass to the memory layer. */
  memoryScope: 'project' | 'global';
}

const LIMITS = { name: 120, description: 1000, instructions: 20_000, knowledgeRefs: 50, knowledgeRef: 500 } as const;

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().slice(0, LIMITS.name) : '';
  if (!name) throw new Error('name is required');
  return name;
}

function cleanKnowledgeRefs(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('knowledgeRefs must be an array of strings');
  const refs = v.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim().slice(0, LIMITS.knowledgeRef));
  if (refs.length > LIMITS.knowledgeRefs) throw new Error(`knowledgeRefs is capped at ${LIMITS.knowledgeRefs}`);
  return [...new Set(refs)];
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  knowledge_refs: string;
  memory_scoped: number;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  let refs: string[] = [];
  try {
    const parsed = JSON.parse(row.knowledge_refs) as unknown;
    if (Array.isArray(parsed)) refs = parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    // corrupted column: serve empty rather than failing the read
  }
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    instructions: row.instructions,
    knowledgeRefs: refs,
    memoryScoped: row.memory_scoped === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed Project store (projects.db under the host data dir). */
export class ProjectStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT NOT NULL DEFAULT '',
        knowledge_refs TEXT NOT NULL DEFAULT '[]',
        memory_scoped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_sessions (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_sessions_session ON project_sessions (session_id);
    `);
  }

  create(input: {
    name: string;
    description?: string;
    instructions?: string;
    knowledgeRefs?: string[];
    memoryScoped?: boolean;
  }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: `proj_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      name: cleanName(input.name),
      ...(typeof input.description === 'string' && input.description.trim()
        ? { description: input.description.trim().slice(0, LIMITS.description) }
        : {}),
      instructions: typeof input.instructions === 'string' ? input.instructions.slice(0, LIMITS.instructions) : '',
      knowledgeRefs: cleanKnowledgeRefs(input.knowledgeRefs),
      memoryScoped: input.memoryScoped === true,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, instructions, knowledge_refs, memory_scoped, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project.id, project.name, project.description ?? null, project.instructions,
        JSON.stringify(project.knowledgeRefs), project.memoryScoped ? 1 : 0, project.createdAt, project.updatedAt);
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id ASC').all() as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }

  update(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>): Project | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: Project = {
      ...existing,
      ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim().slice(0, LIMITS.description) || undefined }
        : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions.slice(0, LIMITS.instructions) } : {}),
      ...(patch.knowledgeRefs !== undefined ? { knowledgeRefs: cleanKnowledgeRefs(patch.knowledgeRefs) } : {}),
      ...(patch.memoryScoped !== undefined ? { memoryScoped: patch.memoryScoped === true } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, instructions = ?, knowledge_refs = ?, memory_scoped = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.name, next.description ?? null, next.instructions, JSON.stringify(next.knowledgeRefs),
        next.memoryScoped ? 1 : 0, next.updatedAt, id);
    return next;
  }

  remove(id: string): boolean {
    this.db.prepare('DELETE FROM project_sessions WHERE project_id = ?').run(id);
    const res = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return res.changes > 0;
  }

  /** Bind a session to a project. A session belongs to at most one project: rebinding moves it. */
  bindSession(projectId: string, sessionId: string): boolean {
    if (!this.get(projectId)) return false;
    this.db.prepare('DELETE FROM project_sessions WHERE session_id = ?').run(sessionId);
    this.db
      .prepare('INSERT INTO project_sessions (project_id, session_id, bound_at) VALUES (?, ?, ?)')
      .run(projectId, sessionId, new Date().toISOString());
    return true;
  }

  unbindSession(projectId: string, sessionId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM project_sessions WHERE project_id = ? AND session_id = ?')
      .run(projectId, sessionId);
    return res.changes > 0;
  }

  sessionsFor(projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT session_id AS sessionId FROM project_sessions WHERE project_id = ? ORDER BY bound_at ASC')
      .all(projectId) as Array<{ sessionId: string }>;
    return rows.map((r) => r.sessionId);
  }

  projectForSession(sessionId: string): Project | undefined {
    const row = this.db
      .prepare('SELECT project_id AS projectId FROM project_sessions WHERE session_id = ?')
      .get(sessionId) as { projectId: string } | undefined;
    return row ? this.get(row.projectId) : undefined;
  }

  /** The turn-context payload a host injects for sessions bound to this project. */
  contextFor(projectId: string): ProjectContext | undefined {
    const p = this.get(projectId);
    if (!p) return undefined;
    return {
      projectId: p.id,
      instructions: p.instructions,
      knowledgeRefs: [...p.knowledgeRefs],
      memoryScoped: p.memoryScoped,
      memoryScope: p.memoryScoped ? 'project' : 'global',
    };
  }

  close(): void {
    this.db.close();
  }
}

export interface ProjectsRoutesDeps {
  /** Host data dir — projects.db lives under it. Ignored when `store` is given. */
  dataDir?: string;
  /** Pre-built store (tests, custom locations). */
  store?: ProjectStore;
  /**
   * Optional runtime sync: called on bind/unbind so the session
   * store's SessionRecord.projectId stays in step (null = unbind).
   */
  bindSession?: (sessionId: string, projectId: string | null) => void;
}

function bodyOf(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** Register the Project routes on an existing router (paths relative). */
export function registerProjectsRoutes(router: Router, deps: ProjectsRoutesDeps): ProjectStore {
  const store = deps.store ?? new ProjectStore(join(deps.dataDir ?? '.', 'projects.db'));

  router.get('/', (_req: Request, res: Response) => {
    res.json({ projects: store.list() });
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const b = bodyOf(req);
      const project = store.create({
        name: b.name as string,
        description: b.description as string | undefined,
        instructions: b.instructions as string | undefined,
        knowledgeRefs: b.knowledgeRefs as string[] | undefined,
        memoryScoped: b.memoryScoped as boolean | undefined,
      });
      res.status(201).json({ project });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const project = store.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ project });
  });

  router.patch('/:id', (req: Request, res: Response) => {
    try {
      const b = bodyOf(req);
      const project = store.update(req.params.id, {
        ...(b.name !== undefined ? { name: b.name as string } : {}),
        ...(b.description !== undefined ? { description: b.description as string } : {}),
        ...(b.instructions !== undefined ? { instructions: b.instructions as string } : {}),
        ...(b.knowledgeRefs !== undefined ? { knowledgeRefs: b.knowledgeRefs as string[] } : {}),
        ...(b.memoryScoped !== undefined ? { memoryScoped: b.memoryScoped as boolean } : {}),
      });
      if (!project) return res.status(404).json({ error: 'project not found' });
      res.json({ project });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const bound = store.sessionsFor(req.params.id);
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'project not found' });
    if (deps.bindSession) for (const sid of bound) deps.bindSession(sid, null);
    res.json({ ok: true });
  });

  router.get('/:id/sessions', (req: Request, res: Response) => {
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'project not found' });
    res.json({ sessionIds: store.sessionsFor(req.params.id) });
  });

  router.post('/:id/sessions', (req: Request, res: Response) => {
    const sessionId = bodyOf(req).sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!store.bindSession(req.params.id, sessionId.trim())) {
      return res.status(404).json({ error: 'project not found' });
    }
    deps.bindSession?.(sessionId.trim(), req.params.id);
    res.status(201).json({ ok: true, sessionIds: store.sessionsFor(req.params.id) });
  });

  router.delete('/:id/sessions/:sessionId', (req: Request, res: Response) => {
    if (!store.unbindSession(req.params.id, req.params.sessionId)) {
      return res.status(404).json({ error: 'binding not found' });
    }
    deps.bindSession?.(req.params.sessionId, null);
    res.json({ ok: true });
  });

  router.get('/:id/context', (req: Request, res: Response) => {
    const context = store.contextFor(req.params.id);
    if (!context) return res.status(404).json({ error: 'project not found' });
    res.json({ context });
  });

  return store;
}

/** Standalone router for the Project surface (mount at /api/projects). */
export function createProjectsRouter(deps: ProjectsRoutesDeps): Router {
  const router = express.Router();
  registerProjectsRoutes(router, deps);
  return router;
}
