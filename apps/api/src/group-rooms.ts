// SPDX-License-Identifier: Apache-2.0
// Group room robustness (OpenMausBot parity): turn timeouts, anti-spam post
// budgets, holds, member locks, message queue (?queue=1), failure resume.
//
// Rooms used to be single-lane: a new message cancelled the in-flight turn,
// turns had no deadline, and a member that threw was silently skipped.
// GroupRoomManager owns the per-room runtime state (in-memory) and
// orchestrates runRoomTurn (group-room-turn.ts) with guard hooks:
//
//   - Turn timeouts: per-room turnTimeoutMin (1–1440 min, default 30, global
//     default via KRIYADOT_GROUP_TURN_TIMEOUT_MIN). A turn that exceeds its
//     deadline is aborted, marked timed-out, and the room is notified with a
//     system message. A per-message ?timeoutMin= override is allowed.
//   - Anti-spam: per-room post budget — max posts per member per turn,
//     per-sender sliding-window rate limit (posts/minute), and a duplicate
//     breaker (near-identical repeats from one member). Trips pause the room
//     (hold) and notify instead of burning tokens.
//   - Holds: hold (pause; new messages queue), halt (stop the in-flight turn
//     now + pause), release (resume + drain the queue). Max 20 held items.
//   - Member locks: a bot claimed by one turn can't be double-invoked by
//     another dispatch.
//   - Queue: POST /messages?queue=1 queues behind the in-flight turn instead
//     of cancelling it; queued messages dispatch in order.
//   - Failure resume: member-turn throws are recorded (room_failures) and
//     retryable via the API; the room continues.

import type { BotConfig, TokenUsage } from '@mvp/agent-runtime';
import {
  GroupChatStore,
  type GroupChat,
  type GroupMessage,
  type RoomFailure,
  type RoomSettingsRow,
} from './group-chats.js';
import { TurnTimeoutError, runRoomTurn, type RoomTurnResult } from './group-room-turn.js';

/** Effective per-room robustness settings (all fields resolved). */
export interface RoomRobustnessSettings {
  /** Turn deadline in minutes, 1–1440. */
  turnTimeoutMin: number;
  /** Max bot posts per member per room turn. */
  maxPostsPerMemberPerTurn: number;
  /** Max posts per minute per sender (user + each member). */
  postsPerMinute: number;
  /** Consecutive near-identical posts from one member before the breaker trips. */
  duplicateRepeatLimit: number;
  /** Max queued/held messages per room. */
  maxHeld: number;
}

export const DEFAULT_ROOM_SETTINGS: RoomRobustnessSettings = {
  turnTimeoutMin: 30,
  maxPostsPerMemberPerTurn: 10,
  postsPerMinute: 6,
  duplicateRepeatLimit: 3,
  maxHeld: 20,
};

/** Global default turn timeout (min), overridable per room. */
export function globalDefaultTimeoutMin(): number {
  const raw = process.env.KRIYADOT_GROUP_TURN_TIMEOUT_MIN;
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n)) return Math.min(1440, Math.max(1, n as number));
  return DEFAULT_ROOM_SETTINGS.turnTimeoutMin;
}

export function resolveRoomSettings(row: RoomSettingsRow): RoomRobustnessSettings {
  return {
    turnTimeoutMin: row.turnTimeoutMin ?? globalDefaultTimeoutMin(),
    maxPostsPerMemberPerTurn: row.maxPostsPerMemberPerTurn ?? DEFAULT_ROOM_SETTINGS.maxPostsPerMemberPerTurn,
    postsPerMinute: row.postsPerMinute ?? DEFAULT_ROOM_SETTINGS.postsPerMinute,
    duplicateRepeatLimit: row.duplicateRepeatLimit ?? DEFAULT_ROOM_SETTINGS.duplicateRepeatLimit,
    maxHeld: row.maxHeld ?? DEFAULT_ROOM_SETTINGS.maxHeld,
  };
}

