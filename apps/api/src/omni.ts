// SPDX-License-Identifier: Apache-2.0
// Omni rolling summary (Omni panel backend): "Where am I right now?"
//
// Four temporal layers, user pins, and time-travel versions, backed by
// <dataDir>/omni.db (node:sqlite):
//
//   attention  — active workflow runs + pending approvals + unread
//                high-priority items (needs a decision right now)
//   recent     — today's activity items
//   period     — this week's compressed highlights (from nightly rollups)
//   milestones — major events (failed runs, deployments, briefings) + pins
//                are always surfaced via the pins[] list
//   versions   — snapshots of the four layers + pins, for time-travel
//
// Progressive compression: Recent → Period rolls up nightly, Period →
// Milestones rolls up weekly. Compression is deterministic and template
// based; the tiered memory store (packages/agent-runtime/src/memory.ts) is
// the distillation substrate — every rolled-up item is distilled into L2
// atoms (botId "omni-rollup") so entity-level recall keeps working. When
// Ollama is reachable AND OMNI_OLLAMA_ENHANCE=1, highlight titles get a
// local-model rewrite pass; any failure falls back to the templates.
// Zero paid APIs, ever.
//
// An OmniCollector feeds the store from the governance audit log, pending
// approvals, and workflow runs (incremental via watermarks). An
// OmniScheduler wires the nightly/weekly rollups onto an interval with a
// testable tick(); POST /api/summary/omni/rollup is the manual trigger.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TieredMemoryStore, heuristicDistill } from '@mvp/agent-runtime';
import { OllamaProvider, ollamaHost } from '@mvp/agent-runtime/dist/providers/ollama.js';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** Snapshot retention: newest N kept per granularity, the rest pruned. */
export const DAILY_VERSION_KEEP = 30;
export const WEEKLY_VERSION_KEEP = 12;
export const MANUAL_VERSION_KEEP = 30;

/** Item caps (oldest non-pinned items dropped past these). */
export const RECENT_ITEM_CAP = 500;
export const MILESTONE_ITEM_CAP = 300;

/** Maximum highlight items produced by one nightly rollup. */
export const MAX_NIGHTLY_HIGHLIGHTS = 5;

export type OmniLayer = 'attention' | 'recent' | 'period' | 'milestones';
export type VersionGranularity = 'daily' | 'weekly' | 'manual';

export const OMNI_LAYERS: ReadonlyArray<OmniLayer> = ['attention', 'recent', 'period', 'milestones'];

/** Matches the frontend BriefingItem contract in apps/web/lib/kriyadot-api.ts. */
export interface OmniItem {
  id: string;
  title: string;
  detail?: string;
  ts?: number;
  kind?: string;
}

export interface OmniItemInput {
  layer: OmniLayer;
  title: string;
  detail?: string;
  ts?: number;
  kind?: string;
  source?: string;
  /** Dedupe key (e.g. "approval:<id>", "audit:<id>", "run:<id>:active"). */
  sourceKey: string;
}

/** Matches the frontend OmniSummary contract exactly. */
export interface OmniSummary {
  attention: OmniItem[];
  recent: OmniItem[];
  period: OmniItem[];
  milestones: OmniItem[];
  pins: OmniItem[];
  versions: Array<{ id: string; createdAt: number; label?: string }>;
}

export interface OmniVersion {
  id: string;
  createdAt: number;
  label?: string;
  granularity: VersionGranularity;
}

export interface RollupStats {
  /** Items consumed by the rollup (removed from their source layer). */
  rolledUp: number;
  /** Highlight/milestone items produced. */
  produced: number;
}

/** Kinds that survive the weekly Period → Milestones promotion. */
export const MAJOR_KINDS: ReadonlySet<string> = new Set([
  'workflow-failed',
  'deployment',
  'release',
  'incident',
  'briefing-generated',
  'milestone',
  'push',
  'approval-denied',
  'tool.denied',
  'turn.budget_cap',
]);

/** Pure: is this item kind a "major event" worth keeping as a milestone? */
export function isMajorKind(kind: string | undefined): boolean {
  return typeof kind === 'string' && MAJOR_KINDS.has(kind);
}

const ATTENTION_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  'tool.denied',
  'tool.plan_mode_denied',
  'tool.sandbox_denied',
  'turn.budget_cap',
  'message.send_blocked',
]);

const MILESTONE_AUDIT_ACTIONS: ReadonlySet<string> = new Set(['briefing.generated']);

