// SPDX-License-Identifier: Apache-2.0
// B5 — generic inbound webhook triggers for routines.
//
// Covers the spec matrix: valid token starts the routine with the JSON
// body as trigger input; wrong token → generic 404 + journalled;
// constant-time compare (unit + code-level); disabled trigger/routine →
// identical non-leaking 404; rotate invalidates the old token; per-
// trigger rate limit trips at the cap; oversized / non-JSON / malformed
// bodies rejected; Idempotency-Key dedupe; token stored hashed only;
// and a webhook-started run whose action requires approval PAUSES for
// a human approval instead of executing (governance is not bypassed).
// Mocks only, no network beyond localhost, no paid APIs.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutineRoutes, RoutineStore } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import { RoutineRunExecutor, RoutineRunStore } from '../src/routine-runs.js';
import {
  RoutineInboundWebhookStore,
  createRoutineInboundWebhookRouter,
  hashInboundWebhookToken,
  inboundWebhookBodyErrorHandler,
  registerRoutineInboundWebhookRoutes,
  summarizePayload,
  verifyInboundWebhookToken,
} from '../src/routine-webhook-inbound.js';
import type { AgentRuntime, BotConfig, ProvenanceNote } from '@mvp/agent-runtime';

const bots = [
  { id: 'worker', name: 'Worker', description: 'does work', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

interface TurnCall {
  botId: string;
  message: string;
  sessionId?: string;
  provenance?: ProvenanceNote;
}

describe('B5 inbound webhook triggers', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let turnCalls: TurnCall[];
  let auditCalls: Array<{ action: string; detail: unknown }>;
  let routineStore: RoutineStore;
  let inboundStore: RoutineInboundWebhookStore;
  let runStore: RoutineRunStore;
  /** Simulated governed side effect: set only when an approval-gated action actually executes. */
  let governedActionExecuted: boolean;
  let approvalsRequested: Array<{ tool: string; provenance?: ProvenanceNote }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'b5-inbound-'));
    turnCalls = [];
    auditCalls = [];
    governedActionExecuted = false;
    approvalsRequested = [];

    // Governance-faithful runtime double: it implements the documented
    // runtime consent rule (runtime.ts provenance contract) — a turn
    // whose provenance origin is not 'user' can never auto-approve; an
    // approval-gated action on such a turn is recorded as a pending
    // human approval and the action does NOT execute. This is exactly
    // the behavior the real AgentRuntime + governance gateway exhibit;
    // the double lets the test assert the webhook path feeds it the
    // provenance that triggers the rule.
    const agentRuntime = {
      runTurn: vi.fn(async (opts: { bot: BotConfig; message: string; sessionId?: string; provenance?: ProvenanceNote }) => {
        turnCalls.push({ botId: opts.bot.id, message: opts.message, sessionId: opts.sessionId, provenance: opts.provenance });
        if (opts.message.includes('NEEDS_APPROVAL')) {
          const isUserOrigin = !opts.provenance || opts.provenance.origin === 'user';
          if (isUserOrigin) {
            governedActionExecuted = true; // a user-origin turn may carry the user's own approval flow
          } else {
            approvalsRequested.push({ tool: 'dangerous_action', provenance: opts.provenance });
            // Paused for human approval — the action is NOT executed.
          }
        }
        return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      }),
    } as unknown as AgentRuntime;

    routineStore = new RoutineStore(dir);
    inboundStore = new RoutineInboundWebhookStore(dir);
    runStore = new RoutineRunStore(dir);
    const runExecutor = new RoutineRunExecutor({ runStore, agentRuntime, getBots: () => bots });

    const app = express();
    // Production mount order (index.ts): raw-body ingress BEFORE the
    // global JSON parser; management routes behind express.json().
    const ingress = createRoutineInboundWebhookRouter({
      routineStore,
      inboundStore,
      getBots: () => bots,
      runExecutor,
      audit: (action, fields) => auditCalls.push({ action, detail: fields.detail }),
    });
    app.use('/api/webhooks/routine', express.raw({ type: '*/*', limit: '64kb' }), ingress, inboundWebhookBodyErrorHandler);
    app.use(express.json());
    const routinesRouter = express.Router();
    registerRoutineRoutes(routinesRouter, {
      dataDir: dir,
      getBots: () => bots,
      hookStore: new RoutineHookStore(dir),
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
    });
    // registerRoutineRoutes created its own RoutineStore over the same
    // DB file; all stores read through SQLite per call, so management,
    // ingress and the CRUD routes agree (index.ts wires it the same way).
    registerRoutineInboundWebhookRoutes(routinesRouter, {
      routineStore,
      inboundStore,
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
    });
    app.use('/api/routines', routinesRouter);

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
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json: json as Record<string, never>, headers: res.headers };
  }

  async function rawPost(path: string, rawBody: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: rawBody });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json: json as Record<string, never>, headers: res.headers };
  }

  async function makeRoutine(promptTemplate = 'Handle this payload: {{payload}}'): Promise<string> {
    const r = await api('POST', '/api/routines', { name: 'Webhook routine', botId: 'worker', promptTemplate });
    expect(r.status).toBe(201);
    return (r.json as { routine: { id: string } }).routine.id;
  }

  async function makeTrigger(routineId: string, rateLimitPerHour?: number) {
    const r = await api('POST', `/api/routines/${routineId}/inbound-webhooks`, rateLimitPerHour ? { rateLimitPerHour } : {});
    expect(r.status).toBe(201);
    return r.json as { trigger: { id: string; routineId: string; enabled: boolean; rateLimitPerHour: number }; token: string; url: string };
  }

  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('valid token starts the routine with the JSON body as trigger input', async () => {
    const routineId = await makeRoutine();
    const { token, url } = await makeTrigger(routineId);
    expect(url).toBe(`http://127.0.0.1:4567/api/webhooks/routine/${token}`);

    const res = await api('POST', `/api/webhooks/routine/${token}`, { deploy: 'done', count: 3 });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ ok: true, accepted: true, routineId });
    const runId = (res.json as { runId: string }).runId;
    expect(typeof runId).toBe('string');

    await settle();
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].message).toBe('Handle this payload: {"deploy":"done","count":3}');
    expect(turnCalls[0].sessionId).toBe(`routine_${routineId}`);
    // Webhook provenance is attached so the consent rule applies.
    expect(turnCalls[0].provenance?.origin).toBe('webhook');
    expect(turnCalls[0].provenance?.relayed).toBe(true);

    // The run is a normal Activity/run-history record, trigger webhook,
    // with source IP + payload SHAPE in its audit entry — never values.
    const run = runStore.get(runId);
    expect(run?.trigger).toBe('webhook');
    expect(run?.status).toBe('succeeded');
    expect(run?.audit?.sourceIp).toContain('127.0.0.1');
    const summary = run?.audit?.payloadSummary as { keys: string[]; types: Record<string, string> };
    expect(summary.keys).toEqual(['count', 'deploy']);
    expect(summary.types).toEqual({ count: 'number', deploy: 'string' });
    expect(JSON.stringify(run?.audit)).not.toContain('done');
    // Host audit sink got the start event with the same summary-only shape.
    expect(auditCalls.some((a) => a.action === 'routine.webhook_started')).toBe(true);
  });

  it('token is stored hashed only; management list never exposes token or hash', async () => {
    const routineId = await makeRoutine();
    const { token, trigger } = await makeTrigger(routineId);
    const storedHash = inboundStore.getTokenHash(trigger.id);
    expect(storedHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(storedHash).not.toBe(token);
    expect(hashInboundWebhookToken(token)).toBe(storedHash);

    const listed = await api('GET', `/api/routines/${routineId}/inbound-webhooks`);
    expect(listed.status).toBe(200);
    const serialized = JSON.stringify(listed.json);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(storedHash as string);
    expect((listed.json as { urlTemplate: string }).urlTemplate).toContain('/api/webhooks/routine/<token>');
  });

  it('wrong token → generic 404 and the failure is journalled', async () => {
    const routineId = await makeRoutine();
    await makeTrigger(routineId);
    const wrong = generateWrongToken();
    const res = await api('POST', `/api/webhooks/routine/${wrong}`, { a: 1 });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not found' });
    await settle();
    expect(turnCalls).toHaveLength(0);
    const journal = inboundStore.listAuthJournal();
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(journal[0].reason).toBe('unknown_token');
    expect(journal[0].sourceIp).toContain('127.0.0.1');
    expect(auditCalls.some((a) => a.action === 'routine.webhook_auth_failed')).toBe(true);

    // Malformed token → the identical generic body.
    const malformed = await api('POST', '/api/webhooks/routine/not-a-token', { a: 1 });
    expect(malformed.status).toBe(404);
    expect(malformed.json).toEqual({ error: 'not found' });
  });

  it('verifyInboundWebhookToken is a constant-time digest compare (unit + code-level)', () => {
    const token = 'A'.repeat(43);
    const hash = hashInboundWebhookToken(token);
    expect(verifyInboundWebhookToken(token, hash)).toBe(true);
    expect(verifyInboundWebhookToken('B'.repeat(43), hash)).toBe(false);
    expect(verifyInboundWebhookToken('short', hash)).toBe(false);
    expect(verifyInboundWebhookToken(token, 'zz-not-hex')).toBe(false);
    // Code-level: the acceptance path must use timingSafeEqual.
    const src = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'routine-webhook-inbound.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual');
    const routerSrc = src.slice(src.indexOf('createRoutineInboundWebhookRouter'));
    expect(routerSrc).toContain('verifyInboundWebhookToken');
  });

  it('disabled trigger and disabled routine return the identical non-leaking 404', async () => {
    const routineId = await makeRoutine();
    const { token, trigger } = await makeTrigger(routineId);

    const unknown = await api('POST', `/api/webhooks/routine/${generateWrongToken()}`, { a: 1 });

    const patched = await api('PATCH', `/api/routines/${routineId}/inbound-webhooks/${trigger.id}`, { enabled: false });
    expect(patched.status).toBe(200);
    const disabledTrigger = await api('POST', `/api/webhooks/routine/${token}`, { a: 1 });
    expect(disabledTrigger.status).toBe(404);
    expect(disabledTrigger.json).toEqual(unknown.json);

    await api('PATCH', `/api/routines/${routineId}/inbound-webhooks/${trigger.id}`, { enabled: true });
    await api('PATCH', `/api/routines/${routineId}`, { enabled: false });
    const disabledRoutine = await api('POST', `/api/webhooks/routine/${token}`, { a: 1 });
    expect(disabledRoutine.status).toBe(404);
    expect(disabledRoutine.json).toEqual(unknown.json);
    await settle();
    expect(turnCalls).toHaveLength(0);
  });

  it('rotate invalidates the old token immediately; the new token works', async () => {
    const routineId = await makeRoutine();
    const { token: oldToken, trigger } = await makeTrigger(routineId);
    expect((await api('POST', `/api/webhooks/routine/${oldToken}`, { v: 1 })).status).toBe(202);

    const rotated = await api('POST', `/api/routines/${routineId}/inbound-webhooks/${trigger.id}/rotate`);
    expect(rotated.status).toBe(200);
    const newToken = (rotated.json as { token: string }).token;
    expect(newToken).not.toBe(oldToken);

    expect((await api('POST', `/api/webhooks/routine/${oldToken}`, { v: 2 })).status).toBe(404);
    expect((await api('POST', `/api/webhooks/routine/${newToken}`, { v: 3 })).status).toBe(202);
  });

  it('revoked trigger no longer fires', async () => {
    const routineId = await makeRoutine();
    const { token, trigger } = await makeTrigger(routineId);
    const del = await api('DELETE', `/api/routines/${routineId}/inbound-webhooks/${trigger.id}`);
    expect(del.status).toBe(200);
    expect((await api('POST', `/api/webhooks/routine/${token}`, { a: 1 })).status).toBe(404);
  });

  it('rate limit trips at the configured cap with 429 + Retry-After', async () => {
    const routineId = await makeRoutine();
    const { token } = await makeTrigger(routineId, 3);
    for (let i = 0; i < 3; i++) {
      expect((await api('POST', `/api/webhooks/routine/${token}`, { i })).status).toBe(202);
    }
    const fourth = await api('POST', `/api/webhooks/routine/${token}`, { i: 4 });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
    await settle();
    expect(turnCalls).toHaveLength(3);
  });

  it('oversized, non-JSON and malformed bodies are rejected without firing', async () => {
    const routineId = await makeRoutine();
    const { token } = await makeTrigger(routineId);
    const path = `/api/webhooks/routine/${token}`;

    const oversized = await rawPost(path, JSON.stringify({ data: 'x'.repeat(70 * 1024) }), {
      'content-type': 'application/json',
    });
    expect(oversized.status).toBe(413);

    const wrongType = await rawPost(path, '{"a":1}', { 'content-type': 'text/plain' });
    expect(wrongType.status).toBe(415);

    const malformed = await rawPost(path, '{not json', { 'content-type': 'application/json' });
    expect(malformed.status).toBe(400);

    await settle();
    expect(turnCalls).toHaveLength(0);
  });

  it('Idempotency-Key dedupe: the same key does not start the routine twice', async () => {
    const routineId = await makeRoutine();
    const { token } = await makeTrigger(routineId);
    const headers = { 'idempotency-key': 'delivery-42' };
    const first = await api('POST', `/api/webhooks/routine/${token}`, { a: 1 }, headers);
    expect(first.status).toBe(202);
    const second = await api('POST', `/api/webhooks/routine/${token}`, { a: 1 }, headers);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ ok: true, deduped: true, runId: (first.json as { runId: string }).runId });
    await settle();
    expect(turnCalls).toHaveLength(1);
    expect(runStore.countByRoutine(routineId)).toBe(1);

    // A different key is a new delivery.
    const third = await api('POST', `/api/webhooks/routine/${token}`, { a: 2 }, { 'idempotency-key': 'delivery-43' });
    expect(third.status).toBe(202);
    await settle();
    expect(turnCalls).toHaveLength(2);
  });

  it('governance: a webhook-started run pauses for approval instead of executing the gated action', async () => {
    const routineId = await makeRoutine('Do the thing. NEEDS_APPROVAL payload: {{payload}}');
    const { token } = await makeTrigger(routineId);
    const res = await api('POST', `/api/webhooks/routine/${token}`, { instruction: 'run the gated action' });
    expect(res.status).toBe(202);
    await settle();
    // The turn ran, hit the approval gate, and paused: an approval was
    // requested for a human and the gated action never executed.
    expect(turnCalls).toHaveLength(1);
    expect(approvalsRequested).toHaveLength(1);
    expect(approvalsRequested[0].provenance?.origin).toBe('webhook');
    expect(governedActionExecuted).toBe(false);
    const run = runStore.get((res.json as { runId: string }).runId);
    expect(run?.trigger).toBe('webhook');
  });

  it('summarizePayload records shape only — keys and types, never values', () => {
    const body = { secret: 'hunter2', nested: { deep: 'value' }, list: [1, 2], n: 5, ok: true, nil: null };
    const s = summarizePayload(body, 123);
    expect(s.keys).toEqual(['list', 'n', 'nested', 'nil', 'ok', 'secret']);
    expect(s.types).toEqual({ list: 'array', n: 'number', nested: 'object', nil: 'null', ok: 'boolean', secret: 'string' });
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect(JSON.stringify(s)).not.toContain('deep');
    expect(summarizePayload([1, 2, 3], 9)).toMatchObject({ topLevelType: 'array', keys: [] });
  });
});

function generateWrongToken(): string {
  // A well-shaped but unknown token (43 base64url chars).
  return `wrong${'x'.repeat(38)}`;
}
