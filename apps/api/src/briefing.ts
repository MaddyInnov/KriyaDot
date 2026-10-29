// SPDX-License-Identifier: Apache-2.0
// Daily Briefing backend. Assembles the overnight digest the web UI's
// briefing panel renders (contract in apps/web/lib/kriyadot-api.ts:
// GET /api/briefing -> { generatedAt, overnight[], calendar[], approvals[],
// summary?, regressions? }).
//
// Sources:
//   - overnight:  governance audit log since the previous briefing (or the
//                 last 12h when there is none)
//   - calendar:   today's events from the platform calendar event store
//                 (tasks.ts CalendarEventStore, <dataDir>/events.json). There
//                 is no external calendar sync server-side — the
//                 google_calendar skill is a client-side assistant capability —
//                 so the briefing reads the platform's own events file and
//                 returns [] when it holds nothing for today.
//   - approvals:  pending approvals from governance.listApprovals('pending')
//   - regressions: the existing run-health regression detector
//                 (same inputs as GET /api/health/regressions)
//   - summary:    3-6 sentence narrative. Prefers a LOCAL Ollama model
//                 (zero cost, no API keys — never a paid API); when Ollama
//                 is unreachable or returns nothing usable, falls back to a
//                 deterministic template so the briefing always renders.
//
// Storage: <dataDir>/briefing.db (node:sqlite, same pattern as
// preferences.ts / thread-scheduler.ts). Retention: 30 days of briefings.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalRecord, AuditEntry, GovernanceGateway } from '@mvp/governance';
import { createProvider } from '@mvp/agent-runtime';
import type { LLMProvider } from '@mvp/agent-runtime';
import { detectRegressions } from '@mvp/run-health';
import type { MetricSample, RegressionAlert, RunHealthStore } from '@mvp/run-health';
import { CalendarEventStore } from './tasks.js';
import { NoteStore } from './notes.js';

import { openDb } from '@mvp/agent-runtime';

// ---- Contract types (mirror apps/web/lib/kriyadot-api.ts) -----------------------

export interface BriefingItem {
  id?: string;
  title: string;
  detail?: string;
  ts?: number;
  kind?: string;
}

export interface Briefing {
  generatedAt: number;
  overnight: BriefingItem[];
  calendar: BriefingItem[];
  approvals: BriefingItem[];
  /** Notes created/updated since the previous briefing (feature interconnection). */
  notes?: BriefingItem[];
  /** Recent workflow runs (feature interconnection). */
  workflows?: BriefingItem[];
  /**
   * Connected-app signals (W14c): GitHub review requests, failing CI,
   * mentions. Optional + omitted when the source is unavailable, so older
   * payloads and not-connected setups render exactly as before.
   */
  signals?: BriefingItem[];
  /**
   * Batched phone notifications digest (W14b): non-urgent notifications
   * accumulated since the previous briefing. Optional, same rule.
   */
  notifications?: BriefingItem[];
  summary?: string;
  regressions?: RegressionAlert[];
}

export type BriefingKind = 'scheduled' | 'manual';

// ---- Config -------------------------------------------------------------------

/** Briefings older than this are pruned on every save. */
export const BRIEFING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Overnight window when no previous briefing exists. */
export const OVERNIGHT_FALLBACK_MS = 12 * 60 * 60 * 1000;
/** Max overnight items carried into one briefing. */
export const OVERNIGHT_ITEM_LIMIT = 50;
/** Max notes carried into one briefing. */
export const NOTES_ITEM_LIMIT = 10;
/** Max workflow runs carried into one briefing. */
export const WORKFLOWS_ITEM_LIMIT = 10;
/** Max audit rows scanned per generation. */
const AUDIT_SCAN_LIMIT = 500;
/** Local-Ollama chat timeout (generation must never hang the request). */
const OLLAMA_TIMEOUT_MS = 30_000;

export interface BriefingConfig {
  /** Local delivery time, "HH:MM" 24h. */
  briefingTime: string;
  briefingEnabled: boolean;
}

