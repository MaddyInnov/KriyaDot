// SPDX-License-Identifier: Apache-2.0
// A-6 follow-up — routine deletion cascades to B5 hardened inbound
// webhook triggers (routine-webhook-inbound.ts).
//
// Wiring under test (mirrors index.ts): the host constructs ONE
// RoutineInboundWebhookStore and injects it into registerRoutineRoutes
// (inboundStore dep + governance audit sink). registerRoutineRoutes
// wires the cascade as an on-removed hook on the RoutineStore instance
// it returns, so EVERY deletion path through that instance cascades:
//   1. the legacy CRUD route DELETE /api/routines/:id (this suite),
//   2. direct store.remove() — exactly what the in-chat
//      cancel_schedule (schedule-tools.ts) and delete_trigger
//      (trigger-tools.ts) tools call on the same instance.
// Assertions: triggers (token hashes) + delivery rows gone, a
// governance audit event `routine.inbound_webhooks_deleted` carrying
// { routineId, triggerCount }, and deletion of a trigger-less routine
// still succeeding (audit count 0).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutineRoutes, type RoutineStore } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import {
  RoutineInboundWebhookStore,
  registerRoutineInboundWebhookRoutes,
} from '../src/routine-webhook-inbound.js';
import type { BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'worker', name: 'Worker', description: 'does work', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

let dir: string;
let base: string;
let server: { close(cb: () => void): void } | null = null;
let inboundStore: RoutineInboundWebhookStore;
let routineStore: RoutineStore;
let auditCalls: Array<{ action: string; actor?: string; detail: unknown }>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, never> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, never> };
}

async function createRoutine(name: string): Promise<string> {
  const r = await api('POST', '/api/routines', { name, botId: 'worker', promptTemplate: 'do the thing' });
  expect(r.status).toBe(201);
  return (r.body.routine as unknown as { id: string }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'routine-delete-cascade-'));
  auditCalls = [];
  inboundStore = new RoutineInboundWebhookStore(dir);

  const app = express();
  app.use(express.json());
  const routinesRouter = express.Router();
  const stores = registerRoutineRoutes(routinesRouter, {
    dataDir: dir,
    getBots: () => bots,
    hookStore: new RoutineHookStore(dir),
    getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
    inboundStore,
    audit: (action, fields) => auditCalls.push({ action, actor: fields.actor, detail: fields.detail }),
  });
  routineStore = stores.routineStore;
  registerRoutineInboundWebhookRoutes(routinesRouter, {
    routineStore,
    inboundStore,
    getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
  });
  app.use('/api/routines', routinesRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => (server as never as { once(e: string, cb: () => void): void }).once('listening', resolve));
  base = `http://127.0.0.1:${(server as never as { address(): AddressInfo }).address().port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('routine deletion cascades to B5 inbound triggers', () => {
  it('DELETE /routines/:id removes its B5 triggers and audits the cascade with the count', async () => {
    const routineId = await createRoutine('with triggers');
    const t1 = await api('POST', `/api/routines/${routineId}/inbound-webhooks`, {});
    const t2 = await api('POST', `/api/routines/${routineId}/inbound-webhooks`, {});
    expect(t1.status).toBe(201);
    expect(t2.status).toBe(201);
    expect(inboundStore.listByRoutine(routineId)).toHaveLength(2);

    const del = await api('DELETE', `/api/routines/${routineId}`);
    expect(del.status).toBe(200);

    expect(inboundStore.listByRoutine(routineId)).toEqual([]);
    // The token hashes are gone too: the first trigger's token no
    // longer resolves to anything.
    const token = t1.body.token as unknown as string;
    expect(inboundStore.findByToken(token)).toBeUndefined();

    const cascade = auditCalls.find((a) => a.action === 'routine.inbound_webhooks_deleted');
    expect(cascade).toBeDefined();
    expect(cascade!.detail).toEqual({ routineId, triggerCount: 2 });
  });

  it('deleting a routine with no B5 triggers still succeeds (audit count 0)', async () => {
    const routineId = await createRoutine('no triggers');
    const del = await api('DELETE', `/api/routines/${routineId}`);
    expect(del.status).toBe(200);
    expect((del.body as { ok?: boolean }).ok).toBe(true);
    const cascade = auditCalls.find((a) => a.action === 'routine.inbound_webhooks_deleted');
    expect(cascade).toBeDefined();
    expect(cascade!.detail).toEqual({ routineId, triggerCount: 0 });
  });

  it('store.remove() (the in-chat tool deletion path) cascades identically', async () => {
    const routineId = await createRoutine('tool deleted');
    const t = await api('POST', `/api/routines/${routineId}/inbound-webhooks`, {});
    expect(t.status).toBe(201);
    expect(inboundStore.listByRoutine(routineId)).toHaveLength(1);

    // cancel_schedule / delete_trigger call exactly this on the same
    // store instance index.ts hands them.
    expect(routineStore.remove(routineId)).toBe(true);

    expect(inboundStore.listByRoutine(routineId)).toEqual([]);
    const cascade = auditCalls.find((a) => a.action === 'routine.inbound_webhooks_deleted');
    expect(cascade).toBeDefined();
    expect(cascade!.detail).toEqual({ routineId, triggerCount: 1 });
  });

  it('deleteByRoutine returns the number of triggers deleted', () => {
    const routineId = 'direct-store-routine';
    inboundStore.create(routineId);
    inboundStore.create(routineId);
    expect(inboundStore.deleteByRoutine(routineId)).toBe(2);
    expect(inboundStore.deleteByRoutine(routineId)).toBe(0);
  });
});
