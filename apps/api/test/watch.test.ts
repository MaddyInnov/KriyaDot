// SPDX-License-Identifier: Apache-2.0
// W5: proactive account watching — watch-rule CRUD + validation, the
// watcher service (baseline, triage surfacing, dedupe/cursor across
// restarts, daily cap, quiet-by-default), one-tap item actions
// (dismiss / draft), and the routing-based triage helper.
// Zero paid API usage: the Composio executor, the triage provider, the
// push service, and the draft runner are all mocked; no network happens.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig, LLMProvider } from '@mvp/agent-runtime';
import {
  WatchStore,
  validateWatchRuleInput,
  watchDayKey,
} from '../src/watch-rules.js';
import {
  WatcherService,
  createRoutingTriage,
  parseTriageVerdict,
  type WatchTriageFn,
} from '../src/watch-watcher.js';
import { registerWatchRoutes } from '../src/watch-routes.js';
import type { ComposioEventExecutor, EventItem } from '../src/routine-events.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import type { PushRequest } from '../src/push.js';

const BOT: BotConfig = {
  id: 'chief', name: 'Chief', description: 'test', systemPrompt: 'test',
  provider: 'groq', model: 'gpt-oss-20b', skills: [], tools: [], mcpServers: [],
} as unknown as BotConfig;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watch-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.UTC(2026, 9, 29, 6, 0, 0); // fixed "now" (UTC day 2026-10-29)

function mockExecutor(handler: (toolSlug: string) => unknown) {
  const calls: Array<{ toolSlug: string; accountId: string; botId: string }> = [];
  const executor: ComposioEventExecutor = {
    executeTool: async (input) => {
      calls.push({ toolSlug: input.toolSlug, accountId: input.accountId, botId: input.botId });
      return handler(input.toolSlug);
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

function mockPush() {
  const sent: PushRequest[] = [];
  const push = {
    notify: vi.fn(async (req: PushRequest) => {
      sent.push(req);
      return { attempted: 1, sent: 1 };
    }),
  };
  return { push, sent };
}

/** Triage that flags exactly the given source item ids. */
function triageFlagging(ids: string[], calls?: EventItem[]): WatchTriageFn {
  return async ({ item }) => {
    calls?.push(item);
    return ids.includes(item.id)
      ? { surface: true, urgency: 'high', reason: 'needs a reply', suggestedAction: 'Draft a reply' }
      : { surface: false, urgency: 'low', reason: 'routine', suggestedAction: '' };
  };
}

function makeWatcher(opts: {
  executor: ComposioEventExecutor;
  triage: WatchTriageFn;
  store?: WatchStore;
  push?: { notify: (req: PushRequest) => Promise<{ attempted: number; sent: number }> };
  dailyCap?: number;
}) {
  const store = opts.store ?? new WatchStore(dir);
  const rule = store.createRule(validateWatchRuleInput({
    app: 'gmail', accountId: 'ca_gmail1', kind: 'needs-reply', dailyCap: opts.dailyCap,
  }, { defaultBotId: 'chief' }));
  const watcher = new WatcherService({
    store, executor: opts.executor, triage: opts.triage, push: opts.push,
    getBotName: () => 'Chief',
  });
  return { store, rule, watcher };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('watch rule validation', () => {
  it('applies defaults: chief owner, 240m interval, cap 10, enabled', () => {
    const v = validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'needs-reply' }, { defaultBotId: 'chief' });
    expect(v.botId).toBe('chief');
    expect(v.intervalMinutes).toBe(240);
    expect(v.dailyCap).toBe(10);
    expect(v.enabled).toBe(true);
    expect(v.userId).toBe('default-user');
  });

  it('clamps the interval to 30..1440 minutes', () => {
    expect(validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'mention', intervalMinutes: 5 }).intervalMinutes).toBe(30);
    expect(validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'mention', intervalMinutes: 99999 }).intervalMinutes).toBe(1440);
    expect(validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'mention', intervalMinutes: 60 }).intervalMinutes).toBe(60);
  });

  it('requires an instruction for custom kind; structured kinds stand alone', () => {
    expect(() => validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'custom' })).toThrow(/instruction is required/);
    expect(validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'custom', instruction: 'flag invoices' }).instruction).toBe('flag invoices');
    expect(validateWatchRuleInput({ app: 'stripe', accountId: 'ca_1', kind: 'payment-failed' }).kind).toBe('payment-failed');
  });

  it('rejects unknown app/kind, missing account, bad timezone, bad source scoping', () => {
    expect(() => validateWatchRuleInput({ app: 'myspace', accountId: 'ca_1', kind: 'mention' })).toThrow(/app must be one of/);
    expect(() => validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'bogus' })).toThrow(/kind must be one of/);
    expect(() => validateWatchRuleInput({ app: 'gmail', kind: 'mention' })).toThrow(/accountId/);
    expect(() => validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'mention', timezone: 'Mars/Olympus' })).toThrow(/timezone/);
    expect(() => validateWatchRuleInput({ app: 'slack', accountId: 'ca_1', kind: 'mention' })).toThrow(/channelId/);
    expect(() => validateWatchRuleInput({ app: 'github', accountId: 'ca_1', kind: 'review-requested' })).toThrow(/repo/);
    expect(() => validateWatchRuleInput({ app: 'github', accountId: 'ca_1', kind: 'review-requested', repo: 'noslash' })).toThrow(/owner\/name/);
  });
});