/**
 * Pure, testable layer assignment for audit-log actions.
 * - attention: unread high-priority items (denied tools, budget caps)
 * - milestones: major events (generated briefings; workflow events are
 *   handled by the runs collector instead to avoid double counting)
 * - recent: everyday activity worth recording today
 * - null: noise / handled elsewhere (skip)
 */
export function classifyAuditAction(action: string): OmniLayer | null {
  if (!action || typeof action !== 'string') return null;
  if (action.startsWith('workflow.')) return null; // runs collector owns these
  if (action === 'tool.approval_requested' || action === 'tool.approval_auto_approved') return null; // approvals collector owns these
  if (ATTENTION_AUDIT_ACTIONS.has(action)) return 'attention';
  if (MILESTONE_AUDIT_ACTIONS.has(action)) return 'milestones';
  if (
    action.startsWith('tool.') ||
    action.startsWith('message.') ||
    action.startsWith('oauth.') ||
    action.startsWith('mcp.') ||
    action.startsWith('processing_rule.') ||
    action.startsWith('tenancy.') ||
    action.startsWith('computer_') ||
    action === 'tool.computer_real_action'
  ) {
    return 'recent';
  }
  return null;
}

/** Human label for an audit action, e.g. "message.sent" → "Message sent". */
export function auditActionLabel(action: string): string {
  return action
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function startOfDayUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfWeekUtc(ts: number): number {
  const day = startOfDayUtc(ts);
  const dow = new Date(day).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (dow + 6) % 7;
  return day - daysSinceMonday * DAY_MS;
}

function utcDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function utcWeekKey(ts: number): string {
  const d = new Date(startOfWeekUtc(ts));
  return `${d.getUTCFullYear()}-W${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

interface OmniItemRow {
  id: string;
  layer: string;
  title: string;
  detail: string | null;
  ts: number | null;
  kind: string | null;
  source: string | null;
  source_key: string;
  pinned: number;
  created_at: number;
}

function rowToItem(r: OmniItemRow): OmniItem & { layer: OmniLayer; source?: string; sourceKey: string; pinned: boolean; createdAt: number } {
  return {
    id: r.id,
    layer: r.layer as OmniLayer,
    title: r.title,
    detail: r.detail ?? undefined,
    ts: r.ts ?? undefined,
    kind: r.kind ?? undefined,
    source: r.source ?? undefined,
    sourceKey: r.source_key,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
  };
}

export type StoredOmniItem = ReturnType<typeof rowToItem>;

/**
 * Optional local-LLM enhancement: rewrite highlight titles with the first
 * available Ollama model. Returns the input unchanged when Ollama is not
 * reachable, has no models, or anything fails — the deterministic template
 * path is always the fallback. Never touches paid APIs.
 */
export async function enhanceHighlightTitles(titles: string[]): Promise<string[]> {
  if (titles.length === 0) return titles;
  try {
    const host = ollamaHost().replace(/\/+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    let tagsRes: Response;
    try {
      tagsRes = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!tagsRes.ok) return titles;
    const data = (await tagsRes.json().catch(() => null)) as { models?: Array<{ name?: string }> } | null;
    const models = Array.isArray(data?.models) ? data!.models : [];
    const model = models.find((m) => typeof m.name === 'string' && m.name.length > 0)?.name;
    if (!model) return titles;
    const provider = new OllamaProvider();
    const { content } = await provider.chat(
      [
        {
          role: 'system',
          content:
            'Rewrite each activity highlight below as one short, clear sentence. ' +
            'Output exactly one rewritten line per input line, no numbering, no commentary.',
        },
        { role: 'user', content: titles.join('\n') },
      ],
      [],
      { model, signal: AbortSignal.timeout(20_000) },
    );
    const lines = content
      .split('\n')
      .map((l) => l.trim().replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, ''))
      .filter((l) => l.length > 0);
    return lines.length === titles.length ? lines : titles;
  } catch {
    return titles;
  }
}

export class OmniStore {
  private readonly db: DatabaseSync;
  /** Tiered memory as the compression substrate (L2 atoms of rolled-up days). */
  private readonly memStore: TieredMemoryStore;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'omni.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS omni_items (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        ts INTEGER,
        kind TEXT,
        source TEXT,
        source_key TEXT NOT NULL UNIQUE,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_omni_items_layer_ts ON omni_items(layer, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_omni_items_source_key ON omni_items(source_key);
      CREATE TABLE IF NOT EXISTS omni_versions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        label TEXT,
        granularity TEXT NOT NULL DEFAULT 'manual',
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_omni_versions_created ON omni_versions(created_at DESC);
      CREATE TABLE IF NOT EXISTS omni_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.memStore = new TieredMemoryStore(join(dataDir, 'omni-memory'));
  }

  close(): void {
    this.db.close();
  }

  // ---- key/value (watermarks, rollup markers) --------------------------------

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM omni_kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO omni_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---- items -------------------------------------------------------------------

  /** True when there is nothing to show: the panel renders its empty state. */
  isEmpty(): boolean {
    const items = (this.db.prepare('SELECT COUNT(*) AS n FROM omni_items').get() as { n: number }).n;
    const versions = (this.db.prepare('SELECT COUNT(*) AS n FROM omni_versions').get() as { n: number }).n;
    return items === 0 && versions === 0;
  }

  /** Insert or update by sourceKey (collector upserts are idempotent). */
  upsertItem(input: OmniItemInput): StoredOmniItem {
    const now = Date.now();
    const title = input.title.trim().slice(0, 500);
    if (!title) throw new Error('omni item title must be non-empty');
    const existing = this.db.prepare('SELECT * FROM omni_items WHERE source_key = ?').get(input.sourceKey) as unknown as OmniItemRow | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE omni_items SET layer = ?, title = ?, detail = ?, ts = ?, kind = ?, source = ? WHERE source_key = ?`,
        )
        .run(
          input.layer,
          title,
          input.detail?.slice(0, 2000) ?? null,
          input.ts ?? null,
          input.kind ?? null,
          input.source ?? null,
          input.sourceKey,
        );
      const updated = this.db.prepare('SELECT * FROM omni_items WHERE source_key = ?').get(input.sourceKey) as unknown as OmniItemRow;
      return rowToItem(updated);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO omni_items (id, layer, title, detail, ts, kind, source, source_key, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.layer,
        title,
        input.detail?.slice(0, 2000) ?? null,
        input.ts ?? null,
        input.kind ?? null,
        input.source ?? null,
        input.sourceKey,
        now,
      );
    const inserted = this.db.prepare('SELECT * FROM omni_items WHERE id = ?').get(id) as unknown as OmniItemRow;
    this.capLayer(input.layer);
    return rowToItem(inserted);
  }

  hasSourceKey(sourceKey: string): boolean {
    const row = this.db.prepare('SELECT 1 AS one FROM omni_items WHERE source_key = ?').get(sourceKey) as { one: number } | undefined;
    return row !== undefined;
  }

  getItem(id: string): StoredOmniItem | undefined {
    const row = this.db.prepare('SELECT * FROM omni_items WHERE id = ?').get(id) as unknown as OmniItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  listItems(layer?: OmniLayer): StoredOmniItem[] {
    const rows = (layer
      ? this.db.prepare('SELECT * FROM omni_items WHERE layer = ? ORDER BY COALESCE(ts, created_at) DESC, created_at DESC').all(layer)
      : this.db.prepare('SELECT * FROM omni_items ORDER BY COALESCE(ts, created_at) DESC, created_at DESC').all()) as unknown as OmniItemRow[];
    return rows.map(rowToItem);
  }

  /** Pinned items across all layers, newest first. */
  listPins(): StoredOmniItem[] {
    const rows = this.db
      .prepare('SELECT * FROM omni_items WHERE pinned = 1 ORDER BY COALESCE(ts, created_at) DESC, created_at DESC')
      .all() as unknown as OmniItemRow[];
    return rows.map(rowToItem);
  }

  setPinned(id: string, pinned: boolean): boolean {
    const res = this.db.prepare('UPDATE omni_items SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
    return res.changes > 0;
  }

  deleteItem(id: string): boolean {
    return this.db.prepare('DELETE FROM omni_items WHERE id = ?').run(id).changes > 0;
  }

  deleteBySourceKey(sourceKey: string): boolean {
    return this.db.prepare('DELETE FROM omni_items WHERE source_key = ?').run(sourceKey).changes > 0;
  }

  /** Drop oldest non-pinned items past the layer cap. */
  private capLayer(layer: OmniLayer): void {
    const cap = layer === 'recent' ? RECENT_ITEM_CAP : layer === 'milestones' ? MILESTONE_ITEM_CAP : 0;
    if (!cap) return;
    this.db
      .prepare(
        `DELETE FROM omni_items WHERE layer = ? AND pinned = 0 AND id NOT IN (
           SELECT id FROM omni_items WHERE layer = ? ORDER BY COALESCE(ts, created_at) DESC, created_at DESC LIMIT ?
         )`,
      )
      .run(layer, layer, cap);
  }

  // ---- summary ---------------------------------------------------------------

  private static toBriefingItem(i: StoredOmniItem): OmniItem {
    return {
      id: i.id,
      title: i.title,
      ...(i.detail !== undefined ? { detail: i.detail } : {}),
      ...(i.ts !== undefined ? { ts: i.ts } : {}),
      ...(i.kind !== undefined ? { kind: i.kind } : {}),
    };
  }

  /** Current summary matching the frontend OmniSummary contract exactly. */
  getSummary(): OmniSummary {
    const byLayer = (layer: OmniLayer): OmniItem[] => this.listItems(layer).map(OmniStore.toBriefingItem);
    return {
      attention: byLayer('attention'),
      recent: byLayer('recent'),
      period: byLayer('period'),
      milestones: byLayer('milestones'),
      pins: this.listPins().map(OmniStore.toBriefingItem),
      versions: this.listVersions().map((v) => ({
        id: v.id,
        createdAt: v.createdAt,
        ...(v.label !== undefined ? { label: v.label } : {}),
      })),
    };
  }

  // ---- versions / snapshots ----------------------------------------------------

  createVersion(label?: string, granularity: VersionGranularity = 'manual'): OmniVersion {
    const s = this.getSummary();
    const snapshot = JSON.stringify({
      attention: s.attention,
      recent: s.recent,
      period: s.period,
      milestones: s.milestones,
      pins: s.pins,
    });
    const v: OmniVersion = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...(label ? { label } : {}),
      granularity,
    };
    this.db
      .prepare('INSERT INTO omni_versions (id, created_at, label, granularity, snapshot) VALUES (?, ?, ?, ?, ?)')
      .run(v.id, v.createdAt, v.label ?? null, v.granularity, snapshot);
    this.pruneVersions();
    return v;
  }

  getVersion(id: string): OmniVersion | undefined {
    const row = this.db.prepare('SELECT id, created_at, label, granularity FROM omni_versions WHERE id = ?').get(id) as
      | { id: string; created_at: number; label: string | null; granularity: string }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      createdAt: row.created_at,
      ...(row.label ? { label: row.label } : {}),
      granularity: row.granularity as VersionGranularity,
    };
  }

  /** Time-travel: the snapshot's layers + pins, with the current versions list. */
  getVersionSummary(id: string): OmniSummary | undefined {
    const row = this.db.prepare('SELECT snapshot FROM omni_versions WHERE id = ?').get(id) as { snapshot: string } | undefined;
    if (!row) return undefined;
    let parsed: { attention?: OmniItem[]; recent?: OmniItem[]; period?: OmniItem[]; milestones?: OmniItem[]; pins?: OmniItem[] };
    try {
      parsed = JSON.parse(row.snapshot) as typeof parsed;
    } catch {
      return undefined;
    }
    return {
      attention: Array.isArray(parsed.attention) ? parsed.attention : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      period: Array.isArray(parsed.period) ? parsed.period : [],
      milestones: Array.isArray(parsed.milestones) ? parsed.milestones : [],
      pins: Array.isArray(parsed.pins) ? parsed.pins : [],
      versions: this.listVersions().map((v) => ({
        id: v.id,
        createdAt: v.createdAt,
        ...(v.label !== undefined ? { label: v.label } : {}),
      })),
    };
  }

  listVersions(): OmniVersion[] {
    const rows = this.db
      .prepare('SELECT id, created_at, label, granularity FROM omni_versions ORDER BY created_at DESC, rowid DESC')
      .all() as Array<{ id: string; created_at: number; label: string | null; granularity: string }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      ...(row.label ? { label: row.label } : {}),
      granularity: row.granularity as VersionGranularity,
    }));
  }

  /** Retention: newest 30 daily + 12 weekly + 30 manual snapshots; prune rest. */
  pruneVersions(): { pruned: number } {
    const keep: Record<string, number> = { daily: DAILY_VERSION_KEEP, weekly: WEEKLY_VERSION_KEEP, manual: MANUAL_VERSION_KEEP };
    const rows = this.db
      .prepare('SELECT id, granularity FROM omni_versions ORDER BY created_at DESC, rowid DESC')
      .all() as Array<{ id: string; granularity: string }>;
    const seen: Record<string, number> = {};
    const drop: string[] = [];
    for (const r of rows) {
      const g = r.granularity in keep ? r.granularity : 'manual';
      seen[g] = (seen[g] ?? 0) + 1;
      if (seen[g] > keep[g]) drop.push(r.id);
    }
    const del = this.db.prepare('DELETE FROM omni_versions WHERE id = ?');
    for (const id of drop) del.run(id);
    return { pruned: drop.length };
  }

  // ---- compression -------------------------------------------------------------

  /**
   * Distill one rolled-up item into L2 atoms on the tiered-memory
   * substrate (botId "omni-rollup"). Deterministic and synchronous —
   * heuristic extraction, no model call.
   */
  private distillToMemory(item: StoredOmniItem): void {
    try {
      const text = item.detail ? `${item.title}. ${item.detail}` : item.title;
      const facts = heuristicDistill(text);
      for (const f of facts) {
        this.memStore.storeAtom('omni-rollup', f, item.id);
      }
    } catch {
      // Compression must never break the rollup.
    }
  }

  private static kindLabel(kind: string): string {
    const cleaned = kind.replace(/^rollup:/, '').replace(/[._:-]+/g, ' ').trim();
    return cleaned.length > 0 ? cleaned : 'activity';
  }

  /**
   * Nightly rollup: compress yesterday-and-older "recent" items into
   * 3–5 "period" highlight items. Stale "attention" items (not pinned)
   * demote to "recent" — attention is for things needing action now.
   * Deterministic; set `enhance: true` for an optional Ollama rewrite.
   */
  async rollupNightly(now: number = Date.now(), opts: { enhance?: boolean } = {}): Promise<RollupStats> {
    const dayStart = startOfDayUtc(now);
    const dayKey = utcDayKey(now - 1);
    const rows = this.listItems('recent').filter((i) => !i.pinned && (i.ts ?? i.createdAt) < dayStart);
    const staleAttention = this.listItems('attention').filter((i) => !i.pinned && (i.ts ?? i.createdAt) < dayStart);

    let produced = 0;
    if (rows.length > 0) {
      for (const item of rows) this.distillToMemory(item);

      // Group by kind, biggest groups first; merge overflow into "other".
      const groups = new Map<string, StoredOmniItem[]>();
      for (const item of rows) {
        const k = item.kind ?? 'activity';
        const g = groups.get(k);
        if (g) g.push(item);
        else groups.set(k, [item]);
      }
      const sorted = [...groups.entries()].sort(
        (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      );
      let kept = sorted;
      if (sorted.length > MAX_NIGHTLY_HIGHLIGHTS) {
        const overflow = sorted.slice(MAX_NIGHTLY_HIGHLIGHTS - 1).flatMap(([, items]) => items);
        kept = [...sorted.slice(0, MAX_NIGHTLY_HIGHLIGHTS - 1), ['other-activity', overflow]];
      }

      const titles = kept.map(([kind, items]) => {
        const n = items.length;
        const label = kind === 'other-activity' ? 'other activity' : OmniStore.kindLabel(kind);
        return `${n} ${label} ${n === 1 ? 'item' : 'items'} on ${dayKey}`;
      });
      const finalTitles = opts.enhance ? await enhanceHighlightTitles(titles) : titles;

      kept.forEach(([kind, items], idx) => {
        const n = items.length;
        const facts = heuristicDistill(items.map((i) => `${i.title}. ${i.detail ?? ''}`).join('\n'))
          .slice(0, 3)
          .map((f) => f.fact);
        const detailParts = [...facts, `${n} ${n === 1 ? 'item' : 'items'} compressed from ${dayKey}`];
        this.upsertItem({
          layer: 'period',
          title: finalTitles[idx],
          detail: detailParts.join(' · ').slice(0, 2000),
          ts: dayStart - 1,
          kind: `rollup:${kind}`,
          source: 'rollup',
          sourceKey: `rollup:nightly:${dayKey}:${kind}`,
        });
        produced++;
      });

      const del = this.db.prepare('DELETE FROM omni_items WHERE id = ?');
      for (const item of rows) del.run(item.id);
    }

    // Demote stale attention items to recent (they're history now, not action).
    for (const item of staleAttention) {
      this.upsertItem({
        layer: 'recent',
        title: item.title,
        detail: item.detail,
        ts: item.ts,
        kind: item.kind,
        source: item.source,
        sourceKey: item.sourceKey,
      });
    }

    return { rolledUp: rows.length, produced };
  }

  /**
   * Weekly rollup: Period items from previous weeks are dropped, except
   * major events which are promoted to Milestones. Pinned items are never
   * touched.
   */
  rollupWeekly(now: number = Date.now()): RollupStats {
    const weekStart = startOfWeekUtc(now);
    const rows = this.listItems('period').filter((i) => !i.pinned && (i.ts ?? i.createdAt) < weekStart);
    let promoted = 0;
    for (const item of rows) {
      if (isMajorKind(item.kind)) {
        this.upsertItem({
          layer: 'milestones',
          title: item.title,
          detail: item.detail,
          ts: item.ts,
          kind: item.kind,
          source: item.source,
          sourceKey: `weekly:${item.sourceKey}`,
        });
        promoted++;
      }
    }
    const del = this.db.prepare('DELETE FROM omni_items WHERE id = ?');
    for (const item of rows) del.run(item.id);
    this.capLayer('milestones');
    this.pruneVersions();
    return { rolledUp: rows.length, produced: promoted };
  }
}

