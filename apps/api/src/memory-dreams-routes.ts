// SPDX-License-Identifier: Apache-2.0
/**
 * Dreams routes (A11, Timon parity programme): settings, the leads
 * inbox, the manual "Run now" trigger, the user decision endpoint, and
 * the nightly scheduler for the self-improvement proposal pass (the
 * deterministic core lives in @mvp/agent-runtime dreams.ts).
 *
 *   GET  /dreams?botId                     → settings + pending leads + last run
 *   GET  /dreams/leads?botId[&status]       → the leads inbox
 *   PUT  /dreams/settings                  { botId, enabled?, hour?, minute?, summarise? }
 *   POST /dreams/run                       { botId }  → run one pass now (testing)
 *   POST /dreams/leads/:id/decide          { botId, action: 'accept'|'dismiss'|'snooze', snoozeDays? }
 *
 * Why these gates (reasoning / threat model): Dreams is PROPOSE-ONLY.
 * The pass itself never applies anything; the only state-changing user
 * actions here are (a) flipping the user's OWN settings, (b) triggering
 * a pass that writes inbox leads, and (c) deciding a lead. All three
 * require a VERIFIED principal (principal.ts, OPEN-1) exactly like
 * A10's decide endpoint — `x-user-id` alone returns 401 — because
 * "accept" can create an A10 rule proposal or a routine draft, and a
 * bot must never be able to do that to itself. When the router is
 * mounted without a principal context (standalone/tests), the upstream
 * loopback boundary is trusted (the sibling memory routers' posture)
 * and decisions record 'local-user'.
 *
 * Accept mapping (the ONLY things Accept can create):
 * - rule-type lead    → an A10 rule proposal via
 *   TieredMemoryStore.createRuleProposal — PENDING, not approved;
 *   promotion still requires the user's A10 decision.
 * - routine-type lead → a routine draft via the host's
 *   createRoutineDraft callback, which creates it DISABLED.
 * - lead with no safe artefact mapping → acknowledged/archived only.
 * If the host did not wire createRoutineDraft, accepting a routine
 * lead fails with 501 and the lead stays pending — no invented path.
 *
 * Opt-in: settings default to enabled=false; the scheduler checks the
 * flag before doing any work, so a never-enabled bot costs zero
 * background work beyond a settings-file read on the tick.
 *
 * HOST WIRING (routes.ts mounts this at /memory; index.ts starts the
 * scheduler next to startMemoryUpkeep):
 *   router.use('/memory', createMemoryDreamsRouter({
 *     dataDir: config.dataDir, tieredMemoryStore,
 *     getBots: () => bots.map((b) => ({ id: b.id })),
 *     getBotById: (id) => bots.find((b) => b.id === id),
 *     principalContext: { dataDir: config.dataDir },
 *     listAudit: (limit) => governance.listAudit(limit),
 *     createRoutineDraft: (draft) => ({ id: <disabled routine id> }),
 *     audit: (action, fields) => governance.audit(action, fields),
 *   }));
 */

import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import {
  DreamLeadStore,
  createModelDreamSummarizer,
  runDreamPass,
  type BotConfig,
  type DreamAuditEvent,
  type DreamSummarizer,
  type TieredMemoryStore,
} from '@mvp/agent-runtime';
import { buildBotChatFn } from './memory-fabric.js';
import { requirePrincipal, type PrincipalContext } from './principal.js';

// ---------------------------------------------------------------------------
// Settings (per bot, <dataDir>/dreams-settings.json — ingestion idiom)
// ---------------------------------------------------------------------------

export interface DreamSettings {
  /** OFF by default (standing posture): the pass never runs until enabled. */
  enabled: boolean;
  /** Local hour of day for the nightly run (0–23). */
  hour: number;
  /** Local minute of the hour for the nightly run (0–59). */
  minute: number;
  /**
   * Optional model summary of new leads, via the bot's already-configured
   * model lane. OFF by default; when on, lead titles + evidence counts
   * are sent to that configured provider — nothing else leaves the machine.
   */
  summarise: boolean;
  updatedAt: string;
}

export const DEFAULT_DREAM_SETTINGS: Omit<DreamSettings, 'updatedAt'> = {
  enabled: false,
  hour: 3,
  minute: 15,
  summarise: false,
};

const SETTINGS_FILE = 'dreams-settings.json';
type SettingsFile = Record<string, DreamSettings>;

function readSettingsFile(dataDir: string): SettingsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SettingsFile;
  } catch {
    return {};
  }
}

function writeSettingsFile(dataDir: string, file: SettingsFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, SETTINGS_FILE);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

