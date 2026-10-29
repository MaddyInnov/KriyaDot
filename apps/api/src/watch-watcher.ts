// SPDX-License-Identifier: Apache-2.0
// Proactive account watching (W5) — the watcher service.
//
// A scheduler ticks (like BriefingScheduler / EventTriggerPoller) and
// runs every due enabled watch rule (watch-rules.ts):
//
//   1. LIST recent items from the rule's connected app through the exact
//      W2 path: sourceCalls + normalizeItems (routine-events.ts) over
//      the server-side Composio executor (vault key → account resolution
//      → per-bot enable gate → executeTool). The persisted cursor +
//      seen-set give the same guarantees as W2: an item is processed at
//      most once across restarts, and a rule's first-ever poll only
//      baselines (existing items are history, never surfaced).
//   2. TRIAGE each new item with a cheap helper model: routeModel with
//      taskType 'simple-qa' (packages/agent-runtime/src/routing.ts —
//      cheapest eligible model, free-only guard honored) answers one
//      strict-JSON question: does this item need the user's decision or
//      action per the rule's flag instruction?
//   3. SURFACE only verdict.surface === true items, bounded by the
//      rule's daily cap: the item becomes a "needs you" entry in the
//      watch inbox (WatchStore items, rendered by the existing
//      approvals/inbox UI) and a 'needsInput' push goes out through the
//      existing PushService. surface === false → nothing at all: no
//      inbox entry, no push — only the run's Activity/audit line.
//
// Bounded catch-up mirrors W2: the first poll of a process for a rule
// with a backlog (or a poll after a daily-cap block) triages at most
// MAX_EVENT_CATCH_UP_FIRES most-recent missed items; older ones are
// marked seen and the skip is noted on the run record.

import type { AgentRuntime, BotConfig, LLMProvider } from '@mvp/agent-runtime';
import { createProvider, routeModel } from '@mvp/agent-runtime';
import type { EventSchedule } from './routine-schedules.js';
import {
  MAX_EVENT_CATCH_UP_FIRES,
  normalizeItems,
  sourceCalls,
  type ComposioEventExecutor,
  type EventItem,
} from './routine-events.js';
import {
  effectiveInstruction,
  watchDayKey,
  WATCH_SEEN_RETENTION_MS,
  type WatchItem,
  type WatchRule,
  type WatchStore,
  type WatchUrgency,
} from './watch-rules.js';
import type { PushService } from './push.js';

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export interface TriageVerdict {
  surface: boolean;
  urgency: WatchUrgency;
  reason: string;
  suggestedAction: string;
}

export interface TriageInput {
  rule: WatchRule;
  item: EventItem;
}

/** Triage one item. Resolves null when no verdict could be produced. */
export type WatchTriageFn = (input: TriageInput) => Promise<TriageVerdict | null>;

export const TRIAGE_QUIET_VERDICT: TriageVerdict = {
  surface: false,
  urgency: 'low',
  reason: 'triage produced no verdict',
  suggestedAction: '',
};

