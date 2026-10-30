// SPDX-License-Identifier: Apache-2.0
// Proactive outreach "editions" + the proactive pacing model
// (Muse parity §4.10 CT-11 / CT-12).
//
// CT-11 — Editions: a proactive message is packaged as an EDITION — a
// titled, multi-item digest where every item carries its source (label +
// optional link) so the message is tappable/verifiable item by item,
// unlike a single free-form nudge. Items are supplied by callers (briefing
// signals, care candidates, watch hits…); this module does the packaging:
// steering, capping, numbering, and composing the delivered text.
//
// CT-12 — Pacing model: every proactive delivery in this module passes
// decidePacing() against the user's pacing config:
//   - waking hours (start–end local): no proactive sends outside them;
//   - daily cap: at most `dailyCap` proactive sends per local day;
//   - minimum gap between proactive sends;
//   - preference steering: preferred topics are ordered first (and can be
//     boosted into an edition), muted topics are excluded entirely, and a
//     per-topic mute is the user's steering wheel — an edition whose items
//     are ALL muted is suppressed, not sent empty.
// ProactiveCare (proactive-care.ts) keeps its own conservative caps; the
// coordinator may also record care sends here via recordExternalSend() so
// the daily cap accounts for them (see WIRING note).
//
// Delivery is injected (chat/push), sends are recorded BEFORE fan-out so a
// crash cannot double-send, and every decision (sent / deferred /
// suppressed, with the reason) is inspectable via the routes.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';

// ---------------------------------------------------------------------------
// Pacing config (CT-12)
// ---------------------------------------------------------------------------

export interface PacingConfig {
  /** Local hour proactive sends may start (0–23). */
  wakingStartHour: number;
  /** Local hour proactive sends must stop (1–24, after start). */
  wakingEndHour: number;
  /** Max proactive sends per local day (0 = proactive off). */
  dailyCap: number;
  /** Minimum minutes between proactive sends. */
  minGapMinutes: number;
  /** Topics ordered first / always eligible for inclusion. */
  preferredTopics: string[];
  /** Topics never included in editions and never sent proactively. */
  mutedTopics: string[];
  updatedAt: number;
}

export function defaultPacingConfig(): PacingConfig {
  return {
    wakingStartHour: 8,
    wakingEndHour: 21,
    dailyCap: 3,
    minGapMinutes: 120,
    preferredTopics: [],
    mutedTopics: [],
    updatedAt: 0,
  };
}

function normTopic(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normTopics(raw: unknown, field: string, base: string[]): string[] {
  if (raw === undefined) return base;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
    throw new Error(`pacing config "${field}" must be an array of strings`);
  }
  const out = [...new Set((raw as string[]).map(normTopic).filter(Boolean))].slice(0, 50);
  return out;
}

export function normalizePacingConfig(raw: unknown, base: PacingConfig): PacingConfig {
  const b = (raw ?? {}) as Record<string, unknown>;
  const intIn = (v: unknown, field: string, min: number, max: number, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(`pacing config "${field}" must be an integer in [${min}, ${max}]`);
    }
    return v;
  };
  const next: PacingConfig = {
    wakingStartHour: intIn(b.wakingStartHour, 'wakingStartHour', 0, 23, base.wakingStartHour),
    wakingEndHour: intIn(b.wakingEndHour, 'wakingEndHour', 1, 24, base.wakingEndHour),
    dailyCap: intIn(b.dailyCap, 'dailyCap', 0, 20, base.dailyCap),
    minGapMinutes: intIn(b.minGapMinutes, 'minGapMinutes', 0, 24 * 60, base.minGapMinutes),
    preferredTopics: normTopics(b.preferredTopics, 'preferredTopics', base.preferredTopics),
    mutedTopics: normTopics(b.mutedTopics, 'mutedTopics', base.mutedTopics),
    updatedAt: Date.now(),
  };
  if (next.wakingEndHour <= next.wakingStartHour) {
    throw new Error('pacing config wakingEndHour must be after wakingStartHour');
  }
  return next;
}

/** Is this topic muted by the user's steering? */
export function isTopicMuted(cfg: PacingConfig, topic: string | undefined): boolean {
  if (!topic) return false;
  return cfg.mutedTopics.includes(normTopic(topic));
}

