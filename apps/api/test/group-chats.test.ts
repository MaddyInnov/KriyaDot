// SPDX-License-Identifier: Apache-2.0
// Tests for group chats (multi-bot rooms):
// - group-chats.ts: store CRUD, validation, member management
// - group-room-turn.ts: mention parsing, room-turn orchestration
//   (round limits, reply ordering, (pass) handling, cancellation)
// - group-chats-routes.ts: API CRUD + room turn via HTTP

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  GroupChatStore,
  newGroupId,
  newGroupMessageId,
  validBotIdList,
  validGroupName,
} from '../src/group-chats.js';
import {
  MAX_ROOM_REPLIES,
  MAX_ROOM_ROUNDS,
  buildMemberPrompt,
  parseMentions,
  resolveSpeakers,
  runRoomTurn,
  stripMentions,
} from '../src/group-room-turn.js';
import { createGroupChatsRouter } from '../src/group-chats-routes.js';
import type { BotConfig } from '@mvp/agent-runtime';

function bot(id: string, name: string): BotConfig {
  return {
    id,
    name,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

const MEMBERS = [bot('coder', 'Coder'), bot('scout', 'Scout'), bot('helper', 'Helper Bot')];

// ---- group-chats.ts: validation -------------------------------------------

describe('group validation', () => {
  it('validates group names', () => {
    expect(validGroupName('Team Alpha')).toBe(true);
    expect(validGroupName('')).toBe(false);
    expect(validGroupName('   ')).toBe(false);
    expect(validGroupName('x'.repeat(81))).toBe(false);
    expect(validGroupName(null)).toBe(false);
    expect(validGroupName(42)).toBe(false);
  });

  it('validates member id lists', () => {
    expect(validBotIdList(['a', 'b'])).toBe(true);
    expect(validBotIdList([])).toBe(false);
    expect(validBotIdList(['a', 'a'])).toBe(false); // distinct
    expect(validBotIdList(['bad id!'])).toBe(false);
    expect(validBotIdList(new Array(21).fill('a').map((_, i) => `b${i}`))).toBe(false);
  });

  it('generates well-formed ids', () => {
    expect(newGroupId()).toMatch(/^grp_[a-z0-9]+_[a-z0-9]+$/);
    expect(newGroupMessageId()).toMatch(/^gmsg_[a-z0-9]+_[a-z0-9]+$/);
  });
});

// ---- group-chats.ts: store -------------------------------------------------

describe('GroupChatStore', () => {
  let dir: string;
  let store: GroupChatStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grp-test-'));
    store = new GroupChatStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, gets, lists, updates, deletes groups', () => {
    const g = store.createGroup('Team', ['coder', 'scout'], 'dev room');
    expect(g.id).toMatch(/^grp_/);
    expect(g.name).toBe('Team');
    expect(g.memberBotIds).toEqual(['coder', 'scout']);

    expect(store.getGroup(g.id)?.name).toBe('Team');
    expect(store.getGroup('grp_nope_xx')).toBeNull();
    expect(store.listGroups()).toHaveLength(1);

    const updated = store.updateGroup(g.id, { name: 'Renamed' });
    expect(updated?.name).toBe('Renamed');

    expect(store.deleteGroup(g.id)).toBe(true);
    expect(store.getGroup(g.id)).toBeNull();
    expect(store.deleteGroup(g.id)).toBe(false);
  });

  it('finds groups by exact member set (dedupe)', () => {
    store.createGroup('A', ['coder', 'scout']);
    const found = store.findByMembers(['scout', 'coder']); // order-insensitive
    expect(found?.name).toBe('A');
    expect(store.findByMembers(['coder'])).toBeNull();
  });

  it('stores messages in order with author labels', () => {
    const g = store.createGroup('Team', ['coder']);
    const u = store.addMessage(g.id, 'user', 'hello');
    const b = store.addMessage(g.id, 'bot', 'hi there', 'coder');
    expect(u.authorType).toBe('user');
    expect(u.authorBotId).toBeNull();
    expect(b.authorBotId).toBe('coder');

    const msgs = store.listMessages(g.id);
    expect(msgs.map((m) => m.text)).toEqual(['hello', 'hi there']);
  });

  it('links threads to messages', () => {
    const g = store.createGroup('Team', ['coder']);
    const m = store.addMessage(g.id, 'user', 'hello');
    expect(m.threadId).toBeNull();
    expect(store.setMessageThread(m.id, 'thr_abc_123')).toBe(true);
    expect(store.getMessage(m.id)?.threadId).toBe('thr_abc_123');
  });

  it('removes a deleted bot from groups; deletes emptied groups', () => {
    const g1 = store.createGroup('A', ['coder', 'scout']);
    const g2 = store.createGroup('B', ['coder']);
    const affected = store.removeBotFromGroups('coder');
    expect(affected).toContain(g1.id);
    expect(affected).toContain(g2.id);
    expect(store.getGroup(g1.id)?.memberBotIds).toEqual(['scout']);
    expect(store.getGroup(g2.id)).toBeNull(); // emptied → deleted
  });

  it('validates group id format', () => {
    expect(store.isValidGroupId('grp_abc_123')).toBe(true);
    expect(store.isValidGroupId('nope')).toBe(false);
  });
});