export function buildTriagePrompt(rule: WatchRule, item: EventItem): { system: string; user: string } {
  const system =
    'You triage items from a connected app for a busy user. Decide whether the item needs the ' +
    'user\'s decision or action, per the watch instruction. Answer with STRICT JSON only — no ' +
    'markdown, no prose — of the form: {"surface": boolean, "urgency": "low"|"medium"|"high", ' +
    '"reason": string, "suggestedAction": string}. "reason" is one short sentence. ' +
    '"suggestedAction" is the single next step you recommend (e.g. "Draft a reply", ' +
    '"Pay the failed invoice", "Reschedule one meeting") or "" when not surfacing. ' +
    'When in doubt, do NOT surface: the user wants a quiet inbox.';
  const fieldLines = Object.entries(item.fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const user = [
    `Watch instruction: ${effectiveInstruction(rule)}`,
    `App: ${rule.app} (rule kind: ${rule.kind})`,
    '',
    'Item:',
    item.summary,
    fieldLines,
    item.ts ? `at: ${new Date(item.ts).toISOString()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}

/** Parse a strict-JSON triage verdict; null when unusable (fail quiet). */
export function parseTriageVerdict(text: string): TriageVerdict | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.surface !== 'boolean') return null;
  const urgency = v.urgency === 'low' || v.urgency === 'high' ? v.urgency : 'medium';
  return {
    surface: v.surface,
    urgency,
    reason: typeof v.reason === 'string' ? v.reason.slice(0, 500) : '',
    suggestedAction: typeof v.suggestedAction === 'string' ? v.suggestedAction.slice(0, 300) : '',
  };
}

export interface RoutingTriageDeps {
  /** Provider factory (tests inject a mock; production: createProvider). */
  providerFactory?: (providerId: string) => LLMProvider;
  /** Routing override (tests). Default: routeModel simple-qa. */
  route?: (rule: WatchRule) => { providerId: string; modelId: string };
}

/**
 * Production triage: the cheapest eligible model via the runtime's
 * routing (simple-qa → free models first, then lowest list price; the
 * FREE_MODELS_ONLY guard is honored inside routeModel). Any failure —
 * no provider, no key, unparseable reply — resolves null and the item
 * stays quiet. (A triage function that *throws* instead is treated by
 * the watcher as infrastructure failure: the item stays unseen and a
 * later poll retries it.)
 */
export function createRoutingTriage(deps: RoutingTriageDeps = {}): WatchTriageFn {
  const factory = deps.providerFactory ?? ((id: string) => createProvider(id));
  return async ({ rule, item }) => {
    try {
      const route =
        deps.route?.(rule) ?? routeModel({ taskType: 'simple-qa', providerHint: undefined });
      const provider = factory(route.providerId);
      const { system, user } = buildTriagePrompt(rule, item);
      const res = await provider.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        [],
        { model: route.modelId, signal: AbortSignal.timeout(30_000) },
      );
      return parseTriageVerdict(res.content ?? '');
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Draft replies (one-tap action)
// ---------------------------------------------------------------------------

export interface DraftResult {
  text: string;
  ref?: string;
}

export interface WatchDraftRunner {
  draft(input: { rule: WatchRule; item: WatchItem }): Promise<DraftResult>;
}

/**
 * Production draft runner: a turn by the rule's owner bot in a fresh
 * `watch_<item>` session, instructed to draft (never send) a reply.
 * The resulting text is stored on the watch item as its draft record.
 */
export function createBotTurnDraftRunner(deps: {
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
}): WatchDraftRunner {
  return {
    async draft({ rule, item }) {
      const bot = deps.getBots().find((b) => b.id === rule.botId);
      if (!bot) throw new Error(`unknown owner bot "${rule.botId}"`);
      const fieldLines = Object.entries(item.fields)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      const message = [
        `Draft a reply for the user to review. Do NOT send anything — only write the draft text.`,
        ``,
        `Watched item from ${item.app}: ${item.summary}`,
        fieldLines,
        item.reason ? `Why it was flagged: ${item.reason}` : '',
        item.suggestedAction ? `Suggested action: ${item.suggestedAction}` : '',
        ``,
        `Write a concise, ready-to-send draft reply in the user's voice. Output only the draft.`,
      ]
        .filter(Boolean)
        .join('\n');
      let text = '';
      const sessionId = `watch_${item.id}`;
      await deps.agentRuntime.runTurn({
        bot,
        message,
        sessionId,
        taskType: 'chat',
        onEvent: (e) => {
          if (e.type === 'token' && typeof e.content === 'string') text += e.content;
        },
      });
      const draft = text.trim();
      if (!draft) throw new Error('the drafting turn produced no text');
      return { text: draft.slice(0, 8000), ref: sessionId };
    },
  };
}

// ---------------------------------------------------------------------------
// Watcher service
// ---------------------------------------------------------------------------

export interface WatchPollResult {
  ruleId: string;
  polled: boolean;
  reason?: string;
  listed: number;
  checked: number;
  surfaced: number;
  /** Ids of watch items created by this poll. */
  itemIds: string[];
  skippedCatchUp: number;
  capBlocked: number;
  error?: string;
}

