// SPDX-License-Identifier: Apache-2.0
// Coordinator integration tests for the last unowned API rows:
//   #32 PATCH thread title · #47 per-session human accounting ·
//   #41 per-bot layer pipelines (PUT /bots/:id/layers backing store).

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@mvp/agent-runtime';
import { createChatThreadsRouter, ThreadTitleStore } from '../src/chat-threads-routes.js';
import {
  computeHumanAccounting,
  computeSessionHumanAccounting,
  registerHumanAccountingRoute,
} from '../src/human-accounting.js';
import { applyBotLayers, saveBotLayersForBot, botLayersPath } from '../src/bot-layers.js';

// ---------------------------------------------------------------- #32 title

describe('#32 thread title PATCH', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: SessionStore;
  let threadId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'closure-title-'));
    store = new SessionStore(join(dir, 'sessions.db'));
    threadId = store.createSession('bot-a');
    store.appendMessage(threadId, { role: 'user', content: 'hello' });
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
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('renames a thread and persists it in the title store', async () => {
    const res = await fetch(`${baseUrl}/${encodeURIComponent(threadId)}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  Quarterly plan  ' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; title: string };
    expect(json.title).toBe('Quarterly plan');
    const titles = new ThreadTitleStore(dir);
    expect(titles.getTitle(threadId)).toBe('Quarterly plan');
  });

  it('rejects empty titles and unknown threads', async () => {
    const bad = await fetch(`${baseUrl}/${encodeURIComponent(threadId)}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${baseUrl}/nope/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(missing.status).toBe(404);
  });
});

// ------------------------------------------------------- #47 human accounting

function approval(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Math.random().toString(36).slice(2),
    ts: 1_000,
    sessionId: 's1',
    botId: 'b1',
    actor: 'api',
    toolName: 'run_command',
    args: {},
    status: 'approved',
    decidedAt: 61_000,
    ...over,
  };
}

const fakeGateway = {
  listApprovals: () => [
    approval({}),
    approval({ sessionId: 's1', decidedAt: 121_000 }),
    approval({ sessionId: 's2', botId: 'b2', status: 'denied', decidedAt: 31_000 }),
    approval({ sessionId: 's2', botId: 'b2', status: 'pending', decidedAt: undefined }),
  ],
} as never;

describe('#47 per-session human accounting', () => {
  it('groups interventions by session in the global report', () => {
    const report = computeHumanAccounting(fakeGateway);
    const s1 = report.bySession.find((s) => s.sessionId === 's1');
    const s2 = report.bySession.find((s) => s.sessionId === 's2');
    expect(s1).toMatchObject({ botId: 'b1', interventions: 2, responseSeconds: 180 });
    expect(s2).toMatchObject({ botId: 'b2', interventions: 1, responseSeconds: 30 });
    // Time saved is never fabricated from approval data.
    expect(report.estimatedTimeSavedSeconds).toBeNull();
  });

  it('computes one session in detail', () => {
    const s = computeSessionHumanAccounting(fakeGateway, 's2');
    expect(s).toMatchObject({
      sessionId: 's2', botId: 'b2', requested: 2, decided: 1,
      approved: 0, denied: 1, pending: 1, interventions: 1, responseSeconds: 30,
    });
  });

  it('serves GET /human-accounting?sessionId= in the web-expected shape', async () => {
    const app = express();
    const router = express.Router();
    registerHumanAccountingRoute(router, { governance: fakeGateway });
    app.use('/api', router);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', () => r()));
    const port = (srv.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/human-accounting?sessionId=s1`);
      const json = (await res.json()) as { ok: boolean; session: { sessionId: string; interventions: number } };
      expect(json.ok).toBe(true);
      expect(json.session.sessionId).toBe('s1');
      expect(json.session.interventions).toBe(2);
      const global = (await (await fetch(`http://127.0.0.1:${port}/api/human-accounting`)).json()) as {
        bySession: Array<{ sessionId: string }>;
      };
      expect(global.bySession.length).toBe(2);
    } finally {
      srv.close();
    }
  });
});

// ------------------------------------------------------------ #41 bot layers

describe('#41 bot layer pipelines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'closure-layers-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const layers = [
    { name: 'frame', kind: 'prepare', prompt: 'Frame the task.', outputMode: 'note' },
    { name: 'check', kind: 'verify', prompt: 'Verify claims.', role: 'auditor', profile: 'cheap' },
  ];

  it('saves, applies at boot, and round-trips the extended stage shape', () => {
    const bots = [{ id: 'b1', layers: undefined }] as never[];
    const saved = saveBotLayersForBot(dir, bots as never, 'b1', layers);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ kind: 'verify', role: 'auditor', profile: 'cheap' });
    expect(existsSync(botLayersPath(dir))).toBe(true);
    const fresh = [{ id: 'b1' }] as Array<{ id: string; layers?: unknown }>;
    applyBotLayers(fresh as never, dir);
    expect(fresh[0]!.layers).toHaveLength(2);
  });

  it('rejects invalid stages and unknown bots', () => {
    const bots = [{ id: 'b1' }] as never[];
    expect(() => saveBotLayersForBot(dir, bots as never, 'b1', [{ name: 'x', kind: 'bogus', prompt: 'p' }])).toThrow(/kind/);
    expect(() => saveBotLayersForBot(dir, bots as never, 'ghost', layers)).toThrow(/Unknown bot/);
  });
});