// ===========================================================================
// Collector: feeds the store from activity sources, incrementally.
// ===========================================================================

export interface OmniApprovalLike {
  id: string;
  toolName: string;
  botId: string;
  ts: number;
  actor?: string;
}

export interface OmniAuditLike {
  id: number;
  ts: number;
  actor: string;
  action: string;
  toolName?: string;
  decision?: string;
}

export interface OmniRunLike {
  id: string;
  workflowId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface OmniCollectorSources {
  listApprovals(status: 'pending'): OmniApprovalLike[];
  listAudit(limit: number, offset: number): OmniAuditLike[];
  listRuns(): OmniRunLike[];
}

export interface CollectStats {
  approvals: number;
  audit: number;
  runs: number;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'paused']);
const AUDIT_PAGE_LIMIT = 100;
const AUDIT_MAX_PAGES = 10;

export class OmniCollector {
  constructor(
    private readonly store: OmniStore,
    private readonly sources: OmniCollectorSources,
  ) {}

  /**
   * One incremental pass. Idempotent (upserts by sourceKey); cheap enough
   * to run hourly. Never throws into the scheduler — failures are logged
   * by the caller.
   */
  async collect(): Promise<CollectStats> {
    const approvals = this.collectApprovals();
    const runs = this.collectRuns();
    const audit = this.collectAudit();
    return { approvals, audit, runs };
  }