export interface WatcherDeps {
  store: WatchStore;
  /** Server-side Composio execution (createComposioEventExecutor). */
  executor: ComposioEventExecutor;
  /** Helper-model triage (createRoutingTriage in production). */
  triage: WatchTriageFn;
  /** Existing push path; surfaced items send one 'needsInput' push. */
  push?: Pick<PushService, 'notify'>;
  /** Draft runner for the one-tap Draft action. */
  draftRunner?: WatchDraftRunner;
  /** Bot display names for pushes. */
  getBotName?: (botId: string) => string | undefined;
  /** Governance audit sink (Activity): every run + every surface. */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Clock override for tests. */
  now?: () => number;
  /** Global pause gate (W14d): while paused, polls skip entirely. */
  isPaused?: () => boolean;
}

/** Adapt a watch rule to the W2 event-source shape (list + normalize). */
export function watchEventSchedule(rule: WatchRule): EventSchedule {
  const schedule: EventSchedule = {
    kind: 'event',
    timezone: rule.timezone,
    enabled: rule.enabled,
    overlap: 'skip',
    app: rule.app,
    accountId: rule.accountId,
    userId: rule.userId,
    pollMinutes: Math.max(5, Math.round(rule.intervalMinutes)),
    dailyCap: rule.dailyCap,
  };
  if (rule.channelId) schedule.channelId = rule.channelId;
  if (rule.repo) {
    schedule.repo = rule.repo;
    schedule.eventTypes = ['issues', 'pull_request', 'push'];
  }
  if (rule.calendarId) schedule.calendarId = rule.calendarId;
  if (rule.app === 'googlecalendar' && !schedule.calendarId) schedule.calendarId = 'primary';
  if (rule.app === 'stripe') {
    // A payment-failed rule only lists payment outcomes at the source;
    // other kinds list the full payment set W2 normalizes.
    schedule.stripeEventTypes =
      rule.kind === 'payment-failed' ? ['payment_failed'] : ['payment_succeeded', 'payment_failed'];
  }
  return schedule;
}