export const DEFAULT_BRIEFING_CONFIG: BriefingConfig = {
  briefingTime: '07:00',
  briefingEnabled: true,
};

const BRIEFING_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateBriefingTime(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !BRIEFING_TIME_RE.test(value)) {
    throw new Error('briefingTime must be "HH:MM" (24h), e.g. "07:00".');
  }
}

// ---- Store --------------------------------------------------------------------

export interface StoredBriefing {
  id: string;
  generatedAt: number;
  kind: BriefingKind;
  payload: Briefing;
}

export interface BriefingHistoryItem {
  id: string;
  generatedAt: number;
  kind: BriefingKind;
  summary?: string;
}

interface BriefingRow {
  id: string;
  generated_at: number;
  kind: string;
  payload: string;
}

export class BriefingStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'briefing.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS briefings (
        id TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_briefings_generated_at ON briefings(generated_at DESC);
      CREATE TABLE IF NOT EXISTS briefing_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Persist a generated briefing; prunes rows older than the retention window. */
  saveBriefing(kind: BriefingKind, briefing: Briefing): StoredBriefing {
    const stored: StoredBriefing = {
      id: randomUUID(),
      generatedAt: briefing.generatedAt,
      kind,
      payload: briefing,
    };
    this.db
      .prepare('INSERT INTO briefings (id, generated_at, kind, payload) VALUES (?, ?, ?, ?)')
      .run(stored.id, stored.generatedAt, kind, JSON.stringify(briefing));
    this.prune();
    return stored;
  }

  latest(): StoredBriefing | undefined {
    const row = this.db
      .prepare('SELECT * FROM briefings ORDER BY generated_at DESC LIMIT 1')
      .get() as unknown as BriefingRow | undefined;
    return row ? rowToStored(row) : undefined;
  }

  list(page: number, limit: number): { items: BriefingHistoryItem[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM briefings').get() as { n: number }).n;
    const rows = this.db
      .prepare('SELECT * FROM briefings ORDER BY generated_at DESC LIMIT ? OFFSET ?')
      .all(limit, (page - 1) * limit) as unknown as BriefingRow[];
    return { items: rows.map(rowToHistoryItem), total };
  }

  /**
   * Delete briefings older than the retention window. Returns the number of
   * rows removed. `now` is injectable for tests.
   */
  prune(now: number = Date.now()): number {
    const cutoff = now - BRIEFING_RETENTION_MS;
    return this.db.prepare('DELETE FROM briefings WHERE generated_at < ?').run(cutoff).changes as number;
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM briefing_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO briefing_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getConfig(): BriefingConfig {
    const cfg: BriefingConfig = { ...DEFAULT_BRIEFING_CONFIG };
    const time = this.getSetting('briefing_time');
    if (time !== undefined) {
      try {
        validateBriefingTime(time);
        cfg.briefingTime = time;
      } catch {
        // Corrupt stored value: keep the default rather than breaking boot.
      }
    }
    const enabled = this.getSetting('briefing_enabled');
    if (enabled === '0') cfg.briefingEnabled = false;
    else if (enabled === '1') cfg.briefingEnabled = true;
    return cfg;
  }

  /** Validate + persist a partial config patch; unknown keys are ignored. */
  setConfig(patch: Partial<BriefingConfig>): BriefingConfig {
    if (patch.briefingTime !== undefined) {
      validateBriefingTime(patch.briefingTime);
      this.setSetting('briefing_time', patch.briefingTime);
    }
    if (patch.briefingEnabled !== undefined) {
      if (typeof patch.briefingEnabled !== 'boolean') {
        throw new Error('briefingEnabled must be a boolean.');
      }
      this.setSetting('briefing_enabled', patch.briefingEnabled ? '1' : '0');
    }
    return this.getConfig();
  }
}

function rowToStored(r: BriefingRow): StoredBriefing {
  return {
    id: r.id,
    generatedAt: r.generated_at,
    kind: r.kind as BriefingKind,
    payload: JSON.parse(r.payload) as Briefing,
  };
}

function rowToHistoryItem(r: BriefingRow): BriefingHistoryItem {
  let summary: string | undefined;
  try {
    summary = (JSON.parse(r.payload) as Briefing).summary ?? undefined;
  } catch {
    summary = undefined;
  }
  return { id: r.id, generatedAt: r.generated_at, kind: r.kind as BriefingKind, summary };
}

// ---- Generation -----------------------------------------------------------------

export interface GenerateBriefingDeps {
  store?: BriefingStore;
  governance: GovernanceGateway;
  runHealth: RunHealthStore;
  dataDir?: string;
  calendarStore?: CalendarEventStore;
  /** Notes source (feature interconnection). Defaults to a NoteStore on dataDir. */
  noteStore?: NoteStore;
  /**
   * Workflow source (feature interconnection). Structural — the real
   * WorkflowRunner satisfies it; tests inject a fake.
   */
  workflowSource?: {
    listRuns: (workflowId?: string) => Array<{
      id: string;
      workflowId: string;
      status: string;
      createdAt: number;
      updatedAt: number;
    }>;
  };
  /**
   * Connected-app signals source (W14c, briefing-signals.ts). Structural —
   * the GitHub source satisfies it; tests inject a fake. Unset or failing
   * → no Signals section, brief unaffected.
   */
  signalsSource?: { collect: () => Promise<BriefingItem[]> };
  /**
   * Batched-notification digest source (W14b): NotificationStore.digestItems
   * satisfies this. Unset → no notifications section.
   */
  notificationDigest?: (since: number, now: number) => BriefingItem[];
  /**
   * Summary override (tests). Defaults to the Ollama attempt with a
   * deterministic template fallback.
   */
  summarize?: SummarizeFn;
}

export interface BriefingSummaryContext {
  overnightCount: number;
  botCount: number;
  approvalCount: number;
  approvalTitles: string[];
  eventCount: number;
  regressionCount: number;
  /** Notes changed in the briefing window (optional; 0/undefined → omitted). */
  noteCount?: number;
  /** Workflow runs in the briefing window (optional; 0/undefined → omitted). */
  workflowCount?: number;
  /** Connected-app signals (W14c; optional, same omission rule). */
  signalCount?: number;
  /** Batched phone notifications (W14b; optional, same omission rule). */
  notificationCount?: number;
}

export type SummarizeFn = (ctx: BriefingSummaryContext) => Promise<string | null>;

function humanizeAction(action: string): string {
  return action.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'event';
}

function auditToItem(e: AuditEntry): BriefingItem {
  const detailParts = [e.actor, e.toolName, e.decision].filter((p): p is string => Boolean(p));
  return {
    id: `audit-${e.id}`,
    title: humanizeAction(e.action),
    detail: detailParts.length ? detailParts.join(' · ') : undefined,
    ts: e.ts,
    kind: 'audit',
  };
}

function approvalToItem(a: ApprovalRecord): BriefingItem {
  return {
    id: a.id,
    title: `Approval needed: ${a.toolName}`,
    detail: [`requested by ${a.actor}`, `bot ${a.botId}`, a.provenance].filter((p): p is string => Boolean(p)).join(' · '),
    ts: a.ts,
    kind: 'approval',
  };
}

/** Notes created/updated inside the briefing window, newest first. */
function collectNotes(noteStore: NoteStore | undefined, since: number, now: number): BriefingItem[] {
  if (!noteStore) return [];
  try {
    return noteStore
      .list()
      .filter((n) => n.updatedAt >= since && n.updatedAt <= now)
      .slice(0, NOTES_ITEM_LIMIT)
      .map((n) => ({
        id: `note-${n.id}`,
        title: n.title,
        detail: n.content ? n.content.slice(0, 160) : undefined,
        ts: n.updatedAt,
        kind: 'note',
      }));
  } catch (err) {
    console.error('[briefing] notes collection failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Recent workflow runs (finished or still running), newest first. */
function collectWorkflowRuns(
  source: GenerateBriefingDeps['workflowSource'],
  since: number,
  now: number,
): BriefingItem[] {
  if (!source) return [];
  try {
    return source
      .listRuns()
      .filter((r) => r.updatedAt >= since && r.updatedAt <= now)
      .slice(0, WORKFLOWS_ITEM_LIMIT)
      .map((r) => ({
        id: `workflow-${r.id}`,
        title: `Workflow ${r.workflowId}: ${r.status}`,
        detail: `run ${r.id.slice(0, 8)}`,
        ts: r.updatedAt,
        kind: 'workflow',
      }));
  } catch (err) {
    console.error('[briefing] workflow-run collection failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today's calendar events (local day, overlapping the day counts). */
export function todaysEvents(calendarStore: CalendarEventStore, now: Date = new Date()): BriefingItem[] {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  return calendarStore
    .list()
    .filter((e) => {
      const s = Date.parse(e.startsAt);
      const en = Date.parse(e.endsAt);
      if (!Number.isFinite(s) || !Number.isFinite(en)) return false;
      return s < endOfDay && en >= startOfDay;
    })
    .map((e) => ({
      id: e.id,
      title: e.title,
      detail: `${fmtTime(e.startsAt)}–${fmtTime(e.endsAt)}${e.notes ? ` · ${e.notes}` : ''}`,
      ts: Date.parse(e.startsAt),
      kind: 'calendar',
    }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same inputs as GET /api/health/regressions; never throws. */
function collectRegressions(runHealth: RunHealthStore, now: number): RegressionAlert[] {
  try {
    const samples: MetricSample[] = [];
    for (const scope of runHealth.listScopes()) {
      samples.push(...runHealth.queryMetrics(scope.scopeKind, scope.scopeId, now - 14 * DAY_MS, now));
    }
    return detectRegressions(samples, { now });
  } catch (err) {
    console.error('[briefing] regression detection failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function buildSummaryPrompt(ctx: BriefingSummaryContext): string {
  const lines = [
    `Overnight activity: ${ctx.overnightCount} events across ${ctx.botCount} bots.`,
    ctx.approvalCount > 0
      ? `Pending approvals (${ctx.approvalCount}): ${ctx.approvalTitles.slice(0, 5).join('; ')}.`
      : 'Pending approvals: none.',
    ctx.eventCount > 0 ? `Calendar events today: ${ctx.eventCount}.` : 'Calendar events today: none.',
    ctx.regressionCount > 0
      ? `Health regressions in the last 7 days: ${ctx.regressionCount}.`
      : 'Health regressions in the last 7 days: none.',
  ];
  if ((ctx.noteCount ?? 0) > 0) lines.push(`Notes changed since the last briefing: ${ctx.noteCount}.`);
  if ((ctx.workflowCount ?? 0) > 0) lines.push(`Workflow runs since the last briefing: ${ctx.workflowCount}.`);
  if ((ctx.signalCount ?? 0) > 0) lines.push(`Connected-app signals needing attention: ${ctx.signalCount}.`);
  if ((ctx.notificationCount ?? 0) > 0) lines.push(`Phone notifications batched for this digest: ${ctx.notificationCount}.`);
  return (
    'Write a 3-6 sentence morning briefing for the operator of a personal AI agent platform, ' +
    'based only on these facts. Plain language, no jargon, no bullet points, no markdown.\n\n' +
    lines.join('\n')
  );
}

/**
 * Narrative summary via the provider stack — LOCAL Ollama only. Never a
 * paid API, never a key. Returns null on any failure (unreachable daemon,
 * no models pulled, empty/oversized reply) so the caller falls back to
 * the deterministic template.
 */
export async function summarizeWithOllama(ctx: BriefingSummaryContext): Promise<string | null> {
  let provider: LLMProvider;
  try {
    provider = createProvider('ollama');
  } catch {
    return null;
  }
  let modelId: string | undefined;
  try {
    const models = await provider.listModels();
    modelId = models[0]?.id;
  } catch {
    return null;
  }
  if (!modelId) return null; // Ollama reachable but no models pulled.
  try {
    const res = await provider.chat(
      [
        {
          role: 'system',
          content: 'You write concise morning briefings for the operator of a personal AI agent platform.',
        },
        { role: 'user', content: buildSummaryPrompt(ctx) },
      ],
      [],
      { model: modelId, signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) },
    );
    const text = res.content.trim();
    if (text.length < 10 || text.length > 2000) return null;
    return text;
  } catch {
    return null;
  }
}

/** Deterministic 4-sentence fallback — always renders, no LLM, no network. */
export function templateSummary(ctx: BriefingSummaryContext): string {
  const parts: string[] = [
    `Overnight: ${ctx.overnightCount} event${plural(ctx.overnightCount)} across ${ctx.botCount} bot${plural(ctx.botCount)}.`,
  ];
  parts.push(
    ctx.approvalCount > 0
      ? `${ctx.approvalCount} approval${plural(ctx.approvalCount)} pending${ctx.approvalTitles.length ? `: ${ctx.approvalTitles.slice(0, 3).join('; ')}` : ''}.`
      : 'No approvals pending.',
  );
  parts.push(
    ctx.eventCount > 0
      ? `Today: ${ctx.eventCount} calendar event${plural(ctx.eventCount)} scheduled.`
      : 'Nothing on the calendar today.',
  );
  parts.push(
    ctx.regressionCount > 0
      ? `${ctx.regressionCount} health regression${plural(ctx.regressionCount)} detected in the last 7 days — see /api/health/regressions for details.`
      : 'No health regressions in the last 7 days.',
  );
  // Extra sentences only when there is something to report, so the
  // baseline 4-sentence shape is unchanged when notes/workflows are empty.
  if ((ctx.noteCount ?? 0) > 0) {
    parts.push(`${ctx.noteCount} note${plural(ctx.noteCount ?? 0)} changed since the last briefing.`);
  }
  if ((ctx.workflowCount ?? 0) > 0) {
    parts.push(`${ctx.workflowCount} workflow run${plural(ctx.workflowCount ?? 0)} since the last briefing.`);
  }
  if ((ctx.signalCount ?? 0) > 0) {
    parts.push(`${ctx.signalCount} connected-app signal${plural(ctx.signalCount ?? 0)} need attention — see Signals.`);
  }
  if ((ctx.notificationCount ?? 0) > 0) {
    parts.push(`${ctx.notificationCount} phone notification${plural(ctx.notificationCount ?? 0)} were batched into this digest.`);
  }
  return parts.join(' ');
}

/**
 * Assemble one briefing. Does not persist — the caller saves it via
 * BriefingStore.saveBriefing with kind 'scheduled' | 'manual'.
 */
export async function generateBriefing(deps: GenerateBriefingDeps): Promise<Briefing> {
  const now = Date.now();
  const since = deps.store?.latest()?.generatedAt ?? now - OVERNIGHT_FALLBACK_MS;

  const windowed = deps.governance
    .listAudit(AUDIT_SCAN_LIMIT)
    .filter((e) => e.ts >= since && e.ts <= now);
  const overnight = windowed.slice(0, OVERNIGHT_ITEM_LIMIT).map(auditToItem);
  const botCount = new Set(windowed.map((e) => e.actor)).size;

  const calendarStore = deps.calendarStore ?? (deps.dataDir ? new CalendarEventStore(deps.dataDir) : undefined);
  const calendar = calendarStore ? todaysEvents(calendarStore) : [];

  const approvals = deps.governance.listApprovals('pending').map(approvalToItem);

  const regressions = collectRegressions(deps.runHealth, now);

  // Feature interconnection: notes + workflow runs join the digest.
  const noteStore = deps.noteStore ?? (deps.dataDir ? new NoteStore(deps.dataDir) : undefined);
  const notes = collectNotes(noteStore, since, now);
  const workflows = collectWorkflowRuns(deps.workflowSource, since, now);

  // W14c signals + W14b notification digest: both best-effort — any
  // failure (not connected, executor error, store error) yields an empty
  // section and the brief still generates.
  let signals: BriefingItem[] = [];
  if (deps.signalsSource) {
    try {
      signals = (await deps.signalsSource.collect()).slice(0, 10);
    } catch (err) {
      console.error('[briefing] signals collection failed:', err instanceof Error ? err.message : err);
      signals = [];
    }
  }
  let notifications: BriefingItem[] = [];
  if (deps.notificationDigest) {
    try {
      notifications = deps.notificationDigest(since, now).slice(0, 20);
    } catch (err) {
      console.error('[briefing] notification digest failed:', err instanceof Error ? err.message : err);
      notifications = [];
    }
  }

  const ctx: BriefingSummaryContext = {
    overnightCount: overnight.length,
    botCount,
    approvalCount: approvals.length,
    approvalTitles: approvals.map((a) => a.title),
    eventCount: calendar.length,
    regressionCount: regressions.length,
    noteCount: notes.length,
    workflowCount: workflows.length,
    signalCount: signals.length,
    notificationCount: notifications.length,
  };

  const summarize = deps.summarize ?? summarizeWithOllama;
  let summary: string | undefined;
  try {
    summary = (await summarize(ctx)) ?? undefined;
  } catch {
    summary = undefined;
  }
  if (!summary) summary = templateSummary(ctx);

  return {
    generatedAt: now,
    overnight,
    calendar,
    approvals,
    notes,
    workflows,
    signals,
    notifications,
    summary,
    regressions,
  };
}

// ---- Scheduler ------------------------------------------------------------------
// A briefing is a background data-assembly job — it needs no bot or chat
// session — so it does not ride ThreadScheduler (which wakes chat threads
// with an agent turn). It follows the ThreadScheduler pattern instead:
// a minute-interval tick with a per-day dedup key persisted in SQLite.

export interface BriefingSchedulerDeps {
  dataDir: string;
  governance: GovernanceGateway;
  runHealth: RunHealthStore;
  calendarStore?: CalendarEventStore;
  /**
   * Summary override (tests). When omitted, generation uses the Ollama
   * attempt with the deterministic template fallback.
   */
  summarize?: SummarizeFn;
  /**
   * Workflow source for the digest (feature interconnection). The real
   * WorkflowRunner satisfies this structurally; unset → no workflow
   * section in scheduled briefings.
   */
  workflowSource?: GenerateBriefingDeps['workflowSource'];
  /** W14c/W14b sources, forwarded to generateBriefing. */
  signalsSource?: GenerateBriefingDeps['signalsSource'];
  notificationDigest?: GenerateBriefingDeps['notificationDigest'];
  /** Global pause gate (W14d): while paused, scheduled briefings skip. */
  isPaused?: () => boolean;
}

export class BriefingScheduler {
  private readonly store: BriefingStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: BriefingSchedulerDeps) {
    this.store = new BriefingStore(deps.dataDir);
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Fire once shortly after boot so a schedule due during downtime fires.
    setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Generate + persist the briefing when the configured time hits. Never throws. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    if (this.deps.isPaused?.()) return; // W14d global pause: skip the tick
    this.running = true;
    try {
      const cfg = this.store.getConfig();
      if (!cfg.briefingEnabled) return;
      const [hh, mm] = cfg.briefingTime.split(':').map(Number);
      if (now.getHours() !== hh || now.getMinutes() !== mm) return;
      const key = dayKey(now);
      if (this.store.getSetting('last_fired_day') === key) return;
      const briefing = await generateBriefing({
        store: this.store,
        governance: this.deps.governance,
        runHealth: this.deps.runHealth,
        dataDir: this.deps.dataDir,
        calendarStore: this.deps.calendarStore,
        summarize: this.deps.summarize,
        workflowSource: this.deps.workflowSource,
        signalsSource: this.deps.signalsSource,
        notificationDigest: this.deps.notificationDigest,
      });
      this.store.saveBriefing('scheduled', briefing);
      this.store.setSetting('last_fired_day', key);
      console.log(`[briefing] scheduled briefing generated (${briefing.overnight.length} overnight, ${briefing.approvals.length} approvals)`);
    } catch (err) {
      console.error('[briefing] scheduled generation failed:', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}