// ---------------------------------------------------------------------------
// Watcher service
// ---------------------------------------------------------------------------

describe('WatcherService', () => {
  it('baselines on first poll (no triage, no surface), then surfaces a flagged new item with a push', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { push, sent } = mockPush();
    const triageCalls: EventItem[] = [];
    const { store, rule, watcher } = makeWatcher({ executor, triage: triageFlagging(['m2'], triageCalls), push });

    const first = await watcher.pollRule(rule, T0);
    expect(first.reason).toBe('baseline established');
    expect(first.surfaced).toBe(0);
    expect(triageCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);

    data = gmailData(['m1', 'm2', 'm3']);
    const second = await watcher.pollRule(rule, T0 + 60_000);
    expect(second.checked).toBe(2);
    expect(second.surfaced).toBe(1);
    expect(second.itemIds).toHaveLength(1);
    const items = store.listItems({ status: 'new' });
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceItemId).toBe('m2');
    expect(items[0]!.urgency).toBe('high');
    expect(items[0]!.suggestedAction).toBe('Draft a reply');
    // One "needs you" push through the existing push path.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('needsInput');
    expect(sent[0]!.botId).toBe('chief');
    expect(sent[0]!.body).toContain('Hello m2');
    // The run is recorded for Activity.
    const runs = store.listRuns({ ruleId: rule.id });
    expect(runs[0]).toMatchObject({ checked: 2, surfaced: 1 });
  });

  it('surface=false is quiet: no inbox entry, no push, only the run record', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { push, sent } = mockPush();
    const { store, rule, watcher } = makeWatcher({ executor, triage: triageFlagging([]), push });
    await watcher.pollRule(rule, T0);
    data = gmailData(['m1', 'm2']);
    const res = await watcher.pollRule(rule, T0 + 60_000);
    expect(res.checked).toBe(1);
    expect(res.surfaced).toBe(0);
    expect(store.listItems()).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(store.listRuns({ ruleId: rule.id })[0]).toMatchObject({ checked: 1, surfaced: 0 });
  });

  it('dedupes across polls and across restarts (cursor + seen-set persist)', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const first = makeWatcher({ executor, triage: triageFlagging(['m2']) });
    await first.watcher.pollRule(first.rule, T0);
    data = gmailData(['m1', 'm2']);
    const fired = await first.watcher.pollRule(first.rule, T0 + 60_000);
    expect(fired.surfaced).toBe(1);
    const again = await first.watcher.pollRule(first.rule, T0 + 120_000);
    expect(again.checked).toBe(0);
    expect(again.surfaced).toBe(0);

    // Restart: brand-new store + watcher over the same directory.
    const store2 = new WatchStore(dir);
    const state = store2.getState(first.rule.id);
    expect(state?.cursorId).toBe('m2');
    expect(store2.hasSeen(first.rule.id, 'm2')).toBe(true);
    const watcher2 = new WatcherService({ store: store2, executor, triage: triageFlagging(['m2']) });
    const rule2 = store2.getRule(first.rule.id)!;
    const res = await watcher2.pollRule(rule2, T0 + 180_000);
    expect(res.checked).toBe(0);
    expect(res.surfaced).toBe(0);
    expect(store2.listItems()).toHaveLength(1);
    expect(watcher2.reconcileOnBoot().cursors).toBe(1);
  });

  it('daily cap: extra flagged items stay unseen and surface the next day', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { store, rule, watcher } = makeWatcher({ executor, triage: triageFlagging(['a', 'b']), dailyCap: 1 });
    await watcher.pollRule(rule, T0); // baseline
    data = gmailData(['m1', 'a', 'b'], T0 + 10_000);
    const res = await watcher.pollRule(rule, T0 + 60_000);
    expect(res.surfaced).toBe(1);
    expect(res.capBlocked).toBe(1);
    expect(store.getState(rule.id)?.capBlocked).toBe(true);
    expect(store.hasSeen(rule.id, 'b')).toBe(false);
    expect(watchDayKey(rule, T0)).toBe('2026-10-29');
    expect(store.surfacedOn(rule.id, '2026-10-29')).toBe(1);

    const sameDay = await watcher.pollRule(rule, T0 + 120_000);
    expect(sameDay.surfaced).toBe(0);

    const nextDay = await watcher.pollRule(rule, T0 + 25 * 3_600_000);
    expect(nextDay.surfaced).toBe(1);
    expect(store.listItems()).toHaveLength(2);
    expect(store.surfacedOn(rule.id, '2026-10-30')).toBe(1);
  });

  it('poll errors are recorded and nothing surfaces', async () => {
    const { executor } = mockExecutor(() => { throw new Error('composio down'); });
    const { store, rule, watcher } = makeWatcher({ executor, triage: triageFlagging(['x']) });
    const res = await watcher.pollRule(rule, T0);
    expect(res.error).toContain('composio down');
    expect(store.getState(rule.id)?.lastError).toContain('composio down');
    expect(store.listRuns({ ruleId: rule.id })[0]?.error).toContain('composio down');
  });

  it('triage failure leaves items unseen for a later retry', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    let fail = true;
    const triage: WatchTriageFn = async () => {
      if (fail) throw new Error('provider down');
      return { surface: true, urgency: 'medium', reason: 'r', suggestedAction: 'Draft a reply' };
    };
    const { store, rule, watcher } = makeWatcher({ executor, triage });
    await watcher.pollRule(rule, T0);
    data = gmailData(['m1', 'm2']);
    const bad = await watcher.pollRule(rule, T0 + 60_000);
    expect(bad.error).toContain('provider down');
    expect(store.hasSeen(rule.id, 'm2')).toBe(false);
    fail = false;
    const good = await watcher.pollRule(rule, T0 + 120_000);
    expect(good.surfaced).toBe(1);
  });

  it('pollDue respects the rule check interval', async () => {
    const { executor, calls } = mockExecutor(() => gmailData(['m1']));
    const { watcher } = makeWatcher({ executor, triage: triageFlagging([]) });
    await watcher.pollDue(T0);
    expect(calls).toHaveLength(1);
    await watcher.pollDue(T0 + 60 * 60_000); // 1h < 240m default interval
    expect(calls).toHaveLength(1);
    await watcher.pollDue(T0 + 241 * 60_000);
    expect(calls).toHaveLength(2);
  });

  it('dismiss persists: a dismissed item never resurfaces', async () => {
    let data = gmailData(['m1']);
    const { executor } = mockExecutor(() => data);
    const { store, rule, watcher } = makeWatcher({ executor, triage: triageFlagging(['m2']) });
    await watcher.pollRule(rule, T0);
    data = gmailData(['m1', 'm2']);
    await watcher.pollRule(rule, T0 + 60_000);
    const item = store.listItems()[0]!;
    const dismissed = watcher.dismissItem(item.id);
    expect(dismissed?.status).toBe('dismissed');
    // Even after a "restart" the item stays dismissed and is not re-created.
    const store2 = new WatchStore(dir);
    expect(store2.getItem(item.id)?.status).toBe('dismissed');
    const res = await watcher.pollRule(rule, T0 + 120_000);
    expect(res.surfaced).toBe(0);
    expect(store.listItems({ status: 'new' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Triage helpers
// ---------------------------------------------------------------------------

describe('triage verdict parsing + routing triage', () => {
  it('parses strict JSON and tolerates surrounding prose', () => {
    expect(parseTriageVerdict('{"surface":true,"urgency":"high","reason":"r","suggestedAction":"a"}'))
      .toEqual({ surface: true, urgency: 'high', reason: 'r', suggestedAction: 'a' });
    expect(parseTriageVerdict('verdict: {"surface":false}'))
      .toMatchObject({ surface: false, urgency: 'medium' });
    expect(parseTriageVerdict('not json')).toBeNull();
    expect(parseTriageVerdict('{"surface":"yes"}')).toBeNull();
  });

  it('routing triage calls the routed cheap model and parses its verdict', async () => {
    const seen: Array<{ providerId: string; model: string }> = [];
    const providerFactory = (providerId: string): LLMProvider => ({
      providerId,
      chat: async (_msgs, _tools, opts) => {
        seen.push({ providerId, model: opts.model });
        return {
          content: '{"surface":true,"urgency":"medium","reason":"waiting on you","suggestedAction":"Draft a reply"}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      listModels: async () => [],
    });
    const triage = createRoutingTriage({ providerFactory });
    const store = new WatchStore(dir);
    const rule = store.createRule(validateWatchRuleInput({ app: 'gmail', accountId: 'ca_1', kind: 'needs-reply' }));
    const verdict = await triage({
      rule,
      item: { id: 'm1', ts: T0, kind: 'message', summary: 'Email from a: hi', fields: { sender: 'a' } },
    });
    expect(verdict).toMatchObject({ surface: true, reason: 'waiting on you' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

describe('watch HTTP API', () => {
  let base: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: WatchStore;

  beforeEach(async () => {
    writeAccountCache(dir, 'default-user', {
      ca_gmail1: { toolkitSlug: 'gmail', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
      ca_slack1: { toolkitSlug: 'slack', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
    });
    store = new WatchStore(dir);
    let data = gmailData(['m1', 'm2']);
    const { executor } = mockExecutor(() => data);
    void data;
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerWatchRoutes(router, {
      dataDir: dir,
      store,
      executor,
      triage: triageFlagging(['m2']),
      getBots: () => [BOT],
      chiefBotId: 'chief',
      draftRunner: {
        draft: async () => ({ text: 'Hi Alice, thanks — will do.', ref: 'session_watch_1' }),
      },
    });
    app.use('/api', router);
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

  it('CRUD: create (defaults + chief owner), list, patch, enable toggle, delete', async () => {
    const created = await req('POST', '/api/watch-rules', { app: 'gmail', accountId: 'ca_gmail1', kind: 'needs-reply' });
    expect(created.status).toBe(201);
    const rule = created.json.rule;
    expect(rule.botId).toBe('chief');
    expect(rule.intervalMinutes).toBe(240);
    expect(rule.dailyCap).toBe(10);
    expect(rule.enabled).toBe(true);

    const list = await req('GET', '/api/watch-rules');
    expect(list.json.rules).toHaveLength(1);

    const patched = await req('PATCH', `/api/watch-rules/${rule.id}`, { intervalMinutes: 10, instruction: 'only invoices' });
    expect(patched.status).toBe(200);
    expect(patched.json.rule.intervalMinutes).toBe(30); // clamped floor
    expect(patched.json.rule.instruction).toBe('only invoices');

    const toggled = await req('PATCH', `/api/watch-rules/${rule.id}`, { enabled: false });
    expect(toggled.json.rule.enabled).toBe(false);

    const del = await req('DELETE', `/api/watch-rules/${rule.id}`);
    expect(del.status).toBe(200);
    const gone = await req('GET', `/api/watch-rules/${rule.id}`);
    expect(gone.status).toBe(404);
  });

  it('400s: unknown account, wrong-app account, unknown bot, custom without instruction', async () => {
    const ghost = await req('POST', '/api/watch-rules', { app: 'gmail', accountId: 'ca_nope', kind: 'mention' });
    expect(ghost.status).toBe(400);
    expect(ghost.json.error ?? ghost.json.detail).toMatch(/unknown connected account/);
    const wrongApp = await req('POST', '/api/watch-rules', { app: 'gmail', accountId: 'ca_slack1', kind: 'mention' });
    expect(wrongApp.status).toBe(400);
    expect(wrongApp.json.error ?? wrongApp.json.detail).toMatch(/slack account, not gmail/);
    const badBot = await req('POST', '/api/watch-rules', { app: 'gmail', accountId: 'ca_gmail1', kind: 'mention', botId: 'ghost' });
    expect(badBot.status).toBe(400);
    const noInstruction = await req('POST', '/api/watch-rules', { app: 'gmail', accountId: 'ca_gmail1', kind: 'custom' });
    expect(noInstruction.status).toBe(400);
  });

  it('run-now surfaces an item; inbox lists it; dismiss + draft actions persist', async () => {
    const created = await req('POST', '/api/watch-rules', { app: 'gmail', accountId: 'ca_gmail1', kind: 'needs-reply' });
    const id = created.json.rule.id as string;
    // First run-now baselines (m1, m2 are history); nothing surfaces.
    const baseline = await req('POST', `/api/watch-rules/${id}/run-now`);
    expect(baseline.json.result.reason).toBe('baseline established');
    expect(store.listItems()).toHaveLength(0);

    // Seed a surfaced item the way the watcher would (executor data is
    // static in this harness) and exercise the item actions over HTTP.
    const item = store.createItem({
      ruleId: id, sourceItemId: 'm2', app: 'gmail', sourceKind: 'message',
      summary: 'Email from alice@example.com: Hello m2', fields: { sender: 'alice@example.com' },
      urgency: 'high', reason: 'needs a reply', suggestedAction: 'Draft a reply', itemTs: T0,
    })!;
    const inbox = await req('GET', '/api/watch-items?status=new');
    expect(inbox.json.items).toHaveLength(1);
    expect(inbox.json.items[0].id).toBe(item.id);

    const opened = await req('GET', `/api/watch-items/${item.id}`);
    expect(opened.status).toBe(200);
    expect(opened.json.rule.id).toBe(id);

    const drafted = await req('POST', `/api/watch-items/${item.id}/draft`);
    expect(drafted.status).toBe(200);
    expect(drafted.json.item.status).toBe('actioned');
    expect(drafted.json.item.draftText).toContain('Hi Alice');
    expect(drafted.json.item.draftRef).toBe('session_watch_1');
    // The draft record persists across a store reopen.
    expect(new WatchStore(dir).getItem(item.id)?.draftText).toContain('Hi Alice');

    const dismissed = await req('POST', `/api/watch-items/${item.id}/dismiss`);
    expect(dismissed.json.item.status).toBe('dismissed');
    const newOnly = await req('GET', '/api/watch-items?status=new');
    expect(newOnly.json.items).toHaveLength(0);

    const runs = await req('GET', `/api/watch-runs?ruleId=${id}`);
    expect(runs.json.runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.json.runs[0].note).toBe('baseline established');
  });
});
