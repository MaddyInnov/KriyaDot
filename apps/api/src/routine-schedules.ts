// SPDX-License-Identifier: Apache-2.0
// Routine scheduling — OpenMausBot parity P0 #6.
//
// BotRoutine previously had no schedule field (webhook-only). This module
// adds timezone-aware schedules to routines:
//
//   - 'once':     run once at a specific datetime
//   - 'daily':    time + weekdays, e.g. Mon/Wed/Fri at 09:00
//   - 'cron':    5-field cron expression (Vixie semantics)
//   - 'interval': every N minutes, with optional anchor time, weekday
//                 filter, wall-clock window, and endsAt
//
// Every schedule carries an explicit IANA timezone (e.g. 'Asia/Kolkata').
// All wall-clock interpretation happens in that timezone — the server's
// local zone is never consulted. Timezone math is done with the platform
// Intl APIs (no new dependencies):
//
//   - zonedParts(): UTC instant  -> wall-clock parts in a zone
//   - wallToUtcMs(): wall-clock parts -> UTC instant (null when the local
//     time does not exist, e.g. the spring-forward gap; ambiguous
//     fall-back times resolve deterministically to the first occurrence)
//
// The RoutineScheduler at the bottom ticks on an interval, computes the
// occurrences that fell inside (lastTick, now] for each routine with an
// enabled schedule, and fires the routine's bot turn. Overlap policy per
// schedule: 'skip' (don't fire while a previous scheduled run is still
// in flight) or 'queue' (fire regardless).

import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { classifyProviderError, computeResumeAtMs, DEFAULT_LIMIT_BACKOFF_MS } from '@mvp/agent-runtime';
import type { BotRoutine, RoutineStore } from './bot-routines.js';
import type { LimitResetResume, LimitResetResumeStore } from './limit-reset-resumes.js';
import {
  RoutineRunExecutor,
  type RoutineRunStore,
  type RunSettledResult,
} from './routine-runs.js';

// ---------------------------------------------------------------------------
// Timezone helpers (Intl-based, no dependencies)
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  /** 0=Sunday .. 6=Saturday (matches Date#getDay). */
  weekday: number;
}

const WEEKDAY_SHORT: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Cached formatters per timezone — Intl construction is not free. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    // Throws RangeError on unknown zones — callers rely on this for
    // validation.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Throw a descriptive Error when the timezone is not a valid IANA zone. */
export function assertValidTimeZone(timeZone: string): void {
  if (typeof timeZone !== 'string' || !timeZone) {
    throw new Error('timezone is required (IANA name, e.g. "Asia/Kolkata")');
  }
  try {
    formatterFor(timeZone);
  } catch (err) {
    throw new Error(`unknown timezone "${timeZone}"`);
  }
}

/** Wall-clock parts of a UTC instant in the given zone. */
export function zonedParts(timeZone: string, utcMs: number): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAY_SHORT[get('weekday')];
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: weekday === undefined ? new Date(utcMs).getUTCDay() : weekday,
  };
}

/**
 * The zone's UTC offset in milliseconds at a given UTC instant
 * (positive east of UTC).
 */
