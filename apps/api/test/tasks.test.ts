// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalendarEventStore, TaskStore, makeTaskCreator, registerTasksRoutes } from '../src/tasks.js';

describe('TaskStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tasks-'));
  });

  it('creates open tasks and persists them', () => {
    const store = new TaskStore(dir);
    const t = store.create({ title: '  Buy milk  ', notes: '2%', dueAt: '2026-10-10T09:00:00.000Z' });
    expect(t.title).toBe('Buy milk');
    expect(t.done).toBe(false);
    expect(t.dueAt).toBe('2026-10-10T09:00:00.000Z');
    expect(t.notes).toBe('2%');
    expect(new TaskStore(dir).get(t.id)).toMatchObject({ title: 'Buy milk', done: false });
  });

  it('sorts open tasks by due date (nulls last), done tasks last', () => {
    const store = new TaskStore(dir);
    const noDue = store.create({ title: 'no due' });
    const later = store.create({ title: 'later', dueAt: '2026-10-20T00:00:00Z' });
    const sooner = store.create({ title: 'sooner', dueAt: '2026-10-11T00:00:00Z' });
    store.update(later.id, { done: true });
    expect(store.list().map((t) => t.title)).toEqual(['sooner', 'no due', 'later']);
    expect(noDue.dueAt).toBeNull();
  });

  it('updates fields, toggles done, and rejects bad input', () => {
    const store = new TaskStore(dir);
    const t = store.create({ title: 'x' });
    const done = store.update(t.id, { done: true, dueAt: '2026-11-01T00:00:00Z' });
    expect(done.done).toBe(true);
    expect(done.dueAt).toBe('2026-11-01T00:00:00.000Z');
    const cleared = store.update(t.id, { dueAt: null, notes: '' });
    expect(cleared.dueAt).toBeNull();
    expect(cleared.notes).toBeUndefined();

    expect(() => store.update(t.id, { done: 'yes' as unknown as boolean })).toThrow(/boolean/);
    expect(() => store.update(t.id, { dueAt: 'not-a-date' })).toThrow(/dueAt/);
    expect(() => store.update(t.id, { title: '' })).toThrow(/title/);
    expect(() => store.update('nope', { done: true })).toThrow(/unknown task/);
  });

  it('deletes tasks', () => {
    const store = new TaskStore(dir);
    const t = store.create({ title: 'bye' });
    store.remove(t.id);
    expect(store.get(t.id)).toBeUndefined();
    expect(() => store.remove(t.id)).toThrow(/unknown task/);
  });

  it('C-11: deleting a blocker task is refused while dependents name it (no silent deadlock)', () => {
    const store = new TaskStore(dir);
    const blocker = store.create({ title: 'Blocker' });
    const dependent = store.create({ title: 'Dependent', blockedBy: [blocker.id] });
    expect(() => store.remove(blocker.id)).toThrow(/blocker for 1 other task/);
    expect(store.get(blocker.id)).toBeDefined();
    // Unblock the dependent explicitly, then deletion succeeds.
    store.update(dependent.id, { blockedBy: [] });
    store.remove(blocker.id);
    expect(store.get(blocker.id)).toBeUndefined();
  });
});

describe('CalendarEventStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-'));
  });

  it('creates and lists events sorted by start time', () => {
    const store = new CalendarEventStore(dir);
    const b = store.create({
      title: 'b',
      startsAt: '2026-10-12T10:00:00Z',
      endsAt: '2026-10-12T11:00:00Z',
      notes: 'bring laptop',
    });
    const a = store.create({
      title: 'a',
      startsAt: '2026-10-09T08:00:00Z',
      endsAt: '2026-10-09T08:30:00Z',
    });
    expect(b.startsAt).toBe('2026-10-12T10:00:00.000Z');
    expect(b.notes).toBe('bring laptop');
    expect(store.list().map((e) => e.id)).toEqual([a.id, b.id]);
    expect(new CalendarEventStore(dir).get(a.id)).toMatchObject({ title: 'a' });
  });

  it('validates timestamps and ordering', () => {
    const store = new CalendarEventStore(dir);
    expect(() =>
      store.create({ title: 'x', startsAt: 'nope', endsAt: '2026-10-09T08:30:00Z' }),
    ).toThrow(/startsAt/);
    expect(() =>
      store.create({
        title: 'x',
        startsAt: '2026-10-09T09:00:00Z',
        endsAt: '2026-10-09T08:00:00Z',
      }),
    ).toThrow(/endsAt/);
    expect(() => store.create({ title: '', startsAt: '2026-10-09T09:00:00Z', endsAt: '2026-10-09T10:00:00Z' })).toThrow(
      /title/,
    );
  });

  it('updates and deletes events', () => {
    const store = new CalendarEventStore(dir);
    const e = store.create({
      title: 'standup',
      startsAt: '2026-10-09T09:00:00Z',
      endsAt: '2026-10-09T09:15:00Z',
    });
    const upd = store.update(e.id, { title: 'standup (moved)', notes: 'async today' });
    expect(upd.title).toBe('standup (moved)');
    expect(upd.startsAt).toBe(e.startsAt);
    store.remove(e.id);
    expect(store.get(e.id)).toBeUndefined();
    expect(() => store.remove(e.id)).toThrow(/unknown event/);
  });
});

