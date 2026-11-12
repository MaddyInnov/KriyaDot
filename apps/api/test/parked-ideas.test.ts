// SPDX-License-Identifier: Apache-2.0
// B6 parked-ideas notebook: CRUD, the structural-separation invariant
// (task automation can never enumerate an idea), the exactly-once
// "Action this idea" bridge, the outcome write-back, and the write-only
// park_idea chat tool.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@mvp/agent-runtime';
import { ModuleDb } from '@mvp/muse-modules';
import { listTrackedItems } from '../../../packages/muse-modules/src/tracked-items/index.js';
import {
  ParkedIdeaStore,
  actionParkedIdea,
  registerParkedIdeasRoutes,
  type ParkedIdea,
} from '../src/parked-ideas.js';
import { createParkedIdeaTools } from '../src/parked-idea-tools.js';
import { TaskStore, makeTaskCreator, registerTasksRoutes } from '../src/tasks.js';

const CTX: ToolContext = { sessionId: 's1', botId: 'bot-1' };

describe('ParkedIdeaStore CRUD', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'parked-ideas-'));
  });

  it('creates parked ideas (manual default) and persists them in their OWN file', () => {
    const store = new ParkedIdeaStore(dir);
    const idea = store.create({ title: '  Solar porch light  ', body: 'motion sensor by the gate' });
    expect(idea.title).toBe('Solar porch light');
    expect(idea.state).toBe('parked');
    expect(idea.source).toBe('manual');
    expect(idea.taskId).toBeUndefined();
    expect(new ParkedIdeaStore(dir).get(idea.id)).toMatchObject({ title: 'Solar porch light' });
    // Separate store file — NOT the tasks file.
    expect(existsSync(join(dir, 'parked-ideas.json'))).toBe(true);
    expect(existsSync(join(dir, 'tasks.json'))).toBe(false);
  });

  it('records chat as a source', () => {
    const store = new ParkedIdeaStore(dir);
    expect(store.create({ title: 'from chat', source: 'chat' }).source).toBe('chat');
  });

  it('validates titles and bodies', () => {
    const store = new ParkedIdeaStore(dir);
    expect(() => store.create({ title: '  ' })).toThrow(/title/);
    expect(() => store.create({ title: 'x', body: 42 as unknown as string })).toThrow(/body/);
  });

  it('updates title/body and moves parked <-> archived, but never to actioned directly', () => {
    const store = new ParkedIdeaStore(dir);
    const idea = store.create({ title: 'x' });
    expect(store.update(idea.id, { title: 'y', body: 'more' })).toMatchObject({ title: 'y', body: 'more' });
    expect(store.update(idea.id, { state: 'archived' }).state).toBe('archived');
    expect(store.update(idea.id, { state: 'parked' }).state).toBe('parked');
    expect(() => store.update(idea.id, { state: 'actioned' })).toThrow(/Action this idea/);
    expect(() => store.update('nope', { title: 'z' })).toThrow(/unknown parked idea/);
  });

  it('deletes ideas and lists parked first, newest first', () => {
    const store = new ParkedIdeaStore(dir);
    const a = store.create({ title: 'a' });
    const b = store.create({ title: 'b' });
    store.update(a.id, { state: 'archived' });
    expect(store.list().map((i) => i.title)).toEqual(['b', 'a']);
    store.remove(b.id);
    expect(store.get(b.id)).toBeUndefined();
    expect(() => store.remove(b.id)).toThrow(/unknown parked idea/);
  });
});

