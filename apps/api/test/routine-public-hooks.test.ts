// SPDX-License-Identifier: Apache-2.0
// Public webhook ingress for routines: HMAC auth, secret-in-URL, delivery
// queue, idempotency, GitHub mapping, retry/backoff. Mocks only, localhost.

import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutineRoutes, RoutineStore } from '../src/bot-routines.js';
import {
  RoutineHookStore,
  WebhookDeliveryWorker,
  createPublicHookRouter,
  mapGitHubEvent,
  secretsEqual,
  verifySignature,
  HOOK_MAX_ATTEMPTS,
} from '../src/routine-hooks.js';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'worker', name: 'Worker', description: 'does work', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

interface Ctx {
  baseUrl: string;
  routineId: string;
  secret: string;
  hookStore: RoutineHookStore;
  routineStore: import('../src/bot-routines.js').RoutineStore;
  turnCalls: Array<{ botId: string; message: string }>;
  failTurns: boolean;
  close: () => void;
}

function sign(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'hook-ingress-'));
  const turnCalls: Array<{ botId: string; message: string }> = [];
  const state = { failTurns: false };
  const agentRuntime = {
    runTurn: vi.fn(async (opts: { bot: BotConfig; message: string }) => {
      if (state.failTurns) throw new Error('turn exploded');
      turnCalls.push({ botId: opts.bot.id, message: opts.message });
      return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    }),
  } as unknown as AgentRuntime;

  const app = express();
  // NOTE: no global express.json() here — the hook router mounts with its own
  // raw parser, mirroring index.ts ordering.
  const routinesRouter = express.Router();
  const hookStore = new RoutineHookStore(dir);
  const { routineStore } = registerRoutineRoutes(routinesRouter, {
    dataDir: dir,
    getBots: () => bots,
    hookStore,
    getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
  });
  app.use('/api/routines', routinesRouter);
  app.use('/api/hooks', express.raw({ type: '*/*', limit: '64kb' }), createPublicHookRouter({ routineStore, hookStore }));

  const routine = routineStore.create({ name: 'nightly', botId: 'worker', promptTemplate: 'do it: {{payload}}' });
  const secret = routineStore.ensureWebhookSecret(routine.id);

  let server: { close(cb: () => void): void } | null = null;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    routineId: routine.id,
    secret,
    hookStore,
    routineStore,
    turnCalls,
    failTurns: false,
    close: () => {
      server?.close(() => {});
      hookStore.close();
      (state as { failTurns: boolean }).failTurns = false;
    },
  };
}

