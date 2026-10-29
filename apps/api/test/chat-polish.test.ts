// SPDX-License-Identifier: Apache-2.0
// Chat polish tests: message pinning + general reactions + spoiler
// convention (chat-ux), bulk ops, thread folders, departments,
// text assist, and bot avatars.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GENERAL_REACTION_EMOJIS, PinnedMessageStore, createChatUxRouter,
  hasSpoiler, isGeneralReactionEmoji, parseSpoilerSegments,
} from '../src/chat-ux.js';
import { MessageReactionStore } from '../src/message-reactions.js';
import { createBulkRouter, parseBulkIds } from '../src/bulk-routes.js';
import { ThreadFolderStore, createThreadFoldersRouter } from '../src/thread-folders.js';
import { DepartmentStore, createDepartmentsRouter, getDepartmentInstructions } from '../src/departments.js';
import { createTextAssistRouter } from '../src/text-assist-routes.js';
import { MAX_BOT_AVATAR_BYTES, applyBotAvatars, getBotAvatar, saveBotAvatar } from '../src/bot-personas.js';
import type { BotConfig } from '@mvp/agent-runtime';

async function req(app: express.Express, method: string, p: string, body?: unknown) {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } finally { server.close(); }
}
const appWith = (router: express.Router) => { const a = express(); a.use(express.json()); a.use('/api', router); return a; };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-polish-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('pinning (item 1)', () => {
  it('pin/list/unpin round-trips and persists', () => {
    const s = new PinnedMessageStore(dir);
    const pin = s.pin('t1', { messageId: 'm1', text: 'hello' });
    expect(pin.messageId).toBe('m1');
    expect(s.pin('t1', { messageId: 'm1' })).toBe(pin); // idempotent
    expect(new PinnedMessageStore(dir).list('t1')).toHaveLength(1);
    expect(s.isPinned('t1', 'm1')).toBe(true);
    expect(s.unpin('t1', 'm1')).toBe(true);
    expect(s.unpin('t1', 'm1')).toBe(false);
    expect(s.list('t1')).toEqual([]);
  });
  it('router: pin, list, unpin, 404 on missing unpin', async () => {
    const app = appWith(createChatUxRouter({ dataDir: dir }));
    const created = await req(app, 'POST', '/api/threads/t1/pins', { messageId: 42, text: 'x' });
    expect(created.status).toBe(201);
    expect((created.json.pin as { messageId: string }).messageId).toBe('42');
    const list = await req(app, 'GET', '/api/threads/t1/pins');
    expect(list.json.pins as unknown[]).toHaveLength(1);
    expect((await req(app, 'POST', '/api/threads/t1/pins', {})).status).toBe(400);
    expect((await req(app, 'DELETE', '/api/threads/t1/pins/42')).status).toBe(200);
    expect((await req(app, 'DELETE', '/api/threads/t1/pins/42')).status).toBe(404);
  });
});

describe('general reactions (item 2)', () => {
  it('emoji set is exactly the required breadth', () => {
    expect([...GENERAL_REACTION_EMOJIS]).toEqual(['👍', '👎', '❤️', '😂', '🎉', '👀']);
    expect(isGeneralReactionEmoji('🎉')).toBe(true);
    expect(isGeneralReactionEmoji('🔥')).toBe(false);
  });
  it('router toggles any allowed emoji on any message; rejects others', async () => {
    const store = new MessageReactionStore(dir);
    const app = appWith(createChatUxRouter({ reactionStore: store, listThreadMessages: () => [{ id: 7, role: 'assistant', content: 'hi' }] }));
    const on = await req(app, 'POST', '/api/threads/t1/messages/7/reactions', { emoji: '👀' });
    expect(on.status).toBe(200); expect(on.json.added).toBe(true);
    const off = await req(app, 'POST', '/api/threads/t1/messages/7/reactions', { emoji: '👀' });
    expect(off.json.added).toBe(false);
    expect((await req(app, 'POST', '/api/threads/t1/messages/7/reactions', { emoji: '🔥' })).status).toBe(400);
    await req(app, 'POST', '/api/threads/t1/messages/7/reactions', { emoji: '❤️' });
    const msgs = await req(app, 'GET', '/api/threads/t1/messages');
    const first = (msgs.json.messages as Array<{ reactions: unknown[]; pinned: boolean }>)[0]!;
    expect(first.reactions).toHaveLength(1); expect(first.pinned).toBe(false);
    store.close();
  });
});