function offsetAtMs(timeZone: string, utcMs: number): number {
  const p = zonedParts(timeZone, utcMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - utcMs;
}

/**
 * Convert wall-clock components in a zone to a UTC instant.
 * Returns null when the local time does not exist (spring-forward gap).
 * Ambiguous times (fall-back overlap) resolve to the first occurrence.
 */
export function wallToUtcMs(
  timeZone: string,
  comps: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
): number | null {
  const second = comps.second ?? 0;
  const wallAsUtc = Date.UTC(comps.year, comps.month - 1, comps.day, comps.hour, comps.minute, second);
  // Fixed-point iteration: utc = wall - offset(utc). Converges in <= 2
  // iterations for real zones; 4 iterations for safety.
  let utc = wallAsUtc;
  for (let i = 0; i < 4; i++) {
    utc = wallAsUtc - offsetAtMs(timeZone, utc);
  }
  // Round-trip check: nonexistent local times land on a different
  // wall-clock reading (the post-gap time), so they fail this test.
  const check = zonedParts(timeZone, utc);
  if (
    check.year !== comps.year ||
    check.month !== comps.month ||
    check.day !== comps.day ||
    check.hour !== comps.hour ||
    check.minute !== comps.minute
  ) {
    return null;
  }
  return utc;
}

/** Shift a wall-clock date by n days (calendar arithmetic, zone-naive). */
function shiftDate(comps: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(comps.year, comps.month - 1, comps.day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Cron parsing (Vixie/standard semantics)
// ---------------------------------------------------------------------------

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface CronField {
  /** Sorted allowed values, or null for '*'. */
  values: number[] | null;
  /** True when the field was a bare '*' (matters for dom/dow OR semantics). */
  star: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=29: leap years exist

function parseCronField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  fieldName: string,
): CronField {
  const field = raw.trim().toLowerCase();
  if (field === '*') return { values: null, star: true };
  const out = new Set<number>();
  const resolveName = (tok: string): number => {
    if (names && names[tok] !== undefined) return names[tok];
    if (!/^-?\d+$/.test(tok)) throw new Error(`invalid ${fieldName} value "${tok}"`);
    return Number(tok);
  };
  for (const part of field.split(',')) {
    if (!part) throw new Error(`empty ${fieldName} list element`);
    const slash = part.split('/');
    if (slash.length > 2) throw new Error(`invalid ${fieldName} step "${part}"`);
    const step = slash.length === 2 ? Number(slash[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid ${fieldName} step "${part}"`);
    const range = slash[0];
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = resolveName(a);
      hi = resolveName(b);
      if (lo > hi) throw new Error(`invalid ${fieldName} range "${part}"`);
    } else {
      lo = resolveName(range);
      hi = range === '*' ? max : lo;
    }
    if (lo < min || hi > max) {
      throw new Error(`${fieldName} value out of range ${min}-${max}: "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty ${fieldName} field`);
  return { values: [...out].sort((a, b) => a - b), star: false };
}

/**
 * Parse and validate a 5-field cron expression. Throws on any problem,
 * including impossible calendar dates (e.g. "30 9 30 2 *" — Feb 30).
 * Feb 29 is allowed (leap years exist).
 */
export function parseCron(expr: string): ParsedCron {
  const m = CRON_RE.exec(expr.trim());
  if (!m) throw new Error('cron must be a 5-field expression: "minute hour dom month dow"');
  const [, minute, hour, dom, month, dow] = m;
  const parsed: ParsedCron = {
    minute: parseCronField(minute, 0, 59, null, 'minute'),
    hour: parseCronField(hour, 0, 23, null, 'hour'),
    dom: parseCronField(dom, 1, 31, null, 'day-of-month'),
    month: parseCronField(month, 1, 12, MONTH_NAMES, 'month'),
    dow: parseCronField(dow, 0, 7, DOW_NAMES, 'day-of-week'),
  };
  // Normalize Sunday=7 to 0.
  if (parsed.dow.values) {
    parsed.dow.values = [...new Set(parsed.dow.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);
  }
  // Impossible-date check: every restricted dom must be valid in at
  // least one allowed month (Feb allows 29 for leap years).
  if (!parsed.dom.star && parsed.dom.values && !parsed.month.star && parsed.month.values) {
    for (const d of parsed.dom.values) {
      const okInSomeMonth = parsed.month.values.some((mo) => d <= DAYS_IN_MONTH[mo - 1]);
      if (!okInSomeMonth) {
        throw new Error(`impossible date: day-of-month ${d} never occurs in the allowed months`);
      }
    }
  }
  return parsed;
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.values === null) return true;
  return field.values.includes(value);
}

/**
 * Standard cron day semantics: dom and dow are OR-ed when both are
 * restricted; when one is '*', the other decides.
 */
export function cronMatchesZone(parsed: ParsedCron, p: ZonedParts): boolean {
  if (!fieldMatches(parsed.minute, p.minute)) return false;
  if (!fieldMatches(parsed.hour, p.hour)) return false;
  if (!fieldMatches(parsed.month, p.month)) return false;
  const domOk = fieldMatches(parsed.dom, p.day);
  const dowOk = fieldMatches(parsed.dow, p.weekday);
  if (parsed.dom.star && parsed.dow.star) return true;
  if (parsed.dom.star) return dowOk;
  if (parsed.dow.star) return domOk;
  return domOk || dowOk;
}

// ---------------------------------------------------------------------------
// Schedule model
// ---------------------------------------------------------------------------

export type RoutineScheduleKind = 'once' | 'daily' | 'cron' | 'interval' | 'limit-reset' | 'event' | 'idle';

/** When a scheduled run fires while the previous run is still in flight. */
export type OverlapPolicy = 'skip' | 'queue';

interface ScheduleBase {
  kind: RoutineScheduleKind;
  /** Explicit IANA timezone; all wall-clock fields are read in this zone. */
  timezone: string;
  enabled: boolean;
  overlap: OverlapPolicy;
  /**
   * Catch up missed occurrences after server downtime: the most recent
   * missed occurrences (bounded, max 3) actually run; all missed
   * occurrences get 'missed' run records regardless. Default false.
   */
  catchUp?: boolean;
  /**
   * Consecutive run failures before the schedule auto-pauses (the user is
   * notified). Integer 1..20, default 3.
   */
  failureStreakLimit?: number;
}

/** Run once at a specific datetime. */
export interface OnceSchedule extends ScheduleBase {
  kind: 'once';
  /**
   * ISO 8601 datetime. Two accepted forms:
   *  - with offset: "2026-10-17T09:00:00+05:30" (offset wins)
   *  - wall-clock:  "2026-10-17T09:00" (interpreted in `timezone`)
   */
  runAt: string;
}

/** Run at a wall-clock time on selected weekdays. */
export interface DailySchedule extends ScheduleBase {
  kind: 'daily';
  /** "HH:mm" 24h wall-clock time in `timezone`. */
  time: string;
  /** Weekdays 0=Sunday..6=Saturday. Default: every day. */
  weekdays: number[];
}

/** 5-field cron expression, matched in `timezone`. */
export interface CronSchedule extends ScheduleBase {
  kind: 'cron';
  expression: string;
}

/** Every N minutes, anchored to a wall-clock grid in `timezone`. */
export interface IntervalSchedule extends ScheduleBase {
  kind: 'interval';
  /** 1..10080 (one week). */
  everyMinutes: number;
  /** "HH:mm" wall-clock anchor; the occurrence grid is anchored to this
   *  time on 1970-01-01 in `timezone`, so it is stable across restarts. */
  anchorTime?: string;
  /** Optional weekday filter 0=Sunday..6=Saturday. */
  weekdays?: number[];
  /** Optional wall-clock window "HH:mm" — occurrences must fall inside. */
  windowStart?: string;
  windowEnd?: string;
  /** Optional absolute cutoff: ISO 8601 datetime with offset. */
  endsAt?: string;
}

/**
 * Idle trigger (Octomind parity): fire once when the bot has had no
 * completed turn activity for `afterMinutes`. Not a time grid — the
 * scheduler's tick consults the host's lastBotActivityAt source.
 * Re-arms automatically when new activity lands.
 */
export interface IdleSchedule extends ScheduleBase {
  kind: 'idle';
  /** 5..10080 minutes of inactivity before firing. */
  afterMinutes: number;
}

/**
 * Limit-reset (W1): the routine is blocked by a provider usage limit and
 * resumes when the provider's limit resets. Not a repeating schedule —
 * it arms with a concrete `resumeAt` (computed from the limit error's
 * reset / retry-after signal, else `defaultBackoffMinutes`) and fires
 * once at that instant. The durable pending resume lives in
 * LimitResetResumeStore; `resumeAt` here mirrors it for next-run display.
 */
export interface LimitResetSchedule extends ScheduleBase {
  kind: 'limit-reset';
  /** Provider whose limit blocked the work (display + arming), optional. */
  providerId?: string;
  /** Fallback wait when the limit error carries no reset signal. 1..10080 minutes, default 60. */
  defaultBackoffMinutes?: number;
  /** Armed resume instant: ISO 8601 datetime with offset. Unset = waiting for a limit event to arm it. */
  resumeAt?: string;
}

/** Connected apps an `event` schedule can listen to (Composio toolkit slugs). */
export type EventAppId = 'gmail' | 'slack' | 'github' | 'stripe' | 'googlecalendar';

export const EVENT_APP_IDS: readonly EventAppId[] = ['gmail', 'slack', 'github', 'stripe', 'googlecalendar'];

/** GitHub repo event categories an event schedule can subscribe to. */
export type GithubEventType = 'issues' | 'pull_request' | 'push';
/** Stripe payment outcomes an event schedule can subscribe to. */
export type StripeEventType = 'payment_succeeded' | 'payment_failed';

/** Default poll interval (minutes) per event source. */
export const EVENT_DEFAULT_POLL_MINUTES: Record<EventAppId, number> = {
  gmail: 15,
  slack: 10,
  github: 10,
  stripe: 10,
  googlecalendar: 10,
};
/** Poll intervals are clamped to at least this many minutes. */
export const EVENT_MIN_POLL_MINUTES = 5;
/** Default per-trigger daily fire cap for event schedules. */
export const EVENT_DEFAULT_DAILY_CAP = 50;

/**
 * Connected-app event trigger (W2): the routine fires when a new item
 * appears in a connected Composio app (see routine-events.ts for the
 * polling engine). Not a time-grid schedule — `nextRuns` yields nothing;
 * the poller compares a persisted cursor against recent items instead.
 * Filter fields are per-app; irrelevant fields are rejected per app only
 * when they carry the wrong type (unknown fields are ignored).
 */
export interface EventSchedule extends ScheduleBase {
  kind: 'event';
  /** Connected app (Composio toolkit slug). */
  app: EventAppId;
  /** Connected Composio account id (nanoid) for `app`. */
  accountId: string;
  /** KriyaDot user that owns the connected account. Default 'default-user'. */
  userId?: string;
  /** Poll interval in minutes (min EVENT_MIN_POLL_MINUTES). */
  pollMinutes: number;
  /** Max fires per day (schedule timezone), 1..1000. */
  dailyCap: number;
  // Gmail filter (also composed into the at-source search query).
  from?: string;
  subjectContains?: string;
  query?: string;
  // Slack filter.
  channelId?: string;
  keyword?: string;
  // GitHub filter.
  repo?: string;
  eventTypes?: GithubEventType[];
  // Stripe filter.
  stripeEventTypes?: StripeEventType[];
  // Calendar filter.
  calendarId?: string;
  /** Fire for events starting within this many minutes from the poll. */
  windowMinutes?: number;
}

export type RoutineSchedule = OnceSchedule | DailySchedule | CronSchedule | IntervalSchedule | LimitResetSchedule | EventSchedule | IdleSchedule;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ONCE_WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?$/;
const ONCE_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?([0-5]\d))$/;

function validWeekdays(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  );
}

/** Parse an ISO datetime with explicit offset to UTC ms. Throws on garbage. */
export function parseIsoWithOffset(s: string): number {
  const m = ONCE_OFFSET_RE.exec(s.trim());
  if (!m) throw new Error(`invalid datetime "${s}" (expected ISO 8601 with offset, e.g. 2026-10-17T09:00:00+05:30)`);
  const [, yy, mo, dd, hh, mi, ss, zone, zh, zm] = m;
  const base = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi), Number(ss ?? 0));
  if (Number.isNaN(base)) throw new Error(`invalid datetime "${s}"`);
  // Sanity: reject impossible calendar dates (Date.UTC normalizes).
  const check = new Date(base);
  if (
    check.getUTCFullYear() !== Number(yy) ||
    check.getUTCMonth() + 1 !== Number(mo) ||
    check.getUTCDate() !== Number(dd)
  ) {
    throw new Error(`impossible date "${s}"`);
  }
  if (zone === 'Z') return base;
  const sign = zone.startsWith('+') ? 1 : -1;
  const offMs = (Number(zh) * 60 + Number(zm)) * 60_000;
  return sign === 1 ? base - offMs : base + offMs;
}

function parseWallClock(s: string, what: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(s.trim());
  if (!m) throw new Error(`${what} must be "HH:mm" (24h), got "${s}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Parse an absolute datetime: ISO 8601 with offset ("...+05:30"/"Z") or
 * wall-clock "YYYY-MM-DDTHH:mm" interpreted in `timezone`. Returns UTC ms.
 */
export function parseScheduleInstant(s: string, timezone: string, what: string): number {
  const t = s.trim();
  if (ONCE_OFFSET_RE.test(t)) return parseIsoWithOffset(t);
  const m = ONCE_WALL_RE.exec(t);
  if (m) {
    const utc = wallToUtcMs(timezone, {
      year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
      hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0),
    });
    if (utc === null) throw new Error(`${what} "${t}" does not exist in timezone "${timezone}" (DST gap)`);
    return utc;
  }
  throw new Error(`${what} must be ISO 8601 with offset ("...+05:30"/"Z") or wall-clock "YYYY-MM-DDTHH:mm"`);
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLACK_CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_EVENT_TYPES: readonly GithubEventType[] = ['issues', 'pull_request', 'push'];
const STRIPE_EVENT_TYPES: readonly StripeEventType[] = ['payment_succeeded', 'payment_failed'];

function eventOptString(s: Record<string, unknown>, field: string, max: number): string | undefined {
  const v = s[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`event ${field} must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new Error(`event ${field} must be at most ${max} characters`);
  return t;
}

function eventEnumList<T extends string>(
  s: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T[],
): T[] {
  const v = s[field];
  if (v === undefined || v === null) return [...fallback];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`event ${field} must be a non-empty array of: ${allowed.join(', ')}`);
  }
  const out: T[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
      throw new Error(`event ${field} contains an unknown value "${String(item)}" (allowed: ${allowed.join(', ')})`);
    }
    if (!out.includes(item as T)) out.push(item as T);
  }
  return out;
}