// ---- group-room-turn.ts: mention parsing ------------------------------------

describe('parseMentions', () => {
  it('returns [] when no mentions (caller treats as everyone)', () => {
    expect(parseMentions('hello everyone', MEMBERS)).toEqual([]);
  });

  it('matches @all and @everyone', () => {
    expect(parseMentions('@all what do you think?', MEMBERS)).toEqual(MEMBERS);
    expect(parseMentions('@everyone hi', MEMBERS)).toEqual(MEMBERS);
  });

  it('matches full names case-insensitively', () => {
    const r = parseMentions('@coder review this', MEMBERS);
    expect(r.map((b) => b.id)).toEqual(['coder']);
  });

  it('matches names without spaces and first words', () => {
    const r = parseMentions('@helperbot what is this?', MEMBERS);
    expect(r.map((b) => b.id)).toEqual(['helper']);
    const r2 = parseMentions('@helper check', MEMBERS);
    expect(r2.map((b) => b.id)).toEqual(['helper']);
  });

  it('matches by bot id and prefix', () => {
    expect(parseMentions('@sco look', MEMBERS).map((b) => b.id)).toEqual(['scout']);
    expect(parseMentions('@scout', MEMBERS).map((b) => b.id)).toEqual(['scout']);
  });

  it('matches multiple mentions in roster order', () => {
    const r = parseMentions('@scout and @coder go', MEMBERS);
    expect(r.map((b) => b.id)).toEqual(['coder', 'scout']); // roster order
  });

  it('ignores unknown mentions', () => {
    expect(parseMentions('@nobody hi', MEMBERS)).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    const r = parseMentions('@coder @coder @CODER', MEMBERS);
    expect(r.map((b) => b.id)).toEqual(['coder']);
  });
});

describe('resolveSpeakers', () => {
  it('falls back to all members when no mentions', () => {
    expect(resolveSpeakers('hello', MEMBERS)).toEqual(MEMBERS);
  });

  it('uses mentioned members otherwise', () => {
    expect(resolveSpeakers('@coder hi', MEMBERS).map((b) => b.id)).toEqual(['coder']);
  });
});

describe('stripMentions', () => {
  it('removes @ tokens but keeps the name text', () => {
    expect(stripMentions('@coder review @all this')).toBe('coder review all this');
  });
});

describe('buildMemberPrompt', () => {
  it('frames the turn as a group chat with context', () => {
    const p = buildMemberPrompt({
      group: { id: 'g', name: 'Dev', description: 'ship it', memberBotIds: [], createdAt: '' },
      members: MEMBERS,
      userText: '@coder fix the bug',
      priorReplies: [{ botName: 'Scout', botId: 'scout', text: 'I found it in auth.ts' }],
      round: 2,
    });
    expect(p).toContain('[Group chat: "Dev"');
    expect(p).toContain('Room purpose: ship it');
    expect(p).toContain('The user said: coder fix the bug');
    // P1 #13: peer replies are fenced as untrusted content.
    expect(p).toContain('UNTRUSTED PEER CONTENT — BEGIN');
    expect(p).toContain('Scout:');
    expect(p).toContain('I found it in auth.ts');
    expect(p).toContain('UNTRUSTED');
    expect(p).toContain('round 2');
    expect(p).toContain('(pass)');
  });
});