const SETTING_LIMITS: Record<keyof RoomRobustnessSettings, [number, number]> = {
  turnTimeoutMin: [1, 1440],
  maxPostsPerMemberPerTurn: [1, 100],
  postsPerMinute: [1, 600],
  duplicateRepeatLimit: [2, 20],
  maxHeld: [1, 20],
};

/**
 * Validate a PATCH body for room settings. Returns the sanitized patch
 * (only known keys, integers within range) or an error string.
 */
export function sanitizeRoomSettingsPatch(
  body: unknown,
): { ok: true; patch: Partial<RoomRobustnessSettings> } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'settings must be an object' };
  }
  const patch: Partial<RoomRobustnessSettings> = {};
  for (const [key, [min, max]] of Object.entries(SETTING_LIMITS) as Array<
    [keyof RoomRobustnessSettings, [number, number]]
  >) {
    const v = (body as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return { ok: false, error: `${key} must be an integer ${min}–${max}` };
    }
    patch[key] = v;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'no valid settings provided' };
  }
  return { ok: true, patch };
}

/** Parse a per-message ?timeoutMin= override (1–1440) or body timeoutMin. */
export function parseTimeoutOverride(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1440) return 'invalid';
  return n;
}

// ---- text similarity (duplicate breaker) ----------------------------------

