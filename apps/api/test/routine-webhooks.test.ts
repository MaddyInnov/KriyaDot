// SPDX-License-Identifier: Apache-2.0
// Bot routines: management CRUD + webhook trigger management + signed
// webhook ingress that enqueues a bot turn. Mocks only, no network beyond
// localhost, no paid APIs.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutineRoutes } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import { createRoutineWebhookRouter, renderRoutinePrompt } from '../src/webhooks.js';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'worker', name: 'Worker', description: 'does work', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

interface TurnCall {
  botId: string;
  message: string;
  sessionId?: string;
}

describe('bot routines', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let turnCalls: TurnCall[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'routines-'));
    turnCalls = [];
    const agentRuntime = {
      runTurn: vi.fn(async (opts: { bot: BotConfig; message: string; sessionId?: string }) => {
        turnCalls.push({ botId: opts.bot.id, message: opts.message, sessionId: opts.sessionId });
        return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      }),
    } as unknown as AgentRuntime;

    const app = express();
    app.use(express.json());
    const routinesRouter = express.Router();
    const { routineStore, triggerStore } = registerRoutineRoutes(routinesRouter, {
      dataDir: dir,
      getBots: () => bots,
      hookStore: new RoutineHookStore(dir),
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
    });
    app.use('/api/routines', routinesRouter);
    // Mount the ingress the way index.ts will: /webhooks/routines.
    app.use(
      '/webhooks/routines',
      createRoutineWebhookRouter({ routineStore, triggerStore, agentRuntime, getBots: () => bots }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function makeRoutine(): Promise<string> {
    const r = await api('POST', '/api/routines', {
      name: 'Nightly digest',
      botId: 'worker',
      promptTemplate: 'Summarize this payload: {{payload}}',
    });
    expect(r.status).toBe(201);
    return r.json.routine.id as string;
  }

  it('creates, lists, gets, patches and deletes routines', async () => {
    const bad = await api('POST', '/api/routines', { name: 'x', botId: 'ghost', promptTemplate: 'hi' });
    expect(bad.status).toBe(400);

    const id = await makeRoutine();
    const list = await api('GET', '/api/routines');
    expect(list.json.routines).toHaveLength(1);

    const patched = await api('PATCH', `/api/routines/${id}`, { enabled: false });
    expect(patched.json.routine.enabled).toBe(false);

    const del = await api('DELETE', `/api/routines/${id}`);
    expect(del.json).toEqual({ ok: true, deleted: id });
    expect((await api('GET', `/api/routines/${id}`)).status).toBe(404);
  });

  it('creates/list/revokes webhook triggers; secrets are write-only', async () => {
    const id = await makeRoutine();
    const created = await api('POST', `/api/routines/${id}/triggers`);
    expect(created.status).toBe(201);
    const secret = created.json.trigger.secret as string;
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThanOrEqual(32);

    const listed = await api('GET', `/api/routines/${id}/triggers`);
    expect(listed.json.triggers).toHaveLength(1);
    // Secret is redacted on list.
    expect(listed.json.triggers[0].secret).toBeUndefined();
    expect(listed.json.triggers[0].id).toBe(created.json.trigger.id);

    const revoked = await api('DELETE', `/api/routines/${id}/triggers/${created.json.trigger.id}`);
    expect(revoked.json).toEqual({ ok: true, revoked: created.json.trigger.id });
    expect((await api('GET', `/api/routines/${id}/triggers`)).json.triggers).toHaveLength(0);
    // The revoked trigger no longer fires.
    const fire = await api('POST', `/webhooks/routines/${created.json.trigger.id}`, { a: 1 }, { 'x-webhook-secret': secret });
    expect(fire.status).toBe(404);
  });

  it('webhook ingress: 404 unknown, 401 bad secret, 202 enqueues the turn', async () => {
    const id = await makeRoutine();
    const trigger = (await api('POST', `/api/routines/${id}/triggers`)).json.trigger;

    expect((await api('POST', '/webhooks/routines/nope', { a: 1 }, { 'x-webhook-secret': 'x' })).status).toBe(404);

    const badSecret = await api('POST', `/webhooks/routines/${trigger.id}`, { a: 1 }, { 'x-webhook-secret': 'wrong' });
    expect(badSecret.status).toBe(401);

    const ok = await api('POST', `/webhooks/routines/${trigger.id}`, { deploy: 'done' }, { 'x-webhook-secret': trigger.secret });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ ok: true, accepted: true, routineId: id });

    // Fire-and-forget: the turn is enqueued with the rendered prompt.
    await new Promise((r) => setTimeout(r, 50));
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]!.botId).toBe('worker');
    expect(turnCalls[0]!.message).toBe('Summarize this payload: {"deploy":"done"}');
    expect(turnCalls[0]!.sessionId).toBe(`routine_${id}`);
  });

  it('disabled triggers and routines do not fire', async () => {
    const id = await makeRoutine();
    const trigger = (await api('POST', `/api/routines/${id}/triggers`)).json.trigger;
    const headers = { 'x-webhook-secret': trigger.secret as string };

    await api('PATCH', `/api/routines/${id}`, { enabled: false });
    expect((await api('POST', `/webhooks/routines/${trigger.id}`, {}, headers)).status).toBe(404);
    expect(turnCalls).toHaveLength(0);
  });

  it('renderRoutinePrompt substitutes {{payload}} / {{body}}', () => {
    expect(renderRoutinePrompt('A {{payload}} B', { x: 1 })).toBe('A {"x":1} B');
    expect(renderRoutinePrompt('A {{body}} B', { x: 1 })).toBe('A {"x":1} B');
    expect(renderRoutinePrompt('no placeholders', { x: 1 })).toBe('no placeholders');
  });
});
