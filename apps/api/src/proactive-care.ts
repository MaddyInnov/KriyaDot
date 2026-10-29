// SPDX-License-Identifier: Apache-2.0
// Proactive care (Octop §2.19 parity, original implementation).
//
// Bots initiate check-ins from their own SCORED memory episodes (atoms).
// This is deliberately conservative:
//
//   - Care is OFF by default per bot (opt-in via CareConfig.enabled).
//   - The person who owns the bot can opt out at any time
//     (CareConfig.personOptedOut) — honoured before any other check.
//   - The global system pause suppresses all care.
//   - Caps: at most `maxPerWeek` sends per bot per rolling 7 days
//     (default 2) and at least `minGapHours` between sends (default 24).
//   - Sends only happen inside the configured local window
//     (windowStartHour–windowEndHour, default 9–20), at a deterministic
//     per-bot-per-day minute inside the window: hash(botId + day) spread
//     across the window. Octop randomizes within the hour; this
//     approximates the same "don't all fire at :00" spread
//     deterministically so behaviour is testable and restart-stable.
//   - Each memory episode can trigger at most ONE care send, ever
//     (care_sends has UNIQUE(bot_id, episode_id)); sends are recorded
//     before delivery fan-out completes so a crash can't double-send.
//   - The check-in text is a deterministic template quoting the atom's
//     fact VERBATIM — the bot never invents details about the episode.
//     An optional injected polish fn may rephrase the surrounding
//     template, never the quoted fact (the quote is re-attached after).
//
// Episode scoring (scoreCareCandidate) uses ONLY real AtomCard fields:
// fact text, confidence, pinned, category, entities, createdAt.
// Weights:
//   confidence            × 20          (0–20)
//   pinned                + 30          (the user said "don't forget")
//   explicit future date  + 35 when due ≤ 7d out / overdue,
//                         + 25 when further out (parseCareDueAt)
//   commitment language   + 15          (deadline, appointment, interview,
//                                        exam, surgery, trip, flight,
//                                        birthday, anniversary, due,
//                                        follow up, appointment…)
//   affect language       + 15          (worried, anxious, stressed, pain,
//                                        doctor, hospital, sick, nervous,
//                                        excited, scared…)
//   category              decision +10, preference +5, others +0
//   recency               age ≤ 7d +10, ≤ 30d +5, > 90d −10
// A candidate must score ≥ CARE_THRESHOLD (45) AND be "due": its parsed
// due date is within the next 24h or past, or (with no parsed date) the
// atom is at least 48h old — a bot never checks in about something the
// person mentioned five minutes ago.
//
// Delivery fan-out per send (all injected, all best-effort except the
// send record): team-inbox FYI for the owner person, a bot-initiated
// chat message via the injected chat deliverer, and a push via the
// injected push fn. Every send is audit-logged via the injected audit fn.

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, type AtomCard } from '@mvp/agent-runtime';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const CARE_THRESHOLD = 45;

const COMMITMENT_RE =
  /\b(deadline|appointment|interview|exam|surgery|operation|trip|flight|birthday|anniversary|due|follow[ -]?up|scheduled|presentation|wedding|move|moving|starts?|begins?)\b/i;
const AFFECT_RE =
  /\b(worried|worry|anxious|anxiety|stressed|stress|pain|doctor|hospital|sick|ill|nervous|excited|scared|afraid|sad|lonely|tired|overwhelmed|difficult|hard time)\b/i;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Extract an explicit future-ish date from an atom's fact text.
 * Recognizes: ISO dates (2026-11-05), "October 30" / "30 October"
 * (year = the year that puts it closest in the future from `now`),
 * "tomorrow", "next week", "in N days". Returns epoch ms or undefined.
 * Deliberately narrow: unparseable text simply yields no date.
 */