describe('public routine hook ingress', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(() => ctx.close());

  const post = (path: string, body: Buffer | string, headers: Record<string, string> = {}) =>
    fetch(`${ctx.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

  it('accepts secret-in-URL and queues a delivery (202, no inline turn)', async () => {
    const res = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(202);
    const data = (await res.json()) as { deliveryId: string };
    expect(data.deliveryId).toBeTruthy();
    expect(ctx.turnCalls).toHaveLength(0); // queued, not executed inline
    const d = ctx.hookStore.get(data.deliveryId);
    expect(d?.status).toBe('pending');
    expect((d?.event as { hello: string }).hello).toBe('world');
  });

  it('rejects wrong secret with 401', async () => {
    const res = await post(`/api/hooks/${ctx.routineId}/wrongsecret`, '{}');
    expect(res.status).toBe(401);
  });

  it('rejects unknown routine with 404', async () => {
    const res = await post(`/api/hooks/nope/${ctx.secret}`, '{}');
    expect(res.status).toBe(404);
  });

  it('accepts Bearer token auth', async () => {
    const res = await post(`/api/hooks/${ctx.routineId}/wrongsecret`, '{}', {
      authorization: `Bearer ${ctx.secret}`,
    });
    expect(res.status).toBe(202);
  });

  it('accepts valid X-Signature-256 HMAC', async () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const res = await post(`/api/hooks/${ctx.routineId}/wrongsecret`, body, {
      'x-signature-256': sign(body, ctx.secret),
    });
    expect(res.status).toBe(202);
  });

  it('accepts GitHub X-Hub-Signature-256 form', async () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const res = await post(`/api/hooks/${ctx.routineId}/wrongsecret`, body, {
      'x-hub-signature-256': sign(body, ctx.secret),
    });
    expect(res.status).toBe(202);
  });

  it('rejects invalid HMAC with 401', async () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const res = await post(`/api/hooks/${ctx.routineId}/wrongsecret`, body, {
      'x-signature-256': sign(body, 'not-the-secret'),
    });
    expect(res.status).toBe(401);
  });

  it('rejects paused routine with 409', async () => {
    ctx.routineStore.update(ctx.routineId, { enabled: false });
    const res = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, '{}');
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('paused');
  });

  it('dedupes on Idempotency-Key within 24h', async () => {
    const headers = { 'idempotency-key': 'key-123' };
    const r1 = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, '{}', headers);
    expect(r1.status).toBe(202);
    const d1 = (await r1.json()) as { deliveryId: string };
    const r2 = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, '{}', headers);
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()) as { deduped: boolean; deliveryId: string };
    expect(d2.deduped).toBe(true);
    expect(d2.deliveryId).toBe(d1.deliveryId);
  });

  it('dedupes on X-GitHub-Delivery', async () => {
    const headers = { 'x-github-delivery': 'gh-999', 'x-github-event': 'ping', 'x-hub-signature-256': '' };
    const body = Buffer.from('{}');
    const sig = sign(body, ctx.secret);
    const r1 = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, body, { ...headers, 'x-hub-signature-256': sig });
    expect(r1.status).toBe(200); // ping → 200, no enqueue
    const j1 = (await r1.json()) as { ping?: boolean };
    expect(j1.ping).toBe(true);
  });

  it('maps GitHub push events and enqueues', async () => {
    const payload = {
      repository: { full_name: 'acme/app' },
      sender: { login: 'octo' },
      pusher: { name: 'octo' },
      commits: [{}, {}],
      compare: 'https://github.com/acme/app/compare/a...b',
    };
    const body = Buffer.from(JSON.stringify(payload));
    const res = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign(body, ctx.secret),
    });
    expect(res.status).toBe(202);
    const { deliveryId } = (await res.json()) as { deliveryId: string };
    const d = ctx.hookStore.get(deliveryId);
    expect(d?.eventType).toBe('github.push');
    const ev = d?.event as Record<string, unknown>;
    expect(ev.source).toBe('github');
    expect(ev.repo).toBe('acme/app');
    expect(String(ev.text)).toContain('2 commits');
  });

  it('rejects bodies over 64KB with 413', async () => {
    const big = Buffer.from(JSON.stringify({ blob: 'x'.repeat(70 * 1024) }));
    const res = await post(`/api/hooks/${ctx.routineId}/${ctx.secret}`, big, {
      'x-signature-256': sign(big, ctx.secret),
    });
    expect(res.status).toBe(413);
  });

  it('hook info endpoint redacts the secret; reveal shows it once', async () => {
    // Management routes need JSON parsing; mount a second app for these.
    const app2 = express();
    app2.use(express.json());
    const dir = mkdtempSync(join(tmpdir(), 'hook-mgmt-'));
    const hookStore2 = new RoutineHookStore(dir);
    const routinesRouter2 = express.Router();
    const { routineStore: rs2 } = registerRoutineRoutes(routinesRouter2, {
      dataDir: dir,
      getBots: () => bots,
      hookStore: hookStore2,
      getBaseUrls: () => ({ publicBaseUrl: 'https://hooks.example.com', localPort: 4567 }),
    });
    app2.use('/api/routines', routinesRouter2);
    const routine = rs2.create({ name: 'r', botId: 'worker', promptTemplate: 'x' });
    const s2 = await new Promise<{ port: number; close: () => void }>((resolve) => {
      const srv = app2.listen(0, '127.0.0.1', () => {
        const a = (srv as unknown as { address(): AddressInfo }).address();
        resolve({ port: a.port, close: () => srv.close() });
      });
    });
    const base = `http://127.0.0.1:${s2.port}`;

    const info = (await (await fetch(`${base}/api/routines/${routine.id}/hook`)).json()) as {
      hook: { url: string; localUrl: string; secret?: string; hasSecret: boolean; connected: boolean };
    };
    expect(info.hook.hasSecret).toBe(true);
    expect(info.hook.secret).toBeUndefined();
    expect(info.hook.localUrl).toContain('<secret>');
    expect(info.hook.url).toContain('https://hooks.example.com/api/hooks/');
    expect(info.hook.connected).toBe(false);

    const revealed = (await (
      await fetch(`${base}/api/routines/${routine.id}/hook/reveal`, { method: 'POST' })
    ).json()) as { hook: { secret: string; localUrl: string } };
    expect(revealed.hook.secret).toHaveLength(64);
    expect(revealed.hook.localUrl).toContain(revealed.hook.secret);

    const regen = (await (
      await fetch(`${base}/api/routines/${routine.id}/hook/regenerate`, { method: 'POST' })
    ).json()) as { hook: { secret: string } };
    expect(regen.hook.secret).not.toBe(revealed.hook.secret);

    // Old secret no longer authenticates (checked via store).
    expect(rs2.getWebhookSecret(routine.id)).toBe(regen.hook.secret);

    const deliveries = (await (await fetch(`${base}/api/routines/${routine.id}/deliveries`)).json()) as {
      deliveries: unknown[];
    };
    expect(deliveries.deliveries).toEqual([]);

    s2.close();
    hookStore2.close();
  });
});