describe('spoiler convention (item 3, server side)', () => {
  it('parses ||spoiler|| spans and preserves plain text', () => {
    expect(parseSpoilerSegments('a ||secret|| b')).toEqual([
      { text: 'a ', spoiler: false }, { text: 'secret', spoiler: true }, { text: ' b', spoiler: false },
    ]);
    expect(parseSpoilerSegments('plain')).toEqual([{ text: 'plain', spoiler: false }]);
    expect(hasSpoiler('x ||y||')).toBe(true); expect(hasSpoiler('nope')).toBe(false);
  });
});

describe('bulk operations (item 4)', () => {
  it('parseBulkIds validates + dedupes', () => {
    expect(parseBulkIds({ ids: ['a', 'a', ' b '] }).ids).toEqual(['a', 'b']);
    expect(parseBulkIds({ ids: [] }).error).toBeTruthy();
    expect(parseBulkIds({}).error).toBeTruthy();
  });
  it('per-id results: success, not-found, and thrown errors coexist; audit fires', async () => {
    const audits: string[] = [];
    const app = appWith(createBulkRouter({
      deleteThread: (id) => { if (id === 'boom') throw new Error('db gone'); return id !== 'ghost'; },
      deleteBot: () => true,
      audit: (a) => audits.push(a),
    }));
    const r = await req(app, 'POST', '/api/bulk/threads/delete', { ids: ['t1', 'ghost', 'boom'] });
    expect(r.json.deleted).toBe(1); expect(r.json.failed).toBe(2);
    expect(r.json.results).toEqual([
      { id: 't1', ok: true }, { id: 'ghost', ok: false, error: 'not found' }, { id: 'boom', ok: false, error: 'db gone' },
    ]);
    expect(audits).toEqual(['bulk.threads.delete']);
    expect((await req(app, 'POST', '/api/bulk/bots/delete', { ids: ['b1'] })).json.deleted).toBe(1);
    expect((await req(app, 'POST', '/api/bulk/threads/delete', { ids: [] })).status).toBe(400);
  });
});

describe('thread folders (item 5)', () => {
  it('store CRUD + assignment survives reload; deleting a folder unassigns', () => {
    const s = new ThreadFolderStore(dir);
    const f = s.create({ botId: 'b1', name: 'Research' });
    expect(s.assign(f.id, 't1')).toBe(true);
    expect(new ThreadFolderStore(dir).threadsIn(f.id)).toEqual(['t1']);
    expect(s.rename(f.id, 'Deep research')?.name).toBe('Deep research');
    expect(s.remove(f.id)).toBe(true);
    expect(s.folderOf('t1')).toBeUndefined();
  });
  it('router CRUD + assign/unassign + 404s', async () => {
    const app = appWith(createThreadFoldersRouter({ store: new ThreadFolderStore() }));
    const created = await req(app, 'POST', '/api/thread-folders', { botId: 'b1', name: 'F' });
    const id = (created.json.folder as { id: string }).id;
    expect(created.status).toBe(201);
    expect((await req(app, 'PUT', `/api/thread-folders/${id}/threads/t9`)).status).toBe(200);
    const list = await req(app, 'GET', '/api/thread-folders?botId=b1');
    expect((list.json.folders as Array<{ threadIds: string[] }>)[0]!.threadIds).toEqual(['t9']);
    expect((await req(app, 'DELETE', `/api/thread-folders/${id}/threads/t9`)).status).toBe(200);
    expect((await req(app, 'DELETE', '/api/thread-folders/nope')).status).toBe(404);
  });
});