export function parseCareDueAt(fact: string, now: number): number | undefined {
  const text = fact.toLowerCase();
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const t = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 9, 0, 0, 0).getTime();
    if (Number.isFinite(t)) return t;
  }
  const monthDay = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  ) ?? text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/,
  );
  if (monthDay) {
    const [monthName, dayStr] = isNaN(Number(monthDay[1])) ? [monthDay[1], monthDay[2]] : [monthDay[2], monthDay[1]];
    const month = MONTHS[monthName!];
    if (month !== undefined) {
      const base = new Date(now);
      let t = new Date(base.getFullYear(), month, Number(dayStr), 9, 0, 0, 0).getTime();
      // "October 30" said in November means next year's — roll forward
      // only when it's more than 30 days in the past.
      if (t < now - 30 * 24 * 3600_000) {
        t = new Date(base.getFullYear() + 1, month, Number(dayStr), 9, 0, 0, 0).getTime();
      }
      return t;
    }
  }
  if (/\btomorrow\b/.test(text)) return now + 24 * 3600_000;
  if (/\bnext week\b/.test(text)) return now + 7 * 24 * 3600_000;
  const inDays = text.match(/\bin\s+(\d{1,3})\s+days?\b/);
  if (inDays) return now + Number(inDays[1]) * 24 * 3600_000;
  return undefined;
}

export interface CareScore {
  atom: AtomCard;
  score: number;
  reasons: string[];
  dueAt?: number;
  /** Due = parsed date within +24h/past, or no date and atom ≥ 48h old. */
  due: boolean;
}

export function scoreCareCandidate(atom: AtomCard, now: number): CareScore {
  const reasons: string[] = [];
  let score = 0;
  const add = (pts: number, why: string): void => { score += pts; reasons.push(`${why} (${pts >= 0 ? '+' : ''}${pts})`); };

  score += Math.round(atom.confidence * 20);
  reasons.push(`confidence (${Math.round(atom.confidence * 20)})`);
  if (atom.pinned) add(30, 'pinned by the user');
  const dueAt = parseCareDueAt(atom.fact, now);
  if (dueAt !== undefined) {
    const days = (dueAt - now) / (24 * 3600_000);
    add(days <= 7 ? 35 : 25, 'explicit date in the episode');
  } else if (COMMITMENT_RE.test(atom.fact)) {
    add(15, 'commitment language');
  }
  if (AFFECT_RE.test(atom.fact)) add(15, 'affect / wellbeing language');
  if (atom.category === 'decision') add(10, 'a recorded decision');
  else if (atom.category === 'preference') add(5, 'a stated preference');

  const ageMs = now - atom.createdAt;
  if (ageMs <= 7 * 24 * 3600_000) add(10, 'recent (≤7d)');
  else if (ageMs <= 30 * 24 * 3600_000) add(5, 'recent (≤30d)');
  else if (ageMs > 90 * 24 * 3600_000) add(-10, 'stale (>90d)');

  const due = dueAt !== undefined
    ? dueAt <= now + 24 * 3600_000
    : ageMs >= 48 * 3600_000;
  return { atom, score, reasons, ...(dueAt !== undefined ? { dueAt } : {}), due };
}

/** Rank a bot's atoms for care: due candidates at/above threshold, best first. */
export function rankCareCandidates(atoms: AtomCard[], now: number): CareScore[] {
  return atoms
    .filter((a) => a.active)
    .map((a) => scoreCareCandidate(a, now))
    .filter((s) => s.due && s.score >= CARE_THRESHOLD)
    .sort((x, y) => y.score - x.score || x.atom.createdAt - y.atom.createdAt);
}

/** Compose the check-in text: template + the verbatim quoted fact. */
export function composeCareMessage(botName: string, scored: CareScore, polish?: string): string {
  const intro = polish?.trim()
    ? polish.trim().slice(0, 300)
    : `Hi — ${botName} checking in. You mentioned this a while back, and I wanted to ask how it's going:`;
  return `${intro}\n"${scored.atom.fact}"\nHow are things with that? No rush — reply whenever.`;
}

