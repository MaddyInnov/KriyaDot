// SPDX-License-Identifier: Apache-2.0
// Sync hub (Part 4): store merge semantics, HTTP auth, unified history,
// and the client engine against a stub instance. No external network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncHubStore, mintLinkToken } from '../src/sync-hub.js';
import { createSyncRouter } from '../src/sync-routes.js';
import { SyncClientEngine, writeSyncTarget, readSyncTarget, createDefaultSyncFetch } from '../src/sync-client.js';
import { PlacementStore } from '../src/placement.js';
import type { BotConfig } from '@mvp/agent-runtime';

const OWNER = 'owner-token-xyz';

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('SyncHubStore merge', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('sync-store-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('dedupes messages by msg_key on re-push (append-only, no duplication)', () => {
    const store = new SyncHubStore(dir);
    const payload = {
      sessions: [{
        sessionId: 's1', botId: 'b1', origin: 'local', originInstanceId: 'laptop-1',
        messages: [
          { rowId: 1, role: 'user', content: 'hi', ts: 1000 },
          { rowId: 2, role: 'assistant', content: 'hello', ts: 2000 },
        ],
      }],
    };
    const first = store.mergePush(payload);
    expect(first.messages).toBe(2);
    const second = store.mergePush(payload);
    expect(second.messages).toBe(0); // insert-or-ignore: nothing duplicated
    // Even a tampered re-push cannot overwrite message content.
    store.mergePush({ sessions: [{ sessionId: 's1', botId: 'b1', origin: 'local', originInstanceId: 'laptop-1', messages: [{ rowId: 1, role: 'user', content: 'CHANGED', ts: 1000 }] }] });
    const pulled = store.pull(0);
    expect(pulled.sessions).toHaveLength(1);
    expect(pulled.sessions[0].messages).toHaveLength(2);
    expect((pulled.sessions[0].messages as Array<{ content: string }>)[0].content).toBe('hi');
    expect(store.instanceId).toBeTruthy();
    expect(new SyncHubStore(dir).instanceId).toBe(store.instanceId); // stable
  });

  it('pull cursor only returns changes after the cursor', () => {
    const store = new SyncHubStore(dir);
    store.mergePush({ sessions: [{ sessionId: 's1', botId: 'b1', messages: [{ rowId: 1, role: 'user', content: 'a', ts: 1 }] }], activity: [{ id: 'a1', kind: 'routine-run', payload: { ok: true }, ts: 5 }] });
    const p1 = store.pull(0);
    expect(p1.cursor).toBeGreaterThan(0);
    expect(p1.activity).toHaveLength(1);
    const p2 = store.pull(p1.cursor);
    expect(p2.sessions).toHaveLength(0);
    expect(p2.activity).toHaveLength(0);
    store.mergePush({ bots: [{ botId: 'b1', config: { id: 'b1' }, placement: 'cloud-report', executorHere: true }] });
    const p3 = store.pull(p1.cursor);
    expect(p3.bots).toHaveLength(1);
    expect(p3.cursor).toBeGreaterThan(p1.cursor);
  });
});