/** Normalize for duplicate comparison: case-fold, collapse whitespace, strip punctuation. */
export function normalizeText(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

/** Jaccard similarity over word sets, 0–1. */
export function textSimilarity(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(Boolean));
  const wb = new Set(b.split(' ').filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1;
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Near-identical when normalized-equal or very high word overlap. */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  return textSimilarity(na, nb) >= 0.92;
}

// ---- runtime state ----------------------------------------------------------

export interface QueuedRoomMessage {
  id: string;
  groupId: string;
  /** Persisted user message id (already in the transcript). */
  messageId: string;
  text: string;
  timeoutMin: number | null;
  createdAt: string;
  attempts: number;
}

export function newQueuedMessageId(): string {
  return `qmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface TurnState {
  id: string;
  cancelled: boolean;
  reason: 'user' | 'timeout' | 'halt' | 'breaker' | null;
  startedAt: number;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BreakerInfo {
  reason: string;
  detail: string;
  at: string;
  botId?: string;
}

interface SpamState {
  /** Bot posts this turn (budget). Reset each turn. */
  perTurnCounts: Map<string, number>;
  /** Sender -> post timestamps (sliding 60s window). Sender is 'user' or a bot id. */
  postTimes: Map<string, number[]>;
  /** Bot -> consecutive near-identical reply streak. */
  dupStreak: Map<string, { norm: string; count: number }>;
  /** Bot -> rate-limit skips this turn (escalation counter). Reset each turn. */
  rateSkips: Map<string, number>;
  breaker: BreakerInfo | null;
}

interface RoomRuntime {
  turn: TurnState | null;
  queue: QueuedRoomMessage[];
  draining: boolean;
  /** botId -> turnId holding the lock. */
  locks: Map<string, string>;
  spam: SpamState;
}

function freshSpamState(): SpamState {
  return {
    perTurnCounts: new Map(),
    postTimes: new Map(),
    dupStreak: new Map(),
    rateSkips: new Map(),
    breaker: null,
  };
}

export interface RoomStatus {
  groupId: string;
  hold: 'active' | 'held' | 'halted';
  turnInFlight: boolean;
  turnStartedAt: string | null;
  queue: QueuedRoomMessage[];
  queueDepth: number;
  maxHeld: number;
  breaker: BreakerInfo | null;
  locks: Array<{ botId: string; turnId: string }>;
  settings: RoomRobustnessSettings;
  /** Raw per-room overrides (null = global default). */
  overrides: {
    turnTimeoutMin: number | null;
    maxPostsPerMemberPerTurn: number | null;
    postsPerMinute: number | null;
    duplicateRepeatLimit: number | null;
    maxHeld: number | null;
  };
}

export type PostMessageResult =
  | { ok: true; queued: true; position: number; message: GroupMessage }
  | { ok: true; queued: false; userMessage: GroupMessage; result: RoomTurnResult }
  | {
      ok: false;
      status: number;
      error: string;
      retryAfterMs?: number;
      maxHeld?: number;
      queueDepth?: number;
    };

export interface GroupRoomManagerDeps {
  store: GroupChatStore;
  getBots: () => BotConfig[];
  runMemberTurn: (bot: BotConfig, prompt: string) => Promise<{ text: string; usage?: TokenUsage }>;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Escalation threshold: rate-limit skips for one bot in a turn before the breaker trips. */
export const RATE_SKIP_ESCALATION = 3;

export class GroupRoomManager {
  private readonly rooms = new Map<string, RoomRuntime>();

  constructor(private readonly deps: GroupRoomManagerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private runtime(groupId: string): RoomRuntime {
    let rt = this.rooms.get(groupId);
    if (!rt) {
      rt = { turn: null, queue: [], draining: false, locks: new Map(), spam: freshSpamState() };
      this.rooms.set(groupId, rt);
    }
    return rt;
  }

  /** Drop all runtime state for a room (call on group delete). */
  deleteRoom(groupId: string): void {
    const rt = this.rooms.get(groupId);
    if (rt?.turn?.timer) clearTimeout(rt.turn.timer);
    this.rooms.delete(groupId);
  }

  getSettings(groupId: string): RoomRobustnessSettings {
    return resolveRoomSettings(this.deps.store.getRoomSettingsRow(groupId));
  }

  updateSettings(groupId: string, patch: Partial<RoomRobustnessSettings>): RoomRobustnessSettings {
    const row = this.deps.store.saveRoomSettings(groupId, patch);
    this.deps.audit('group.settings', { detail: { groupId, patch } });
    return resolveRoomSettings(row);
  }

  resetSettings(groupId: string): RoomRobustnessSettings {
    return resolveRoomSettings(this.deps.store.clearRoomSettings(groupId));
  }

  getStatus(groupId: string): RoomStatus {
    const rt = this.runtime(groupId);
    const row = this.deps.store.getRoomSettingsRow(groupId);
    const settings = resolveRoomSettings(row);
    return {
      groupId,
      hold: row.holdState,
      turnInFlight: rt.turn !== null,
      turnStartedAt: rt.turn ? new Date(rt.turn.startedAt).toISOString() : null,
      queue: [...rt.queue],
      queueDepth: rt.queue.length,
      maxHeld: settings.maxHeld,
      breaker: rt.spam.breaker,
      locks: [...rt.locks.entries()].map(([botId, turnId]) => ({ botId, turnId })),
      settings,
      overrides: {
        turnTimeoutMin: row.turnTimeoutMin,
        maxPostsPerMemberPerTurn: row.maxPostsPerMemberPerTurn,
        postsPerMinute: row.postsPerMinute,
        duplicateRepeatLimit: row.duplicateRepeatLimit,
        maxHeld: row.maxHeld,
      },
    };
  }

  getQueue(groupId: string): QueuedRoomMessage[] {
    return [...this.runtime(groupId).queue];
  }

  clearQueue(groupId: string): number {
    const rt = this.runtime(groupId);
    const n = rt.queue.length;
    rt.queue = [];
    if (n > 0) this.deps.audit('group.queue_clear', { detail: { groupId, cleared: n } });
    return n;
  }

  listFailures(groupId: string): RoomFailure[] {
    return this.deps.store.listRoomFailures(groupId);
  }

  // ---- holds ---------------------------------------------------------------

  /** Pause the room: no new turns start; posted messages queue. */
  hold(groupId: string): RoomStatus {
    this.deps.store.setHoldState(groupId, 'held');
    this.deps.store.addSystemMessage(groupId, '⏸ Room held — new messages will queue until released.');
    this.deps.audit('group.hold', { detail: { groupId } });
    return this.getStatus(groupId);
  }

  /** Stop everything now: cancel the in-flight turn and pause the room. */
  halt(groupId: string): RoomStatus {
    const rt = this.runtime(groupId);
    if (rt.turn) {
      rt.turn.cancelled = true;
      rt.turn.reason = 'halt';
      this.releaseTurnLocks(groupId, rt.turn.id);
    }
    this.deps.store.setHoldState(groupId, 'halted');
    this.deps.store.addSystemMessage(groupId, '⏹ Room halted — in-flight turn stopped, room paused.');
    this.deps.audit('group.halt', { detail: { groupId } });
    return this.getStatus(groupId);
  }

  /** Resume the room (clears any breaker) and drain the queue in order. */
  async release(groupId: string): Promise<RoomStatus> {
    const rt = this.runtime(groupId);
    rt.spam.breaker = null;
    this.deps.store.setHoldState(groupId, 'active');
    this.deps.store.addSystemMessage(groupId, '▶ Room released — resuming.');
    this.deps.audit('group.release', { detail: { groupId } });
    await this.drainQueue(groupId);
    return this.getStatus(groupId);
  }

  /** Cancel the in-flight turn (legacy stop). Returns true when one was running. */
  stopTurn(groupId: string): boolean {
    const rt = this.runtime(groupId);
    if (rt.turn) {
      rt.turn.cancelled = true;
      rt.turn.reason = 'user';
      this.releaseTurnLocks(groupId, rt.turn.id);
      return true;
    }
    return false;
  }

  // ---- posting ---------------------------------------------------------------

  /**
   * Post a user message to a room.
   *
   * - Rate-limited per sender (429).
   * - When the room is held/halted, or ?queue=1 with a turn in flight, the
   *   message is persisted and queued (maxHeld cap, 429 when full).
   * - Otherwise a new turn starts immediately, cancelling any in-flight
   *   turn (legacy single-lane behavior).
   */
  async postMessage(
    groupId: string,
    group: GroupChat,
    text: string,
    opts: { queue?: boolean; timeoutMin?: number | null } = {},
  ): Promise<PostMessageResult> {
    const settings = this.getSettings(groupId);
    const rt = this.runtime(groupId);
    const now = this.now();

    // Sender rate limit (the user posts via this endpoint).
    const retryAfterMs = this.checkSenderRate(rt, 'user', settings.postsPerMinute, now);
    if (retryAfterMs !== null) {
      return { ok: false, status: 429, error: 'rate-limited', retryAfterMs };
    }

    const row = this.deps.store.getRoomSettingsRow(groupId);
    const mustQueue = row.holdState !== 'active' || (opts.queue === true && rt.turn !== null);
    if (mustQueue) {
      if (rt.queue.length >= settings.maxHeld) {
        return {
          ok: false,
          status: 429,
          error: 'queue-full',
          maxHeld: settings.maxHeld,
          queueDepth: rt.queue.length,
        };
      }
      const message = this.deps.store.addMessage(groupId, 'user', text);
      this.recordSenderPost(rt, 'user', now);
      const qm: QueuedRoomMessage = {
        id: newQueuedMessageId(),
        groupId,
        messageId: message.id,
        text,
        timeoutMin: opts.timeoutMin ?? null,
        createdAt: new Date(now).toISOString(),
        attempts: 0,
      };
      rt.queue.push(qm);
      this.deps.audit('group.queue', {
        detail: { groupId, queueId: qm.id, position: rt.queue.length, hold: row.holdState },
      });
      return { ok: true, queued: true, position: rt.queue.length, message };
    }

    // Immediate turn: cancel any in-flight turn first (legacy behavior),
    // releasing its member locks so the new turn can claim them.
    if (rt.turn) {
      rt.turn.cancelled = true;
      rt.turn.reason = 'user';
      this.releaseTurnLocks(groupId, rt.turn.id);
    }
    const userMessage = this.deps.store.addMessage(groupId, 'user', text);
    this.recordSenderPost(rt, 'user', now);
    this.deps.audit('group.message', { detail: { groupId, messageId: userMessage.id } });
    const result = await this.runTurn(groupId, group, text, { timeoutMin: opts.timeoutMin ?? null });
    return { ok: true, queued: false, userMessage, result };
  }

  // ---- failure retry -----------------------------------------------------------

  /** Re-run a failed member turn with its original prompt. */
  async retryFailure(groupId: string, failureId: string): Promise<GroupMessage> {
    const failure = this.deps.store.getRoomFailure(failureId);
    if (!failure || failure.groupId !== groupId) {
      throw new Error('failure-not-found');
    }
    const bot = this.deps.getBots().find((b) => b.id === failure.botId);
    if (!bot) {
      throw new Error('bot-not-found');
    }
    const settings = this.getSettings(groupId);
    const timeoutMs = settings.turnTimeoutMin * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.deps.runMemberTurn(bot, failure.prompt),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TurnTimeoutError('Retry exceeded the room turn timeout')),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      const text = (result.text ?? '').trim();
      if (!text) throw new Error('empty-reply');
      const msg = this.deps.store.addMessage(groupId, 'bot', text, bot.id);
      this.deps.store.markRoomFailureRetried(failureId, msg.id);
      this.deps.audit('group.failure_retry', {
        detail: { groupId, failureId, botId: bot.id, messageId: msg.id },
      });
      return msg;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- internals ---------------------------------------------------------------

  /** Sliding-window check. Returns retry-after ms, or null when allowed. */
  private checkSenderRate(
    rt: RoomRuntime,
    senderId: string,
    postsPerMinute: number,
    now: number,
  ): number | null {
    this.pruneTimes(rt, senderId, now);
    const times = rt.spam.postTimes.get(senderId) ?? [];
    if (times.length >= postsPerMinute) {
      return Math.max(0, 60_000 - (now - times[0]));
    }
    return null;
  }

  private recordSenderPost(rt: RoomRuntime, senderId: string, now: number): void {
    this.pruneTimes(rt, senderId, now);
    const arr = rt.spam.postTimes.get(senderId) ?? [];
    arr.push(now);
    rt.spam.postTimes.set(senderId, arr);
  }

  private pruneTimes(rt: RoomRuntime, senderId: string, now: number): void {
    const arr = rt.spam.postTimes.get(senderId);
    if (!arr) return;
    const cutoff = now - 60_000;
    rt.spam.postTimes.set(
      senderId,
      arr.filter((t) => t > cutoff),
    );
  }

  /** skipSpeaker hook: budget + rate limit. Returns a skip reason or null. */
  private checkSkipSpeaker(
    groupId: string,
    botId: string,
    settings: RoomRobustnessSettings,
  ): string | null {
    const rt = this.runtime(groupId);
    const count = rt.spam.perTurnCounts.get(botId) ?? 0;
    if (count >= settings.maxPostsPerMemberPerTurn) return 'post-budget-exceeded';
    const now = this.now();
    if (this.checkSenderRate(rt, botId, settings.postsPerMinute, now) !== null) {
      const skips = (rt.spam.rateSkips.get(botId) ?? 0) + 1;
      rt.spam.rateSkips.set(botId, skips);
      return 'rate-limited';
    }
    return null;
  }

  /** checkReply hook: record the post, run the duplicate breaker. */
  private checkReply(
    groupId: string,
    bot: BotConfig,
    text: string,
    settings: RoomRobustnessSettings,
  ):
    | { action: 'allow' }
    | { action: 'block'; reason: string }
    | { action: 'trip'; reason: string; detail: string } {
    const rt = this.runtime(groupId);
    const now = this.now();
    this.recordSenderPost(rt, bot.id, now);
    rt.spam.perTurnCounts.set(bot.id, (rt.spam.perTurnCounts.get(bot.id) ?? 0) + 1);

    const norm = normalizeText(text);
    const streak = rt.spam.dupStreak.get(bot.id);
    if (streak && isNearDuplicate(streak.norm, norm)) {
      streak.count += 1;
      if (streak.count >= settings.duplicateRepeatLimit) {
        return {
          action: 'trip',
          reason: 'duplicate-spam',
          detail: `${bot.name} posted near-identical messages ${streak.count}× in a row`,
        };
      }
    } else {
      rt.spam.dupStreak.set(bot.id, { norm, count: 1 });
    }
    return { action: 'allow' };
  }

  /**
   * Claim an exclusive per-turn lock on a member bot. Used by the turn
   * orchestrator so parallel dispatches can't double-invoke the same bot.
   * Public for tests; returns false when another live turn holds the lock.
   */
  claimLock(groupId: string, botId: string, turnId: string): boolean {
    const rt = this.runtime(groupId);
    const holder = rt.locks.get(botId);
    if (holder !== undefined && holder !== turnId) return false;
    rt.locks.set(botId, turnId);
    return true;
  }

  /** Release a lock previously claimed via claimLock. */
  releaseLock(groupId: string, botId: string, turnId: string): void {
    const rt = this.runtime(groupId);
    if (rt.locks.get(botId) === turnId) rt.locks.delete(botId);
  }

  private releaseTurnLocks(groupId: string, turnId: string): void {
    const rt = this.runtime(groupId);
    for (const [botId, holder] of rt.locks) {
      if (holder === turnId) rt.locks.delete(botId);
    }
  }

  private timeOutTurn(groupId: string, turnId: string): void {
    const rt = this.runtime(groupId);
    if (rt.turn && rt.turn.id === turnId && !rt.turn.cancelled) {
      rt.turn.cancelled = true;
      rt.turn.reason = 'timeout';
    }
  }

  /** Guarded member turn: enforces the turn deadline per member call. */
  private runMemberTurnGuarded(
    groupId: string,
    turn: TurnState,
    bot: BotConfig,
    prompt: string,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const remaining = Math.max(0, turn.deadlineAt - this.now());
    let timer: ReturnType<typeof setTimeout>;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.timeOutTurn(groupId, turn.id);
        reject(new TurnTimeoutError(`Room turn exceeded its ${Math.round((turn.deadlineAt - turn.startedAt) / 60000)} min deadline`));
      }, remaining);
      timer.unref?.();
    });
    const run = this.deps
      .runMemberTurn(bot, prompt)
      .finally(() => clearTimeout(timer));
    return Promise.race([run, timeoutP]);
  }

  private tripBreaker(groupId: string, trip: { reason: string; detail: string; botId?: string }): void {
    const rt = this.runtime(groupId);
    rt.spam.breaker = { ...trip, at: new Date().toISOString() };
    this.deps.store.setHoldState(groupId, 'held');
    if (rt.turn) {
      rt.turn.cancelled = true;
      rt.turn.reason = 'breaker';
    }
    this.deps.store.addSystemMessage(
      groupId,
      `🛡 Anti-spam breaker tripped (${trip.reason}): ${trip.detail}. Room paused — Release to resume.`,
    );
    this.deps.audit('group.breaker', { detail: { groupId, ...trip } });
  }

  private async runTurn(
    groupId: string,
    group: GroupChat,
    userText: string,
    opts: { timeoutMin?: number | null } = {},
  ): Promise<RoomTurnResult> {
    const rt = this.runtime(groupId);
    const settings = this.getSettings(groupId);
    const timeoutMin = opts.timeoutMin ?? settings.turnTimeoutMin;
    const timeoutMs = timeoutMin * 60_000;
    const now = this.now();
    const turn: TurnState = {
      id: `turn_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      cancelled: false,
      reason: null,
      startedAt: now,
      deadlineAt: now + timeoutMs,
      timer: null,
    };
    rt.turn = turn;
    rt.spam.perTurnCounts = new Map();
    rt.spam.rateSkips = new Map();
    rt.spam.dupStreak = new Map();
    turn.timer = setTimeout(() => this.timeOutTurn(groupId, turn.id), timeoutMs);
    turn.timer.unref?.();

    const bots = this.deps.getBots();
    const getBot = (id: string): BotConfig | undefined => bots.find((b) => b.id === id);

    let result: RoomTurnResult;
    try {
      result = await runRoomTurn(group, userText, {
        store: this.deps.store,
        getBot,
        runMemberTurn: (bot, prompt) => this.runMemberTurnGuarded(groupId, turn, bot, prompt),
        isCancelled: () => turn.cancelled,
        skipSpeaker: (botId) => this.checkSkipSpeaker(groupId, botId, settings),
        claimSpeakerLock: (botId) => this.claimLock(groupId, botId, turn.id),
        releaseSpeakerLock: (botId) => this.releaseLock(groupId, botId, turn.id),
        onMemberError: ({ bot, round, prompt, error }) => {
          const failure = this.deps.store.recordRoomFailure({
            groupId,
            botId: bot.id,
            botName: bot.name,
            round,
            prompt,
            userText,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          this.deps.audit('group.member_failure', {
            detail: { groupId, botId: bot.id, round, failureId: failure.id },
          });
          return failure.id;
        },
        checkReply: (bot, text) => this.checkReply(groupId, bot, text, settings),
      });
    } finally {
      if (turn.timer) clearTimeout(turn.timer);
      this.releaseTurnLocks(groupId, turn.id);
      if (rt.turn === turn) rt.turn = null;
    }

    if (result.timedOut) {
      this.deps.store.addSystemMessage(
        groupId,
        `⏱ Room turn timed out after ${timeoutMin} min — stopping to protect your token budget.`,
      );
      this.deps.audit('group.turn_timeout', { detail: { groupId, timeoutMin } });
    }
    if (result.breakerTripped) {
      this.tripBreaker(groupId, {
        reason: result.breakerTripped.reason,
        detail: result.breakerTripped.detail,
      });
    } else {
      // Rate-limit escalation: a bot skipped 3×+ for rate in one turn trips the breaker.
      for (const [botId, skips] of rt.spam.rateSkips) {
        if (skips >= RATE_SKIP_ESCALATION) {
          const bot = getBot(botId);
          this.tripBreaker(groupId, {
            reason: 'rate-escalation',
            detail: `${bot?.name ?? botId} hit the per-minute post budget ${skips}× this turn`,
            botId,
          });
          break;
        }
      }
    }

    await this.drainQueue(groupId);
    return result;
  }

  /** Dispatch queued messages in order while the room is active. */
  private async drainQueue(groupId: string): Promise<void> {
    const rt = this.runtime(groupId);
    if (rt.draining) return;
    rt.draining = true;
    try {
      while (rt.queue.length > 0) {
        const row = this.deps.store.getRoomSettingsRow(groupId);
        if (row.holdState !== 'active' || rt.spam.breaker) break;
        if (rt.turn) break; // safety: never overlap turns
        const qm = rt.queue.shift()!;
        qm.attempts += 1;
        const group = this.deps.store.getGroup(groupId);
        if (!group) break;
        this.deps.audit('group.queue_dispatch', {
          detail: { groupId, queueId: qm.id, attempt: qm.attempts },
        });
        try {
          await this.runTurn(groupId, group, qm.text, { timeoutMin: qm.timeoutMin });
        } catch (err) {
          // A queued turn must never kill the drain loop.
          this.deps.store.addSystemMessage(
            groupId,
            `⚠ Queued message failed to dispatch: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      rt.draining = false;
    }
  }
}