/** Validate + normalize an `event` schedule (connected-app trigger, W2). */
function validateEventSchedule(
  s: Record<string, unknown>,
  base: { timezone: string; enabled: boolean; overlap: OverlapPolicy; catchUp: boolean; failureStreakLimit: number },
): EventSchedule {
  const app = s.app;
  if (typeof app !== 'string' || !(EVENT_APP_IDS as readonly string[]).includes(app)) {
    throw new Error(`event app must be one of: ${EVENT_APP_IDS.join(', ')}`);
  }
  const appId = app as EventAppId;
  const accountId = s.accountId;
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId.trim())) {
    throw new Error('event accountId is required (the connected Composio account id)');
  }
  const out: EventSchedule = {
    kind: 'event',
    ...base,
    app: appId,
    accountId: accountId.trim(),
    pollMinutes: EVENT_DEFAULT_POLL_MINUTES[appId],
    dailyCap: EVENT_DEFAULT_DAILY_CAP,
  };
  if (s.userId !== undefined) {
    if (typeof s.userId !== 'string' || !EVENT_USER_RE.test(s.userId.trim())) {
      throw new Error('event userId must match /^[A-Za-z0-9_-]{1,64}$/');
    }
    out.userId = s.userId.trim();
  }
  if (s.pollMinutes !== undefined) {
    if (!Number.isInteger(s.pollMinutes) || (s.pollMinutes as number) < EVENT_MIN_POLL_MINUTES || (s.pollMinutes as number) > 1440) {
      throw new Error(`event pollMinutes must be an integer ${EVENT_MIN_POLL_MINUTES}..1440`);
    }
    out.pollMinutes = s.pollMinutes as number;
  }
  if (s.dailyCap !== undefined) {
    if (!Number.isInteger(s.dailyCap) || (s.dailyCap as number) < 1 || (s.dailyCap as number) > 1000) {
      throw new Error('event dailyCap must be an integer 1..1000');
    }
    out.dailyCap = s.dailyCap as number;
  }
  // Per-source filters. Fields for other sources are type-checked when
  // present but only the active source's required fields are enforced.
  const from = eventOptString(s, 'from', 200);
  const subjectContains = eventOptString(s, 'subjectContains', 200);
  const query = eventOptString(s, 'query', 500);
  const channelId = eventOptString(s, 'channelId', 64);
  const keyword = eventOptString(s, 'keyword', 200);
  const repo = eventOptString(s, 'repo', 200);
  const calendarId = eventOptString(s, 'calendarId', 200);
  if (from) out.from = from;
  if (subjectContains) out.subjectContains = subjectContains;
  if (query) out.query = query;
  if (channelId) out.channelId = channelId;
  if (keyword) out.keyword = keyword;
  if (repo) out.repo = repo;
  if (calendarId) out.calendarId = calendarId;
  if (appId === 'slack') {
    if (!out.channelId || !SLACK_CHANNEL_RE.test(out.channelId)) {
      throw new Error('event channelId is required for slack (the channel id to watch)');
    }
  }
  if (appId === 'github') {
    if (!out.repo || !GITHUB_REPO_RE.test(out.repo)) {
      throw new Error('event repo is required for github in "owner/name" form');
    }
    out.eventTypes = eventEnumList(s, 'eventTypes', GITHUB_EVENT_TYPES, [...GITHUB_EVENT_TYPES]);
  }
  if (appId === 'stripe') {
    out.stripeEventTypes = eventEnumList(s, 'stripeEventTypes', STRIPE_EVENT_TYPES, [...STRIPE_EVENT_TYPES]);
  }
  if (appId === 'googlecalendar') {
    if (s.windowMinutes !== undefined) {
      if (!Number.isInteger(s.windowMinutes) || (s.windowMinutes as number) < 5 || (s.windowMinutes as number) > 10080) {
        throw new Error('event windowMinutes must be an integer 5..10080');
      }
      out.windowMinutes = s.windowMinutes as number;
    } else {
      out.windowMinutes = 120;
    }
    if (!out.calendarId) out.calendarId = 'primary';
  }
  return out;
}

/**
 * Validate a schedule object (from JSON input). Returns a normalized copy
 * with defaults applied. Throws a descriptive Error on any problem.
 */