export function sanitizeDreamSettings(input: unknown, base?: DreamSettings, now = new Date()): DreamSettings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as {
    enabled?: unknown;
    hour?: unknown;
    minute?: unknown;
    summarise?: unknown;
  };
  const clampInt = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), min), max) : fallback;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : (base?.enabled ?? DEFAULT_DREAM_SETTINGS.enabled),
    hour: clampInt(o.hour, base?.hour ?? DEFAULT_DREAM_SETTINGS.hour, 0, 23),
    minute: clampInt(o.minute, base?.minute ?? DEFAULT_DREAM_SETTINGS.minute, 0, 59),
    summarise: typeof o.summarise === 'boolean' ? o.summarise : (base?.summarise ?? DEFAULT_DREAM_SETTINGS.summarise),
    updatedAt: now.toISOString(),
  };
}

export function getDreamSettings(dataDir: string, botId: string): DreamSettings {
  return readSettingsFile(dataDir)[botId] ?? { ...DEFAULT_DREAM_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function saveDreamSettings(dataDir: string, botId: string, input: unknown, now = new Date()): DreamSettings {
  const file = readSettingsFile(dataDir);
  const settings = sanitizeDreamSettings(input, file[botId], now);
  file[botId] = settings;
  writeSettingsFile(dataDir, file);
  return settings;
}

// ---------------------------------------------------------------------------
// Audit normalization: governance entries → DreamAuditEvent
// ---------------------------------------------------------------------------

/** The minimal audit-entry shape this module consumes (governance listAudit). */
export interface DreamAuditSourceEntry {
  ts: number;
  actor: string;
  action: string;
  toolName?: string;
  decision?: string;
  /** Governance stores detail as a JSON string; objects are accepted too. */
  detail?: string | unknown;
}

export function normalizeDreamAuditEntry(entry: DreamAuditSourceEntry): DreamAuditEvent {
  let detail: unknown = entry.detail;
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail) as unknown;
    } catch {
      detail = undefined;
    }
  }
  const detailBotId =
    typeof detail === 'object' && detail !== null && typeof (detail as { botId?: unknown }).botId === 'string'
      ? ((detail as { botId: string }).botId as string)
      : undefined;
  return {
    ts: entry.ts,
    botId: detailBotId ?? entry.actor,
    action: entry.action,
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    ...(entry.decision ? { decision: entry.decision } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** Build the pass's audit reader over a host listAudit(limit) source. */
export function dreamAuditEventsFrom(
  listAudit: (limit: number) => DreamAuditSourceEntry[],
  scanLimit = 5000,
): (botId: string, since: number, until: number) => DreamAuditEvent[] {
  return (botId, since, until) =>
    listAudit(scanLimit)
      .map(normalizeDreamAuditEntry)
      .filter((e) => e.botId === botId && e.ts >= since && e.ts <= until);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface MemoryDreamsRouterDeps {
  dataDir: string;
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
  /** Full bot lookup so summarisation can use the bot's own model lane. Optional. */
  getBotById?: (botId: string) => BotConfig | undefined;
  /** Shared leads store (host/scheduler share one instance). Defaults to a store on dataDir. */
  leadStore?: DreamLeadStore;
  /** OPEN-1 principal context. When provided, settings/run/decide REQUIRE a verified principal. */
  principalContext?: PrincipalContext;
  /** Audit/Activity source (host wires governance.listAudit). Without it, passes see no audit events. */
  listAudit?: (limit: number) => DreamAuditSourceEntry[];
  /** Host mapping for routine-type accepts: MUST create the routine DISABLED. */
  createRoutineDraft?: (draft: { botId: string; name: string; promptTemplate: string }) => { id: string };
  /** Injectable summarizer factory (tests mock the model lane; zero paid API use). */
  summarizerForBot?: (bot: BotConfig | undefined, botId: string) => DreamSummarizer | undefined;
  /** Audit sink (host wires governance.audit). Optional. */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Clock override for tests. */
  now?: () => number;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function createMemoryDreamsRouter(deps: MemoryDreamsRouterDeps): Router {
  const router = express.Router();
  const store = deps.tieredMemoryStore;
  const leadStore = deps.leadStore ?? new DreamLeadStore(deps.dataDir);
  const now = deps.now ?? (() => Date.now());

  const requireBotId = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('"botId" is required');
    const id = raw.trim();
    if (!deps.getBots().some((b) => b.id === id)) throw new Error(`Unknown bot "${id}"`);
    return id;
  };

  /** The deciding user for this request, or null after sending 401. (A10 posture.) */
  const decidingUser = (req: express.Request, res: express.Response): string | null => {
    if (!deps.principalContext) return 'local-user';
    const principal = requirePrincipal(req, res, deps.principalContext);
    return principal ? principal.userId : null;
  };

  const summarizerFor = (botId: string, settings: DreamSettings): DreamSummarizer | undefined => {
    if (!settings.summarise) return undefined; // model lane is opt-in on top of opt-in
    if (deps.summarizerForBot) return deps.summarizerForBot(deps.getBotById?.(botId), botId);
    const bot = deps.getBotById?.(botId);
    if (!bot) return undefined;
    const chat = buildBotChatFn(bot);
    return chat ? createModelDreamSummarizer(chat) : undefined;
  };

  const runPass = async (botId: string) => {
    const settings = getDreamSettings(deps.dataDir, botId);
    return runDreamPass(
      {
        memory: store,
        leads: leadStore,
        auditEvents: deps.listAudit ? dreamAuditEventsFrom(deps.listAudit) : () => [],
        ...(summarizerFor(botId, settings) ? { summarizer: summarizerFor(botId, settings) } : {}),
        now,
      },
      botId,
    );
  };

  // Read-only overview: settings + pending leads + last run. Any caller
  // the host lets reach the memory routes may view (A10 list posture).
  router.get('/dreams', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(typeof req.query.botId === 'string' ? req.query.botId : '');
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      res.json({
        ok: true,
        botId,
        settings: getDreamSettings(deps.dataDir, botId),
        lastRunAt: leadStore.lastRunAt(botId) ?? null,
        leads: leadStore.list(botId, 'pending'),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to read dreams state', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/dreams/leads', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(typeof req.query.botId === 'string' ? req.query.botId : '');
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    const raw = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status = raw === 'accepted' || raw === 'dismissed' || raw === 'snoozed' || raw === 'all' ? raw : 'pending';
    try {
      res.json({ ok: true, botId, status, leads: leadStore.list(botId, status) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list dream leads', err instanceof Error ? err.message : String(err)));
    }
  });

  // The USER's settings (enable/schedule/summarise). Dreams itself never
  // writes settings — this endpoint is the user's hand, principal-gated.
  router.put('/dreams/settings', (req, res) => {
    const user = decidingUser(req, res);
    if (!user) return; // 401 already sent
    let botId: string;
    try {
      botId = requireBotId((req.body as { botId?: unknown })?.botId);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const settings = saveDreamSettings(deps.dataDir, botId, req.body ?? {});
      deps.audit?.('memory.dreams_settings', { actor: user, detail: { botId, enabled: settings.enabled, hour: settings.hour, minute: settings.minute, summarise: settings.summarise } });
      res.json({ ok: true, botId, settings });
    } catch (err) {
      res.status(500).json(errorBody('Failed to save dream settings', err instanceof Error ? err.message : String(err)));
    }
  });

  // Manual "Run now" — works even while the schedule is disabled (that
  // is what it is for: testing). Still writes leads only, never changes.
  router.post('/dreams/run', async (req, res) => {
    const user = decidingUser(req, res);
    if (!user) return; // 401 already sent
    let botId: string;
    try {
      botId = requireBotId((req.body as { botId?: unknown })?.botId);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const result = await runPass(botId);
      deps.audit?.('memory.dreams_run', {
        actor: user,
        detail: { botId, created: result.created.length, suppressed: result.suppressed, lane: result.lane, manual: true },
      });
      res.json({ ...result });
    } catch (err) {
      res.status(500).json(errorBody('Dreams pass failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // THE decision endpoint: accept (safe artefact mapping only) /
  // dismiss (remembered; cooling-period suppression) / snooze.
  router.post('/dreams/leads/:id/decide', (req, res) => {
    const user = decidingUser(req, res);
    if (!user) return; // 401 already sent
    const body = (req.body ?? {}) as { botId?: unknown; action?: unknown; snoozeDays?: unknown };
    let botId: string;
    try {
      botId = requireBotId(body.botId);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    if (body.action !== 'accept' && body.action !== 'dismiss' && body.action !== 'snooze') {
      res.status(400).json(errorBody('Body must be { botId, action: "accept" | "dismiss" | "snooze", snoozeDays?: number }'));
      return;
    }
    const lead = leadStore.get(botId, req.params.id);
    if (!lead) {
      res.status(404).json(errorBody('Failed to decide dream lead', `Unknown dream lead "${req.params.id}"`));
      return;
    }
    if (lead.status !== 'pending') {
      res.status(400).json(errorBody('Failed to decide dream lead', `Dream lead "${lead.id}" is already ${lead.status}`));
      return;
    }
    try {
      let acceptedArtefact: { type: 'rule-proposal' | 'routine-draft' | 'acknowledged'; id?: string } | undefined;
      if (body.action === 'accept') {
        if (lead.artefact.type === 'rule') {
          // A10 inbox: a PENDING proposal. Promotion stays user-gated there.
          const proposalId = store.createRuleProposal(botId, {
            text: lead.artefact.text,
            scope: lead.artefact.scope,
            sourceAtomIds: [],
            rationale: `Dreams lead (A11): ${lead.title} — evidence count ${lead.evidence.count}, score ${lead.score}.`,
          });
          acceptedArtefact = { type: 'rule-proposal', id: proposalId };
        } else if (lead.artefact.type === 'routine') {
          if (!deps.createRoutineDraft) {
            res.status(501).json(errorBody('Routine drafts are not wired on this host; the lead stays pending'));
            return;
          }
          const draft = deps.createRoutineDraft({
            botId,
            name: lead.artefact.name,
            promptTemplate: lead.artefact.promptTemplate,
          });
          acceptedArtefact = { type: 'routine-draft', id: draft.id };
        } else {
          acceptedArtefact = { type: 'acknowledged' };
        }
      }
      const snoozeDays =
        typeof body.snoozeDays === 'number' && Number.isFinite(body.snoozeDays)
          ? Math.min(Math.max(body.snoozeDays, 1), 90)
          : 7;
      const decided = leadStore.decideLead(botId, lead.id, {
        action: body.action,
        decidedBy: user,
        now: now(),
        ...(body.action === 'snooze' ? { snoozeMs: snoozeDays * 86_400_000 } : {}),
        ...(acceptedArtefact ? { acceptedArtefact } : {}),
      });
      deps.audit?.('memory.dreams_decided', {
        actor: user,
        detail: { botId, leadId: decided.id, action: body.action, kind: decided.kind, acceptedArtefact: decided.acceptedArtefact },
      });
      res.json({ ok: true, lead: decided });
    } catch (err) {
      res.status(400).json(errorBody('Failed to decide dream lead', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Scheduler (startMemoryUpkeep / startMemoryIngestionScheduler idiom)
// ---------------------------------------------------------------------------

export interface DreamsSchedulerDeps {
  dataDir: string;
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
  getBotById?: (botId: string) => BotConfig | undefined;
  leadStore?: DreamLeadStore;
  listAudit?: (limit: number) => DreamAuditSourceEntry[];
  summarizerForBot?: MemoryDreamsRouterDeps['summarizerForBot'];
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Tick cadence override for tests. Default 15 min. */
  intervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface DreamsScheduler {
  stop: () => void;
  /** One scheduler tick (exposed for tests; the timer calls this). */
  tick: () => Promise<void>;
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Start the Dreams scheduler. Ticks every 15 min; a bot runs its pass
 * only when ALL hold: settings.enabled is true, local time has reached
 * the configured hour:minute, and no run is recorded for today. When
 * Dreams was never enabled, the tick reads the settings file and does
 * nothing else — zero pass work, zero audit reads.
 */
export function startDreamsScheduler(deps: DreamsSchedulerDeps): DreamsScheduler {
  const leadStore = deps.leadStore ?? new DreamLeadStore(deps.dataDir);
  const nowFn = deps.now ?? (() => Date.now());

  const tick = async (): Promise<void> => {
    for (const bot of deps.getBots()) {
      try {
        const settings = getDreamSettings(deps.dataDir, bot.id);
        if (!settings.enabled) continue; // OFF by default — no work at all
        const now = nowFn();
        const local = new Date(now);
        if (local.getHours() < settings.hour || (local.getHours() === settings.hour && local.getMinutes() < settings.minute)) {
          continue; // not yet time tonight
        }
        const lastRun = leadStore.lastRunAt(bot.id);
        if (lastRun !== undefined && localDayKey(lastRun) === localDayKey(now)) continue; // already ran today
        let summarizer: DreamSummarizer | undefined;
        if (settings.summarise) {
          if (deps.summarizerForBot) {
            summarizer = deps.summarizerForBot(deps.getBotById?.(bot.id), bot.id);
          } else {
            const botConfig = deps.getBotById?.(bot.id);
            const chat = botConfig ? buildBotChatFn(botConfig) : undefined;
            summarizer = chat ? createModelDreamSummarizer(chat) : undefined;
          }
        }
        const result = await runDreamPass(
          {
            memory: deps.tieredMemoryStore,
            leads: leadStore,
            auditEvents: deps.listAudit ? dreamAuditEventsFrom(deps.listAudit) : () => [],
            ...(summarizer ? { summarizer } : {}),
            now: nowFn,
          },
          bot.id,
        );
        if (result.created.length > 0) {
          deps.audit?.('memory.dreams_run', {
            actor: 'system',
            detail: { botId: bot.id, created: result.created.length, suppressed: result.suppressed, lane: result.lane, manual: false },
          });
        }
      } catch {
        // Dreams must never break the server.
      }
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
