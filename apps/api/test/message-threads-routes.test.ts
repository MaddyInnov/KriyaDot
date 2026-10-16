// SPDX-License-Identifier: Apache-2.0
// Tests for Slack-style reply threads (message-threads-routes.ts):
// - POST / creates a thread by forking the session at the root message
// - Creating twice on the same root is idempotent (returns existing)
// - GET / lists thread summaries with reply counts and unread flags
// - GET /:threadId returns the thread's messages tagged with threadId
// - POST /:threadId/read marks a thread read (clears unread)
// - POST /:threadId/reply validates and returns the thread session id
// - 404 for unknown thread / session mismatch, 400 for bad input

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@mvp/agent-runtime';
import { MessageThreadStore, createMessageThreadsRouter } from '../src/message-threads-routes.js';

describe('message-threads router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: SessionStore;
  let audits: Array<{ action: string; fields: unknown }>;
  let sessionId: string;
  let messageIds: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'msg-threads-'));
    audits = [];
    store = new SessionStore(join(dir, 'sessions.db'));
    sessionId = store.createSession('bot-a');
    store.appendMessage(sessionId, { role: 'user', content: 'q1' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'a1' });
    store.appendMessage(sessionId, { role: 'user', content: 'q2' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'a2' });
    messageIds = store.listThreadMessages(sessionId).map((m) => m.id);

    const app = express();
    app.use(express.json());
    app.use(
      '/api/chat/:sessionId/message-threads',
      createMessageThreadsRouter({
        dataDir: dir,
        branchSession: (id, msgId, opts) => store.branchSession(id, msgId, opts?.botId),
        listThreadMessages: (id) => store.listThreadMessages(id),
        audit: (action, fields) => {
          audits.push({ action, fields });
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/chat/${sessionId}/message-threads`;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  it('creates a thread by forking the session at the root message', async () => {
    const { status, json } = await api('POST', '/', { rootMessageId: messageIds[1] });
    expect(status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.created).toBe(true);
    expect(json.thread.id).toMatch(/^thr_/);
    expect(json.thread.sessionId).toBe(sessionId);
    expect(json.thread.rootMessageId).toBe(messageIds[1]);
    expect(json.thread.threadSessionId).not.toBe(sessionId);
    // The forked session contains history up to and including the root.
    const forked = store.listThreadMessages(json.thread.threadSessionId);
    expect(forked.map((m) => m.content)).toEqual(['q1', 'a1']);
    expect(audits.some((a) => a.action === 'message-thread.create')).toBe(true);
  });

  it('is idempotent: creating twice on the same root returns the existing thread', async () => {
    const first = await api('POST', '/', { rootMessageId: messageIds[0] });
    const second = await api('POST', '/', { rootMessageId: messageIds[0] });
    expect(second.status).toBe(200);
    expect(second.json.created).toBe(false);
    expect(second.json.thread.id).toBe(first.json.thread.id);
  });

  it('rejects bad input and unknown messages', async () => {
    const bad = await api('POST', '/', { rootMessageId: 'nope' });
    expect(bad.status).toBe(400);
    const missing = await api('POST', '/', {});
    expect(missing.status).toBe(400);
    const unknown = await api('POST', '/', { rootMessageId: 999999 });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain('message-not-found');
  });

  it('lists thread summaries with reply counts', async () => {
    const created = await api('POST', '/', { rootMessageId: messageIds[1], rootClientId: 'blk-1' });
    const threadId = created.json.thread.id;
    // Simulate a reply landing in the forked session after creation.
    store.appendMessage(created.json.thread.threadSessionId, { role: 'user', content: 'follow-up' });
    const { status, json } = await api('GET', '/');
    expect(status).toBe(200);
    expect(json.threads).toHaveLength(1);
    expect(json.threads[0].id).toBe(threadId);
    expect(json.threads[0].replyCount).toBe(1);
    expect(json.threads[0].lastReplyAt).not.toBeNull();
  });

  it('marks threads read and clears the unread flag', async () => {
    const created = await api('POST', '/', { rootMessageId: messageIds[1] });
    const threadId = created.json.thread.id;
    const threadSessionId = created.json.thread.threadSessionId;
    // New reply after creation → unread.
    store.appendMessage(threadSessionId, { role: 'assistant', content: 'answer in thread' });
    const before = await api('GET', '/');
    expect(before.json.threads[0].unread).toBe(true);
    const read = await api('POST', `/${threadId}/read`);
    expect(read.status).toBe(200);
    const after = await api('GET', '/');
    expect(after.json.threads[0].unread).toBe(false);
  });

  it('returns thread messages tagged with threadId', async () => {
    const created = await api('POST', '/', {
      rootMessageId: messageIds[1],
      rootClientId: 'blk-9',
    });
    const threadId = created.json.thread.id;
    const { status, json } = await api('GET', `/${threadId}`);
    expect(status).toBe(200);
    expect(json.thread.id).toBe(threadId);
    expect(json.messages.length).toBeGreaterThan(0);
    for (const m of json.messages) {
      expect(m.threadId).toBe(threadId);
      expect(m.threadRootId).toBe('blk-9');
    }
  });

  it('reply endpoint validates and returns the thread session id', async () => {
    const created = await api('POST', '/', { rootMessageId: messageIds[0] });
    const threadId = created.json.thread.id;
    const { status, json } = await api('POST', `/${threadId}/reply`, { content: 'hello thread' });
    expect(status).toBe(200);
    expect(json.threadSessionId).toBe(created.json.thread.threadSessionId);
    const empty = await api('POST', `/${threadId}/reply`, { content: '   ' });
    expect(empty.status).toBe(400);
    const unknown = await api('POST', '/thr_nope/reply', { content: 'x' });
    expect(unknown.status).toBe(404);
  });

  it('404s for unknown threads', async () => {
    const get = await api('GET', '/thr_nope');
    expect(get.status).toBe(404);
    const read = await api('POST', '/thr_nope/read');
    expect(read.status).toBe(404);
  });
});

describe('MessageThreadStore', () => {
  let dir: string;
  let store: MessageThreadStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'msg-thread-store-'));
    store = new MessageThreadStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips threads and read state', () => {
    const t = store.createThread('sess-1', 'sess-fork-1', 42, 'blk-42');
    expect(t.id).toMatch(/^thr_/);
    expect(store.getThread(t.id)?.threadSessionId).toBe('sess-fork-1');
    expect(store.findByRoot('sess-1', 42)?.id).toBe(t.id);
    expect(store.findByRoot('sess-1', 43)).toBeNull();
    expect(store.listThreads('sess-1')).toHaveLength(1);
    expect(store.listThreads('sess-2')).toHaveLength(0);
    // Creation marks read; a later check sees a lastReadAt.
    expect(store.lastReadAt(t.id)).not.toBeNull();
    store.markRead(t.id);
    expect(store.lastReadAt(t.id)).not.toBeNull();
    expect(store.getThread('thr_nope')).toBeNull();
  });
});