describe('structural separation: task automation never sees ideas', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'parked-sep-'));
  });

  it('TaskStore.list, makeTaskCreator output and listTrackedItems contain tasks only', () => {
    const ideas = new ParkedIdeaStore(dir);
    const tasks = new TaskStore(dir);
    const idea = ideas.create({ title: 'IDEA-TITLE-SENTINEL', body: 'must never be dispatched' });
    const real = tasks.create({ title: 'real task' });
    const viaWorkflow = makeTaskCreator({ dataDir: dir })({ title: 'workflow task' });

    // 1) The tasks store enumeration.
    const listed = tasks.list();
    expect(listed.map((t) => t.id)).toEqual(expect.arrayContaining([real.id, viaWorkflow.id]));
    expect(listed.some((t) => t.id === idea.id || t.title === 'IDEA-TITLE-SENTINEL')).toBe(false);

    // 2) The unified tracked-items read model (the enumeration the
    //    Goals/memory-goals surfaces — and A5's dispatcher — build on).
    const mdb = new ModuleDb(join(dir, 'muse.db'));
    const tracked = listTrackedItems(mdb, { tasks: () => tasks.list() });
    expect(tracked.map((t) => t.title)).toContain('real task');
    expect(tracked.some((t) => t.id === idea.id || t.title === 'IDEA-TITLE-SENTINEL')).toBe(false);
    mdb.close();

    // 3) The raw tasks file contains no idea rows at all.
    const tasksFile = readFileSync(join(dir, 'tasks.json'), 'utf8');
    expect(tasksFile).not.toContain('IDEA-TITLE-SENTINEL');
    expect(tasksFile).not.toContain(idea.id);
  });

  it('park_idea tool writes ONLY into the ideas store — tasks store untouched', async () => {
    const ideas = new ParkedIdeaStore(dir);
    const tools = createParkedIdeaTools(ideas);
    expect(tools.map((t) => t.name)).toEqual(['park_idea']);

    const tasksBefore = existsSync(join(dir, 'tasks.json'))
      ? readFileSync(join(dir, 'tasks.json'), 'utf8')
      : null;
    const out = (await tools[0].handler({ title: 'chat idea', body: 'from a conversation' }, CTX)) as {
      parked: boolean;
      ideaId: string;
    };
    expect(out.parked).toBe(true);
    expect(ideas.get(out.ideaId)).toMatchObject({ title: 'chat idea', source: 'chat', state: 'parked' });

    // The tasks store is byte-for-byte unchanged (here: still absent).
    const tasksAfter = existsSync(join(dir, 'tasks.json'))
      ? readFileSync(join(dir, 'tasks.json'), 'utf8')
      : null;
    expect(tasksAfter).toBe(tasksBefore);
    expect(new TaskStore(dir).list()).toEqual([]);

    // Blank titles are refused without writing anything anywhere.
    const bad = (await tools[0].handler({ title: '   ' }, CTX)) as { parked: boolean };
    expect(bad.parked).toBe(false);
    expect(ideas.list()).toHaveLength(1);
  });
});

describe('action this idea (the only bridge)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'parked-action-'));
  });

  it('creates exactly one linked task; double-action is refused', () => {
    const ideas = new ParkedIdeaStore(dir);
    const tasks = new TaskStore(dir);
    const idea = ideas.create({ title: 'Build a birdhouse', body: 'cedar, pitched roof' });

    const { idea: updated, task } = actionParkedIdea(ideas, tasks, idea.id);
    expect(task.title).toBe('Build a birdhouse');
    expect(task.notes).toBe('cedar, pitched roof');
    expect(task.done).toBe(false);
    expect(task.ideaId).toBe(idea.id);
    expect(updated.state).toBe('actioned');
    expect(updated.taskId).toBe(task.id);
    expect(ideas.getByTaskId(task.id)?.id).toBe(idea.id);

    expect(() => actionParkedIdea(ideas, tasks, idea.id)).toThrow(/already actioned/);
    expect(tasks.list()).toHaveLength(1);
  });

  it('refuses archived and unknown ideas without creating tasks', () => {
    const ideas = new ParkedIdeaStore(dir);
    const tasks = new TaskStore(dir);
    const idea = ideas.create({ title: 'x' });
    ideas.update(idea.id, { state: 'archived' });
    expect(() => actionParkedIdea(ideas, tasks, idea.id)).toThrow(/archived/);
    expect(() => actionParkedIdea(ideas, tasks, 'nope')).toThrow(/unknown parked idea/);
    expect(tasks.list()).toEqual([]);
  });
});

describe('outcome loop (store level)', () => {
  it('completion stamps a pending outcome; recordOutcome fills it; re-completion never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parked-outcome-'));
    const ideas = new ParkedIdeaStore(dir);
    const tasks = new TaskStore(dir);
    const idea = ideas.create({ title: 'Try a newsletter' });
    const { task } = actionParkedIdea(ideas, tasks, idea.id);

    const stamped = ideas.noteTaskCompleted(task.id);
    expect(stamped?.outcome?.taskId).toBe(task.id);
    expect(stamped?.outcome?.text).toBe('');
    expect(stamped?.outcomePending).toBe(true);

    const filled = ideas.recordOutcome(idea.id, 'Grew to 200 subscribers in a month');
    expect(filled.outcome?.text).toBe('Grew to 200 subscribers in a month');
    expect(filled.outcomePending).toBe(false);
    expect(filled.outcome?.completedAt).toBe(stamped?.outcome?.completedAt);

    // A duplicate completion notice must not clobber the user's outcome.
    expect(ideas.noteTaskCompleted(task.id)?.outcome?.text).toBe('Grew to 200 subscribers in a month');

    // A pre-filled summary (when a caller has one) lands as the outcome.
    const idea2 = ideas.create({ title: 'Second' });
    const { task: task2 } = actionParkedIdea(ideas, tasks, idea2.id);
    const prefilled = ideas.noteTaskCompleted(task2.id, 'Shipped and announced');
    expect(prefilled?.outcome?.text).toBe('Shipped and announced');
    expect(prefilled?.outcomePending).toBe(false);

    // Outcomes can only be recorded on actioned ideas.
    const parkedOnly = ideas.create({ title: 'Still parked' });
    expect(() => ideas.recordOutcome(parkedOnly.id, 'n/a')).toThrow(/actioned/);
    expect(() => ideas.recordOutcome(idea.id, '  ')).toThrow(/text/);
  });
});