/** Deterministic in-window minute for a bot on a given local day. */
export function careScheduledMinute(botId: string, dayKey: string, windowStartHour: number, windowEndHour: number): number {
  const span = Math.max(1, (windowEndHour - windowStartHour) * 60);
  const h = createHash('sha256').update(`${botId}:${dayKey}`).digest();
  const n = h.readUInt32BE(0) % span;
  return windowStartHour * 60 + n;
}

// ---------------------------------------------------------------------------
// Config + send store (proactive-care.db)
// ---------------------------------------------------------------------------

export interface CareConfig {
  botId: string;
  /** The person the bot's care messages are for (its owner). */
  ownerPersonId: string;
  enabled: boolean;
  maxPerWeek: number;
  windowStartHour: number;
  windowEndHour: number;
  minGapHours: number;
  /** The OWNER person's opt-out — suppresses care even when enabled. */
  personOptedOut: boolean;
  updatedAt: number;
}

export function defaultCareConfig(botId: string, ownerPersonId: string): CareConfig {
  return {
    botId,
    ownerPersonId,
    enabled: false,
    maxPerWeek: 2,
    windowStartHour: 9,
    windowEndHour: 20,
    minGapHours: 24,
    personOptedOut: false,
    updatedAt: 0,
  };
}

export function normalizeCareConfig(botId: string, raw: unknown, base: CareConfig): CareConfig {
  const b = (raw ?? {}) as Record<string, unknown>;
  const intIn = (v: unknown, field: string, min: number, max: number, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(`care config "${field}" must be an integer in [${min}, ${max}]`);
    }
    return v;
  };
  const next: CareConfig = {
    botId,
    ownerPersonId: typeof b.ownerPersonId === 'string' && b.ownerPersonId.trim() ? b.ownerPersonId.trim() : base.ownerPersonId,
    enabled: b.enabled === undefined ? base.enabled : b.enabled === true,
    maxPerWeek: intIn(b.maxPerWeek, 'maxPerWeek', 0, 14, base.maxPerWeek),
    windowStartHour: intIn(b.windowStartHour, 'windowStartHour', 0, 23, base.windowStartHour),
    windowEndHour: intIn(b.windowEndHour, 'windowEndHour', 1, 24, base.windowEndHour),
    minGapHours: intIn(b.minGapHours, 'minGapHours', 0, 24 * 14, base.minGapHours),
    personOptedOut: b.personOptedOut === undefined ? base.personOptedOut : b.personOptedOut === true,
    updatedAt: Date.now(),
  };
  if (next.windowEndHour <= next.windowStartHour) {
    throw new Error('care config windowEndHour must be after windowStartHour');
  }
  return next;
}

export interface CareSend {
  id: string;
  botId: string;
  episodeId: string;
  personId: string;
  text: string;
  score: number;
  sentAt: number;
}

interface ConfigRow { bot_id: string; config_json: string }
interface SendRow {
  id: string; bot_id: string; episode_id: string; person_id: string;
  text: string; score: number; sent_at: number;
}