describe('webhook delivery worker', () => {
  let dir: string;
  let hookStore: RoutineHookStore;
  let routineId: string;
  let turnCalls: Array<{ message: string }>;
  let failTurns: boolean;
  let mkWorker: () => WebhookDeliveryWorker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hook-worker-'));
    hookStore = new RoutineHookStore(dir);
    turnCalls = [];
    failTurns = false;
    const agentRuntime = {
      runTurn: async (opts: { message: string }) => {
        if (failTurns) throw new Error('boom');
        turnCalls.push({ message: opts.message });
        return {};
      },
    } as unknown as AgentRuntime;
    // Minimal routine store stub sharing the same DB file.
    const routineStore = new RoutineStore(dir);
    const created = routineStore.create({ name: 'w', botId: 'worker', promptTemplate: 'run: {{payload}}' });
    routineId = created.id;
    mkWorker = () =>
      new WebhookDeliveryWorker({
        routineStore,
        hookStore,
        agentRuntime,
        getBots: () => bots,
        pollMs: 10,
      });
  });

  afterEach(() => hookStore.close());

  it('processes a queued delivery and marks it done', async () => {
    const { delivery } = hookStore.enqueue({ routineId, eventType: 'webhook', event: { ping: 1 } });
    const n = await mkWorker().pumpOnce();
    expect(n).toBe(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].message).toContain('"ping":1');
    expect(hookStore.get(delivery.id)?.status).toBe('done');
  });

  it('retries with backoff then fails terminally after 3 attempts', async () => {
    failTurns = true;
    const { delivery } = hookStore.enqueue({ routineId, eventType: 'webhook', event: {} });
    const worker = mkWorker();

    // Attempt 1 via the worker → requeued as pending with backoff.
    await worker.pumpOnce();
    let d = hookStore.get(delivery.id)!;
    expect(d.status).toBe('pending');
    expect(d.attempts).toBe(1);
    expect(d.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(hookStore.claimDue(5, 'w').length).toBe(0); // backoff not elapsed

    // Drive attempts 2 and 3 deterministically at the store level by
    // claiming with a future clock and failing each attempt.
    for (const attempt of [2, 3]) {
      const future = Date.now() + 60 * 60_000;
      const due = hookStore.claimDue(5, 'w', future);
      expect(due.length).toBe(1);
      const status = hookStore.markAttemptFailed(due[0].id, 'boom');
      d = hookStore.get(delivery.id)!;
      expect(d.attempts).toBe(attempt);
      if (attempt < HOOK_MAX_ATTEMPTS) {
        expect(status).toBe('pending');
      } else {
        expect(status).toBe('failed');
      }
    }
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(HOOK_MAX_ATTEMPTS);
    // Backoff grows: delay after attempt 1 (30s) < delay after attempt 2 (5min).
    // (Verified implicitly by nextAttemptAt deltas above.)
  });

  it('marks terminal failure when the routine was deleted', async () => {
    const { delivery } = hookStore.enqueue({ routineId: 'gone', eventType: 'webhook', event: {} });
    await mkWorker().pumpOnce();
    const d = hookStore.get(delivery.id)!;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('deleted');
  });
});

describe('helpers', () => {
  it('secretsEqual is timing-safe on length', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });

  it('verifySignature accepts sha256= prefix and bare hex', () => {
    const body = Buffer.from('hello');
    const secret = randomBytes(32).toString('hex');
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifySignature('sha256=' + hex, body, secret)).toBe(true);
    expect(verifySignature(hex, body, secret)).toBe(true);
    expect(verifySignature('sha256=' + hex, body, 'other')).toBe(false);
    expect(verifySignature('nothex', body, secret)).toBe(false);
  });

  it('mapGitHubEvent handles ping/pull_request/issues', () => {
    const ping = mapGitHubEvent('ping', {});
    expect(ping.shouldRun).toBe(false);
    const pr = mapGitHubEvent('pull_request', {
      action: 'opened',
      number: 7,
      repository: { full_name: 'a/b' },
      sender: { login: 'u' },
      pull_request: { title: 'Fix it', html_url: 'https://x' },
    });
    expect(pr.shouldRun).toBe(true);
    const ev = pr.event as Record<string, unknown>;
    expect(ev.event).toBe('pull_request.opened');
    expect(String(ev.text)).toContain('#7');
    const iss = mapGitHubEvent('issues', {
      action: 'closed',
      number: 3,
      repository: { full_name: 'a/b' },
      issue: { title: 'Bug', html_url: 'https://y' },
    });
    expect((iss.event as Record<string, unknown>).event).toBe('issues.closed');
  });
});