/** Steering order: preferred topics first, then the rest (stable). */
export function steerItems<T extends { topic?: string }>(cfg: PacingConfig, items: T[]): T[] {
  const pref = new Set(cfg.preferredTopics);
  return items
    .map((item, i) => ({ item, i, rank: item.topic && pref.has(normTopic(item.topic)) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}

export interface PacingDecision {
  allowed: boolean;
  reason: string;
  /** When a retry could succeed (cap/gap/window), epoch ms. */
  nextAllowedAt?: number;
}

function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The pacing gate. `sendsToday` / `lastSentAt` come from the send ledger
 * (this module's store in production). Pure + deterministic for tests.
 */
export function decidePacing(
  cfg: PacingConfig,
  state: { sendsToday: number; lastSentAt?: number },
  now: number,
  topic?: string,
): PacingDecision {
  if (cfg.dailyCap === 0) return { allowed: false, reason: 'proactive sends are off (daily cap is 0)' };
  if (topic && isTopicMuted(cfg, topic)) {
    return { allowed: false, reason: `topic "${topic}" is muted by the user` };
  }
  const d = new Date(now);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  if (minuteOfDay < cfg.wakingStartHour * 60) {
    const next = new Date(now); next.setHours(cfg.wakingStartHour, 0, 0, 0);
    return { allowed: false, reason: `before waking hours (${cfg.wakingStartHour}:00–${cfg.wakingEndHour}:00)`, nextAllowedAt: next.getTime() };
  }
  if (minuteOfDay >= cfg.wakingEndHour * 60) {
    const next = new Date(now); next.setDate(next.getDate() + 1); next.setHours(cfg.wakingStartHour, 0, 0, 0);
    return { allowed: false, reason: `after waking hours (${cfg.wakingStartHour}:00–${cfg.wakingEndHour}:00)`, nextAllowedAt: next.getTime() };
  }
  if (state.sendsToday >= cfg.dailyCap) {
    const next = new Date(localDayStart(now) + 24 * 3600_000); next.setHours(cfg.wakingStartHour, 0, 0, 0);
    return { allowed: false, reason: `daily proactive cap reached (${state.sendsToday}/${cfg.dailyCap})`, nextAllowedAt: next.getTime() };
  }
  if (state.lastSentAt !== undefined && cfg.minGapMinutes > 0) {
    const gapMs = cfg.minGapMinutes * 60_000;
    if (now - state.lastSentAt < gapMs) {
      return { allowed: false, reason: 'minimum gap since the last proactive send not met', nextAllowedAt: state.lastSentAt + gapMs };
    }
  }
  return { allowed: true, reason: 'within waking hours, under the daily cap, gap satisfied' };
}

// ---------------------------------------------------------------------------
// Editions (CT-11)
// ---------------------------------------------------------------------------

export interface EditionItemInput {
  headline: string;
  summary?: string;
  /** Source label shown with the item (e.g. "GitHub", "Calendar"). */
  sourceLabel: string;
  /** Optional source link (item is tappable when present). */
  sourceUrl?: string;
  topic?: string;
  botId?: string;
}

export interface EditionItem extends EditionItemInput {
  id: string;
  /** 1-based position in the delivered edition. */
  position: number;
}

export type EditionStatus = 'draft' | 'sent' | 'deferred' | 'suppressed';

export interface Edition {
  id: string;
  title: string;
  items: EditionItem[];
  /** The composed digest message delivered to the user. */
  text: string;
  status: EditionStatus;
  statusReason?: string;
  createdAt: number;
  sentAt?: number;
}

export const MAX_EDITION_ITEMS = 8;

/** Compose the delivered digest text: numbered, sourced, tappable items. */
export function composeEditionText(title: string, items: EditionItem[]): string {
  const lines = [`📰 ${title}`];
  for (const item of items) {
    lines.push('');
    lines.push(`${item.position}. ${item.headline}`);
    if (item.summary) lines.push(`   ${item.summary}`);
    lines.push(`   Source: ${item.sourceLabel}${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Build an edition from candidate items, applying steering: muted topics
 * are excluded, preferred topics are ordered first, the edition is capped
 * at MAX_EDITION_ITEMS. Returns the excluded items too (inspectability).
 */
export function buildEdition(
  cfg: PacingConfig,
  input: { title: string; items: EditionItemInput[] },
  now: number,
): { edition: Edition; excluded: EditionItemInput[] } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('"title" is required');
  const excluded: EditionItemInput[] = [];
  const kept: EditionItemInput[] = [];
  for (const item of input.items ?? []) {
    if (typeof item?.headline !== 'string' || !item.headline.trim()) continue;
    if (typeof item?.sourceLabel !== 'string' || !item.sourceLabel.trim()) continue;
    if (isTopicMuted(cfg, item.topic)) { excluded.push(item); continue; }
    kept.push(item);
  }
  const steered = steerItems(cfg, kept).slice(0, MAX_EDITION_ITEMS);
  const items: EditionItem[] = steered.map((item, i) => ({
    ...item,
    headline: item.headline.trim().slice(0, 200),
    ...(item.summary ? { summary: item.summary.trim().slice(0, 500) } : {}),
    sourceLabel: item.sourceLabel.trim().slice(0, 80),
    id: `editem_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    position: i + 1,
  }));
  const edition: Edition = {
    id: `edition_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    title: input.title.trim().slice(0, 160),
    items,
    text: composeEditionText(input.title.trim(), items),
    status: items.length === 0 ? 'suppressed' : 'draft',
    ...(items.length === 0 ? { statusReason: 'every candidate item was muted or invalid — nothing to send' } : {}),
    createdAt: now,
  };
  return { edition, excluded };
}

// ---------------------------------------------------------------------------
// Store + service
// ---------------------------------------------------------------------------

interface EditionRow { payload: string }
interface SendRow { sent_at: number; kind: string }

export class ProactiveEditionStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'proactive-editions.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pacing_config (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS editions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS proactive_sends (id TEXT PRIMARY KEY, kind TEXT NOT NULL, topic TEXT, sent_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_proactive_sends_at ON proactive_sends (sent_at DESC);
    `);
  }

  getPacingConfig(): PacingConfig {
    const r = this.db.prepare('SELECT payload FROM pacing_config WHERE id = 1').get() as { payload: string } | undefined;
    if (!r) return defaultPacingConfig();
    try { return { ...defaultPacingConfig(), ...(JSON.parse(r.payload) as PacingConfig) }; }
    catch { return defaultPacingConfig(); }
  }
  setPacingConfig(raw: unknown): PacingConfig {
    const next = normalizePacingConfig(raw, this.getPacingConfig());
    this.db.prepare('INSERT INTO pacing_config (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(JSON.stringify(next));
    return next;
  }

  saveEdition(e: Edition): void {
    this.db.prepare('INSERT INTO editions (id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(e.id, JSON.stringify(e), e.createdAt);
  }
  getEdition(id: string): Edition | undefined {
    const r = this.db.prepare('SELECT payload FROM editions WHERE id = ?').get(id) as EditionRow | undefined;
    return r ? (JSON.parse(r.payload) as Edition) : undefined;
  }
  listEditions(limit = 50): Edition[] {
    const rows = this.db.prepare('SELECT payload FROM editions ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as unknown as EditionRow[];
    return rows.map((r) => JSON.parse(r.payload) as Edition);
  }

  recordSend(kind: string, sentAt: number, topic?: string): void {
    this.db.prepare('INSERT INTO proactive_sends (id, kind, topic, sent_at) VALUES (?, ?, ?, ?)')
      .run(`psend_${randomUUID().replace(/-/g, '').slice(0, 12)}`, kind, topic ?? null, sentAt);
  }
  sendsToday(now: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM proactive_sends WHERE sent_at >= ?')
      .get(localDayStart(now)) as unknown as { n: number };
    return r.n;
  }
  lastSentAt(): number | undefined {
    const r = this.db.prepare('SELECT sent_at FROM proactive_sends ORDER BY sent_at DESC LIMIT 1').get() as SendRow | undefined;
    return r?.sent_at;
  }

  close(): void { this.db.close(); }
}

export interface ProactiveEditionDeps {
  store: ProactiveEditionStore;
  /** Deliver the edition text (chat and/or push fan-out injected by the host). */
  deliver: (args: { edition: Edition; text: string }) => Promise<void> | void;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  isPaused?: () => boolean;
  now?: () => number;
}

export class ProactiveEditionService {
  constructor(private readonly deps: ProactiveEditionDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private audit(action: string, fields: Record<string, unknown>): void {
    try { this.deps.audit?.(action, fields); } catch { /* never breaks delivery */ }
  }

  getPacingConfig(): PacingConfig { return this.deps.store.getPacingConfig(); }
  setPacingConfig(raw: unknown): PacingConfig { return this.deps.store.setPacingConfig(raw); }

  /** Live pacing status for the UI: config + today's usage + next window. */
  pacingStatus(nowMs?: number): { config: PacingConfig; sendsToday: number; lastSentAt: number | null; decision: PacingDecision } {
    const now = nowMs ?? this.now();
    const cfg = this.deps.store.getPacingConfig();
    const sendsToday = this.deps.store.sendsToday(now);
    const lastSentAt = this.deps.store.lastSentAt();
    return {
      config: cfg, sendsToday, lastSentAt: lastSentAt ?? null,
      decision: decidePacing(cfg, { sendsToday, lastSentAt }, now),
    };
  }

  /** Record a proactive send made elsewhere (e.g. proactive care) so the cap accounts for it. */
  recordExternalSend(kind: string, topic?: string): void {
    this.deps.store.recordSend(kind, this.now(), topic);
  }

  createEdition(input: { title: string; items: EditionItemInput[] }): { edition: Edition; excluded: EditionItemInput[] } {
    const { edition, excluded } = buildEdition(this.deps.store.getPacingConfig(), input, this.now());
    this.deps.store.saveEdition(edition);
    this.audit('proactive_edition.created', { editionId: edition.id, items: edition.items.length, excluded: excluded.length, status: edition.status });
    return { edition, excluded };
  }

  getEdition(id: string): Edition | undefined { return this.deps.store.getEdition(id); }
  listEditions(limit?: number): Edition[] { return this.deps.store.listEditions(limit); }

  /**
   * Deliver an edition through the pacing gate. Outcomes:
   *  - sent: recorded BEFORE fan-out (crash-safe), then delivered.
   *  - deferred: pacing says not now (window/cap/gap) — edition stays
   *    deliverable later; the decision's nextAllowedAt says when.
   *  - suppressed: edition has no items (all muted) or proactive is off.
   */
  async deliverEdition(id: string): Promise<Edition> {
    const edition = this.deps.store.getEdition(id);
    if (!edition) throw Object.assign(new Error(`unknown edition "${id}"`), { status: 404 });
    if (edition.status === 'sent') return edition;
    if (edition.status === 'suppressed' || edition.items.length === 0) {
      return { ...edition, status: 'suppressed', statusReason: edition.statusReason ?? 'edition has no items to send' };
    }
    if (this.deps.isPaused?.()) {
      const next = { ...edition, status: 'deferred' as const, statusReason: 'system paused' };
      this.deps.store.saveEdition(next);
      return next;
    }
    const now = this.now();
    const cfg = this.deps.store.getPacingConfig();
    const decision = decidePacing(cfg, {
      sendsToday: this.deps.store.sendsToday(now),
      lastSentAt: this.deps.store.lastSentAt(),
    }, now);
    if (!decision.allowed) {
      const status: EditionStatus = cfg.dailyCap === 0 ? 'suppressed' : 'deferred';
      const next = { ...edition, status, statusReason: decision.reason };
      this.deps.store.saveEdition(next);
      this.audit('proactive_edition.deferred', { editionId: id, reason: decision.reason, nextAllowedAt: decision.nextAllowedAt });
      return next;
    }
    // Record first, then fan out — a crash mid-delivery cannot double-send.
    this.deps.store.recordSend('edition', now);
    const sent: Edition = { ...edition, status: 'sent', sentAt: now, statusReason: undefined };
    this.deps.store.saveEdition(sent);
    try { await this.deps.deliver({ edition: sent, text: sent.text }); } catch { /* stored as sent; delivery best-effort */ }
    this.audit('proactive_edition.sent', { editionId: id, items: sent.items.length });
    return sent;
  }

  /** Build + immediately attempt delivery (the common scheduler path). */
  async publishEdition(input: { title: string; items: EditionItemInput[] }): Promise<{ edition: Edition; excluded: EditionItemInput[] }> {
    const { edition, excluded } = this.createEdition(input);
    const delivered = await this.deliverEdition(edition.id);
    return { edition: delivered, excluded };
  }
}