  private collectApprovals(): number {
    let count = 0;
    const seen = new Set<string>();
    for (const a of this.sources.listApprovals('pending')) {
      const key = `approval:${a.id}`;
      seen.add(key);
      this.store.upsertItem({
        layer: 'attention',
        title: `Approval needed: ${a.toolName}`,
        detail: `Bot ${a.botId} requested ${a.toolName}${a.actor ? ` (actor: ${a.actor})` : ''} — decide in the approvals inbox.`,
        ts: a.ts,
        kind: 'approval-pending',
        source: 'approval',
        sourceKey: key,
      });
      count++;
    }
    // Approvals that are no longer pending lose their attention slot.
    for (const item of this.store.listItems('attention')) {
      if (item.kind === 'approval-pending' && !item.pinned && !seen.has(item.sourceKey)) {
        this.store.deleteItem(item.id);
      }
    }
    return count;
  }

  private collectRuns(): number {
    let count = 0;
    const activeKeys = new Set<string>();
    for (const r of this.sources.listRuns()) {
      if (ACTIVE_RUN_STATUSES.has(r.status)) {
        const key = `run:${r.id}:active`;
        activeKeys.add(key);
        this.store.upsertItem({
          layer: 'attention',
          title: `Workflow ${r.status}: ${r.workflowId}`,
          detail: `Run ${r.id} is ${r.status} (updated ${new Date(r.updatedAt).toISOString()}).`,
          ts: r.updatedAt,
          kind: r.status === 'running' ? 'workflow-running' : 'workflow-paused',
          source: 'workflow',
          sourceKey: key,
        });
        count++;
      } else {
        // Terminal run seen for the first time → record once, drop the
        // active attention slot. Failed runs are milestones; successes land
        // in recent (they compress into the period highlights overnight).
        const terminalKey = `run:${r.id}:terminal`;
        if (!this.store.hasSourceKey(terminalKey)) {
          const failed = r.status === 'failed';
          this.store.upsertItem({
            layer: failed ? 'milestones' : 'recent',
            title: `Workflow ${r.status}: ${r.workflowId}`,
            detail: `Run ${r.id} finished ${r.status}.`,
            ts: r.updatedAt,
            kind: failed ? 'workflow-failed' : 'workflow-completed',
            source: 'workflow',
            sourceKey: terminalKey,
          });
        }
        this.store.deleteBySourceKey(`run:${r.id}:active`);
      }
    }
    // Runs that vanished (store reset etc.) lose their attention slot.
    for (const item of this.store.listItems('attention')) {
      if ((item.kind === 'workflow-running' || item.kind === 'workflow-paused') && !item.pinned && !activeKeys.has(item.sourceKey)) {
        this.store.deleteItem(item.id);
      }
    }
    return count;
  }