// ---- group-room-turn.ts: orchestration ---------------------------------------

function makeDeps(overrides: Partial<Parameters<typeof runRoomTurn>[2]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'room-test-'));
  const store = new GroupChatStore(dir);
  const calls: Array<{ botId: string; prompt: string }> = [];
  const deps = {
    store,
    getBot: (id: string) => MEMBERS.find((b) => b.id === id),
    runMemberTurn: async (bot: BotConfig, prompt: string) => {
      calls.push({ botId: bot.id, prompt });
      return { text: `reply from ${bot.name}` };
    },
    ...overrides,
  };
  return { dir, store, calls, deps };
}

describe('runRoomTurn', () => {
  it('all members reply when no mentions (one round each, 3 rounds)', async () => {
    const { dir, store, calls, deps } = makeDeps();
    try {
      const group = store.createGroup('Team', ['coder', 'scout']);
      const result = await runRoomTurn(group, 'hello team', deps);
      // 2 members × 3 rounds = 6 replies (under the 10 cap)
      expect(result.replies).toHaveLength(6);
      expect(result.roundsCompleted).toBe(3);
      expect(result.quietRound).toBe(false);
      // Rotation: round 1 starts coder, round 2 starts scout, round 3 starts coder
      expect(result.replies.map((r) => r.botId)).toEqual([
        'coder', 'scout', // round 1
        'scout', 'coder', // round 2 (rotated)
        'coder', 'scout', // round 3
      ]);
      expect(calls).toHaveLength(6);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only mentioned members reply', async () => {
    const { dir, store, deps } = makeDeps();
    try {
      const group = store.createGroup('Team', ['coder', 'scout', 'helper']);
      const result = await runRoomTurn(group, '@coder what do you think?', deps);
      expect(result.replies.map((r) => r.botId)).toEqual(['coder', 'coder', 'coder']);
      expect(result.replies).toHaveLength(3); // 1 member × 3 rounds
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps at 10 replies per room turn', async () => {
    const many = Array.from({ length: 5 }, (_, i) => bot(`b${i}`, `Bot${i}`));
    const dir = mkdtempSync(join(tmpdir(), 'room-cap-'));
    const store = new GroupChatStore(dir);
    try {
      const group = store.createGroup('Big', many.map((b) => b.id));
      const result = await runRoomTurn(group, 'go', {
        store,
        getBot: (id: string) => many.find((b) => b.id === id),
        runMemberTurn: async (bot: BotConfig) => ({ text: `hi from ${bot.id}` }),
      });
      expect(result.replies.length).toBeLessThanOrEqual(MAX_ROOM_REPLIES);
      expect(result.replies).toHaveLength(10);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a (pass) reply says nothing and is not persisted', async () => {
    const { dir, store, deps } = makeDeps({
      runMemberTurn: async (bot: BotConfig) => ({ text: bot.id === 'scout' ? '(pass)' : `reply from ${bot.id}` }),
    });
    try {
      const group = store.createGroup('Team', ['coder', 'scout']);
      const result = await runRoomTurn(group, 'hello', deps);
      // scout passes every round; coder replies 3 times
      expect(result.replies.map((r) => r.botId)).toEqual(['coder', 'coder', 'coder']);
      const msgs = store.listMessages(group.id);
      expect(msgs.filter((m) => m.authorType === 'bot')).toHaveLength(3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a quiet round ends the turn early', async () => {
    const { dir, store, deps } = makeDeps({
      runMemberTurn: async () => ({ text: '(PASS)' }), // everyone passes
    });
    try {
      const group = store.createGroup('Team', ['coder', 'scout']);
      const result = await runRoomTurn(group, 'hello', deps);
      expect(result.replies).toHaveLength(0);
      expect(result.roundsCompleted).toBe(1);
      expect(result.quietRound).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a member error skips its turn without breaking the room', async () => {
    const { dir, store, deps } = makeDeps({
      runMemberTurn: async (bot: BotConfig) => {
        if (bot.id === 'scout') throw new Error('boom');
        return { text: `reply from ${bot.id}` };
      },
    });
    try {
      const group = store.createGroup('Team', ['coder', 'scout']);
      const result = await runRoomTurn(group, 'hello', deps);
      expect(result.replies.map((r) => r.botId)).toEqual(['coder', 'coder', 'coder']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancellation stops before the next speaker', async () => {
    const { dir, store, deps } = makeDeps();
    try {
      const group = store.createGroup('Team', ['coder', 'scout']);
      // isCancelled is checked at round start (n=1), before each speaker
      // (n=2, n=4...), and once more after each member turn resolves (n=3).
      // Cancelling at n=3 drops the in-flight speaker's stale reply.
      let n = 0;
      const result = await runRoomTurn(group, 'hello', {
        ...deps,
        isCancelled: () => ++n > 2,
      });
      expect(result.replies).toHaveLength(0);
      expect(result.skipped).toEqual([{ botId: 'coder', reason: 'turn-cancelled' }]);
      expect(result.stoppedEarly).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('each member sees prior replies in its prompt', async () => {
    const { dir, store, calls, deps } = makeDeps();
    try {
      const group = store.createGroup('Team', ['coder', 'scout']);
      await runRoomTurn(group, 'hello', deps);
      // Second speaker's prompt includes the first speaker's reply,
      // fenced as untrusted peer content (P1 #13).
      expect(calls[1].prompt).toContain('Coder:');
      expect(calls[1].prompt).toContain('reply from Coder');
      expect(calls[1].prompt).toContain('UNTRUSTED PEER CONTENT — BEGIN');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty member list ends immediately', async () => {
    const { dir, store, deps } = makeDeps();
    try {
      const group = store.createGroup('Team', ['coder']);
      store.updateGroup(group.id, { memberBotIds: [] });
      // getBot resolves nothing now
      const result = await runRoomTurn(
        { ...group, memberBotIds: ['ghost'] },
        'hello',
        deps,
      );
      expect(result.replies).toHaveLength(0);
      expect(result.quietRound).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('constants match Codync limits', () => {
    expect(MAX_ROOM_ROUNDS).toBe(3);
    expect(MAX_ROOM_REPLIES).toBe(10);
  });
});

// ---- group-chats-routes.ts: HTTP API ----------------------------------------

describe('group-chats-routes', () => {
  let dir: string;
  let app: express.Express;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  const bots = MEMBERS;
  const audit = vi.fn();
  let n = 0;

  async function runMemberTurn(bot: BotConfig, _prompt: string) {
    // Unique text per call: the room's duplicate-spam breaker must not trip
    // in tests that are not about spam.
    return { text: `mock reply ${++n} from ${bot.name}` };
  }

  beforeEach(async () => {
    n = 0;
    dir = mkdtempSync(join(tmpdir(), 'grp-api-'));
    app = express();
    app.use(express.json());
    app.use(
      '/api/groups',
      createGroupChatsRouter({
        dataDir: dir,
        getBots: () => bots,
        runMemberTurn,
        audit,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/groups`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    audit.mockClear();
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function get(path: string) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function patch(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function del(path: string) {
    const res = await fetch(`${base}${path}`, { method: 'DELETE' });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('creates a group (201) and dedupes on same members', async () => {
    const r1 = await post('/', { name: 'Dev', memberBotIds: ['coder', 'scout'] });
    expect(r1.status).toBe(201);
    expect(r1.json.ok).toBe(true);
    expect(r1.json.created).toBe(true);

    const r2 = await post('/', { name: 'Other name', memberBotIds: ['scout', 'coder'] });
    expect(r2.status).toBe(200);
    expect(r2.json.created).toBe(false);
    expect((r2.json.group as { id: string }).id).toBe((r1.json.group as { id: string }).id);
  });

  it('rejects bad input', async () => {
    expect((await post('/', { name: '', memberBotIds: ['coder'] })).status).toBe(400);
    expect((await post('/', { name: 'x', memberBotIds: [] })).status).toBe(400);
    expect((await post('/', { name: 'x', memberBotIds: ['ghost'] })).status).toBe(400);
    expect((await post('/', { name: 'x', memberBotIds: ['coder', 'coder'] })).status).toBe(400);
  });

  it('lists, gets, patches, deletes groups', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder'] });
    const id = (created.json.group as { id: string }).id;

    const list = await get('/');
    expect((list.json.groups as unknown[])).toHaveLength(1);

    const one = await get(`/${id}`);
    expect((one.json.group as { name: string }).name).toBe('Dev');

    const patched = await patch(`/${id}`, { name: 'Renamed', memberBotIds: ['coder', 'scout'] });
    expect((patched.json.group as { name: string }).name).toBe('Renamed');
    expect((patched.json.group as { memberBotIds: string[] }).memberBotIds).toEqual(['coder', 'scout']);

    expect((await get('/grp_nope_xx')).status).toBe(404);
    expect((await get('/bad-id')).status).toBe(400);

    const deleted = await del(`/${id}`);
    expect(deleted.json.ok).toBe(true);
    expect((await get(`/${id}`)).status).toBe(404);
  });

  it('adds and removes members', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder'] });
    const id = (created.json.group as { id: string }).id;

    const added = await post(`/${id}/members`, { add: ['scout'] });
    expect((added.json.group as { memberBotIds: string[] }).memberBotIds).toEqual(['coder', 'scout']);

    const bad = await post(`/${id}/members`, { add: ['ghost'] });
    expect(bad.status).toBe(400);

    const removed = await post(`/${id}/members`, { remove: ['coder'] });
    expect((removed.json.group as { memberBotIds: string[] }).memberBotIds).toEqual(['scout']);

    const empty = await post(`/${id}/members`, { remove: ['scout'] });
    expect(empty.status).toBe(400); // must keep ≥1 member
  });

  it('sends a user message and runs the room turn', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder', 'scout'] });
    const id = (created.json.group as { id: string }).id;

    const sent = await post(`/${id}/messages`, { text: 'hello team' });
    expect(sent.status).toBe(200);
    expect(sent.json.ok).toBe(true);
    const replies = sent.json.replies as Array<{ botId: string; text: string }>;
    expect(replies).toHaveLength(6); // 2 members × 3 rounds
    expect(replies[0].text).toContain('mock reply');

    const msgs = await get(`/${id}/messages`);
    const list = msgs.json.messages as Array<{ authorType: string; text: string }>;
    expect(list).toHaveLength(7); // 1 user + 6 bot
    expect(list[0].authorType).toBe('user');
    expect(list[1].authorType).toBe('bot');
  });

  it('mentions scope the room turn to mentioned members', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder', 'scout'] });
    const id = (created.json.group as { id: string }).id;

    const sent = await post(`/${id}/messages`, { text: '@coder your turn' });
    const replies = sent.json.replies as Array<{ botId: string }>;
    expect(replies.map((r) => r.botId)).toEqual(['coder', 'coder', 'coder']);
  });

  it('rejects empty message text', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder'] });
    const id = (created.json.group as { id: string }).id;
    expect((await post(`/${id}/messages`, { text: '   ' })).status).toBe(400);
    expect((await post(`/${id}/messages`, {})).status).toBe(400);
  });

  it('stop cancels the room turn flag', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder'] });
    const id = (created.json.group as { id: string }).id;
    const stopped = await post(`/${id}/stop`, {});
    expect(stopped.json.ok).toBe(true);
    expect(stopped.json.stopped).toBe(false); // nothing in flight
  });

  it('audits group lifecycle actions', async () => {
    const created = await post('/', { name: 'Dev', memberBotIds: ['coder'] });
    expect(audit).toHaveBeenCalledWith('group.create', expect.anything());
    const id = (created.json.group as { id: string }).id;
    await post(`/${id}/messages`, { text: 'hi' });
    expect(audit).toHaveBeenCalledWith('group.message', expect.anything());
    await del(`/${id}`);
    expect(audit).toHaveBeenCalledWith('group.delete', expect.anything());
  });
});
