// SPDX-License-Identifier: Apache-2.0
// Tests for bot context-menu management (chat thread flags + duplicate/delete):
// - PATCH /:id/flags sets pinned/unread/hidden flags (persisted)
// - GET / lists flags, pinned-first, ?includeHidden shows hidden
// - POST /:id/duplicate copies the thread with "Copy of" title
// - DELETE /:id removes the thread and calls onThreadDeleted

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@mvp/agent-runtime';
import { ThreadTitleStore, createChatThreadsRouter } from '../src/chat-threads-routes.js';

describe('chat thread flags + duplicate + delete', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: SessionStore;
  let deleted: string[];
  let threadA: string;
  let threadB: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'threadflags-'));
    deleted = [];
    store = new SessionStore(join(dir, 'sessions.db'));
    threadA = store.createSession('bot-a');
    store.appendMessage(threadA, { role: 'user', content: 'hello a' });
    threadB = store.createSession('bot-a');
    store.appendMessage(threadB, { role: 'user', content: 'hello b' });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/chat/threads',
      createChatThreadsRouter({
        dataDir: dir,
        listThreads: (opts) => store.listSessions(opts ?? {}),
        branchSession: (id, msgId, opts) => store.branchSession(id, msgId, opts?.botId),
        listThreadMessages: (id) => store.listThreadMessages(id),
        duplicateThread: (id) => store.duplicateSession(id),
        deleteThread: (id) => store.deleteSession(id),
        onThreadDeleted: (id) => {
          deleted.push(id);
        },
        audit: () => {},
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/chat/threads`;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('pins a thread and lists it first', async () => {
    const patch = await fetch(`${baseUrl}/${threadB}/flags`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    expect(patch.status).toBe(200);
    const list = (await (await fetch(baseUrl)).json()) as { threads: Array<{ id: string; flags: { pinned: boolean } }> };
    expect(list.threads[0].id).toBe(threadB);
    expect(list.threads[0].flags.pinned).toBe(true);
  });

  it('hides a thread and excludes it unless ?includeHidden', async () => {
    await fetch(`${baseUrl}/${threadA}/flags`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hidden: true }),
    });
    const list = (await (await fetch(baseUrl)).json()) as { threads: Array<{ id: string }> };
    expect(list.threads.map((t) => t.id)).not.toContain(threadA);
    const withHidden = (await (await fetch(`${baseUrl}?includeHidden=1`)).json()) as {
      threads: Array<{ id: string; flags: { hidden: boolean } }>;
    };
    const found = withHidden.threads.find((t) => t.id === threadA);
    expect(found?.flags.hidden).toBe(true);
  });

  it('marks a thread unread', async () => {
    const res = await fetch(`${baseUrl}/${threadA}/flags`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unread: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: { unread: boolean } };
    expect(body.flags.unread).toBe(true);
  });

  it('duplicates a thread with its history and a "Copy of" title', async () => {
    const res = await fetch(`${baseUrl}/${threadA}/duplicate`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread: { id: string; title: string } };
    expect(body.thread.id).not.toBe(threadA);
    expect(body.thread.title).toContain('Copy of');
    const msgs = (await (await fetch(`${baseUrl}/${body.thread.id}/messages`)).json()) as {
      messages: Array<{ content: string }>;
    };
    expect(msgs.messages.map((m) => m.content)).toContain('hello a');
  });

  it('deletes a thread and notifies onThreadDeleted', async () => {
    const res = await fetch(`${baseUrl}/${threadA}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deleted).toContain(threadA);
    const list = (await (await fetch(`${baseUrl}?includeHidden=1`)).json()) as {
      threads: Array<{ id: string }>;
    };
    expect(list.threads.map((t) => t.id)).not.toContain(threadA);
  });
});