export function validateRoutineSchedule(input: unknown): RoutineSchedule {
  if (typeof input !== 'object' || input === null) {
    throw new Error('schedule must be an object');
  }
  const s = input as Record<string, unknown>;
  const kind = s.kind;
  if (kind !== 'once' && kind !== 'daily' && kind !== 'cron' && kind !== 'interval' && kind !== 'limit-reset' && kind !== 'event' && kind !== 'idle') {
    throw new Error('schedule.kind must be one of: once, daily, cron, interval, limit-reset, event, idle');
  }
  const timezone = s.timezone;
  assertValidTimeZone(typeof timezone === 'string' ? timezone : '');
  const overlap: OverlapPolicy = s.overlap === 'queue' ? 'queue' : s.overlap === 'skip' || s.overlap === undefined ? 'skip' : (() => { throw new Error('schedule.overlap must be "skip" or "queue"'); })();
  const enabled = s.enabled === undefined ? true : s.enabled === true;
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
    throw new Error('schedule.enabled must be a boolean');
  }
  // Run-governance options (OpenMausBot parity P0 #7): missed-run catch-up
  // and the failure-streak auto-pause limit.
  let catchUp = false;
  if (s.catchUp !== undefined) {
    if (typeof s.catchUp !== 'boolean') throw new Error('schedule.catchUp must be a boolean');
    catchUp = s.catchUp;
  }
  let failureStreakLimit = 3;
  if (s.failureStreakLimit !== undefined) {
    if (!Number.isInteger(s.failureStreakLimit) || (s.failureStreakLimit as number) < 1 || (s.failureStreakLimit as number) > 20) {
      throw new Error('schedule.failureStreakLimit must be an integer 1..20');
    }
    failureStreakLimit = s.failureStreakLimit as number;
  }
  const governance = { catchUp, failureStreakLimit };

  if (kind === 'event') {
    return validateEventSchedule(s, { timezone: timezone as string, enabled, overlap, ...governance });
  }

  if (kind === 'limit-reset') {
    const out: LimitResetSchedule = { kind, timezone: timezone as string, enabled, overlap, ...governance };
    if (s.providerId !== undefined) {
      if (typeof s.providerId !== 'string' || !s.providerId.trim()) {
        throw new Error('limit-reset providerId must be a non-empty string');
      }
      out.providerId = s.providerId.trim().slice(0, 128);
    }
    if (s.defaultBackoffMinutes !== undefined) {
      if (!Number.isInteger(s.defaultBackoffMinutes) || (s.defaultBackoffMinutes as number) < 1 || (s.defaultBackoffMinutes as number) > 10080) {
        throw new Error('limit-reset defaultBackoffMinutes must be an integer 1..10080');
      }
      out.defaultBackoffMinutes = s.defaultBackoffMinutes as number;
    } else {
      out.defaultBackoffMinutes = 60;
    }
    if (s.resumeAt !== undefined) {
      if (typeof s.resumeAt !== 'string' || !s.resumeAt.trim()) {
        throw new Error('limit-reset resumeAt must be a datetime string');
      }
      parseScheduleInstant(s.resumeAt, timezone as string, 'limit-reset resumeAt'); // validates
      out.resumeAt = s.resumeAt.trim();
    }
    return out;
  }

  if (kind === 'idle') {
    const after = s.afterMinutes;
    if (!Number.isInteger(after) || (after as number) < 5 || (after as number) > 10080) {
      throw new Error('idle schedule requires afterMinutes (integer 5..10080)');
    }
    return { kind, timezone: timezone as string, enabled, overlap, ...governance, afterMinutes: after as number };
  }

  if (kind === 'once') {
    const runAt = s.runAt;
    if (typeof runAt !== 'string' || !runAt.trim()) throw new Error('once schedule requires runAt');
    parseScheduleInstant(runAt, timezone as string, 'once runAt'); // validates
    return { kind, timezone: timezone as string, enabled, overlap, ...governance, runAt: runAt.trim() };
  }

  if (kind === 'daily') {
    const { hour, minute } = parseWallClock(typeof s.time === 'string' ? s.time : '', 'daily time');
    const weekdays = s.weekdays === undefined ? [0, 1, 2, 3, 4, 5, 6] : s.weekdays;
    if (!validWeekdays(weekdays)) throw new Error('daily weekdays must be a non-empty array of 0..6 (0=Sunday)');
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return { kind, timezone: timezone as string, enabled, overlap, ...governance, time, weekdays: [...weekdays].sort((a, b) => a - b) };
  }

  if (kind === 'cron') {
    if (typeof s.expression !== 'string' || !s.expression.trim()) {
      throw new Error('cron schedule requires expression');
    }
    parseCron(s.expression); // throws with details
    return { kind, timezone: timezone as string, enabled, overlap, ...governance, expression: s.expression.trim() };
  }

  // interval
  const everyMinutes = s.everyMinutes;
  if (!Number.isInteger(everyMinutes) || (everyMinutes as number) < 1 || (everyMinutes as number) > 10080) {
    throw new Error('interval everyMinutes must be an integer 1..10080');
  }
  const out: IntervalSchedule = {
    kind, timezone: timezone as string, enabled, overlap, ...governance, everyMinutes: everyMinutes as number,
  };
  if (s.anchorTime !== undefined) {
    const { hour, minute } = parseWallClock(String(s.anchorTime), 'interval anchorTime');
    out.anchorTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  if (s.weekdays !== undefined) {
    if (!validWeekdays(s.weekdays)) throw new Error('interval weekdays must be a non-empty array of 0..6 (0=Sunday)');
    out.weekdays = [...(s.weekdays as number[])].sort((a, b) => a - b);
  }
  if (s.windowStart !== undefined || s.windowEnd !== undefined) {
    if (s.windowStart === undefined || s.windowEnd === undefined) {
      throw new Error('interval window requires both windowStart and windowEnd');
    }
    const ws = parseWallClock(String(s.windowStart), 'interval windowStart');
    const we = parseWallClock(String(s.windowEnd), 'interval windowEnd');
    out.windowStart = `${String(ws.hour).padStart(2, '0')}:${String(ws.minute).padStart(2, '0')}`;
    out.windowEnd = `${String(we.hour).padStart(2, '0')}:${String(we.minute).padStart(2, '0')}`;
    if (out.windowStart === out.windowEnd) throw new Error('interval windowStart and windowEnd must differ');
  }
  if (s.endsAt !== undefined) {
    if (typeof s.endsAt !== 'string') throw new Error('interval endsAt must be a datetime string');
    parseScheduleInstant(s.endsAt, timezone as string, 'interval endsAt'); // validates
    out.endsAt = s.endsAt.trim();
  }
  return out;
}