describe('departments (item 6)', () => {
  it('membership move + shared instructions helper', () => {
    const s = new DepartmentStore(dir);
    const a = s.create({ name: 'Sales', sharedInstructions: 'Be brief.' });
    const b = s.create({ name: 'Support' });
    expect(s.addBot(a.id, 'bot1')).toBe(true);
    expect(getDepartmentInstructions(s, 'bot1')).toBe('Be brief.');
    expect(s.addBot(b.id, 'bot1')).toBe(true); // move
    expect(s.botsIn(a.id)).toEqual([]); expect(s.botsIn(b.id)).toEqual(['bot1']);
    expect(getDepartmentInstructions(new DepartmentStore(dir), 'bot1')).toBe('');
    expect(s.remove(b.id)).toBe(true);
    expect(s.departmentOf('bot1')).toBeUndefined();
  });
  it('router CRUD + move + by-bot lookup', async () => {
    const app = appWith(createDepartmentsRouter({ store: new DepartmentStore() }));
    const created = await req(app, 'POST', '/api/departments', { name: 'Ops', sharedInstructions: 'Escalate billing.' });
    const id = (created.json.department as { id: string }).id;
    expect((await req(app, 'POST', `/api/departments/${id}/bots`, { botId: 'bot7' })).status).toBe(200);
    const byBot = await req(app, 'GET', '/api/departments/by-bot/bot7');
    expect(byBot.json.sharedInstructions).toBe('Escalate billing.');
    expect((await req(app, 'PATCH', `/api/departments/${id}`, { name: 'Operations' })).status).toBe(200);
    expect((await req(app, 'DELETE', `/api/departments/${id}/bots/bot7`)).status).toBe(200);
    expect((await req(app, 'DELETE', `/api/departments/${id}`)).status).toBe(200);
  });
});

describe('text assist (item 7)', () => {
  it('polish uses the injected completion fn; skill returns insertion text', async () => {
    const app = appWith(createTextAssistRouter({
      complete: (t) => t.replace('teh', 'the'),
      skills: { research: { id: 'research', insertionText: '/research ' } },
    }));
    const polished = await req(app, 'POST', '/api/text-assist/polish', { text: 'teh draft' });
    expect(polished.json).toMatchObject({ ok: true, text: 'the draft', changed: true });
    expect((await req(app, 'POST', '/api/text-assist/polish', { text: '' })).status).toBe(400);
    const skill = await req(app, 'POST', '/api/text-assist/skill', { skillId: 'research' });
    expect(skill.json.text).toBe('/research ');
    expect((await req(app, 'POST', '/api/text-assist/skill', { skillId: 'nope' })).status).toBe(404);
  });
  it('polish surfaces completion failure as 502', async () => {
    const app = appWith(createTextAssistRouter({ complete: () => { throw new Error('model down'); } }));
    expect((await req(app, 'POST', '/api/text-assist/polish', { text: 'x' })).status).toBe(502);
  });
});

describe('bot avatar (item 8)', () => {
  const bots = (): BotConfig[] => [{
    id: 'helper', name: 'Helper', description: 'd', systemPrompt: 'p',
    provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [],
  }] as BotConfig[];
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`;
  it('stores a capped data-URL avatar, applies avatarUrl, clears on null', () => {
    const b = bots();
    const out = saveBotAvatar(dir, b, 'helper', png);
    expect(out.avatarUrl).toBe('/api/bots/helper/avatar');
    expect((b[0] as BotConfig & { avatarUrl?: string }).avatarUrl).toBe('/api/bots/helper/avatar');
    expect(getBotAvatar(dir, 'helper')?.mime).toBe('image/png');
    const b2 = bots(); applyBotAvatars(b2, dir);
    expect((b2[0] as BotConfig & { avatarUrl?: string }).avatarUrl).toBe('/api/bots/helper/avatar');
    expect(saveBotAvatar(dir, b, 'helper', null).avatarUrl).toBeNull();
    expect(getBotAvatar(dir, 'helper')).toBeNull();
  });
  it('rejects non-images, oversize payloads, and unknown bots', () => {
    expect(() => saveBotAvatar(dir, bots(), 'helper', 'data:text/html;base64,PGI+')).toThrow(/data:image/);
    const big = `data:image/png;base64,${Buffer.alloc(MAX_BOT_AVATAR_BYTES + 1).toString('base64')}`;
    expect(() => saveBotAvatar(dir, bots(), 'helper', big)).toThrow(/exceeds/);
    expect(() => saveBotAvatar(dir, bots(), 'nope', png)).toThrow(/Unknown bot/);
  });
});
