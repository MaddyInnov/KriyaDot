// SPDX-License-Identifier: Apache-2.0
// Activity / live-work panel API (Muse parity audit §2 + §4.1, ACT-1..ACT-10).
//
// A plain-language projection over work KriyaDot already records — this
// module creates no new store. It reads:
//   - observability runs (SpanStore: listRuns / getRun / listSpans / runTotals)
//   - routine runs (host-supplied lister over RoutineRunStore)
//   - background jobs (host-supplied lister over BackgroundRunRegistry)
//   - the session's first user message (host-supplied lookup over
//     SessionStore) for titles in the user's own words
//
// Routes (router mounted at /api by the coordinator):
//   GET /work-panel/live            → one status sentence + running items
//   GET /work-panel/items?limit=    → day-grouped work list (Today / Yesterday / …)
//   GET /work-panel/runs/:runId     → plain-language summary header for one run
//   GET /work-panel/permissions     → ACT-9 permissions & identity summary
//                                     (counts only — secret values never leave
//                                     the vault; the principal is the verified
//                                     one from principal.ts)
//
// Status language here is original, plain, and friendly on purpose: this is
// the consumer surface, not the engineer trace view (which stays in Runs).

import express from 'express';
import type { Request, Response } from 'express';
import type { BotConfig, RunOutcome, RunTotals, Span, SpanStore } from '@mvp/agent-runtime';
import { MockWalletProvider, SecureVault } from '@mvp/vault';
import { getOAuthStatus } from './oauth.js';
import { loadBotPolicies } from './bot-policies.js';
import { getBotApprovalMode } from './bot-approval-modes.js';
import { resolvePrincipal, DEFAULT_USER_ID, type PrincipalContext } from './principal.js';
import type { RoutineRun } from './routine-runs.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type WorkItemStatus =
  | 'running'
  | 'writing'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'needs-input'
  | 'cancelled';

export type WorkItemSource = 'observability' | 'routine' | 'background';

export interface WorkAttempt {
  [key: string]: unknown;
}

export interface WorkItem {
  /** Run id in its source store (observability runId, routine run id, background id). */
  runId: string;
  source: WorkItemSource;
  /** Plain-language title in the user's own words (first request / routine name). */
  title: string;
  /** One-line plain-language outcome / current activity. */
  outcome: string;
  status: WorkItemStatus;
  /** Epoch ms the work started (or was created). */
  timestamp: number;
  endedAt: number | null;
  botId: string;
  botName: string;
  sessionId?: string;
  /** Attempt trail when the source record carries one; [] otherwise. */
  attempts: WorkAttempt[];
}

export interface WorkDayGroup {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** "Today" | "Yesterday" | e.g. "Fri, 24 Oct". */
  label: string;
  items: WorkItem[];
}

export interface LiveStatus {
  sentence: string;
  idle: boolean;
  runningCount: number;
  running: WorkItem[];
  generatedAt: number;
}

export interface WorkRunSummary {
  runId: string;
  source: WorkItemSource;
  title: string;
  /** What was asked, in the user's own words (same source as the title). */
  asked: string;
  /** What happened, in one or two plain sentences. */
  happened: string;
  outcome: string;
  status: WorkItemStatus;
  botId: string;
  botName: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  /** Total recorded cost in USD cents, when the source records it. */
  costCents: number | null;
  attempts: WorkAttempt[];
}

export interface BotPermissionSummary {
  botId: string;
  botName: string;
  approvalMode: string;
  policyRuleCount: number;
  allowCount: number;
  denyCount: number;
  requireApprovalCount: number;
  /** Persistent "always allow" rules the user granted this bot. */
  lastingAllowCount: number;
  toolCount: number;
}

export interface PermissionsSummary {
  principal: { kind: string; userId: string; assertedProfile: boolean; orgId?: string };
  bots: BotPermissionSummary[];
  vault: {
    secrets: number;
    logins: number;
    walletMethods: number;
    accountsConnected: number;
    accountsTotal: number;
  };
  lastingAllowTotal: number;
  pendingApprovals: number | null;
}