describe('sync HTTP surface', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('sync-http-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makeApp(store = new SyncHubStore(dir)) {
    const a = express();
    a.use(express.json());
    a.use('/api', createSyncRouter({
      dataDir: dir,
      store,
      loopbackToken: OWNER,
      getLocalSessions: () => [{ sessionId: 'live-1', botId: 'b1', messageCount: 3, lastMessageTs: 9000 }],
    }));
    return a;
  }

  async function mint(base: string): Promise<string> {
    const res = await fetch(`${base}/api/sync/link-token`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}` } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { linkToken: string }).linkToken;
  }

  it('link-token lifecycle: mint → push/pull authorized; wrong token 401; revoke kills it', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const noAuth = await fetch(`${base}/api/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(noAuth.status).toBe(401);
      const token = await mint(base);
      // Only the hash is stored on disk.
      const file = JSON.parse(fs.readFileSync(path.join(dir, 'sync-hub.json'), 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(file)).not.toContain(token);
      expect(typeof file.linkTokenHash).toBe('string');

      const push = await fetch(`${base}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessions: [{ sessionId: 'cs1', botId: 'b1', origin: 'cloud', originInstanceId: 'cloud-1', messages: [{ rowId: 1, role: 'user', content: 'from cloud', ts: 10 }] }] }),
      });
      expect(push.status).toBe(200);
      const pushJson = (await push.json()) as { accepted: { messages: number }; cursor: number };
      expect(pushJson.accepted.messages).toBe(1);

      const pull = await (await fetch(`${base}/api/sync/pull?since=0`, { headers: { authorization: `Bearer ${token}` } })).json() as { sessions: unknown[] };
      expect(pull.sessions).toHaveLength(1);

      const revoke = await fetch(`${base}/api/sync/revoke-link-token`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}` } });
      expect(revoke.status).toBe(200);
      const after = await fetch(`${base}/api/sync/pull?since=0`, { headers: { authorization: `Bearer ${token}` } });
      expect(after.status).toBe(401);
    } finally { server.close(); }
  });

  it('history merges live local sessions with remote copies, flagged by origin/readOnly', async () => {
    const store = new SyncHubStore(dir);
    store.mergePush({ sessions: [{ sessionId: 'cs1', botId: 'b2', origin: 'cloud', originInstanceId: 'cloud-1', messages: [{ rowId: 1, role: 'user', content: 'x', ts: 5000 }] }] });
    const { server, base } = await listen(makeApp(store));
    try {
      const res = await fetch(`${base}/api/sync/history`, { headers: { authorization: `Bearer ${OWNER}` } });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sessions: Array<Record<string, unknown>> };
      const live = json.sessions.find((s) => s.sessionId === 'live-1');
      expect(live).toMatchObject({ origin: 'local', readOnly: false, messageCount: 3 });
      const remote = json.sessions.find((s) => s.sessionId === 'cs1');
      expect(remote).toMatchObject({ origin: 'cloud', readOnly: true, messageCount: 1 });
      const unauth = await fetch(`${base}/api/sync/history`);
      expect(unauth.status).toBe(401);
    } finally { server.close(); }
  });

  it('target set + status reflect configuration without exposing the token', async () => {
    const { server, base } = await listen(makeApp());
    try {
      const set = await fetch(`${base}/api/sync/target`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` },
        body: JSON.stringify({ instanceUrl: 'https://inst.example/', linkToken: 'secret-token' }),
      });
      expect(set.status).toBe(200);
      expect(readSyncTarget(dir)?.instanceUrl).toBe('https://inst.example');
      const status = (await (await fetch(`${base}/api/sync/status`, { headers: { authorization: `Bearer ${OWNER}` } })).json()) as Record<string, unknown>;
      expect(status).toMatchObject({ configured: true, instanceUrl: 'https://inst.example', pendingOutbox: 0 });
      expect(JSON.stringify(status)).not.toContain('secret-token');
    } finally { server.close(); }
  });
});

describe('SyncClientEngine against a stub instance', () => {
  let localDir: string;
  let instDir: string;
  beforeEach(() => { localDir = tmp('sync-local-'); instDir = tmp('sync-inst-'); });
  afterEach(() => { fs.rmSync(localDir, { recursive: true, force: true }); fs.rmSync(instDir, { recursive: true, force: true }); });

  const bots = [
    { id: 'b1', name: 'One' },
    { id: 'b-secret', name: 'Secret' },
  ] as unknown as BotConfig[];

  function fakeSessionStore() {
    const messages: Record<string, Array<{ id: number; role: string; content: string; ts: string }>> = {
      s1: [{ id: 1, role: 'user', content: 'hello', ts: new Date(1000).toISOString() }],
      s2: [{ id: 1, role: 'user', content: 'private', ts: new Date(2000).toISOString() }],
    };
    return {
      listSessions: () => [
        { id: 's1', botId: 'b1', createdAt: '', messageCount: 1, lastMessageTs: null },
        { id: 's2', botId: 'b-secret', createdAt: '', messageCount: 1, lastMessageTs: null },
      ],
      listThreadMessages: (id: string) => messages[id] ?? [],
    };
  }

  async function stubInstance() {
    const store = new SyncHubStore(instDir);
    const token = mintLinkToken(instDir, 'owner-1');
    const a = express();
    a.use(express.json());
    a.use('/api', createSyncRouter({ dataDir: instDir, store, loopbackToken: OWNER }));
    const srv = await listen(a);
    return { store, token, ...srv };
  }

  function makeEngine(localStore: SyncHubStore) {
    const placement = new PlacementStore(localDir);
    placement.setBot('b-secret', { localOnly: true });
    return new SyncClientEngine({
      dataDir: localDir,
      store: localStore,
      sessionStore: fakeSessionStore() as never,
      getBots: () => bots,
      placementStore: placement,
      origin: 'local',
    });
  }

  it('pushes local sessions on demand, never pushes localOnly bots, pulls cloud sessions into the cache', async () => {
    const inst = await stubInstance();
    const localStore = new SyncHubStore(localDir);
    writeSyncTarget(localDir, { instanceUrl: inst.base, linkToken: inst.token });
    const engine = makeEngine(localStore);
    try {
      await engine.pushNow();
      const instSessions = inst.store.listStoredSessions();
      expect(instSessions.map((s) => s.sessionId)).toContain('s1');
      expect(instSessions.map((s) => s.sessionId)).not.toContain('s2'); // localOnly bot
      const status = engine.status();
      expect(status.configured).toBe(true);
      expect(status.lastPushAt).toEqual(expect.any(Number));

      // A cloud-origin session appears on the instance; pull caches it locally.
      inst.store.mergePush({ sessions: [{ sessionId: 'cloud-sess', botId: 'b1', origin: 'cloud', originInstanceId: 'cloud-9', messages: [{ rowId: 7, role: 'assistant', content: 'cloud reply', ts: 3000 }] }] });
      await engine.pullNow();
      const cached = localStore.listStoredSessions().find((s) => s.sessionId === 'cloud-sess');
      expect(cached).toMatchObject({ origin: 'cloud', messageCount: 1 });
      expect(engine.status().lastPullAt).toEqual(expect.any(Number));
    } finally { inst.server.close(); }
  });

  it('offline pushes land in the persistent outbox and are delivered on reconnect without duplication', async () => {
    const inst = await stubInstance();
    const localStore = new SyncHubStore(localDir);
    const engine = makeEngine(localStore);
    try {
      writeSyncTarget(localDir, { instanceUrl: 'http://127.0.0.1:1', linkToken: inst.token });
      await expect(engine.pushNow()).rejects.toThrow();
      expect(localStore.outboxCount()).toBe(1);
      expect(engine.status().pendingOutbox).toBe(1);
      // Reconnect: the outbox flushes first, then the (now watermarked? no —
      // watermarks only advance on success) fresh payload dedupes by msg_key.
      writeSyncTarget(localDir, { instanceUrl: inst.base, linkToken: inst.token });
      const out = await engine.pushNow();
      expect(out.outboxFlushed).toBe(1);
      expect(localStore.outboxCount()).toBe(0);
      const pulled = inst.store.pull(0);
      const s1 = pulled.sessions.find((s) => s.sessionId === 's1');
      expect(s1?.messages).toHaveLength(1);
    } finally { inst.server.close(); }
  });

  it('boot tick syncs when configured (push + pull)', async () => {
    const inst = await stubInstance();
    const localStore = new SyncHubStore(localDir);
    writeSyncTarget(localDir, { instanceUrl: inst.base, linkToken: inst.token });
    const engine = makeEngine(localStore);
    try {
      await engine.tick();
      expect(inst.store.listStoredSessions().map((s) => s.sessionId)).toContain('s1');
      expect(engine.status().lastError).toBeUndefined();
    } finally { inst.server.close(); }
  });

  it('default sync fetch aborts a hanging request instead of wedging the tick', async () => {
    // A server that accepts the connection and never responds — the
    // dead-socket case after an instance restart. The bounded fetch must
    // reject quickly so the serialized engine tick cannot stall for
    // minutes (live-smoke regression: a routine import landed ~5 min
    // late behind a hung fetch).
    const http = await import('node:http');
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const fetchFn = createDefaultSyncFetch(200);
    const started = Date.now();
    await expect(fetchFn(`http://127.0.0.1:${port}/api/sync/pull?since=0`, { method: 'GET' })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    server.close();
  });
});