  private collectAudit(): number {
    const lastId = Number(this.store.getKv('collector.audit.lastId') ?? '0') || 0;
    let maxId = lastId;
    let count = 0;
    for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
      const entries = this.sources.listAudit(AUDIT_PAGE_LIMIT, page * AUDIT_PAGE_LIMIT);
      if (entries.length === 0) break;
      let pageHadNew = false;
      // listAudit is newest-first; walk oldest-first so watermarks advance.
      for (const e of [...entries].reverse()) {
        if (e.id <= lastId) continue;
        pageHadNew = true;
        if (e.id > maxId) maxId = e.id;
        const layer = classifyAuditAction(e.action);
        if (!layer) continue;
        const title =
          e.action.startsWith('tool.') && e.toolName
            ? `${auditActionLabel(e.action)}: ${e.toolName}`
            : auditActionLabel(e.action);
        const detailParts = [`actor: ${e.actor}`];
        if (e.toolName && !e.action.startsWith('tool.')) detailParts.push(`tool: ${e.toolName}`);
        if (e.decision) detailParts.push(`decision: ${e.decision}`);
        this.store.upsertItem({
          layer,
          title: title.slice(0, 500),
          detail: detailParts.join(' · '),
          ts: e.ts,
          kind: e.action,
          source: 'audit',
          sourceKey: `audit:${e.id}`,
        });
        count++;
      }
      if (!pageHadNew) break;
    }
    if (maxId > lastId) this.store.setKv('collector.audit.lastId', String(maxId));
    return count;
  }
}

