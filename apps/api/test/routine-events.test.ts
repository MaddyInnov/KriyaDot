// SPDX-License-Identifier: Apache-2.0
// W2: connected-app event triggers — `event` schedule validation, the
// polling engine (dedupe cursors, bounded catch-up, daily cap, filter
// behavior), reuse of the server-side Composio execution path, and the
// routine API (account validation + event status).
// Zero paid API usage: the Composio executor and the agent runtime are
// both mocked; no network happens.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent } from '@mvp/agent-runtime';
import { RoutineStore, registerRoutineRoutes } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import { RoutineRunExecutor, RoutineRunStore } from '../src/routine-runs.js';
import {
  describeSchedule,
  validateRoutineSchedule,
  type EventSchedule,
} from '../src/routine-schedules.js';
import {
  EventTriggerPoller,
  EventTriggerStore,
  createComposioEventExecutor,
  normalizeItems,
  sourceCalls,
  type ComposioEventExecutor,
} from '../src/routine-events.js';
import type { ComposioClient } from '../src/composio.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import { writeFileSync } from 'node:fs';

const BOT: BotConfig = {
  id: 'helper', name: 'Helper', description: 'test', systemPrompt: 'test',
  provider: 'groq', model: 'gpt-oss-20b', skills: [], tools: [], mcpServers: [],
} as unknown as BotConfig;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routine-events-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.UTC(2026, 9, 29, 6, 0, 0); // a fixed "now" for poll tests

function gmailSchedule(extra?: Record<string, unknown>): EventSchedule {
  const s = validateRoutineSchedule({
    kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_gmail1', ...extra,
  });
  if (s.kind !== 'event') throw new Error('not event');
  return s;
}