describe('parked-ideas router + tasks completion hook', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'parked-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    // Same wiring shape as routes.ts: tasks routes get the B6 completion
    // hook; the ideas routes register on the same router.
    registerTasksRoutes(router, {
      dataDir: dir,
      onTaskCompleted: (task) => {
        if (task.ideaId) new ParkedIdeaStore(dir).noteTaskCompleted(task.id);
      },
    });
    registerParkedIdeasRoutes(router, { dataDir: dir });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('CRUDs an idea over HTTP and rejects actioned-by-PUT', async () => {
    expect((await api('GET', '/parked-ideas')).json).toEqual([]);
    const created = await api('POST', '/parked-ideas', { title: 'HTTP idea', body: 'b' });
    expect(created.status).toBe(201);
    const idea = created.json as ParkedIdea;
    expect(idea.state).toBe('parked');

    expect((await api('POST', '/parked-ideas', { title: '' })).status).toBe(400);
    expect((await api('GET', `/parked-ideas/${idea.id}`)).status).toBe(200);
    const renamed = await api('PUT', `/parked-ideas/${idea.id}`, { title: 'HTTP idea v2' });
    expect(renamed.json).toMatchObject({ title: 'HTTP idea v2' });
    expect((await api('PUT', `/parked-ideas/${idea.id}`, { state: 'actioned' })).status).toBe(400);

    expect((await api('DELETE', `/parked-ideas/${idea.id}`)).status).toBe(200);
    expect((await api('GET', `/parked-ideas/${idea.id}`)).status).toBe(404);
    expect((await api('GET', '/parked-ideas/nope')).status).toBe(404);
  });

  it('actions an idea exactly once over HTTP (second action → 409, still one task)', async () => {
    const idea = (await api('POST', '/parked-ideas', { title: 'Action me' })).json as ParkedIdea;
    const first = await api('POST', `/parked-ideas/${idea.id}/action`);
    expect(first.status).toBe(201);
    const { task } = first.json as { task: { id: string; ideaId?: string } };
    expect(task.ideaId).toBe(idea.id);

    const second = await api('POST', `/parked-ideas/${idea.id}/action`);
    expect(second.status).toBe(409);
    const tasksList = (await api('GET', '/tasks')).json as unknown[];
    expect(tasksList).toHaveLength(1);
  });

  it('task completion writes the pending outcome back; POST outcome fills it', async () => {
    const idea = (await api('POST', '/parked-ideas', { title: 'Outcome me' })).json as ParkedIdea;
    const { task } = (await api('POST', `/parked-ideas/${idea.id}/action`)).json as {
      task: { id: string };
    };

    const done = await api('PUT', `/tasks/${task.id}`, { done: true });
    expect(done.status).toBe(200);

    const after = (await api('GET', `/parked-ideas/${idea.id}`)).json as ParkedIdea;
    expect(after.outcome?.taskId).toBe(task.id);
    expect(after.outcomePending).toBe(true);

    const filled = await api('POST', `/parked-ideas/${idea.id}/outcome`, { text: 'It worked — kept it.' });
    expect(filled.status).toBe(200);
    expect(filled.json).toMatchObject({ outcomePending: false });
    expect((filled.json as ParkedIdea).outcome?.text).toBe('It worked — kept it.');

    expect((await api('POST', `/parked-ideas/${idea.id}/outcome`, { text: ' ' })).status).toBe(400);
    expect((await api('POST', '/parked-ideas/nope/outcome', { text: 'x' })).status).toBe(404);
  });

  it('GET /tasks never returns a parked idea', async () => {
    await api('POST', '/parked-ideas', { title: 'ROUTE-SENTINEL-IDEA' });
    const tasksList = (await api('GET', '/tasks')).json as Array<{ title: string }>;
    expect(tasksList.some((t) => t.title === 'ROUTE-SENTINEL-IDEA')).toBe(false);
  });
});