export class ProactiveCareStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'proactive-care.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS care_configs (
        bot_id TEXT PRIMARY KEY, config_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS care_sends (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        person_id TEXT NOT NULL, text TEXT NOT NULL, score REAL NOT NULL,
        sent_at INTEGER NOT NULL,
        UNIQUE (bot_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_care_sends_bot ON care_sends (bot_id, sent_at DESC);
    `);
  }

  getConfig(botId: string, ownerPersonId = 'you'): CareConfig {
    const row = this.db.prepare('SELECT * FROM care_configs WHERE bot_id = ?').get(botId) as unknown as ConfigRow | undefined;
    if (!row) return defaultCareConfig(botId, ownerPersonId);
    try {
      return { ...defaultCareConfig(botId, ownerPersonId), ...(JSON.parse(row.config_json) as CareConfig), botId };
    } catch {
      return defaultCareConfig(botId, ownerPersonId);
    }
  }

  setConfig(botId: string, raw: unknown, ownerPersonId = 'you'): CareConfig {
    const next = normalizeCareConfig(botId, raw, this.getConfig(botId, ownerPersonId));
    this.db.prepare(
      `INSERT INTO care_configs (bot_id, config_json) VALUES (?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET config_json = excluded.config_json`,
    ).run(botId, JSON.stringify(next));
    return next;
  }

  listConfigs(): CareConfig[] {
    const rows = this.db.prepare('SELECT * FROM care_configs').all() as unknown as ConfigRow[];
    return rows.map((r) => this.getConfig(r.bot_id));
  }

  /** Record a send. Returns false when this episode was already sent (dedupe). */
  recordSend(send: Omit<CareSend, 'id'>): CareSend | undefined {
    const rec: CareSend = { ...send, id: `care_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}` };
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO care_sends (id, bot_id, episode_id, person_id, text, score, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(rec.id, rec.botId, rec.episodeId, rec.personId, rec.text, rec.score, rec.sentAt);
    return r.changes > 0 ? rec : undefined;
  }

  hasSent(botId: string, episodeId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS x FROM care_sends WHERE bot_id = ? AND episode_id = ?').get(botId, episodeId) as unknown as { x: number } | undefined;
    return row !== undefined;
  }

  listSends(botId?: string, limit = 50): CareSend[] {
    const rows = (botId
      ? this.db.prepare('SELECT * FROM care_sends WHERE bot_id = ? ORDER BY sent_at DESC LIMIT ?').all(botId, limit)
      : this.db.prepare('SELECT * FROM care_sends ORDER BY sent_at DESC LIMIT ?').all(limit)) as unknown as SendRow[];
    return rows.map((r) => ({
      id: r.id, botId: r.bot_id, episodeId: r.episode_id, personId: r.person_id,
      text: r.text, score: r.score, sentAt: r.sent_at,
    }));
  }

  sendsSince(botId: string, sinceMs: number): CareSend[] {
    const rows = this.db.prepare('SELECT * FROM care_sends WHERE bot_id = ? AND sent_at >= ? ORDER BY sent_at DESC')
      .all(botId, sinceMs) as unknown as SendRow[];
    return rows.map((r) => ({
      id: r.id, botId: r.bot_id, episodeId: r.episode_id, personId: r.person_id,
      text: r.text, score: r.score, sentAt: r.sent_at,
    }));
  }

  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ProactiveCareDeps {
  store: ProactiveCareStore;
  /** Bots care may run for: id, display name, owner person id. */
  listBots: () => Array<{ id: string; name: string; ownerPersonId: string }>;
  /** The bot's memory atoms (TieredMemoryStore.getAtoms in production). */
  getAtoms: (botId: string) => AtomCard[];
  /** Team-inbox delivery (FYI item for the owner person). */
  addInboxItem: (item: { personId: string; title: string; summary: string; botId: string; refId?: string }) => void;
  /** Bot-initiated chat message delivery (injected; stubbed in tests). */
  deliverChat: (args: { botId: string; personId: string; text: string }) => Promise<void> | void;
  /** Push delivery (PushService.notify in production; stubbed in tests). */
  push: (args: { botId: string; botName: string; title: string; body: string }) => Promise<void> | void;
  /** Global system pause gate (system-pause.ts pauseGate in production). */
  isPaused: () => boolean;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Optional intro polisher — rephrases the intro line ONLY. */
  polish?: (intro: string, atom: AtomCard) => Promise<string> | string;
  now?: () => number;
}

export interface CareTickAction {
  botId: string;
  action: 'sent' | 'skipped';
  reason: string;
  send?: CareSend;
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ProactiveCareEngine {
  constructor(private readonly deps: ProactiveCareDeps) {}

  /**
   * One scheduler tick. For each bot: at most ONE send. `opts.force`
   * (manual run-once) bypasses the in-window scheduled-minute check but
   * NEVER the opt-in, opt-out, pause, caps, gap, or dedupe checks.
   */
  async tick(opts: { force?: boolean } = {}): Promise<CareTickAction[]> {
    const now = (this.deps.now ?? (() => Date.now()))();
    const actions: CareTickAction[] = [];
    if (this.deps.isPaused()) {
      return this.deps.listBots().map((b) => ({ botId: b.id, action: 'skipped' as const, reason: 'system paused' }));
    }
    const local = new Date(now);
    const minuteOfDay = local.getHours() * 60 + local.getMinutes();
    for (const bot of this.deps.listBots()) {
      const cfg = this.deps.store.getConfig(bot.id, bot.ownerPersonId);
      const skip = (reason: string): void => { actions.push({ botId: bot.id, action: 'skipped', reason }); };
      if (!cfg.enabled) { skip('care is not enabled for this bot (opt-in)'); continue; }
      if (cfg.personOptedOut) { skip('the person opted out of proactive care'); continue; }
      if (cfg.maxPerWeek === 0) { skip('weekly cap is 0'); continue; }
      if (minuteOfDay < cfg.windowStartHour * 60 || minuteOfDay >= cfg.windowEndHour * 60) {
        skip(`outside the care window (${cfg.windowStartHour}:00–${cfg.windowEndHour}:00 local)`);
        continue;
      }
      if (!opts.force) {
        const scheduled = careScheduledMinute(bot.id, dayKeyOf(local), cfg.windowStartHour, cfg.windowEndHour);
        if (minuteOfDay < scheduled) { skip('before today\'s scheduled care minute'); continue; }
      }
      const recent = this.deps.store.sendsSince(bot.id, now - 7 * 24 * 3600_000);
      if (recent.length >= cfg.maxPerWeek) { skip(`weekly cap reached (${recent.length}/${cfg.maxPerWeek})`); continue; }
      const last = recent[0];
      if (last && now - last.sentAt < cfg.minGapHours * 3600_000) { skip('minimum gap since last care send not met'); continue; }

      const candidates = rankCareCandidates(this.deps.getAtoms(bot.id), now)
        .filter((c) => !this.deps.store.hasSent(bot.id, c.atom.id));
      const top = candidates[0];
      if (!top) { skip('no due care candidate at/above threshold'); continue; }

      let intro: string | undefined;
      if (this.deps.polish) {
        try {
          const polished = await this.deps.polish(
            `Hi — ${bot.name} checking in. You mentioned this a while back, and I wanted to ask how it's going:`,
            top.atom,
          );
          if (typeof polished === 'string' && polished.trim()) intro = polished;
        } catch { /* polish optional */ }
      }
      const text = composeCareMessage(bot.name, top, intro);
      // Record FIRST (dedupe + crash safety), then fan out delivery.
      const send = this.deps.store.recordSend({
        botId: bot.id, episodeId: top.atom.id, personId: cfg.ownerPersonId,
        text, score: top.score, sentAt: now,
      });
      if (!send) { skip('episode already sent (dedupe)'); continue; }
      try {
        this.deps.addInboxItem({
          personId: cfg.ownerPersonId,
          title: `${bot.name} checked in with you`,
          summary: text,
          botId: bot.id,
          refId: send.id,
        });
      } catch { /* inbox is one of three channels; keep going */ }
      try { await this.deps.deliverChat({ botId: bot.id, personId: cfg.ownerPersonId, text }); } catch { /* best-effort */ }
      try {
        await this.deps.push({ botId: bot.id, botName: bot.name, title: `${bot.name} checked in`, body: text.slice(0, 300) });
      } catch { /* best-effort */ }
      try {
        this.deps.audit?.('proactive_care.sent', {
          actor: bot.id,
          detail: { botId: bot.id, personId: cfg.ownerPersonId, episodeId: top.atom.id, score: top.score, reasons: top.reasons, sendId: send.id },
        });
      } catch { /* audit must never break care */ }
      actions.push({ botId: bot.id, action: 'sent', reason: `sent (score ${top.score}: ${top.reasons.join('; ')})`, send });
    }
    return actions;
  }
}