// ===========================================================================
// Scheduler: hourly tick — refresh collector, run rollups on day/week
// boundaries. Deterministic tick(now) for tests; start() for production.
// ===========================================================================

export interface OmniSchedulerOptions {
  collector?: OmniCollector;
  /** Tick interval in ms (default 1h). */
  intervalMs?: number;
  /** Pass OMNI_OLLAMA_ENHANCE=1 to allow the nightly Ollama rewrite. */
  ollamaEnhance?: boolean;
}

export class OmniScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: OmniStore,
    private readonly opts: OmniSchedulerOptions = {},
  ) {}

  start(intervalMs: number = this.opts.intervalMs ?? 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Fire once shortly after boot so downtime rollups catch up.
    setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: number = Date.now()): Promise<void> {
    if (this.opts.collector) {
      try {
        await this.opts.collector.collect();
      } catch (err) {
        console.error('[omni] collect failed:', err instanceof Error ? err.message : err);
      }
    }
    const dayKey = utcDayKey(now);
    if (this.store.getKv('rollup.lastNightly') !== dayKey) {
      try {
        await this.store.rollupNightly(now, { enhance: this.opts.ollamaEnhance ?? false });
        this.store.setKv('rollup.lastNightly', dayKey);
      } catch (err) {
        console.error('[omni] nightly rollup failed:', err instanceof Error ? err.message : err);
      }
    }
    if (new Date(now).getUTCDay() === 1) {
      const weekKey = utcWeekKey(now);
      if (this.store.getKv('rollup.lastWeekly') !== weekKey) {
        try {
          this.store.rollupWeekly(now);
          this.store.setKv('rollup.lastWeekly', weekKey);
        } catch (err) {
          console.error('[omni] weekly rollup failed:', err instanceof Error ? err.message : err);
        }
      }
    }
  }
}