/** Human-readable one-line summary of a schedule (UI + logs). */
export function describeSchedule(s: RoutineSchedule): string {
  const tz = s.timezone;
  switch (s.kind) {
    case 'once':
      return `once at ${s.runAt} (${tz})`;
    case 'daily': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = s.weekdays.length === 7 ? 'daily' : s.weekdays.map((d) => names[d]).join('/');
      return `${days} at ${s.time} (${tz})`;
    }
    case 'cron':
      return `cron "${s.expression}" (${tz})`;
    case 'interval': {
      let d = `every ${s.everyMinutes}m`;
      if (s.anchorTime) d += ` from ${s.anchorTime}`;
      if (s.windowStart) d += ` ${s.windowStart}–${s.windowEnd}`;
      if (s.weekdays) d += ` on ${s.weekdays.join(',')}`;
      if (s.endsAt) d += ` until ${s.endsAt}`;
      return `${d} (${tz})`;
    }
    case 'limit-reset': {
      let d = 'on provider limit reset';
      if (s.providerId) d += ` (${s.providerId})`;
      if (s.resumeAt) d += ` — armed for ${s.resumeAt}`;
      else d += ` — waits for a limit event (default backoff ${s.defaultBackoffMinutes ?? 60}m)`;
      return `${d} (${tz})`;
    }
    case 'idle':
      return `after ${s.afterMinutes}m of bot inactivity (${tz})`;
    case 'event': {
      let d = `on ${s.app} event via account ${s.accountId}`;
      if (s.app === 'gmail' && (s.from || s.subjectContains || s.query)) {
        const f = [s.from && `from:${s.from}`, s.subjectContains && `subject:~${s.subjectContains}`, s.query].filter(Boolean).join(' ');
        d += ` matching ${f}`;
      }
      if (s.app === 'slack') d += ` in channel ${s.channelId}${s.keyword ? ` matching "${s.keyword}"` : ''}`;
      if (s.app === 'github') d += ` on ${s.repo} (${(s.eventTypes ?? []).join('/')})`;
      if (s.app === 'stripe') d += ` (${(s.stripeEventTypes ?? []).join('/')})`;
      if (s.app === 'googlecalendar') d += ` on ${s.calendarId ?? 'primary'} starting within ${s.windowMinutes ?? 120}m`;
      return `${d} — polls every ${s.pollMinutes}m, cap ${s.dailyCap}/day (${tz})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------------------

export interface NextRun {
  /** UTC epoch ms of the occurrence. */
  at: number;
  /** ISO 8601 string in UTC. */
  atIso: string;
  /** Wall-clock label in the schedule's timezone, e.g. "2026-10-17 09:00 (Asia/Kolkata)". */
  label: string;
}

const MAX_NEXT_RUNS = 100;
/** Hard cap on forward scanning so a pathological schedule can't spin. */
const MAX_SCAN_DAYS = 400;

function makeNextRun(timeZone: string, at: number): NextRun {
  const p = zonedParts(timeZone, at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    at,
    atIso: new Date(at).toISOString(),
    label: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${timeZone})`,
  };
}

function onceInstant(s: OnceSchedule): number {
  return parseScheduleInstant(s.runAt, s.timezone, 'runAt');
}

function nextRunsOnce(s: OnceSchedule, n: number, fromMs: number): NextRun[] {
  const at = onceInstant(s);
  return at > fromMs ? [makeNextRun(s.timezone, at)].slice(0, n) : [];
}

function nextRunsDaily(s: DailySchedule, n: number, fromMs: number): NextRun[] {
  const { hour, minute } = parseWallClock(s.time, 'daily time');
  const out: NextRun[] = [];
  let cursor = zonedParts(s.timezone, fromMs);
  for (let d = 0; d < MAX_SCAN_DAYS && out.length < n; d++) {
    const date = shiftDate(cursor, d);
    const at = wallToUtcMs(s.timezone, { ...date, hour, minute });
    // null = nonexistent wall time (DST spring-forward gap): skip the day.
    if (at === null) continue;
    if (at <= fromMs) continue;
    const wd = zonedParts(s.timezone, at).weekday;
    if (!s.weekdays.includes(wd)) continue;
    out.push(makeNextRun(s.timezone, at));
  }
  return out;
}

function nextRunsCron(s: CronSchedule, n: number, fromMs: number): NextRun[] {
  const parsed = parseCron(s.expression);
  const out: NextRun[] = [];
  // Start at the next whole minute strictly after `fromMs`.
  const cursorMin = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const startWall = zonedParts(s.timezone, cursorMin);
  const startMinuteOfDay = startWall.hour * 60 + startWall.minute;

  const dayMatches = (date: { year: number; month: number; day: number }): boolean => {
    if (!fieldMatches(parsed.month, date.month)) return false;
    const wd = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const domOk = fieldMatches(parsed.dom, date.day);
    const dowOk = fieldMatches(parsed.dow, wd);
    // Standard cron day semantics: dom/dow are OR-ed when both restricted.
    if (parsed.dom.star && parsed.dow.star) return true;
    if (parsed.dom.star) return dowOk;
    if (parsed.dow.star) return domOk;
    return domOk || dowOk;
  };

  for (let d = 0; d < MAX_SCAN_DAYS && out.length < n; d++) {
    const date = shiftDate(startWall, d);
    if (!dayMatches(date)) continue;
    const firstMinute = d === 0 ? startMinuteOfDay : 0;
    for (let mi = firstMinute; mi < 1440 && out.length < n; mi++) {
      const hour = Math.floor(mi / 60);
      const minute = mi % 60;
      if (!fieldMatches(parsed.hour, hour) || !fieldMatches(parsed.minute, minute)) continue;
      const at = wallToUtcMs(s.timezone, { ...date, hour, minute });
      // null = spring-forward gap minute: can never occur, skip.
      // Enumerating wall minutes means a fall-back overlap yields exactly
      // one occurrence (wallToUtcMs picks the first deterministically).
      if (at === null || at <= fromMs) continue;
      out.push(makeNextRun(s.timezone, at));
    }
  }
  return out;
}

/**
 * Interval grid anchor: the anchor wall-clock on 1970-01-01 in the
 * schedule's timezone, as a UTC instant. Anchoring to the epoch (not to
 * "now" or boot time) keeps the occurrence grid stable across restarts,
 * so a restart can never double-fire or skip an occurrence.
 */
function intervalAnchorMs(s: IntervalSchedule): number {
  const { hour, minute } = parseWallClock(s.anchorTime ?? '00:00', 'interval anchorTime');
  const at = wallToUtcMs(s.timezone, { year: 1970, month: 1, day: 1, hour, minute });
  if (at === null) {
    // 00:0x on 1970-01-01 essentially always exists; a zone with a
    // transition exactly then is pathological — fall back to UTC midnight.
    return 0;
  }
  return at;
}

function intervalWindowAllows(s: IntervalSchedule, at: number): boolean {
  if (!s.windowStart || !s.windowEnd) return true;
  const p = zonedParts(s.timezone, at);
  const t = p.hour * 60 + p.minute;
  const ws = parseWallClock(s.windowStart, 'windowStart');
  const we = parseWallClock(s.windowEnd, 'windowEnd');
  const start = ws.hour * 60 + ws.minute;
  const end = we.hour * 60 + we.minute;
  // Overnight windows (e.g. 22:00–06:00) wrap around midnight.
  return start < end ? t >= start && t < end : t >= start || t < end;
}

function nextRunsInterval(s: IntervalSchedule, n: number, fromMs: number): NextRun[] {
  const step = s.everyMinutes * 60_000;
  const anchor = intervalAnchorMs(s);
  const endsAt = s.endsAt ? parseScheduleInstant(s.endsAt, s.timezone, 'endsAt') : Infinity;
  const out: NextRun[] = [];
  // First k with anchor + k*step > fromMs.
  let k = Math.max(0, Math.floor((fromMs - anchor) / step) + 1);
  // Safety: k must stay non-negative (fromMs < anchor → k=0).
  if (anchor + k * step <= fromMs) k += 1;
  const maxK = k + Math.ceil((MAX_SCAN_DAYS * 86_400_000) / step) + 2;
  for (; k <= maxK && out.length < n; k++) {
    const at = anchor + k * step;
    if (at > endsAt) break;
    const p = zonedParts(s.timezone, at);
    if (s.weekdays && !s.weekdays.includes(p.weekday)) continue;
    if (!intervalWindowAllows(s, at)) continue;
    out.push(makeNextRun(s.timezone, at));
  }
  return out;
}