function fakeRuntime() {
  const turns: Array<{ message: string; sessionId: string }> = [];
  const runtime = {
    runTurn: vi.fn(async (args: { message: string; sessionId: string; onEvent: (e: StreamEvent) => void }) => {
      turns.push({ message: args.message, sessionId: args.sessionId });
      args.onEvent({ type: 'token', content: 'done' });
      args.onEvent({ type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    }),
  } as unknown as AgentRuntime;
  return { runtime, turns };
}

/** Mock ComposioEventExecutor: serves queued list results per tool slug. */
function mockExecutor(handler: (toolSlug: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ toolSlug: string; args: Record<string, unknown>; accountId: string; botId: string }> = [];
  const executor: ComposioEventExecutor = {
    executeTool: async (input) => {
      calls.push({ toolSlug: input.toolSlug, args: input.args, accountId: input.accountId, botId: input.botId });
      return handler(input.toolSlug, input.args);
    },
  };
  return { executor, calls };
}

function gmailData(ids: string[], startTs = T0) {
  return {
    messages: ids.map((id, i) => ({
      messageId: id,
      sender: 'alice@example.com',
      subject: `Hello ${id}`,
      messageTimestamp: startTs + i * 1000,
    })),
  };
}

async function waitForRuns(runStore: RoutineRunStore, routineId: string, n: number) {
  for (let i = 0; i < 100; i++) {
    const runs = runStore.listByRoutine(routineId, 50);
    const settled = runs.filter((r) => ['succeeded', 'failed', 'cancelled', 'missed'].includes(r.status));
    if (settled.length >= n) return runs;
    await new Promise((r) => setTimeout(r, 10));
  }
  return runStore.listByRoutine(routineId, 50);
}

function makePoller(opts: {
  executor: ComposioEventExecutor;
  schedule?: EventSchedule;
  routineStore?: RoutineStore;
}) {
  const routineStore = opts.routineStore ?? new RoutineStore(dir);
  const routine = routineStore.create({
    name: 'watcher',
    botId: 'helper',
    promptTemplate: 'New event: {{payload}}',
    schedule: opts.schedule ?? gmailSchedule(),
  });
  const eventStore = new EventTriggerStore(dir);
  const runStore = new RoutineRunStore(dir);
  const { runtime, turns } = fakeRuntime();
  const runExecutor = new RoutineRunExecutor({
    runStore, agentRuntime: runtime, getBots: () => [BOT],
  });
  const poller = new EventTriggerPoller({
    routineStore, eventStore, executor: opts.executor, runExecutor, runStore,
  });
  return { routineStore, routine, eventStore, runStore, poller, turns };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('event schedule validation', () => {
  it('accepts a gmail event schedule with defaults (15m poll, cap 50)', () => {
    const s = gmailSchedule();
    expect(s.app).toBe('gmail');
    expect(s.pollMinutes).toBe(15);
    expect(s.dailyCap).toBe(50);
    expect(describeSchedule(s)).toContain('gmail');
  });

  it('rejects an unknown app and a missing account', () => {
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'myspace', accountId: 'ca_1' })).toThrow(/event app/);
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'gmail' })).toThrow(/accountId/);
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'bad id!' })).toThrow(/accountId/);
  });

  it('clamps poll interval to >= 5 minutes and validates the daily cap', () => {
    expect(() => gmailSchedule({ pollMinutes: 4 })).toThrow(/pollMinutes/);
    expect(gmailSchedule({ pollMinutes: 5 }).pollMinutes).toBe(5);
    expect(() => gmailSchedule({ dailyCap: 0 })).toThrow(/dailyCap/);
    expect(() => gmailSchedule({ dailyCap: 1001 })).toThrow(/dailyCap/);
  });

  it('requires slack channelId and github repo; validates enum filters', () => {
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'slack', accountId: 'ca_s1' })).toThrow(/channelId/);
    const slack = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'slack', accountId: 'ca_s1', channelId: 'C123', keyword: 'deploy' });
    expect(slack.kind).toBe('event');
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'github', accountId: 'ca_g1' })).toThrow(/repo/);
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'github', accountId: 'ca_g1', repo: 'noslash' })).toThrow(/repo/);
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'github', accountId: 'ca_g1', repo: 'o/r', eventTypes: ['issues', 'bogus'] })).toThrow(/unknown value/);
    const gh = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'github', accountId: 'ca_g1', repo: 'o/r' });
    if (gh.kind === 'event') expect(gh.eventTypes).toEqual(['issues', 'pull_request', 'push']);
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'stripe', accountId: 'ca_st1', stripeEventTypes: ['refund'] })).toThrow(/unknown value/);
    expect(() => validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_1', from: 42 })).toThrow(/from must be a string/);
  });

  it('calendar defaults: primary calendar and a 120-minute window', () => {
    const s = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'googlecalendar', accountId: 'ca_cal1' });
    if (s.kind !== 'event') throw new Error('not event');
    expect(s.calendarId).toBe('primary');
    expect(s.windowMinutes).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Source calls + normalization
// ---------------------------------------------------------------------------

describe('source calls filter at source', () => {
  it('gmail composes the search query from from/subject/query', () => {
    const s = gmailSchedule({ from: 'alice@example.com', subjectContains: 'invoice', query: 'has:attachment' });
    const [call] = sourceCalls(s, T0);
    expect(call.toolSlug).toBe('GMAIL_FETCH_EMAILS');
    expect(call.args.query).toBe('from:alice@example.com subject:invoice has:attachment');
  });

  it('github fans out per subscribed event type', () => {
    const s = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'github', accountId: 'ca_g1', repo: 'octo/repo', eventTypes: ['issues', 'push'] });
    if (s.kind !== 'event') throw new Error('not event');
    const slugs = sourceCalls(s, T0).map((c) => c.toolSlug);
    expect(slugs).toEqual(['GITHUB_LIST_ISSUES', 'GITHUB_LIST_COMMITS']);
  });

  it('calendar scopes the list call to the lookahead window', () => {
    const s = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'googlecalendar', accountId: 'ca_cal1', windowMinutes: 60 });
    if (s.kind !== 'event') throw new Error('not event');
    const [call] = sourceCalls(s, T0);
    expect(call.args.timeMin).toBe(new Date(T0).toISOString());
    expect(call.args.timeMax).toBe(new Date(T0 + 3_600_000).toISOString());
  });
});