describe('makeTaskCreator (workflow → task bridge)', () => {
  it('creates a task through the same store the routes use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-creator-'));
    const createTaskFromWorkflow = makeTaskCreator({ dataDir: dir });
    const task = createTaskFromWorkflow({
      title: 'Follow up: nightly digest workflow',
      notes: 'cron trigger fired',
      dueAt: '2026-10-09T09:00:00.000Z',
    });
    expect(task.title).toContain('nightly digest');
    expect(task.done).toBe(false);
    expect(task.notes).toBe('cron trigger fired');
    // Visible through a fresh store instance (same file).
    expect(new TaskStore(dir).get(task.id)).toBeDefined();
  });

  it('throws on a blank title (validation surfaces to the caller)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-creator-bad-'));
    const create = makeTaskCreator({ dataDir: dir });
    expect(() => create({ title: '  ' })).toThrow(/title/);
  });
});

describe('tasks/events router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tasks-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTasksRoutes(router, { dataDir: dir });
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

  it('CRUDs a task: create → toggle done → update → delete', async () => {
    expect((await api('GET', '/tasks')).json).toEqual([]);

    const created = await api('POST', '/tasks', { title: 'Review PR', dueAt: '2026-10-10T12:00:00Z' });
    expect(created.status).toBe(201);
    const task = created.json as { id: string };
    expect((await api('GET', `/tasks/${task.id}`)).status).toBe(200);

    const toggled = await api('PUT', `/tasks/${task.id}`, { done: true });
    expect(toggled.status).toBe(200);
    expect(toggled.json).toMatchObject({ done: true });

    const renamed = await api('PUT', `/tasks/${task.id}`, { title: 'Review PR + deploy' });
    expect(renamed.json).toMatchObject({ title: 'Review PR + deploy', done: true });

    expect((await api('DELETE', `/tasks/${task.id}`)).status).toBe(200);
    expect((await api('GET', `/tasks/${task.id}`)).status).toBe(404);
  });

  it('returns 400 for invalid task input and 404 for unknown task ids', async () => {
    expect((await api('POST', '/tasks', { title: '' })).status).toBe(400);
    expect((await api('POST', '/tasks', {})).status).toBe(400);
    const ok = (await api('POST', '/tasks', { title: 'x' })).json as { id: string };
    expect((await api('PUT', `/tasks/${ok.id}`, { done: 'yes' })).status).toBe(400);
    expect((await api('GET', '/tasks/nope')).status).toBe(404);
    expect((await api('PUT', '/tasks/nope', { done: true })).status).toBe(404);
    expect((await api('DELETE', '/tasks/nope')).status).toBe(404);
  });

  it('CRUDs a calendar event', async () => {
    expect((await api('GET', '/events')).json).toEqual([]);

    const created = await api('POST', '/events', {
      title: 'Team sync',
      startsAt: '2026-10-13T14:00:00Z',
      endsAt: '2026-10-13T14:30:00Z',
      notes: 'weekly',
    });
    expect(created.status).toBe(201);
    const event = created.json as { id: string; startsAt: string };
    expect(event.startsAt).toBe('2026-10-13T14:00:00.000Z');

    const updated = await api('PUT', `/events/${event.id}`, { title: 'Team sync (rescheduled)' });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ title: 'Team sync (rescheduled)', notes: 'weekly' });

    expect((await api('DELETE', `/events/${event.id}`)).status).toBe(200);
    expect((await api('GET', `/events/${event.id}`)).status).toBe(404);
  });

  it('rejects bad event ranges and unknown ids', async () => {
    const bad = await api('POST', '/events', {
      title: 'x',
      startsAt: '2026-10-13T15:00:00Z',
      endsAt: '2026-10-13T14:00:00Z',
    });
    expect(bad.status).toBe(400);
    const badTs = await api('POST', '/events', { title: 'x', startsAt: 'soon', endsAt: 'later' });
    expect(badTs.status).toBe(400);
    expect((await api('GET', '/events/nope')).status).toBe(404);
    expect((await api('DELETE', '/events/nope')).status).toBe(404);
  });
});
