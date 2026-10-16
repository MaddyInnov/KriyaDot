// SPDX-License-Identifier: Apache-2.0
// Tests for the message search router (message-search-routes.ts) and the
// branch-family endpoint (GET /:threadId/branches in chat-threads-routes.ts):
// - GET /api/search/messages validates q, filters, and attaches titles
// - POST /api/search/messages/rebuild rebuilds the index (audited)
// - GET /api/chat/threads/:id/branches returns the versioned family

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@mvp/agent-runtime';
import { ThreadTitleStore, createChatThreadsRouter } from '../src/chat-threads-routes.js';
import { createMessageSearchRouter } from '../src/message-search-routes.js';

describe('message-search router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: SessionStore;
  let audits: Array<{ action: string; fields: unknown }>;
  let threadA: string;
  let threadB: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'msg-search-'));
    audits = [];
    store = new SessionStore(join(dir, 'sessions.db'));
    threadA = store.createSession('bot-a');
    store.appendMessage(threadA, { role: 'user', content: 'how do I train a parrot to talk' });
    store.appendMessage(threadA, { role: 'assistant', content: 'parrots learn by repetition and treats' });
    threadB = store.createSession('bot-b');
    store.appendMessage(threadB, { role: 'user', content: 'best parrot species for beginners' });

    const titles = new ThreadTitleStore(dir);
    titles.setTitle(threadA, 'Parrot training');

    const app = express();
    app.use(express.json());
    app.use(
      '/api/search/messages',
      createMessageSearchRouter({
        searchMessages: (q, opts) => store.searchMessages(q, opts),
        rebuildSearchIndex: () => store.rebuildSearchIndex(),
        getThreadTitle: (id) => titles.getTitle(id),
        audit: (action, fields) => {
          audits.push({ action, fields });
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/search/messages`;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  it('searches across sessions and attaches thread titles', async () => {
    const { status, json } = await get('?q=parrot');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.results.length).toBeGreaterThanOrEqual(3);
    const fromA = json.results.filter((r: any) => r.sessionId === threadA);
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromA[0].title).toBe('Parrot training');
    expect(fromA[0].botId).toBe('bot-a');
    expect(fromA[0].snippet).toContain('parrot');
    expect(typeof fromA[0].messageId).toBe('number');
  });

  it('filters by botId and sessionId', async () => {
    const byBot = await get('?q=parrot&botId=bot-b');
    expect(byBot.json.results).toHaveLength(1);
    expect(byBot.json.results[0].sessionId).toBe(threadB);

    const bySession = await get(`?q=parrot&sessionId=${encodeURIComponent(threadA)}`);
    expect(bySession.json.results.every((r: any) => r.sessionId === threadA)).toBe(true);
  });

  it('respects the limit parameter', async () => {
    const { json } = await get('?q=parrot&limit=2');
    expect(json.results).toHaveLength(2);
  });

  it('400s on missing/short/oversized q', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('?q=x')).status).toBe(400);
    expect((await get(`?q=${'y'.repeat(201)}`)).status).toBe(400);
  });

  it('rebuilds the index and audits', async () => {
    const res = await fetch(`${baseUrl}/rebuild`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.ok).toBe(true);
    expect(json.indexed).toBe(3);
    expect(audits.some((a) => a.action === 'search.messages_rebuild')).toBe(true);
    // Search still works after rebuild.
    const { json: after } = await get('?q=parrot');
    expect(after.results.length).toBeGreaterThanOrEqual(3);
  });
});

describe('chat-threads branches endpoint', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: SessionStore;
  let titles: ThreadTitleStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-branches-'));
    store = new SessionStore(join(dir, 'sessions.db'));
    titles = new ThreadTitleStore(dir);

    const app = express();
    app.use(express.json());
    app.use(
      '/api/chat/threads',
      createChatThreadsRouter({
        dataDir: dir,
        listThreads: (opts) => store.listSessions(opts ?? {}),
        branchSession: (id, msgId, opts) => store.branchSession(id, msgId, opts?.botId),
        listThreadMessages: (id) => store.listThreadMessages(id),
        audit: () => undefined,
        titles,
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
    titles.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function branch(id: string, msgId: number, title: string) {
    const res = await fetch(`${baseUrl}/${encodeURIComponent(id)}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromMessageId: msgId, title }),
    });
    return (await res.json()) as { ok: boolean; thread: { id: string } };
  }

  it('returns the versioned family: root v1, branches by creation time', async () => {
    const root = store.createSession('bot-a');
    store.appendMessage(root, { role: 'user', content: 'root question' });
    const msgId = store.listThreadMessages(root)[0]!.id;
    titles.setTitle(root, 'Root thread');

    const b1 = await branch(root, msgId, 'First branch');
    // Small delay so created_at ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    // Nested branch: use the branch's own message id (copies get new ids).
    const b1log = (await (await fetch(`${baseUrl}/${encodeURIComponent(b1.thread.id)}/messages`)).json()) as {
      messages: Array<{ id: number }>;
    };
    const b2 = await branch(b1.thread.id, b1log.messages[0]!.id, 'Nested branch');
    expect(b2.ok).toBe(true);

    const res = await fetch(`${baseUrl}/${encodeURIComponent(root)}/branches`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      root: string;
      threads: Array<{ id: string; title: string; version: number; isRoot: boolean; branchedFrom: string | null }>;
    };
    expect(json.ok).toBe(true);
    expect(json.root).toBe(root);
    expect(json.threads).toHaveLength(3);
    expect(json.threads[0]).toMatchObject({ id: root, version: 1, isRoot: true, title: 'Root thread' });
    expect(json.threads[1]).toMatchObject({ id: b1.thread.id, version: 2, isRoot: false, branchedFrom: root });
    expect(json.threads[2]).toMatchObject({ id: b2.thread.id, version: 3, isRoot: false, branchedFrom: b1.thread.id });

    // Asking from a nested branch walks up to the same root.
    const res2 = await fetch(`${baseUrl}/${encodeURIComponent(b2.thread.id)}/branches`);
    const json2 = (await res2.json()) as typeof json;
    expect(json2.root).toBe(root);
    expect(json2.threads).toHaveLength(3);
  });

  it('returns just the thread itself when it has no branches', async () => {
    const root = store.createSession('bot-a');
    store.appendMessage(root, { role: 'user', content: 'lonely question' });
    const res = await fetch(`${baseUrl}/${encodeURIComponent(root)}/branches`);
    const json = (await res.json()) as { ok: boolean; threads: Array<{ version: number; isRoot: boolean }> };
    expect(json.ok).toBe(true);
    expect(json.threads).toHaveLength(1);
    expect(json.threads[0]).toMatchObject({ version: 1, isRoot: true });
  });

  it('400s on an oversized threadId', async () => {
    const res = await fetch(`${baseUrl}/${'x'.repeat(300)}/branches`);
    expect(res.status).toBe(400);
  });
});
