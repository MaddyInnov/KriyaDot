// SPDX-License-Identifier: Apache-2.0
// W7 multiplayer layer — HTTP tests: people CRUD, ownership + org
// reassign (audited, persisted), approval routing to the bot owner,
// room @mentions creating inbox items for exactly the mentioned person,
// the approval-gated relay flow (mock gateway), inbox reply + gateway
// inbound reply returning fenced into the origin chat, team-inbox
// aggregation states, per-person chief notification turns, and
// private-chat filtering by person.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { GovernanceGateway, DEFAULT_POLICY } from '@mvp/governance';
import {
  PeopleStore,
  SessionStore,
  TeamInboxStore,
  type BotConfig,
  type Person,
} from '@mvp/agent-runtime';
import { applyBotOwners, createPeopleService, resolvePersonContext } from '../src/people.js';
import { createPeopleRouter } from '../src/people-routes.js';
import { createGroupChatsRouter } from '../src/group-chats-routes.js';

function bot(id: string, name: string): BotConfig {
  return {
    id, name, description: 'd', systemPrompt: 'p', provider: 'groq', model: 'm',
    skills: [], tools: [], mcpServers: [],
  };
}

describe('people-routes (W7)', () => {
  let dir: string;
  let app: express.Express;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let bots: BotConfig[];
  let governance: GovernanceGateway;
  let people: PeopleStore;
  let inbox: TeamInboxStore;
  let sessions: SessionStore;
  let audit: ReturnType<typeof vi.fn>;
  let sent: Array<{ channel: string; to: string; text: string }>;
  let chiefTurns: Array<{ botId: string; message: string }>;
  let pushes: Array<{ botId: string; title: string }>;
  let ana: Person;
  let ben: Person;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'people-api-'));
    bots = [bot('bot-a', 'Alpha'), bot('bot-b', 'Beta'), bot('chief-a', 'Chief A')];
    governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
    people = new PeopleStore(dir);
    inbox = new TeamInboxStore(dir);
    sessions = new SessionStore(join(dir, 'sessions.db'));
    audit = vi.fn();
    sent = [];
    chiefTurns = [];
    pushes = [];
    ana = people.createPerson({
      name: 'Ana Rao',
      email: 'ana@example.com',
      channels: { handles: { telegram: 'ana_tg' } },
    });
    ben = people.createPerson({ name: 'Ben Cole', channels: { handles: { slack: 'U_BEN' } } });

    const service = createPeopleService({
      dataDir: dir,
      people,
      inbox,
      getBots: () => bots,
      governance,
      sender: {
        send: async (a) => {
          sent.push({ channel: a.channel, to: a.to, text: a.text });
          return { ok: true, id: `mock-${sent.length}` };
        },
      },
      getRuntime: () => ({
        runTurn: async (opts) => {
          chiefTurns.push({ botId: opts.bot.id, message: opts.message });
          return {};
        },
        sessionStore: sessions,
      }),
      getPush: () => ({
        notify: async (req) => {
          pushes.push({ botId: req.botId, title: req.title });
        },
      }),
    });

    app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPeopleRouter({
        dataDir: dir,
        service,
        getBots: () => bots,
        governance,
        listSessions: (opts) => sessions.listSessions(opts),
        audit,
      }),
    );
    app.use(
      '/api/groups',
      createGroupChatsRouter({
        dataDir: dir,
        getBots: () => bots,
        runMemberTurn: async () => ({ text: '(pass)' }),
        audit,
        onPersonMentions: async ({ group, text, req }) => {
          await service.handleRoomPersonMentions({
            groupId: group.id,
            groupName: group.name,
            text,
            authorPersonId: resolvePersonContext(req as never),
          });
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    governance.close();
    people.close();
    inbox.close();
    sessions.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }
  const get = (p: string, h?: Record<string, string>) => call('GET', p, undefined, h);
  const post = (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b ?? {}, h);
  const patch = (p: string, b: unknown) => call('PATCH', p, b);

  // ---- People CRUD -----------------------------------------------------------

  it('people CRUD over HTTP, with the default user seeded and protected', async () => {
    const list = await get('/api/people');
    expect(list.json.people[0]).toMatchObject({ id: 'you', name: 'You', isDefaultUser: true });

    const created = await post('/api/people', { name: 'Cleo D', channels: { handles: { telegram: 'cleo' } } });
    expect(created.status).toBe(201);
    const cleo = created.json.person as Person;
    expect(cleo.channels.handles.telegram).toBe('cleo');

    const renamed = await patch(`/api/people/${cleo.id}`, { name: 'Cleo Doe' });
    expect(renamed.json.person.name).toBe('Cleo Doe');

    expect((await post('/api/people/you/chief', { botId: 'missing-bot' })).status).toBe(400);
    expect((await call('DELETE', '/api/people/you')).status).toBe(400);
    expect((await call('DELETE', `/api/people/${cleo.id}`)).status).toBe(200);
    expect((await get(`/api/people/${cleo.id}`)).status).toBe(404);
    expect((await post('/api/people', { name: 'Bad', email: 'nope' })).status).toBe(400);
  });

  it('per-person chief designation round-trips', async () => {
    const res = await post(`/api/people/${ana.id}/chief`, { botId: 'chief-a' });
    expect(res.json.person.chiefBotId).toBe('chief-a');
    const cleared = await post(`/api/people/${ana.id}/chief`, { botId: null });
    expect(cleared.json.person.chiefBotId).toBeUndefined();
  });

  // ---- Ownership + org ---------------------------------------------------------

  it('reassigns a bot owner (audited + persisted) and renders the org view', async () => {
    const res = await post('/api/bots/bot-a/owner', { personId: ana.id });
    expect(res.status).toBe(200);
    expect(res.json.previousOwnerId).toBe('you');
    expect(bots.find((b) => b.id === 'bot-a')?.ownerId).toBe(ana.id);
    expect(audit).toHaveBeenCalledWith(
      'people.bot_owner_reassigned',
      expect.objectContaining({
        detail: expect.objectContaining({ botId: 'bot-a', fromPersonId: 'you', toPersonId: ana.id }),
      }),
    );
    // Persisted overlay re-applies onto a fresh roster.
    const fresh = [bot('bot-a', 'Alpha'), bot('bot-b', 'Beta')];
    applyBotOwners(fresh, dir);
    expect(fresh[0]?.ownerId).toBe(ana.id);
    expect(fresh[1]?.ownerId).toBeUndefined();

    const org = await get('/api/org');
    const colAna = (org.json.columns as Array<{ person: Person; bots: Array<{ id: string }> }>).find(
      (c) => c.person.id === ana.id,
    );
    expect(colAna?.bots.map((b) => b.id)).toEqual(['bot-a']);
    const colYou = (org.json.columns as Array<{ person: Person; bots: Array<{ id: string }> }>).find(
      (c) => c.person.id === 'you',
    );
    expect(colYou?.bots.map((b) => b.id).sort()).toEqual(['bot-b', 'chief-a']);

    expect((await post('/api/bots/bot-a/owner', { personId: 'ghost' })).status).toBe(400);
    expect((await post('/api/bots/nope/owner', { personId: ana.id })).status).toBe(404);
  });

  // ---- Approval routing ---------------------------------------------------------

  it("routes a bot's approvals to its owner in the team inbox", async () => {
    await post('/api/bots/bot-a/owner', { personId: ana.id });
    // Recorded addressee (what the governance adapter stamps at mint time).
    governance.requestApproval(
      'run_command',
      { command: 'ls' },
      { sessionId: 's', botId: 'bot-a', actor: 'bot-a', addresseePersonId: ana.id },
    );
    // Pre-W7 style record with no addressee: falls back to the bot's owner.
    governance.requestApproval('write_file', { path: 'x' }, { sessionId: 's', botId: 'bot-a', actor: 'bot-a' });
    // Another person's bot approval must not leak into Ana's inbox.
    governance.requestApproval('run_command', { command: 'pwd' }, { sessionId: 's', botId: 'bot-b', actor: 'bot-b' });

    const anaInbox = await get(`/api/team-inbox?personId=${ana.id}`);
    expect(anaInbox.json.counts.needsYou).toBe(2);
    expect((anaInbox.json.needsYou as Array<{ kind: string }>).every((i) => i.kind === 'approval')).toBe(true);
    const youInbox = await get('/api/team-inbox?personId=you');
    expect(youInbox.json.counts.needsYou).toBe(1);
    expect((await get('/api/team-inbox?personId=ghost')).status).toBe(404);
  });

  // ---- Mentions -------------------------------------------------------------------

  it('a room @mention creates an inbox item + push + chief turn for exactly that person', async () => {
    await post(`/api/people/${ana.id}/chief`, { botId: 'chief-a' });
    const grp = await post('/api/groups/', { name: 'Standup', memberBotIds: ['bot-a', 'bot-b'] });
    const groupId = (grp.json.group as { id: string }).id;

    const posted = await post(`/api/groups/${groupId}/messages`, { text: '@ana can you review the plan?' });
    expect(posted.status).toBe(200);

    const anaInbox = await get(`/api/team-inbox?personId=${ana.id}`);
    const mentions = (anaInbox.json.needsYou as Array<{ kind: string; title: string }>).filter((i) => i.kind === 'mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.title).toContain('Standup');
    const benInbox = await get(`/api/team-inbox?personId=${ben.id}`);
    expect(benInbox.json.counts.needsYou).toBe(0);
    // Push went out for Ana's mention; her chief bot got a notification turn.
    expect(pushes.some((p) => p.title.includes('Standup'))).toBe(true);
    expect(chiefTurns).toHaveLength(1);
    expect(chiefTurns[0]?.botId).toBe('chief-a');
    expect(chiefTurns[0]?.message).toContain('Ana Rao');

    // @all notifies nobody (bots still answer; people are not pinged).
    await post(`/api/groups/${groupId}/messages`, { text: '@all hands on deck' });
    const anaAfter = await get(`/api/team-inbox?personId=${ana.id}`);
    expect(anaAfter.json.counts.needsYou).toBe(1);
  });

  it("the default user's chief is NOT per-person notified (global chief behaviour)", async () => {
    await post('/api/people/you/chief', { botId: 'chief-a' });
    const res = await post('/api/team-inbox/items', {
      personId: 'you', kind: 'fyi', state: 'needs-you', title: 'Heads up', summary: 'for you',
    });
    expect(res.status).toBe(201);
    expect(chiefTurns).toHaveLength(0);
  });

  // ---- Relay flow -------------------------------------------------------------------

  async function decidePendingRelay(decision: 'approved' | 'denied'): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const pending = governance.listApprovals('pending').filter((a) => a.toolName === 'relay_to_person');
      if (pending.length > 0) {
        governance.decide(pending[0]!.id, decision);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('relay approval never appeared');
  }

  it('relay: approval gate blocks until approved, then the mock gateway sends; inbox reply returns fenced into the chat', async () => {
    const relayPromise = post('/api/relays', {
      personId: ana.id, message: 'Please confirm the shipment', botId: 'bot-a', sessionId: 'sess-relay', waitMs: 10_000,
    });
    // Nothing is sent before the approval lands.
    expect(sent).toHaveLength(0);
    await decidePendingRelay('approved');
    const relayRes = await relayPromise;
    expect(relayRes.status).toBe(200);
    expect(sent).toEqual([{ channel: 'telegram', to: 'ana_tg', text: 'Please confirm the shipment' }]);
    const item = relayRes.json.relay as { id: string; state: string };
    expect(item.state).toBe('needs-you');

    const reply = await post(`/api/team-inbox/${item.id}/reply`, { text: 'Confirmed, ship it' });
    expect(reply.status).toBe(200);
    expect(reply.json.item.state).toBe('done');
    expect(reply.json.delivered).toBe(true);
    const msgs = sessions.listThreadMessages('sess-relay');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toContain('<<<UNTRUSTED PEER CONTENT — BEGIN>>>');
    expect(msgs[0]?.content).toContain('Confirmed, ship it');
    expect(msgs[0]?.content).toContain('UNTRUSTED DATA');
  });

  it('relay: a denied approval sends nothing (403)', async () => {
    const relayPromise = post('/api/relays', {
      personId: ana.id, message: 'secret plans', botId: 'bot-a', waitMs: 10_000,
    });
    await decidePendingRelay('denied');
    const relayRes = await relayPromise;
    expect(relayRes.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('relay: gateway inbound reply matches by handle and lands in the origin chat', async () => {
    const relayPromise = post('/api/relays', {
      personId: ben.id, message: 'Ben: ETA?', botId: 'bot-a', sessionId: 'sess-ben', waitMs: 10_000,
    });
    await decidePendingRelay('approved');
    await relayPromise;
    expect(sent[0]).toMatchObject({ channel: 'slack', to: 'U_BEN' });

    const miss = await post('/api/relays/inbound', { provider: 'slack', from: 'U_STRANGER', text: 'hi' });
    expect(miss.json.matched).toBe(false);
    const hit = await post('/api/relays/inbound', { provider: 'slack', from: 'U_BEN', text: 'ETA Friday' });
    expect(hit.json.matched).toBe(true);
    const msgs = sessions.listThreadMessages('sess-ben');
    expect(msgs[0]?.content).toContain('ETA Friday');
    expect(msgs[0]?.content).toContain('<<<UNTRUSTED PEER CONTENT');
  });

  // ---- Inbox aggregation states ---------------------------------------------------------

  it('team inbox buckets + state filter + manual state moves', async () => {
    await post('/api/team-inbox/items', { personId: ana.id, kind: 'fyi', title: 'FYI one', summary: 's' });
    const needs = await post('/api/team-inbox/items', {
      personId: ana.id, kind: 'run-result', state: 'needs-you', title: 'Run finished', summary: 's',
    });
    const all = await get(`/api/team-inbox?personId=${ana.id}`);
    expect(all.json.counts).toEqual({ needsYou: 1, fyi: 1, done: 0 });
    const fyiOnly = await get(`/api/team-inbox?personId=${ana.id}&state=fyi`);
    expect((fyiOnly.json.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['FYI one']);
    const moved = await post(`/api/team-inbox/${(needs.json.item as { id: string }).id}/state`, { state: 'done' });
    expect(moved.json.item.state).toBe('done');
    const after = await get(`/api/team-inbox?personId=${ana.id}`);
    expect(after.json.counts.done).toBe(1);
  });

  // ---- Private chats ----------------------------------------------------------------------

  it("filters a person's private chats: only their own sessions are listed", async () => {
    const anaChat = sessions.createSession('bot-a', { ownerPersonId: ana.id });
    const benChat = sessions.createSession('bot-a', { ownerPersonId: ben.id });
    const youChat = sessions.createSession('bot-a', { ownerPersonId: 'you' });
    const legacy = sessions.createSession('bot-a');
    for (const id of [anaChat, benChat, youChat, legacy]) {
      sessions.appendMessage(id, { role: 'user', content: 'hello' });
    }
    const anaChats = await get(`/api/people/${ana.id}/chats`);
    expect((anaChats.json.chats as Array<{ id: string }>).map((c) => c.id)).toEqual([anaChat]);
    const youChats = await get('/api/people/you/chats');
    expect((youChats.json.chats as Array<{ id: string }>).map((c) => c.id).sort()).toEqual(
      [youChat, legacy].sort(),
    );
  });
});
