// SPDX-License-Identifier: Apache-2.0
// Tests for chat thread branching routes (chat-threads-routes.ts):
// - POST /:threadId/branch copies history up to & including fromMessageId
// - 404 for unknown thread / unknown message, 400 for bad fromMessageId
// - GET /:threadId/messages returns the verbatim log with stable ids
// - branch is audit-logged and titled "Branch of <original>"

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@mvp/agent-runtime';
import { ThreadTitleStore, createChatThreadsRouter } from '../src/chat-threads-routes.js';

describe('chat-threads router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: SessionStore;
  let audits: Array<{ action: string; fields: unknown }>;
  let threadId: string;
  let messageIds: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-threads-'));
    audits = [];
    store = new SessionStore(join(dir, 'sessions.db'));
    threadId = store.createSession('bot-a');
    store.appendMessage(threadId, { role: 'user', content: 'q1' });
    store.appendMessage(threadId, { role: 'assistant', content: 'a1' });
    store.appendMessage(threadId, { role: 'user', content: 'q2' });
    store.appendMessage(threadId, { role: 'assistant', content: 'a2' });
    messageIds = store.listThreadMessages(threadId).map((m) => m.id);

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
        audit: (action, fields) => {
          audits.push({ action, fields });
        },
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
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function postBranch(id: string, body: unknown) {
    const res = await fetch(`${baseUrl}/${encodeURIComponent(id)}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  it('branches a thread copying history up to and including the message', async () => {
    const { status, json } = await postBranch(threadId, { fromMessageId: messageIds[1] });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.thread.id).not.toBe(threadId);
    expect(json.thread.branchedFrom).toBe(threadId);
    expect(json.thread.title).toBe(`Branch of ${threadId}`);
    expect(json.thread.botId).toBe('bot-a');
    expect(json.thread.copiedMessages).toBe(2);

    const branched = store.listThreadMessages(json.thread.id);
    expect(branched.map((m) => m.content)).toEqual(['q1', 'a1']);
    // original untouched
    expect(store.listThreadMessages(threadId)).toHaveLength(4);
    // audit-logged
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('chat.thread_branch');
    expect((audits[0].fields as any).sessionId).toBe(json.thread.id);
  });

  it('honours an explicit title and stores it for later branches', async () => {
    const first = await postBranch(threadId, { fromMessageId: messageIds[3], title: 'My custom branch' });
    expect(first.json.thread.title).toBe('My custom branch');
    // branching off the branch defaults to "Branch of <stored title>"
    const second = await postBranch(first.json.thread.id, {
      fromMessageId: store.listThreadMessages(first.json.thread.id)[0].id,
    });
    expect(second.json.thread.title).toBe('Branch of My custom branch');
  });

  it('404s for an unknown thread', async () => {
    const { status, json } = await postBranch('nope', { fromMessageId: 1 });
    expect(status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/Unknown thread/);
  });

  it('404s for a message that is not in the thread', async () => {
    const { status, json } = await postBranch(threadId, { fromMessageId: 999999 });
    expect(status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/Unknown message/);
  });

  it('400s for a missing or invalid fromMessageId', async () => {
    for (const body of [{}, { fromMessageId: 0 }, { fromMessageId: -3 }, { fromMessageId: 'abc' }, { fromMessageId: 1.5 }]) {
      const { status, json } = await postBranch(threadId, body);
      expect(status).toBe(400);
      expect(json.ok).toBe(false);
    }
  });

  it('GET /:threadId/messages returns the verbatim log with ids', async () => {
    const res = await fetch(`${baseUrl}/${encodeURIComponent(threadId)}/messages`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; messages: Array<{ id: number; role: string; content: string }> };
    expect(json.ok).toBe(true);
    expect(json.messages.map((m) => m.id)).toEqual(messageIds);
    expect(json.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('GET /:threadId/messages 404s for an unknown thread', async () => {
    const res = await fetch(`${baseUrl}/nope/messages`);
    expect(res.status).toBe(404);
  });

  it('GET / lists threads most-recently-active first with titles and counts', async () => {
    // Title the first thread so the list merges titles in.
    const titles = new ThreadTitleStore(dir);
    titles.setTitle(threadId, 'First thread');
    titles.close();
    const other = store.createSession('bot-b');
    store.appendMessage(other, { role: 'user', content: 'hello' });
    const res = await fetch(`${baseUrl}?limit=10`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      threads: Array<{ id: string; botId: string; title: string | null; messageCount: number; lastMessageTs: string | null }>;
    };
    expect(json.ok).toBe(true);
    expect(json.threads).toHaveLength(2);
    // `other` got a message after `threadId`'s last message → first in list.
    expect(json.threads[0].id).toBe(other);
    expect(json.threads[0].title).toBeNull();
    expect(json.threads[0].messageCount).toBe(1);
    expect(json.threads[1].id).toBe(threadId);
    expect(json.threads[1].title).toBe('First thread');
    expect(json.threads[1].messageCount).toBe(4);
  });

  it('GET / filters by botId', async () => {
    const res = await fetch(`${baseUrl}?botId=bot-b`);
    const json = (await res.json()) as { ok: boolean; threads: Array<{ id: string }> };
    expect(json.ok).toBe(true);
    expect(json.threads).toHaveLength(0);
    const res2 = await fetch(`${baseUrl}?botId=bot-a`);
    const json2 = (await res2.json()) as { ok: boolean; threads: Array<{ id: string }> };
    expect(json2.threads).toHaveLength(1);
    expect(json2.threads[0].id).toBe(threadId);
  });

  it('ThreadTitleStore round-trips titles', () => {
    const titles = new ThreadTitleStore(dir);
    expect(titles.getTitle('t1')).toBeUndefined();
    titles.setTitle('t1', 'Hello', undefined);
    expect(titles.getTitle('t1')).toBe('Hello');
    titles.setTitle('t2', 'Branch of Hello', 't1');
    expect(titles.getTitle('t2')).toBe('Branch of Hello');
    titles.close();
  });
});