// Minimal structural views of the source records (the real stores satisfy
// these; tests pass plain objects).
export interface ObsRunLike {
  runId: string;
  sessionId: string;
  botId: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  attempts?: unknown;
}

export interface RoutineRunLike {
  id: string;
  routineId: string;
  routineName: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  outputExcerpt?: string | null;
  error?: string | null;
  costUsd?: number | null;
  attempts?: unknown;
}

export interface BackgroundRunLike {
  id: string;
  botId: string;
  botName: string;
  task: string;
  status: string;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface WorkPanelDeps {
  /** Observability span store (runs + spans + totals). Optional: absent → no observability items. */
  spanStore?: Pick<SpanStore, 'listRuns' | 'getRun' | 'listSpans' | 'runTotals'> | null;
  /** All routine runs, newest first (host flattens RoutineRunStore.listByRoutine). */
  listRoutineRuns?: (limit: number) => RoutineRunLike[];
  /** All background-job runs (host reads BackgroundRunRegistry.list()). */
  listBackgroundRuns?: () => BackgroundRunLike[];
  /** First user-authored message of a session — the title source. */
  getFirstUserMessage?: (sessionId: string) => string | undefined;
  /** Bot roster (names + policy/approval display). Array or getter. */
  bots: BotConfig[] | (() => BotConfig[]);
  dataDir: string;
  loopbackToken?: string;
  jwtSecret?: string;
  /** Pending approval count for the permissions summary (governance). */
  countPendingApprovals?: () => number;
  /** Vault/accounts counts override (tests); default reads the real stores. */
  getVaultCounts?: (userId: string) => PermissionsSummary['vault'];
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure projection helpers (unit-tested without HTTP)
// ---------------------------------------------------------------------------

const TITLE_MAX = 90;
const OUTCOME_MAX = 140;

export function cleanTitle(raw: string | undefined | null, fallback: string): string {
  const oneLine = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return fallback;
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1).trimEnd()}…` : oneLine;
}

function cleanLine(raw: string | undefined | null, fallback: string): string {
  const oneLine = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return fallback;
  return oneLine.length > OUTCOME_MAX ? `${oneLine.slice(0, OUTCOME_MAX - 1).trimEnd()}…` : oneLine;
}

/** Normalize a source record's attempt trail into the attempts array field. */
export function normalizeAttempts(raw: unknown): WorkAttempt[] {
  if (Array.isArray(raw)) {
    return raw.map((a) =>
      a !== null && typeof a === 'object' ? (a as WorkAttempt) : { detail: String(a) },
    );
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Array.from({ length: Math.min(50, Math.floor(raw)) }, (_, i) => ({ attempt: i + 1 }));
  }
  return [];
}

/** Extract the originating user message from a run's spans (turn span payload). */
export function titleFromSpans(spans: Span[] | undefined): string | undefined {
  if (!spans) return undefined;
  for (const span of spans) {
    if (span.kind !== 'turn') continue;
    const payload = span.payload as { input?: { message?: unknown } } | undefined;
    const message = payload?.input?.message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return undefined;
}

export function mapObsStatus(run: ObsRunLike, spans?: Span[]): WorkItemStatus {
  if (run.outcome === 'success') return 'completed';
  if (run.outcome === 'failed') return 'failed';
  if (run.outcome === 'cancelled') return 'cancelled';
  if (run.outcome === 'needs-input') return 'needs-input';
  // Still running: a turn whose latest activity is a model/tool span reads
  // as "writing"; anything else is plainly running.
  if (spans && spans.length > 0) {
    const open = spans.filter((s) => s.status === 'running');
    const latest = open[open.length - 1] ?? spans[spans.length - 1];
    if (latest && (latest.kind === 'llm' || latest.kind === 'tool')) return 'writing';
  }
  return 'running';
}

export function mapRoutineStatus(status: string): WorkItemStatus {
  switch (status) {
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'missed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    default:
      return 'queued';
  }
}

export function mapBackgroundStatus(status: string): WorkItemStatus {
  switch (status) {
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'cancelled';
    case 'running':
      return 'running';
    default:
      return 'queued';
  }
}

function obsOutcomeLine(run: ObsRunLike, status: WorkItemStatus, totals?: RunTotals): string {
  switch (status) {
    case 'completed':
      return 'Finished — all done.';
    case 'failed':
      return 'Did not finish — open the run to see what went wrong.';
    case 'cancelled':
      return 'Stopped before it finished.';
    case 'needs-input':
      return 'Paused — it needs something from you to continue.';
    case 'writing':
      return 'Writing a reply right now.';
    case 'queued':
      return 'Waiting to start.';
    default:
      return totals && totals.errorCount > 0
        ? `Working on it — ${totals.errorCount} hiccup${totals.errorCount === 1 ? '' : 's'} so far.`
        : 'Working on it right now.';
  }
}

function routineOutcomeLine(run: RoutineRunLike, status: WorkItemStatus): string {
  if (status === 'completed') {
    return cleanLine(run.outputExcerpt, 'Finished — all done.');
  }
  if (status === 'failed') {
    if (run.status === 'missed') return 'This scheduled run was skipped.';
    return cleanLine(run.error, 'Did not finish — open the run to see what went wrong.');
  }
  if (status === 'cancelled') return 'Stopped before it finished.';
  if (status === 'running') return 'Working on it right now.';
  return 'Waiting to start.';
}

function backgroundOutcomeLine(run: BackgroundRunLike, status: WorkItemStatus): string {
  if (status === 'completed') return cleanLine(run.result, 'Finished — all done.');
  if (status === 'failed') return cleanLine(run.error, 'Did not finish.');
  if (status === 'cancelled') return 'Stopped before it finished.';
  if (status === 'running') return 'Working on it in the background.';
  return 'Waiting to start.';
}

export interface ProjectionSources {
  obsRuns: ObsRunLike[];
  routineRuns: RoutineRunLike[];
  backgroundRuns: BackgroundRunLike[];
  botName: (botId: string) => string;
  firstUserMessage?: (sessionId: string) => string | undefined;
  spansFor?: (runId: string) => Span[] | undefined;
  totalsFor?: (runId: string) => RunTotals | undefined;
}

/** Project every source record into consumer work items, newest first. */
export function projectWorkItems(src: ProjectionSources): WorkItem[] {
  const items: WorkItem[] = [];

  for (const run of src.obsRuns) {
    const spans = src.spansFor?.(run.runId);
    const status = mapObsStatus(run, spans);
    const fromSession = src.firstUserMessage?.(run.sessionId);
    const title = cleanTitle(fromSession ?? titleFromSpans(spans), `A task with ${src.botName(run.botId)}`);
    items.push({
      runId: run.runId,
      source: 'observability',
      title,
      outcome: obsOutcomeLine(run, status, src.totalsFor?.(run.runId)),
      status,
      timestamp: run.startedAt,
      endedAt: run.endedAt,
      botId: run.botId,
      botName: src.botName(run.botId),
      sessionId: run.sessionId,
      attempts: normalizeAttempts((run as { attempts?: unknown }).attempts),
    });
  }

  for (const run of src.routineRuns) {
    const status = mapRoutineStatus(run.status);
    items.push({
      runId: run.id,
      source: 'routine',
      title: cleanTitle(run.routineName, 'Scheduled task'),
      outcome: routineOutcomeLine(run as RoutineRun, status),
      status,
      timestamp: run.startedAt ?? run.createdAt,
      endedAt: run.endedAt,
      botId: '',
      botName: run.routineName,
      attempts: normalizeAttempts(run.attempts),
    });
  }

  for (const run of src.backgroundRuns) {
    const status = mapBackgroundStatus(run.status);
    items.push({
      runId: run.id,
      source: 'background',
      title: cleanTitle(run.task, `Background work by ${run.botName}`),
      outcome: backgroundOutcomeLine(run, status),
      status,
      timestamp: run.startedAt,
      endedAt: run.finishedAt ?? null,
      botId: run.botId,
      botName: run.botName,
      attempts: normalizeAttempts((run as { attempts?: unknown }).attempts),
    });
  }

  items.sort((a, b) => b.timestamp - a.timestamp || b.runId.localeCompare(a.runId));
  return items;
}

// -- day grouping -----------------------------------------------------------

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayLabel(dateKey: string, now: number): string {
  if (dateKey === localDateKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === localDateKey(yesterday.getTime())) return 'Yesterday';
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: y !== new Date(now).getFullYear() ? 'numeric' : undefined,
  });
}

/** Group items by local calendar day, newest day first, newest item first. */
export function groupWorkByDay(items: WorkItem[], now: number): WorkDayGroup[] {
  const byDay = new Map<string, WorkItem[]>();
  for (const item of items) {
    const key = localDateKey(item.timestamp);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(item);
    else byDay.set(key, [item]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, groupItems]) => ({
      date,
      label: dayLabel(date, now),
      items: [...groupItems].sort((a, b) => b.timestamp - a.timestamp || b.runId.localeCompare(a.runId)),
    }));
}

// -- live status sentence -----------------------------------------------------

function shortTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
}

function verbFor(item: WorkItem): string {
  if (item.status === 'writing') return 'writing';
  const t = item.title.toLowerCase();
  if (/\b(research|search|find|look up|investigat)/.test(t)) return 'researching';
  if (/\b(write|draft|compose)/.test(t)) return 'writing';
  if (/\b(summar|report|brief)/.test(t)) return 'summarizing';
  if (/\b(check|review|audit|verif)/.test(t)) return 'checking';
  return 'working on';
}

/** One plain-language sentence describing what is running right now. */
export function buildStatusSentence(running: WorkItem[]): string {
  if (running.length === 0) return 'Nothing running right now';
  if (running.length === 1) {
    const item = running[0]!;
    return `Working on 1 task — ${verbFor(item)} ${shortTitle(item.title)}`;
  }
  const parts = running.slice(0, 3).map((item) => `${verbFor(item)} ${shortTitle(item.title)}`);
  const extra = running.length > 3 ? ` · and ${running.length - 3} more` : '';
  return `Running ${running.length} tasks — ${parts.join(' · ')}${extra}`;
}

export function isActiveStatus(status: WorkItemStatus): boolean {
  return status === 'running' || status === 'writing' || status === 'queued';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function registerWorkPanelRoutes(router: express.Router, deps: WorkPanelDeps): void {
  const now = deps.now ?? Date.now;
  const botsOf = (): BotConfig[] => (typeof deps.bots === 'function' ? deps.bots() : deps.bots);
  const botName = (botId: string): string => botsOf().find((b) => b.id === botId)?.name ?? botId;

  const collect = (limit: number): WorkItem[] =>
    projectWorkItems({
      obsRuns: deps.spanStore ? (deps.spanStore.listRuns({ limit }) as ObsRunLike[]) : [],
      routineRuns: deps.listRoutineRuns ? deps.listRoutineRuns(limit) : [],
      backgroundRuns: deps.listBackgroundRuns ? deps.listBackgroundRuns() : [],
      botName,
      firstUserMessage: deps.getFirstUserMessage,
      spansFor: (runId) => {
        // Spans are only needed to tell "writing" from "running" and as a
        // title fallback — a read failure must never break the panel.
        try {
          return deps.spanStore?.listSpans(runId);
        } catch {
          return undefined;
        }
      },
      totalsFor: (runId) => {
        try {
          return deps.spanStore?.runTotals(runId);
        } catch {
          return undefined;
        }
      },
    });

  router.get('/work-panel/live', (_req: Request, res: Response) => {
    try {
      const items = collect(200);
      const running = items.filter((i) => isActiveStatus(i.status));
      const live: LiveStatus = {
        sentence: buildStatusSentence(running),
        idle: running.length === 0,
        runningCount: running.length,
        running,
        generatedAt: now(),
      };
      res.json(live);
    } catch (err) {
      res.status(500).json(errorBody('Failed to load live status', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/work-panel/items', (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.limit);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(500, Math.floor(raw)) : 200;
      const items = collect(limit);
      res.json({ groups: groupWorkByDay(items, now()), items });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load work items', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/work-panel/runs/:runId', (req: Request, res: Response) => {
    try {
      const { runId } = req.params;

      // Observability run?
      const obsRun = deps.spanStore?.getRun(runId) as ObsRunLike | undefined;
      if (obsRun) {
        let spans: Span[] | undefined;
        let totals: RunTotals | undefined;
        try {
          spans = deps.spanStore?.listSpans(runId);
        } catch {
          spans = undefined;
        }
        try {
          totals = deps.spanStore?.runTotals(runId);
        } catch {
          totals = undefined;
        }
        const status = mapObsStatus(obsRun, spans);
        const asked = cleanTitle(
          deps.getFirstUserMessage?.(obsRun.sessionId) ?? titleFromSpans(spans),
          `A task with ${botName(obsRun.botId)}`,
        );
        const durationMs =
          totals?.durationMs ?? (obsRun.endedAt !== null ? Math.max(0, obsRun.endedAt - obsRun.startedAt) : null);
        const summary: WorkRunSummary = {
          runId,
          source: 'observability',
          title: asked,
          asked,
          happened: obsOutcomeLine(obsRun, status, totals),
          outcome: obsOutcomeLine(obsRun, status, totals),
          status,
          botId: obsRun.botId,
          botName: botName(obsRun.botId),
          startedAt: obsRun.startedAt,
          endedAt: obsRun.endedAt,
          durationMs,
          costCents: totals ? totals.totalCostCents : null,
          attempts: normalizeAttempts((obsRun as { attempts?: unknown }).attempts),
        };
        res.json({ summary });
        return;
      }

      // Routine run?
      const routineRun = deps.listRoutineRuns ? deps.listRoutineRuns(500).find((r) => r.id === runId) : undefined;
      if (routineRun) {
        const status = mapRoutineStatus(routineRun.status);
        const startedAt = routineRun.startedAt ?? routineRun.createdAt;
        const summary: WorkRunSummary = {
          runId,
          source: 'routine',
          title: cleanTitle(routineRun.routineName, 'Scheduled task'),
          asked: cleanTitle(routineRun.routineName, 'Scheduled task'),
          happened: routineOutcomeLine(routineRun as RoutineRun, status),
          outcome: routineOutcomeLine(routineRun as RoutineRun, status),
          status,
          botId: '',
          botName: routineRun.routineName,
          startedAt,
          endedAt: routineRun.endedAt,
          durationMs:
            routineRun.endedAt !== null && routineRun.startedAt !== null
              ? Math.max(0, routineRun.endedAt - routineRun.startedAt)
              : null,
          costCents: typeof routineRun.costUsd === 'number' ? Math.round(routineRun.costUsd * 100) : null,
          attempts: normalizeAttempts(routineRun.attempts),
        };
        res.json({ summary });
        return;
      }

      // Background job?
      const bgRun = deps.listBackgroundRuns ? deps.listBackgroundRuns().find((r) => r.id === runId) : undefined;
      if (bgRun) {
        const status = mapBackgroundStatus(bgRun.status);
        const summary: WorkRunSummary = {
          runId,
          source: 'background',
          title: cleanTitle(bgRun.task, `Background work by ${bgRun.botName}`),
          asked: cleanTitle(bgRun.task, `Background work by ${bgRun.botName}`),
          happened: backgroundOutcomeLine(bgRun, status),
          outcome: backgroundOutcomeLine(bgRun, status),
          status,
          botId: bgRun.botId,
          botName: bgRun.botName,
          startedAt: bgRun.startedAt,
          endedAt: bgRun.finishedAt ?? null,
          durationMs: bgRun.finishedAt ? Math.max(0, bgRun.finishedAt - bgRun.startedAt) : null,
          costCents: null,
          attempts: normalizeAttempts((bgRun as { attempts?: unknown }).attempts),
        };
        res.json({ summary });
        return;
      }

      res.status(404).json(errorBody(`Unknown run "${runId}"`));
    } catch (err) {
      res.status(500).json(errorBody('Failed to load run summary', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/work-panel/permissions', (req: Request, res: Response) => {
    try {
      // Verified principal only (principal.ts). When the host wired no
      // credential context at all (standalone/test mounting), the panel is
      // behind loopback auth at the app level and acts as the default user —
      // the same posture as the observability routes.
      const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
      const principal = resolvePrincipal(req, pctx);
      const hasCredentialContext = deps.loopbackToken !== undefined || process.env.KRIYADOT_TENANCY_JWT_SECRET !== undefined;
      if (!principal && hasCredentialContext) {
        res.status(401).json({ ok: false, error: 'unauthenticated: a verified credential is required' });
        return;
      }
      const userId = principal?.userId ?? DEFAULT_USER_ID;

      const overlay = loadBotPolicies(deps.dataDir);
      const bots: BotPermissionSummary[] = botsOf().map((bot) => {
        const rules = overlay[bot.id]?.rules ?? bot.policy?.rules ?? [];
        return {
          botId: bot.id,
          botName: bot.name,
          approvalMode: getBotApprovalMode(deps.dataDir, bot.id) ?? bot.approvalMode ?? 'auto',
          policyRuleCount: rules.length,
          allowCount: rules.filter((r) => r.effect === 'allow').length,
          denyCount: rules.filter((r) => r.effect === 'deny').length,
          requireApprovalCount: rules.filter((r) => r.effect === 'require-approval').length,
          lastingAllowCount: rules.filter((r) => r.effect === 'allow' && r.id.startsWith('user-allow-')).length,
          toolCount: bot.tools?.length ?? 0,
        };
      });

      let vault: PermissionsSummary['vault'];
      if (deps.getVaultCounts) {
        vault = deps.getVaultCounts(userId);
      } else {
        try {
          const store = new SecureVault(deps.dataDir, userId, userId);
          const metas = store.list();
          const wallet = new MockWalletProvider(deps.dataDir, userId);
          const oauth = getOAuthStatus(deps.dataDir);
          vault = {
            secrets: metas.filter((m) => m.kind !== 'login').length,
            logins: store.listLogins().length,
            walletMethods: wallet.listPaymentMethods().length,
            accountsConnected: oauth.filter((o) => o.connected).length,
            accountsTotal: oauth.length,
          };
        } catch {
          vault = { secrets: 0, logins: 0, walletMethods: 0, accountsConnected: 0, accountsTotal: 0 };
        }
      }

      const summary: PermissionsSummary = {
        principal: {
          kind: principal?.kind ?? 'owner',
          userId,
          assertedProfile: principal?.assertedProfile ?? false,
          ...(principal?.orgId ? { orgId: principal.orgId } : {}),
        },
        bots,
        vault,
        lastingAllowTotal: bots.reduce((acc, b) => acc + b.lastingAllowCount, 0),
        pendingApprovals: deps.countPendingApprovals ? deps.countPendingApprovals() : null,
      };
      res.json({ summary });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load permissions summary', err instanceof Error ? err.message : String(err)));
    }
  });
}