export class WatcherService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Rules already polled by this process (boot catch-up detection). */
  private readonly polledThisBoot = new Set<string>();

  constructor(private readonly deps: WatcherDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollDue().catch((err) =>
        console.error('[watch] poll failed:', err instanceof Error ? err.message : err),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    setTimeout(() => void this.pollDue().catch(() => {}), 4_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Boot reconciliation: cursors and seen-sets are durable, so there is
   * nothing to rebuild — the first pollDue() of the process runs in
   * catch-up mode for every rule with a persisted cursor.
   */
  reconcileOnBoot(): { cursors: number } {
    return { cursors: this.deps.store.countStates() };
  }

  private audit(action: string, detail: unknown): void {
    try {
      this.deps.audit?.(action, { actor: 'system', detail });
    } catch {
      // Audit must never break watching.
    }
  }

  /** Poll every enabled rule whose check interval has elapsed. */
  async pollDue(nowMs?: number): Promise<WatchPollResult[]> {
    if (this.deps.isPaused?.()) return []; // W14d global pause: skip polls
    if (this.polling) return [];
    this.polling = true;
    try {
      const now = nowMs ?? this.deps.now?.() ?? Date.now();
      const out: WatchPollResult[] = [];
      for (const rule of this.deps.store.listRules()) {
        if (!rule.enabled) continue;
        const state = this.deps.store.getState(rule.id);
        const dueAt = (state?.lastPollAt ?? 0) + rule.intervalMinutes * 60_000;
        if (state && now < dueAt) continue;
        out.push(await this.pollRule(rule, now));
      }
      return out;
    } finally {
      this.polling = false;
    }
  }

  /** Poll one rule now (enabled or not — manual run-now passes enabled rules). */
  async pollRule(rule: WatchRule, nowMs?: number): Promise<WatchPollResult> {
    const now = nowMs ?? this.deps.now?.() ?? Date.now();
    const base: WatchPollResult = {
      ruleId: rule.id, polled: false, listed: 0, checked: 0, surfaced: 0,
      itemIds: [], skippedCatchUp: 0, capBlocked: 0,
    };
    if (!rule.enabled) return { ...base, reason: 'rule disabled' };
    const store = this.deps.store;
    const prior = store.getState(rule.id);
    const firstEverPoll = prior === undefined;
    const catchUpMode = !firstEverPoll && (!this.polledThisBoot.has(rule.id) || prior.capBlocked);
    this.polledThisBoot.add(rule.id);
    store.pruneSeen(rule.id, now - WATCH_SEEN_RETENTION_MS);

    const schedule = watchEventSchedule(rule);
    let items: EventItem[] = [];
    try {
      for (const call of sourceCalls(schedule, now)) {
        const data = await this.deps.executor.executeTool({
          userId: rule.userId,
          botId: rule.botId,
          accountId: rule.accountId,
          toolSlug: call.toolSlug,
          args: call.args,
        });
        items.push(...normalizeItems(schedule, call, data));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.upsertState(rule.id, { lastPollAt: now, lastError: message.slice(0, 300) });
      store.recordRun({
        ruleId: rule.id, startedAt: now, listed: 0, checked: 0, surfaced: 0,
        skippedCatchUp: 0, capBlocked: 0, error: message.slice(0, 300),
      });
      this.audit('watch.run', { ruleId: rule.id, app: rule.app, checked: 0, surfaced: 0, error: message.slice(0, 300) });
      return { ...base, polled: true, error: message };
    }

    base.polled = true;
    base.listed = items.length;
    const byId = new Map<string, EventItem>();
    for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
    items = [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

    const newest = items.length > 0 ? items[items.length - 1] : undefined;
    const cursorPatch: { cursorId?: string; cursorTs?: number } = {};
    if (newest) {
      cursorPatch.cursorId = newest.id;
      cursorPatch.cursorTs = newest.ts || now;
    }

    if (firstEverPoll) {
      // Baseline: existing items are history, not news. Mark them seen so
      // only items arriving after the rule was created can surface.
      store.markSeen(rule.id, items.map((i) => i.id), now);
      store.upsertState(rule.id, { ...cursorPatch, lastPollAt: now, lastError: null });
      store.recordRun({
        ruleId: rule.id, startedAt: now, listed: items.length, checked: 0, surfaced: 0,
        skippedCatchUp: 0, capBlocked: 0, note: 'baseline established',
      });
      this.audit('watch.run', { ruleId: rule.id, app: rule.app, checked: 0, surfaced: 0, note: 'baseline established' });
      return { ...base, reason: 'baseline established' };
    }

    const unseen = items.filter((i) => !store.hasSeen(rule.id, i.id));
    if (unseen.length === 0) {
      store.upsertState(rule.id, { ...cursorPatch, lastPollAt: now, lastError: null, capBlocked: false });
      store.recordRun({
        ruleId: rule.id, startedAt: now, listed: items.length, checked: 0, surfaced: 0,
        skippedCatchUp: 0, capBlocked: 0,
      });
      this.audit('watch.run', { ruleId: rule.id, app: rule.app, checked: 0, surfaced: 0 });
      return base;
    }

    // Bounded catch-up: keep the most recent items, skip the older ones.
    let toCheck = unseen;
    let skipped = 0;
    if (catchUpMode && unseen.length > MAX_EVENT_CATCH_UP_FIRES) {
      skipped = unseen.length - MAX_EVENT_CATCH_UP_FIRES;
      toCheck = unseen.slice(skipped);
      store.markSeen(rule.id, unseen.slice(0, skipped).map((i) => i.id), now);
      base.skippedCatchUp = skipped;
    }

    const day = watchDayKey(rule, now);
    let capBlockedCount = 0;
    let lastSurfacedAt: number | undefined;
    for (const item of toCheck) {
      // Daily surface cap, checked before spending a triage call.
      if (store.surfacedOn(rule.id, day) >= rule.dailyCap) {
        capBlockedCount += 1;
        continue; // stays unseen — a later day's catch-up poll picks it up
      }
      let verdict: TriageVerdict | null;
      try {
        verdict = await this.deps.triage({ rule, item });
      } catch (err) {
        // Triage infrastructure is down: leave this and the remaining
        // items unseen so a later poll can retry, and record the error.
        const message = err instanceof Error ? err.message : String(err);
        store.upsertState(rule.id, { ...cursorPatch, lastPollAt: now, lastError: message.slice(0, 300), capBlocked: capBlockedCount > 0 });
        store.recordRun({
          ruleId: rule.id, startedAt: now, listed: items.length, checked: base.checked,
          surfaced: base.surfaced, skippedCatchUp: skipped, capBlocked: capBlockedCount,
          error: message.slice(0, 300),
        });
        this.audit('watch.run', { ruleId: rule.id, app: rule.app, checked: base.checked, surfaced: base.surfaced, error: message.slice(0, 300) });
        return { ...base, capBlocked: capBlockedCount, error: message };
      }
      base.checked += 1;
      // Mark seen BEFORE surfacing: at-most-once, even if the process
      // dies mid-surface (the inbox item is the audit trail).
      store.markSeen(rule.id, [item.id], now);
      if (!verdict || !verdict.surface) continue; // quiet: no inbox, no push
      const created = store.createItem({
        ruleId: rule.id,
        sourceItemId: item.id,
        app: rule.app,
        sourceKind: item.kind,
        summary: item.summary,
        fields: item.fields,
        urgency: verdict.urgency,
        reason: verdict.reason,
        suggestedAction: verdict.suggestedAction,
        itemTs: item.ts || null,
      }, now);
      if (!created) continue; // already surfaced once — never duplicates
      store.recordSurface(rule.id, day);
      base.surfaced += 1;
      base.itemIds.push(created.id);
      lastSurfacedAt = now;
      this.audit('watch.item_surfaced', {
        ruleId: rule.id, itemId: created.id, app: rule.app, urgency: created.urgency,
      });
      if (this.deps.push) {
        try {
          await this.deps.push.notify({
            kind: 'needsInput',
            botId: rule.botId,
            botName: this.deps.getBotName?.(rule.botId) ?? rule.botId,
            title: `${rule.app} needs you — ${rule.name}`,
            body: `${item.summary}${verdict.reason ? ` — ${verdict.reason}` : ''}`.slice(0, 400),
          });
        } catch {
          // Push is best-effort; the inbox entry is the durable record.
        }
      }
    }
    base.capBlocked = capBlockedCount;
    store.upsertState(rule.id, {
      ...cursorPatch,
      lastPollAt: now,
      lastError: null,
      capBlocked: capBlockedCount > 0,
      ...(lastSurfacedAt !== undefined ? { lastSurfacedAt } : {}),
    });
    store.recordRun({
      ruleId: rule.id, startedAt: now, listed: items.length, checked: base.checked,
      surfaced: base.surfaced, skippedCatchUp: skipped, capBlocked: capBlockedCount,
      ...(skipped > 0 ? { note: `catch-up: skipped ${skipped} older item(s)` } : {}),
    });
    this.audit('watch.run', {
      ruleId: rule.id, app: rule.app, checked: base.checked, surfaced: base.surfaced,
      skippedCatchUp: skipped, capBlocked: capBlockedCount,
    });
    return base;
  }

  // ---- One-tap item actions ---------------------------------------------------

  /** Dismiss: terminal — the item never resurfaces (seen-set + status). */
  dismissItem(itemId: string): WatchItem | undefined {
    const item = this.deps.store.getItem(itemId);
    if (!item) return undefined;
    if (item.status === 'dismissed') return item;
    const updated = this.deps.store.updateItem(itemId, { status: 'dismissed' });
    if (updated) this.audit('watch.item_dismissed', { ruleId: item.ruleId, itemId });
    return updated;
  }

  /** Draft reply: run the owner bot's drafting turn, store the draft. */
  async draftItem(itemId: string): Promise<WatchItem | undefined> {
    const item = this.deps.store.getItem(itemId);
    if (!item) return undefined;
    if (!this.deps.draftRunner) throw new Error('drafting is not wired (no draft runner)');
    const rule = this.deps.store.getRule(item.ruleId);
    if (!rule) throw new Error(`watch rule "${item.ruleId}" no longer exists`);
    const draft = await this.deps.draftRunner.draft({ rule, item });
    const updated = this.deps.store.updateItem(itemId, {
      status: 'actioned',
      draftText: draft.text,
      draftRef: draft.ref,
    });
    if (updated) this.audit('watch.item_drafted', { ruleId: item.ruleId, itemId });
    return updated;
  }
}