describe('normalization + receipt-side filters', () => {
  it('slack keyword filter drops non-matching messages', () => {
    const s = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'slack', accountId: 'ca_s1', channelId: 'C1', keyword: 'deploy' });
    if (s.kind !== 'event') throw new Error('not event');
    const [call] = sourceCalls(s, T0);
    const items = normalizeItems(s, call, {
      messages: [
        { ts: '1760000000.0001', user: 'U1', text: 'deploy finished' },
        { ts: '1760000001.0002', user: 'U2', text: 'lunch?' },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain('deploy finished');
  });

  it('stripe keeps only configured payment outcomes', () => {
    const s = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'stripe', accountId: 'ca_st1', stripeEventTypes: ['payment_failed'] });
    if (s.kind !== 'event') throw new Error('not event');
    const [call] = sourceCalls(s, T0);
    const items = normalizeItems(s, call, {
      data: [
        { id: 'evt_1', type: 'payment_intent.succeeded', created: 1760000000, data: { object: { amount: 500, currency: 'usd' } } },
        { id: 'evt_2', type: 'charge.failed', created: 1760000100, data: { object: { amount: 700, currency: 'usd' } } },
        { id: 'evt_3', type: 'customer.created', created: 1760000200, data: { object: {} } },
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['evt_2']);
    expect(items[0]!.kind).toBe('payment_failed');
  });

  it('github: a merged PR yields both opened and merged items; PRs are excluded from issues', () => {
    const s = validateRoutineSchedule({ kind: 'event', timezone: 'UTC', app: 'github', accountId: 'ca_g1', repo: 'o/r' });
    if (s.kind !== 'event') throw new Error('not event');
    const calls = sourceCalls(s, T0);
    const prCall = calls.find((c) => c.category === 'pull_request')!;
    const items = normalizeItems(s, prCall, {
      items: [{ number: 7, title: 'Fix it', state: 'closed', created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T00:00:00Z' }],
    });
    expect(items.map((i) => i.id)).toEqual(['pr:7:opened', 'pr:7:merged']);
    const issueCall = calls.find((c) => c.category === 'issues')!;
    const issueItems = normalizeItems(s, issueCall, {
      items: [
        { number: 8, title: 'Real issue', created_at: '2026-10-01T00:00:00Z' },
        { number: 9, title: 'A PR in disguise', created_at: '2026-10-01T00:00:00Z', pull_request: { url: 'x' } },
      ],
    });
    expect(issueItems.map((i) => i.id)).toEqual(['issue:8:opened']);
  });
});

// ---------------------------------------------------------------------------
// Polling engine
// ---------------------------------------------------------------------------

describe('EventTriggerPoller', () => {
  it('baselines on first poll, then fires a new item exactly once', async () => {
    let data = gmailData(['m1']);
    const { executor, calls } = mockExecutor(() => data);
    const { routine, poller, runStore, turns } = makePoller({ executor });

    const first = await poller.pollRoutine(routine, T0);
    expect(first.reason).toBe('baseline established');
    expect(first.firedRunIds).toHaveLength(0);

    data = gmailData(['m1', 'm2']);
    const second = await poller.pollRoutine(routine, T0 + 60_000);
    expect(second.firedRunIds).toHaveLength(1);
    const runs = await waitForRuns(runStore, routine.id, 1);
    const fired = runs.find((r) => r.id === second.firedRunIds[0])!;
    expect(fired.trigger).toBe('event');
    expect(fired.status).toBe('succeeded');
    // The bot's prompt carries the triggering item's summary.
    expect(turns[0]!.message).toContain('Hello m2');
    expect(turns[0]!.message).toContain('alice@example.com');
    expect(calls[0]!.accountId).toBe('ca_gmail1');
    expect(calls[0]!.botId).toBe('helper');

    // Same items again → no second fire, ever.
    const third = await poller.pollRoutine(routine, T0 + 120_000);
    expect(third.firedRunIds).toHaveLength(0);
    expect(runStore.countByRoutine(routine.id)).toBe(1);
  });

  it('filter mismatch at receipt → no fire (gmail from/subject)', async () => {
    const schedule = gmailSchedule({ from: 'boss@example.com', subjectContains: 'urgent' });
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { routine, poller, runStore } = makePoller({ executor, schedule });
    await poller.pollRoutine(routine, T0); // baseline
    data = {
      messages: [
        { messageId: 'm2', sender: 'alice@example.com', subject: 'urgent thing', messageTimestamp: T0 + 1000 },
        { messageId: 'm3', sender: 'boss@example.com', subject: 'weekly sync', messageTimestamp: T0 + 2000 },
      ],
    };
    const res = await poller.pollRoutine(routine, T0 + 60_000);
    expect(res.firedRunIds).toHaveLength(0);
    expect(runStore.countByRoutine(routine.id)).toBe(0);
  });

  it('cursor + seen-set persist across store reopen (no re-fire after restart)', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const first = makePoller({ executor });
    await first.poller.pollRoutine(first.routine, T0);
    data = gmailData(['m1', 'm2']);
    const fired = await first.poller.pollRoutine(first.routine, T0 + 60_000);
    expect(fired.firedRunIds).toHaveLength(1);
    await waitForRuns(first.runStore, first.routine.id, 1);

    // Simulate a restart: brand-new stores + poller over the same dir.
    const routineStore2 = new RoutineStore(dir);
    const eventStore2 = new EventTriggerStore(dir);
    const state = eventStore2.getState(first.routine.id);
    expect(state?.cursorId).toBe('m2');
    expect(eventStore2.hasSeen(first.routine.id, 'm2')).toBe(true);
    const runStore2 = new RoutineRunStore(dir);
    const { runtime } = fakeRuntime();
    const poller2 = new EventTriggerPoller({
      routineStore: routineStore2,
      eventStore: eventStore2,
      executor,
      runExecutor: new RoutineRunExecutor({ runStore: runStore2, agentRuntime: runtime, getBots: () => [BOT] }),
      runStore: runStore2,
    });
    const routine2 = routineStore2.get(first.routine.id)!;
    const res = await poller2.pollRoutine(routine2, T0 + 120_000);
    expect(res.firedRunIds).toHaveLength(0);
    expect(runStore2.countByRoutine(first.routine.id)).toBe(1);
  });

  it('catch-up after downtime is bounded to the 5 most recent, with the skip noted', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { routine, poller, runStore } = makePoller({ executor });
    await poller.pollRoutine(routine, T0); // baseline

    // 8 items arrive "while down"; the next poll is this process's first
    // for the trigger with a backlog → catch-up mode after a simulated
    // restart (new poller instance, same stores).
    data = gmailData(['m1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'], T0 + 10_000);
    const routineStore2 = new RoutineStore(dir);
    const eventStore2 = new EventTriggerStore(dir);
    const runStore2 = new RoutineRunStore(dir);
    const { runtime } = fakeRuntime();
    const poller2 = new EventTriggerPoller({
      routineStore: routineStore2,
      eventStore: eventStore2,
      executor,
      runExecutor: new RoutineRunExecutor({ runStore: runStore2, agentRuntime: runtime, getBots: () => [BOT] }),
      runStore: runStore2,
    });
    const res = await poller2.pollRoutine(routineStore2.get(routine.id)!, T0 + 3_600_000);
    expect(res.firedRunIds).toHaveLength(5);
    expect(res.skippedCatchUp).toBe(3);
    const runs = await waitForRuns(runStore2, routine.id, 6);
    const missed = runs.find((r) => r.status === 'missed');
    expect(missed?.trigger).toBe('event');
    expect(missed?.error).toContain('skipped 3 older');
    // And the skipped ones never fire later.
    const again = await poller2.pollRoutine(routineStore2.get(routine.id)!, T0 + 3_700_000);
    expect(again.firedRunIds).toHaveLength(0);
  });

  it('daily cap stops firing until the next day; backlog fires as catch-up', async () => {
    const schedule = gmailSchedule({ dailyCap: 2 });
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { routine, poller, runStore, eventStore } = makePoller({ executor, schedule });
    await poller.pollRoutine(routine, T0); // baseline

    data = gmailData(['m1', 'a', 'b', 'c'], T0 + 10_000);
    const res = await poller.pollRoutine(routine, T0 + 60_000);
    expect(res.firedRunIds).toHaveLength(2);
    expect(res.capBlocked).toBe(1);
    expect(eventStore.getState(routine.id)?.capBlocked).toBe(true);
    await waitForRuns(runStore, routine.id, 2);

    // Still capped later the same day: nothing new fires.
    const sameDay = await poller.pollRoutine(routine, T0 + 120_000);
    expect(sameDay.firedRunIds).toHaveLength(0);

    // Next day the backlog item fires (catch-up mode, within the bound).
    const nextDay = await poller.pollRoutine(routine, T0 + 25 * 3_600_000);
    expect(nextDay.firedRunIds).toHaveLength(1);
    await waitForRuns(runStore, routine.id, 3);
    expect(eventStore.firesOn(routine.id, '2026-10-30')).toBe(1);
  });

  it('poll errors are recorded on the cursor and do not fire', async () => {
    const { executor } = mockExecutor(() => { throw new Error('composio down'); });
    const { routine, poller, eventStore } = makePoller({ executor });
    const res = await poller.pollRoutine(routine, T0);
    expect(res.error).toContain('composio down');
    expect(eventStore.getState(routine.id)?.lastError).toContain('composio down');
    expect(eventStore.getState(routine.id)?.lastPollAt).toBe(T0);
  });

  it('pollDue respects the per-trigger poll interval', async () => {
    const { executor, calls } = mockExecutor(() => gmailData(['m1']));
    const { poller } = makePoller({ executor });
    await poller.pollDue(T0);
    expect(calls).toHaveLength(1);
    await poller.pollDue(T0 + 60_000); // 1m later < 15m interval
    expect(calls).toHaveLength(1);
    await poller.pollDue(T0 + 16 * 60_000);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Composio execution path reuse
// ---------------------------------------------------------------------------

describe('createComposioEventExecutor (shared Composio path)', () => {
  function mockClient(data: unknown) {
    const executed: Array<{ toolSlug: string; connectedAccountId: string; userId: string; args: Record<string, unknown> }> = [];
    const client: ComposioClient = {
      validateApiKey: async () => ({ ok: true }),
      listApps: async () => [],
      createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
      listConnectedAccounts: async () => [{ id: 'ca_gmail1', toolkitSlug: 'gmail', status: 'ACTIVE' }],
      getConnectedAccount: async (_k, id) => (id === 'ca_gmail1' ? { id, toolkitSlug: 'gmail', status: 'ACTIVE' } : null),
      deleteConnectedAccount: async () => {},
      revokeConnectedAccount: async () => {},
      listTools: async () => [],
      executeTool: async (_k, input) => {
        executed.push({ ...input });
        return { successful: true, data };
      },
    };
    return { client, executed };
  }

  it('executes through the vault key + account resolution + per-bot gate', async () => {
    // Seed the account cache, the per-bot enablement, and the vault key
    // the same way the production routes do.
    writeAccountCache(dir, 'default-user', {
      ca_gmail1: { toolkitSlug: 'gmail', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
    });
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ helper: { gmail: true } }));
    const { SecureVault } = await import('@mvp/vault');
    new SecureVault(dir, 'default-user', 'default-user').create('composio-api-key', 'test-key', 'test');

    const { client, executed } = mockClient({ messages: [] });
    const executor = createComposioEventExecutor({ dataDir: dir, client });
    const data = await executor.executeTool({
      userId: 'default-user', botId: 'helper', accountId: 'ca_gmail1',
      toolSlug: 'GMAIL_FETCH_EMAILS', args: { max_results: 25 },
    });
    expect(data).toEqual({ messages: [] });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.connectedAccountId).toBe('ca_gmail1');
    expect(executed[0]!.userId).toBe('default-user');

    // A bot without the app enabled is refused before any execution.
    await expect(executor.executeTool({
      userId: 'default-user', botId: 'other-bot', accountId: 'ca_gmail1',
      toolSlug: 'GMAIL_FETCH_EMAILS', args: {},
    })).rejects.toThrow(/not enabled for bot/);
    expect(executed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

describe('routine API: event triggers', () => {
  let base: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    writeAccountCache(dir, 'default-user', {
      ca_gmail1: { toolkitSlug: 'gmail', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
      ca_slack1: { toolkitSlug: 'slack', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
    });
    const app = express();
    app.use(express.json());
    const routinesRouter = express.Router();
    registerRoutineRoutes(routinesRouter, {
      dataDir: dir,
      getBots: () => [BOT],
      hookStore: new RoutineHookStore(dir),
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
      eventStore: new EventTriggerStore(dir),
    });
    app.use('/api/routines', routinesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    base = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  const eventBody = (schedule: Record<string, unknown>) => ({
    name: 'watcher', botId: 'helper', promptTemplate: 'act on {{payload}}', schedule,
  });

  it('creates an event routine when the account exists for the app', async () => {
    const res = await req('POST', '/api/routines', eventBody({
      kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_gmail1', from: 'alice@example.com',
    }));
    expect(res.status).toBe(201);
    expect(res.json.routine.schedule.kind).toBe('event');
    expect(res.json.routine.schedule.pollMinutes).toBe(15);
  });

  it('400s: unknown app, missing account, unknown account, wrong-app account, bad filter', async () => {
    const unknownApp = await req('POST', '/api/routines', eventBody({ kind: 'event', timezone: 'UTC', app: 'myspace', accountId: 'ca_gmail1' }));
    expect(unknownApp.status).toBe(400);
    const missing = await req('POST', '/api/routines', eventBody({ kind: 'event', timezone: 'UTC', app: 'gmail' }));
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/accountId/);
    const ghost = await req('POST', '/api/routines', eventBody({ kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_nope' }));
    expect(ghost.status).toBe(400);
    expect(ghost.json.error).toMatch(/unknown connected account/);
    const wrongApp = await req('POST', '/api/routines', eventBody({ kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_slack1' }));
    expect(wrongApp.status).toBe(400);
    expect(wrongApp.json.error).toMatch(/slack account, not gmail/);
    const badFilter = await req('POST', '/api/routines', eventBody({ kind: 'event', timezone: 'UTC', app: 'slack', accountId: 'ca_slack1' }));
    expect(badFilter.status).toBe(400);
    expect(badFilter.json.error).toMatch(/channelId/);
    const badInterval = await req('POST', '/api/routines', eventBody({ kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_gmail1', pollMinutes: 1 }));
    expect(badInterval.status).toBe(400);
  });

  it('event-trigger status returns cursor state and daily counts', async () => {
    const created = await req('POST', '/api/routines', eventBody({
      kind: 'event', timezone: 'UTC', app: 'gmail', accountId: 'ca_gmail1',
    }));
    const id = created.json.routine.id as string;
    // Seed poller state as the engine would.
    const store = new EventTriggerStore(dir);
    store.upsertState(id, { cursorId: 'm9', cursorTs: T0, lastPollAt: T0, lastFiredAt: T0 });
    store.recordFire(id, '2026-10-29');
    const res = await req('GET', `/api/routines/${id}/event-trigger`);
    expect(res.status).toBe(200);
    expect(res.json.status.cursorId).toBe('m9');
    expect(res.json.status.dailyCap).toBe(50);
    // A non-event routine 400s on the status route.
    const plain = await req('POST', '/api/routines', { name: 'plain', botId: 'helper', promptTemplate: 'x' });
    const bad = await req('GET', `/api/routines/${plain.json.routine.id}/event-trigger`);
    expect(bad.status).toBe(400);
  });

  it('PATCH can replace a schedule with an event schedule (account-checked)', async () => {
    const created = await req('POST', '/api/routines', { name: 'plain', botId: 'helper', promptTemplate: 'x' });
    const id = created.json.routine.id as string;
    const ok = await req('PATCH', `/api/routines/${id}`, {
      schedule: { kind: 'event', timezone: 'UTC', app: 'slack', accountId: 'ca_slack1', channelId: 'C99' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.routine.schedule.app).toBe('slack');
    const bad = await req('PATCH', `/api/routines/${id}`, {
      schedule: { kind: 'event', timezone: 'UTC', app: 'slack', accountId: 'ca_ghost', channelId: 'C99' },
    });
    expect(bad.status).toBe(400);
  });
});