/**
 * The next N run times strictly after `fromMs` (default: now).
 * Returns at most 100 runs. Throws on invalid schedules.
 */
function nextRunsLimitReset(s: LimitResetSchedule, n: number, fromMs: number): NextRun[] {
  if (!s.resumeAt) return []; // not armed yet — a limit event arms it
  const at = parseScheduleInstant(s.resumeAt, s.timezone, 'resumeAt');
  return at > fromMs ? [makeNextRun(s.timezone, at)].slice(0, n) : [];
}

/**
 * Resume instant for a limit-blocked routine: the provider's reset time
 * from the error when available, else retry-after, else the schedule's
 * configured default backoff (or the global default). Pure — the single
 * computation both the API route and the scheduler use.
 */
export function computeLimitResetResumeAt(
  err: unknown,
  opts?: { nowMs?: number; defaultBackoffMinutes?: number; providerId?: string },
): number {
  const classified = classifyProviderError(err, { providerId: opts?.providerId });
  const fallback =
    opts?.defaultBackoffMinutes !== undefined
      ? opts.defaultBackoffMinutes * 60_000
      : DEFAULT_LIMIT_BACKOFF_MS;
  return computeResumeAtMs(classified, { nowMs: opts?.nowMs, defaultBackoffMs: fallback });
}

export function nextRuns(schedule: RoutineSchedule, n = 5, fromMs: number = Date.now()): NextRun[] {
  const count = Math.max(1, Math.min(MAX_NEXT_RUNS, Math.floor(n) || 5));
  switch (schedule.kind) {
    case 'once':
      return nextRunsOnce(schedule, count, fromMs);
    case 'daily':
      return nextRunsDaily(schedule, count, fromMs);
    case 'cron':
      return nextRunsCron(schedule, count, fromMs);
    case 'interval':
      return nextRunsInterval(schedule, count, fromMs);
    case 'limit-reset':
      return nextRunsLimitReset(schedule, count, fromMs);
    case 'event':
      // Event triggers are poll-driven (routine-events.ts), not a time
      // grid — there is no computable "next run" instant.
      return [];
    case 'idle':
      // Idle triggers are activity-driven (see tickRoutine), not a
      // time grid — there is no computable "next run" instant.
      return [];
  }
}

/**
 * Occurrences with fromMs < at <= toMs. Used by the scheduler tick.
 * Bounded: at most 500 occurrences are enumerated.
 */
export function occurrencesBetween(schedule: RoutineSchedule, fromMs: number, toMs: number): NextRun[] {
  if (toMs <= fromMs) return [];
  return nextRuns(schedule, 500, fromMs).filter((r) => r.at <= toMs);
}

// ---------------------------------------------------------------------------
// Scheduler engine
// ---------------------------------------------------------------------------

export interface RoutineFireInfo {
  routine: BotRoutine;
  /** The scheduled occurrence time (UTC ms). */
  at: number;
  ok: boolean;
  error?: string;
  /** True when the run was skipped by the 'skip' overlap policy. */
  skipped?: boolean;
}

export interface RoutineSchedulerDeps {
  routineStore: RoutineStore;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Render the routine prompt template (default: {{payload}} substitution). */
  renderPrompt?: (template: string, body: unknown) => string;
  /** Called after every scheduled fire attempt (and every skip). */
  onFire?: (info: RoutineFireInfo) => void;
  /** Clock override for tests. */
  now?: () => number;
  /**
   * Run-record store (routine-runs.ts). When set, every fire leaves a run
   * record and manual controls (run-now / cancel / retry) are available.
   * Omit it and the scheduler behaves exactly as before (no records).
   */
  runStore?: RoutineRunStore;
  /**
   * Turn executor. Defaults to a RoutineRunExecutor over runStore +
   * agentRuntime when runStore is set; inject a stub in tests.
   */
  runExecutor?: RoutineRunExecutor;
  /**
   * Missed-occurrence window for reconcileMissedRuns (boot): occurrences
   * older than this are too stale to record. Default 24h.
   */
  catchUpWindowMs?: number;
  /** Called when a failure streak auto-pauses a schedule. */
  onScheduleAutoPaused?: (routine: BotRoutine, streak: number) => void;
  /**
   * Limit-reset resumes (W1): durable pending resumes for limit-blocked
   * routines. When set, tick() fires due resumes and
   * reconcileLimitResetResumes() recovers crash-orphaned ones on boot.
   */
  resumeStore?: LimitResetResumeStore;
  /** Called after a limit-reset resume fires (observability / Activity). */
  onLimitResetResume?: (resume: LimitResetResume, routine: BotRoutine) => void;
  /** Global pause gate (W14d): while paused, ticks skip entirely. */
  isPaused?: () => boolean;
  /**
   * Idle triggers (Octomind parity): the bot's last turn-activity time
   * (UTC ms), or undefined when the bot has never been active. Without
   * this source, idle schedules simply never fire.
   */
  lastBotActivityAt?: (botId: string) => number | undefined;
}

/** Missed occurrences older than this are too stale to record (boot catch-up). */
export const DEFAULT_CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bounded backfill: at most this many catch-up runs per routine per boot. */
export const MAX_CATCH_UP_RUNS = 3;

/**
 * Ticks on an interval; for each routine with an enabled schedule, fires
 * the occurrences that fell inside (lastTick, now].
 *
 * Restart behavior: a routine's last-fired watermark is persisted in the
 * store. On boot, routines with no watermark get watermarked at the boot
 * time. Missed occurrences from downtime are handled by
 * reconcileMissedRuns() (call once before start()): occurrences inside the
 * catch-up window are recorded as 'missed' run records, and routines with
 * catchUp:true get a bounded backfill (max 3 runs). The epoch-anchored
 * interval grid and minute-granular cron matching mean a restart can
 * neither double-fire nor skip an occurrence that falls after boot.
 */
