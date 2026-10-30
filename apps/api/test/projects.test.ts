// SPDX-License-Identifier: Apache-2.0
// CA-31: Project entity — store + register-style routes. A Project
// groups sessions with shared knowledge refs, per-project
// instructions, and a project-scoped memory flag; sessions gain an
// optional projectId binding (runtime store side is covered in
// agent-runtime's bare-turn.test.ts). Zero network beyond loopback
// express; zero paid APIs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore, createProjectsRouter } from '../src/projects.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mvp-projects-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ProjectStore', () => {
  it('creates, reads, lists and updates a project with all CA-31 fields', () => {
    const store = new ProjectStore(join(dir, 'projects.db'));
    const p = store.create({
      name: 'Launch Plan',
      instructions: 'Always answer in metric units.',
      knowledgeRefs: ['kb://handbook', 'file://spec.pdf', 'kb://handbook'],
      memoryScoped: true,
    });
    expect(p.id).toMatch(/^proj_/);
    expect(p.knowledgeRefs).toEqual(['kb://handbook', 'file://spec.pdf']); // deduped
    expect(p.memoryScoped).toBe(true);
    expect(store.get(p.id)?.instructions).toContain('metric units');
    expect(store.list()).toHaveLength(1);

    const updated = store.update(p.id, { name: 'Launch Plan v2', memoryScoped: false });
    expect(updated?.name).toBe('Launch Plan v2');
    expect(updated?.memoryScoped).toBe(false);
    expect(updated?.instructions).toContain('metric units'); // untouched fields survive
    store.close();
  });

  it('rejects empty names and non-array knowledgeRefs', () => {
    const store = new ProjectStore(join(dir, 'projects.db'));
    expect(() => store.create({ name: '  ' })).toThrow(/name is required/);
    expect(() => store.create({ name: 'x', knowledgeRefs: 'nope' as never })).toThrow(/knowledgeRefs/);
    store.close();
  });

  it('binds sessions (one project per session), resolves context, unbinds on delete', () => {
    const store = new ProjectStore(join(dir, 'projects.db'));
    const a = store.create({ name: 'A', memoryScoped: true, instructions: 'inst-a' });
    const b = store.create({ name: 'B' });
    expect(store.bindSession(a.id, 'sess-1')).toBe(true);
    expect(store.bindSession('proj-missing', 'sess-2')).toBe(false);
    expect(store.sessionsFor(a.id)).toEqual(['sess-1']);
    expect(store.projectForSession('sess-1')?.id).toBe(a.id);

    // Rebinding moves the session to the new project.
    store.bindSession(b.id, 'sess-1');
    expect(store.sessionsFor(a.id)).toEqual([]);
    expect(store.projectForSession('sess-1')?.id).toBe(b.id);

    const ctx = store.contextFor(a.id);
    expect(ctx).toEqual({
      projectId: a.id, instructions: 'inst-a', knowledgeRefs: [], memoryScoped: true, memoryScope: 'project',
    });
    expect(store.contextFor(b.id)?.memoryScope).toBe('global');

    expect(store.unbindSession(b.id, 'sess-1')).toBe(true);
    expect(store.projectForSession('sess-1')).toBeUndefined();
    expect(store.remove(b.id)).toBe(true);
    expect(store.get(b.id)).toBeUndefined();
    store.close();
  });

  it('persists across store instances (same file)', () => {
    const path = join(dir, 'projects.db');
    const first = new ProjectStore(path);
    const p = first.create({ name: 'Durable' });
    first.bindSession(p.id, 'sess-9');
    first.close();
    const second = new ProjectStore(path);
    expect(second.get(p.id)?.name).toBe('Durable');
    expect(second.sessionsFor(p.id)).toEqual(['sess-9']);
    second.close();
  });
});

describe('Project routes', () => {
  async function makeServer(bindCalls: Array<[string, string | null]>) {
    const app = express();
    app.use(express.json());
    app.use('/projects', createProjectsRouter({
      dataDir: dir,
      bindSession: (sessionId, projectId) => { bindCalls.push([sessionId, projectId]); },
    }));
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('CRUD + bind + context over HTTP, with the runtime bind hook fired', async () => {
    const bindCalls: Array<[string, string | null]> = [];
    const srv = await makeServer(bindCalls);
    try {
      const created = await fetch(srv.base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Research', instructions: 'Cite sources.', knowledgeRefs: ['kb://papers'], memoryScoped: true }),
      });
      expect(created.status).toBe(201);
      const { project } = (await created.json()) as { project: { id: string } };

      const bad = await fetch(srv.base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);

      const bound = await fetch(`${srv.base}/${project.id}/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-42' }),
      });
      expect(bound.status).toBe(201);
      expect(bindCalls).toEqual([['sess-42', project.id]]);

      const sessions = await (await fetch(`${srv.base}/${project.id}/sessions`)).json() as { sessionIds: string[] };
      expect(sessions.sessionIds).toEqual(['sess-42']);

      const ctx = await (await fetch(`${srv.base}/${project.id}/context`)).json() as { context: { memoryScope: string; instructions: string } };
      expect(ctx.context.memoryScope).toBe('project');
      expect(ctx.context.instructions).toBe('Cite sources.');

      const missing = await fetch(`${srv.base}/proj-nope`);
      expect(missing.status).toBe(404);

      const del = await fetch(`${srv.base}/${project.id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(bindCalls).toContainEqual(['sess-42', null]); // delete unbinds via the hook
    } finally {
      await srv.close();
    }
  });
});