export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private booted = false;
  private readonly executor: RoutineRunExecutor | undefined;

  constructor(private readonly deps: RoutineSchedulerDeps) {
    this.executor =
      deps.runExecutor ??
      (deps.runStore
        ? new RoutineRunExecutor({
            runStore: deps.runStore,
            agentRuntime: deps.agentRuntime,
            getBots: deps.getBots,
            renderPrompt: deps.renderPrompt,
          })
        : undefined);
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => {
      console.error('[routine-scheduler] tick failed:', err instanceof Error ? err.message : err);
    }), intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    // First tick shortly after boot so schedules due at startup fire
    // promptly; boot watermarking (see tick) prevents backfill.
    setTimeout(() => void this.tick().catch(() => {}), 2_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** For tests: is a scheduled run currently in flight for this routine? */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  async tick(nowMs?: number): Promise<void> {
    if (this.deps.isPaused?.()) return; // W14d global pause: skip the tick
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = nowMs ?? this.deps.now?.() ?? Date.now();
      for (const routine of this.deps.routineStore.list()) {
        await this.tickRoutine(routine, now);
      }
      await this.tickLimitResetResumes(now);
      this.booted = true;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Arm a limit-reset resume for a routine blocked by a provider limit.
   * Computes the resume instant from the error (reset / retry-after /
   * the schedule's default backoff), persists it in the resume store
   * (survives restart), and mirrors it onto a limit-reset schedule when
   * the routine has one. Returns the persisted resume.
   */
  armLimitResetResume(
    routine: BotRoutine,
    err: unknown,
    opts?: { providerId?: string; nowMs?: number },
  ): LimitResetResume {
    const store = this.deps.resumeStore;
    if (!store) throw new Error('limit-reset resumes are not enabled');
    const schedule = routine.schedule?.kind === 'limit-reset' ? routine.schedule : undefined;
    const providerId = opts?.providerId ?? schedule?.providerId ?? 'unknown';
    const resumeAt = computeLimitResetResumeAt(err, {
      nowMs: opts?.nowMs,
      defaultBackoffMinutes: schedule?.defaultBackoffMinutes,
      providerId,
    });
    const classified = classifyProviderError(err, { providerId });
    const resume = store.schedule({
      routineId: routine.id,
      botId: routine.botId,
      providerId,
      resumeAt,
      reason: classified.message.slice(0, 300),
    });
    if (schedule) {
      try {
        this.deps.routineStore.setSchedule(routine.id, {
          ...schedule,
          resumeAt: new Date(resumeAt).toISOString(),
        });
      } catch {
        // Mirroring is display-only; the resume store is authoritative.
      }
    }
    return resume;
  }

  /**
   * Boot reconciliation for limit-reset resumes: crash-orphaned 'firing'
   * resumes return to 'pending'; due ones fire on the next tick.
   */
  reconcileLimitResetResumes(nowMs?: number): { recovered: number; due: number } {
    const store = this.deps.resumeStore;
    if (!store) return { recovered: 0, due: 0 };
    return store.reconcileOnBoot(nowMs ?? this.deps.now?.() ?? Date.now());
  }

  /** Fire every due pending limit-reset resume. Called from tick(). */
  private async tickLimitResetResumes(now: number): Promise<void> {
    const store = this.deps.resumeStore;
    if (!store) return;
    for (const resume of store.duePending(now)) {
      if (!resume.routineId) continue; // standalone resumes are host-fired
      const routine = this.deps.routineStore.get(resume.routineId);
      if (!routine || !routine.enabled) {
        store.cancel(resume.id);
        continue;
      }
      if (routine.schedule?.overlap === 'skip' && this.inFlight.has(routine.id)) continue;
      if (!store.claim(resume.id)) continue;
      try {
        await this.fireResume(routine, resume);
        store.markFired(resume.id);
        try {
          this.deps.onLimitResetResume?.(resume, routine);
        } catch (err) {
          console.error('[routine-scheduler] onLimitResetResume threw:', err instanceof Error ? err.message : err);
        }
      } catch (err) {
        store.release(resume.id);
        console.error('[routine-scheduler] limit-reset resume failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  private async fireResume(routine: BotRoutine, resume: LimitResetResume): Promise<void> {
    this.inFlight.add(routine.id);
    try {
      if (this.executor) {
        await this.executor.execute({
          routine,
          trigger: 'schedule',
          scheduledFor: resume.resumeAt,
          payload: {
            source: 'limit-reset',
            routineId: routine.id,
            routineName: routine.name,
            resumeId: resume.id,
            providerId: resume.providerId,
            reason: resume.reason,
          },
          sessionId: routine.sessionId ?? `routine_${routine.id}`,
          onSettled: () => this.checkStreak(routine),
        });
      } else {
        const bot = this.deps.getBots().find((b) => b.id === routine.botId);
        if (!bot) throw new Error(`Unknown bot "${routine.botId}"`);
        const render = this.deps.renderPrompt ?? defaultRenderPrompt;
        const message = render(routine.promptTemplate, {
          source: 'limit-reset',
          routineId: routine.id,
          routineName: routine.name,
          resumeId: resume.id,
        });
        await this.deps.agentRuntime.runTurn({
          bot,
          message,
          sessionId: routine.sessionId ?? `routine_${routine.id}`,
          taskType: 'chat',
          onEvent: () => {},
        });
      }
    } finally {
      this.inFlight.delete(routine.id);
    }
  }

  private async tickRoutine(routine: BotRoutine, now: number): Promise<void> {
    const schedule = routine.schedule;
    if (!routine.enabled || !schedule || !schedule.enabled) return;
    // Event schedules are fired by the EventTriggerPoller
    // (routine-events.ts), which owns their cursors — never by this
    // time-grid tick.
    if (schedule.kind === 'event') return;
    // Limit-reset schedules fire through the durable resume store (the
    // authoritative path) when one is wired — never twice.
    if (schedule.kind === 'limit-reset' && this.deps.resumeStore) return;

    // Idle triggers: fire once per idle period. An idle period's
    // threshold instant is lastActivity + afterMinutes; the watermark
    // reaching that instant means this period is already covered (by
    // a fire, or by first-sight arming after the threshold passed —
    // no backfill, matching the other kinds). New activity starts a
    // new period with a later threshold, which re-arms the trigger.
    if (schedule.kind === 'idle') {
      const lastActivity = this.deps.lastBotActivityAt?.(routine.botId);
      if (lastActivity === undefined) return;
      const watermark = this.deps.routineStore.getLastFiredAt(routine.id);
      if (watermark === undefined) {
        this.deps.routineStore.setLastFiredAt(routine.id, now);
        return;
      }
      const afterMs = schedule.afterMinutes * 60_000;
      if (now - lastActivity < afterMs) return;
      if (watermark >= lastActivity + afterMs) return; // period already covered
      if (schedule.overlap === 'skip' && this.inFlight.has(routine.id)) return;
      this.deps.routineStore.setLastFiredAt(routine.id, now);
      void this.fire(routine, now);
      return;
    }

    let watermark = this.deps.routineStore.getLastFiredAt(routine.id);
    if (watermark === undefined) {
      // First sight (fresh schedule or pre-schedule routine): watermark
      // at now so downtime occurrences don't backfill on boot.
      this.deps.routineStore.setLastFiredAt(routine.id, now);
      return;
    }
    if (watermark > now) {
      // Clock moved backwards — re-anchor rather than firing a huge
      // backfill window.
      this.deps.routineStore.setLastFiredAt(routine.id, now);
      return;
    }

    const due = occurrencesBetween(schedule, watermark, now);
    if (due.length === 0) return;
    // Advance the watermark past this tick even if firing fails, so a
    // failing routine can't wedge the scheduler into a retry storm.
    // (Failure reporting goes through onFire.)
    this.deps.routineStore.setLastFiredAt(routine.id, now);

    for (const occ of due) {
      if (schedule.overlap === 'skip' && this.inFlight.has(routine.id)) {
        // A skip is a missed run: record it so the history shows the gap.
        this.recordMissed(routine, occ.at, 'skipped: previous run still in flight (overlap: skip)');
        this.emit({ routine, at: occ.at, ok: true, skipped: true });
        continue;
      }
      // Fire without awaiting: a long-running turn must not block the
      // scheduler (or other routines). The 'skip' overlap policy is
      // enforced via the inFlight set, which fire() maintains.
      void this.fire(routine, occ.at);
    }
  }

  /**
   * Boot reconciliation for missed occurrences. Call once before start().
   *
   * For each routine with an enabled schedule and a stale watermark:
   * occurrences in (watermark, now] inside the catch-up window
   * (default 24h) are recorded as 'missed' runs; routines with
   * catchUp:true also run the 3 most recent missed occurrences as
   * catch-up runs (bounded backfill). Older windows are simply
   * re-anchored — no records, no fires.
   */
  async reconcileMissedRuns(nowMs?: number): Promise<{ routines: number; missed: number; catchUpRuns: number }> {
    const now = nowMs ?? this.deps.now?.() ?? Date.now();
    const windowMs = this.deps.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS;
    let routines = 0;
    let missed = 0;
    let catchUpRuns = 0;
    for (const routine of this.deps.routineStore.list()) {
      const schedule = routine.schedule;
      if (!routine.enabled || !schedule || !schedule.enabled) continue;
      // Event triggers reconcile through their own cursor catch-up in
      // the EventTriggerPoller (bounded, per routine-events.ts).
      if (schedule.kind === 'event') continue;
      // Idle triggers have no occurrence grid to reconcile.
      if (schedule.kind === 'idle') continue;
      const watermark = this.deps.routineStore.getLastFiredAt(routine.id);
      if (watermark === undefined || watermark >= now) continue;
      const gap = now - watermark;
      if (gap <= 0 || gap > windowMs) continue;
      const due = occurrencesBetween(schedule, watermark, now);
      if (due.length === 0) continue;
      routines += 1;
      for (const occ of due) {
        this.recordMissed(routine, occ.at, 'missed while the server was down');
        missed += 1;
      }
      if (schedule.catchUp === true && this.executor) {
        for (const occ of due.slice(-MAX_CATCH_UP_RUNS)) {
          void this.fire(routine, occ.at, { catchUp: true });
          catchUpRuns += 1;
        }
      }
      // Advance the watermark so the first tick doesn't reprocess.
      this.deps.routineStore.setLastFiredAt(routine.id, now);
    }
    return { routines, missed, catchUpRuns };
  }

  /**
   * Manually fire a routine right now (trigger 'manual'). Returns the run
   * id; the turn runs in the background.
   */
  async runNow(routineId: string): Promise<string> {
    const routine = this.deps.routineStore.get(routineId);
    if (!routine) throw new Error(`Unknown routine "${routineId}"`);
    if (!routine.enabled) throw new Error(`Routine "${routine.name}" is paused`);
    const bot = this.deps.getBots().find((b) => b.id === routine.botId);
    if (!bot) throw new Error(`Unknown bot "${routine.botId}"`);
    if (!this.executor) throw new Error('run records are not enabled');
    return this.executor.execute({
      routine,
      trigger: 'manual',
      payload: { source: 'manual', routineId: routine.id, routineName: routine.name },
      sessionId: routine.sessionId ?? `routine_${routine.id}`,
      onSettled: () => this.checkStreak(routine),
    });
  }

  /**
   * Retry a failed/cancelled/missed run as a fresh manual run. Returns the
   * new run id.
   */
  async retryRun(runId: string): Promise<string> {
    const runStore = this.deps.runStore;
    if (!runStore) throw new Error('run records are not enabled');
    const run = runStore.get(runId);
    if (!run) throw new Error(`Unknown run "${runId}"`);
    if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'missed') {
      throw new Error(`Run ${runId} is ${run.status} — only failed/cancelled/missed runs can be retried`);
    }
    const routine = this.deps.routineStore.get(run.routineId);
    if (!routine) throw new Error(`Routine for run "${runId}" was deleted`);
    if (!routine.enabled) throw new Error(`Routine "${routine.name}" is paused`);
    const bot = this.deps.getBots().find((b) => b.id === routine.botId);
    if (!bot) throw new Error(`Unknown bot "${routine.botId}"`);
    if (!this.executor) throw new Error('run records are not enabled');
    return this.executor.execute({
      routine,
      trigger: 'manual',
      scheduledFor: run.scheduledFor,
      payload: {
        source: 'retry',
        routineId: routine.id,
        routineName: routine.name,
        originalRunId: run.id,
        originalTrigger: run.trigger,
      },
      sessionId: routine.sessionId ?? `routine_${routine.id}`,
      onSettled: () => this.checkStreak(routine),
    });
  }

  /** Cancel a queued/running run (aborts the turn). */
  cancelRun(runId: string): boolean {
    return this.executor?.cancel(runId) ?? false;
  }

  /** Record a missed occurrence (best-effort; never breaks the scheduler). */
  private recordMissed(routine: BotRoutine, at: number, note: string): void {
    try {
      this.deps.runStore?.markMissed(routine.id, routine.name, at, note);
    } catch (err) {
      console.error('[routine-scheduler] failed to record missed run:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * After a run settles, check the failure streak: at failureStreakLimit
   * (default 3) consecutive failures the schedule auto-pauses and the
   * onScheduleAutoPaused hook notifies the user.
   */
  private checkStreak(routine: BotRoutine): void {
    const { runStore, routineStore } = this.deps;
    const schedule = routine.schedule;
    if (!runStore || !schedule || !schedule.enabled) return;
    const limit = schedule.failureStreakLimit ?? 3;
    const { consecutiveFailures } = runStore.getStreak(routine.id);
    if (consecutiveFailures >= limit) {
      routineStore.setScheduleEnabled(routine.id, false);
      const paused: BotRoutine = { ...routine, schedule: { ...schedule, enabled: false } };
      try {
        this.deps.onScheduleAutoPaused?.(paused, consecutiveFailures);
      } catch (err) {
        console.error('[routine-scheduler] onScheduleAutoPaused threw:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Invoke onFire without letting a throwing listener break the scheduler. */
  private emit(info: RoutineFireInfo): void {
    try {
      this.deps.onFire?.(info);
    } catch (err) {
      console.error('[routine-scheduler] onFire listener threw:', err instanceof Error ? err.message : err);
    }
  }

  private async fire(routine: BotRoutine, at: number, opts?: { catchUp?: boolean }): Promise<void> {
    const { agentRuntime, getBots } = this.deps;
    const bot = getBots().find((b) => b.id === routine.botId);
    if (!bot) {
      this.emit({ routine, at, ok: false, error: `Unknown bot "${routine.botId}"` });
      return;
    }
    this.inFlight.add(routine.id);
    const settle = (ok: boolean, error?: string): void => {
      this.inFlight.delete(routine.id);
      this.emit({ routine, at, ok, error });
    };
    try {
      if (this.executor) {
        // Run-record path: the executor owns the turn and its bookkeeping.
        // inFlight is held until the turn settles (onSettled), preserving
        // the 'skip' overlap semantics for long runs.
        const onSettled = (res: RunSettledResult): void => {
          settle(res.status === 'succeeded', res.error ?? undefined);
          this.checkStreak(routine);
        };
        await this.executor.execute({
          routine,
          trigger: 'schedule',
          scheduledFor: at,
          payload: {
            source: 'schedule',
            routineId: routine.id,
            routineName: routine.name,
            scheduledAt: new Date(at).toISOString(),
            ...(opts?.catchUp ? { catchUp: true } : {}),
          },
          sessionId: routine.sessionId ?? `routine_${routine.id}`,
          onSettled,
        });
      } else {
        // Legacy path (no runStore): direct turn, same as before.
        const render = this.deps.renderPrompt ?? defaultRenderPrompt;
        try {
          const message = render(routine.promptTemplate, {
            source: 'schedule',
            routineId: routine.id,
            routineName: routine.name,
            scheduledAt: new Date(at).toISOString(),
          });
          await agentRuntime.runTurn({
            bot,
            message,
            sessionId: routine.sessionId ?? `routine_${routine.id}`,
            taskType: 'chat',
            onEvent: () => {},
          });
          settle(true);
        } catch (err) {
          settle(false, err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      settle(false, err instanceof Error ? err.message : String(err));
    }
  }
}

function defaultRenderPrompt(template: string, body: unknown): string {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return template.split('{{payload}}').join(payload).split('{{body}}').join(payload);
}
