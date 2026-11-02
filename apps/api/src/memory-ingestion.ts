// SPDX-License-Identifier: Apache-2.0
// OH-4: opt-in account ingestion into bot memory.
//
// A bot's owner can opt specific sources IN (default: everything OFF).
// Enabled sources are periodically (and on demand) read, summarized
// EXTRACTIVELY (deterministic, no model call), and stored as memory
// atoms (category 'summary') in the bot's TieredMemoryStore:
//
//   files — new/changed text files in the bot's own workspace
//           (content-hash dedupe; sourceTurn `ingest:files:<relpath>`)
//   rss   — items from the owner's configured feed URLs
//           (sourceTurn `ingest:rss:<feedUrl>`)
//   gmail — recent messages via the first-party Google Workspace
//           client, ONLY when it is configured + connected
//           (sourceTurn `ingest:gmail:<messageId>`)
//   drive — recent file metadata via the same client (Drive reads are
//           metadata-only in this codebase — atoms summarize metadata,
//           never contents; sourceTurn `ingest:drive:<fileId>`)
//
// Settings persist per bot in <dataDir>/memory-ingestion.json (the
// bot-models.ts read/write pattern); run state (seen content hashes,
// last run) persists in <dataDir>/memory-ingestion-state.json. The same
// normalized content hash is never ingested twice for a bot.
//
// Guards (checked before every run, in order): system pause → Privacy
// Mode → bot local-only. NOTE on Privacy Mode: apps/api has no global
// "Privacy Mode" flag today (privacy exists as per-atom/per-secret
// tiers); the guard therefore reads an injected predicate, defaulting
// to the explicit <dataDir>/privacy-mode.json file ({ "enabled": true })
// when present — absent file means OFF, exactly like every other opt-in
// here. The scheduler (startMemoryIngestionScheduler) ticks every
// 30 min, runs enabled bots only, and wraps every run in try/catch so
// ingestion can never crash boot or a turn.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, TieredMemoryStore } from '@mvp/agent-runtime';
import {
  createFetchGoogleWorkspaceClient,
  googleWorkspaceConfigStatus,
  type GoogleWorkspaceClient,
} from './google-workspace.js';
import { getOAuthStatus, getValidToken } from './oauth.js';

export const INGESTION_SOURCES = ['files', 'gmail', 'drive', 'rss'] as const;
export type IngestionSourceId = (typeof INGESTION_SOURCES)[number];

export interface MemoryIngestionSettings {
  sources: Partial<Record<IngestionSourceId, boolean>>;
  rssFeeds?: string[];
  updatedAt: string;
}

export interface MemoryIngestionState {
  seenHashes: string[];
  lastRunAt: string | null;
  lastAdded: number;
  totalAdded: number;
  perSourceLast: Partial<Record<IngestionSourceId, { added: number; skipped: number }>>;
}

const SETTINGS_FILE = 'memory-ingestion.json';
const STATE_FILE = 'memory-ingestion-state.json';

// ---------------------------------------------------------------------------
// Settings + state persistence (bot-models.ts pattern: tmp + rename)
// ---------------------------------------------------------------------------

type SettingsFile = Record<string, MemoryIngestionSettings>;
type StateFile = Record<string, MemoryIngestionState>;

function readJsonFile<T>(dataDir: string, name: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(dataDir: string, name: string, value: unknown): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function sanitizeIngestionSettings(input: unknown, now = new Date()): MemoryIngestionSettings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as {
    sources?: unknown;
    rssFeeds?: unknown;
  };
  const rawSources = (typeof o.sources === 'object' && o.sources !== null ? o.sources : {}) as Record<string, unknown>;
  const sources: Partial<Record<IngestionSourceId, boolean>> = {};
  for (const id of INGESTION_SOURCES) {
    if (typeof rawSources[id] === 'boolean') sources[id] = rawSources[id] as boolean;
  }
  const rssFeeds = Array.isArray(o.rssFeeds)
    ? [...new Set(o.rssFeeds.filter((f): f is string => typeof f === 'string' && /^https?:\/\//i.test(f.trim())).map((f) => f.trim()))].slice(0, 50)
    : undefined;
  return { sources, ...(rssFeeds ? { rssFeeds } : {}), updatedAt: now.toISOString() };
}

export function getIngestionSettings(dataDir: string, botId: string): MemoryIngestionSettings {
  const file = readJsonFile<SettingsFile>(dataDir, SETTINGS_FILE, {});
  return file[botId] ?? { sources: {}, updatedAt: new Date(0).toISOString() };
}

export function saveIngestionSettings(
  dataDir: string,
  botId: string,
  input: unknown,
  now = new Date(),
): MemoryIngestionSettings {
  const settings = sanitizeIngestionSettings(input, now);
  const file = readJsonFile<SettingsFile>(dataDir, SETTINGS_FILE, {});
  file[botId] = settings;
  writeJsonFile(dataDir, SETTINGS_FILE, file);
  return settings;
}

export function listIngestionSettings(dataDir: string): SettingsFile {
  return readJsonFile<SettingsFile>(dataDir, SETTINGS_FILE, {});
}

const EMPTY_STATE: MemoryIngestionState = {
  seenHashes: [],
  lastRunAt: null,
  lastAdded: 0,
  totalAdded: 0,
  perSourceLast: {},
};

export function getIngestionState(dataDir: string, botId: string): MemoryIngestionState {
  const file = readJsonFile<StateFile>(dataDir, STATE_FILE, {});
  const s = file[botId];
  if (!s) return { ...EMPTY_STATE, seenHashes: [], perSourceLast: {} };
  return {
    seenHashes: Array.isArray(s.seenHashes) ? s.seenHashes : [],
    lastRunAt: s.lastRunAt ?? null,
    lastAdded: s.lastAdded ?? 0,
    totalAdded: s.totalAdded ?? 0,
    perSourceLast: s.perSourceLast ?? {},
  };
}

function saveIngestionState(dataDir: string, botId: string, state: MemoryIngestionState): void {
  const file = readJsonFile<StateFile>(dataDir, STATE_FILE, {});
  file[botId] = state;
  writeJsonFile(dataDir, STATE_FILE, file);
}

// ---------------------------------------------------------------------------
// Extractive summarization + content hashing (deterministic, no model)
// ---------------------------------------------------------------------------

export function contentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

/** Collapse whitespace and cap — the whole "summarizer" on the no-model path. */
export function extractiveExcerpt(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// RSS/Atom parsing (tiny built-in parser — no new dependencies)
// ---------------------------------------------------------------------------

export interface RssItem {
  title: string;
  link: string;
  date?: string;
  summary: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  // Unwrap CDATA first — otherwise the tag stripper eats into the wrapper.
  const unwrapped = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(unwrapped.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? stripTags(m[1]!) : '';
}

export function parseFeedItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks.slice(0, 50)) {
    const title = tagText(block, 'title');
    let link = tagText(block, 'link');
    if (!link) {
      // Atom: <link href="..."/>
      const href = /<link[^>]*\bhref="([^"]+)"/i.exec(block);
      if (href) link = decodeEntities(href[1]!);
    }
    const date = tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || undefined;
    const summary = tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content');
    if (!title && !link) continue;
    items.push({ title: title || link, link, ...(date ? { date } : {}), summary });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface IngestionGoogleDeps {
  client: GoogleWorkspaceClient;
  getAccessToken: (dataDir: string) => Promise<string>;
}

export interface MemoryIngestionDeps {
  dataDir: string;
  tieredMemoryStore: Pick<TieredMemoryStore, 'storeAtom'>;
  getBot: (botId: string) => BotConfig | undefined;
  workspaceDirForBot: (bot: BotConfig) => string;
  isPaused?: () => boolean;
  isPrivacyMode?: (botId: string) => boolean;
  isLocalOnly?: (botId: string) => boolean;
  /** Injectable fetch (tests stub feeds; production uses global fetch). */
  fetchFn?: typeof fetch;
  /** Injectable Google client/token (tests); production resolves OAuth. */
  google?: IngestionGoogleDeps;
  now?: () => Date;
}

export interface SourceAvailability {
  id: IngestionSourceId;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  lastRunAt: string | null;
  lastAdded: number;
}

export interface IngestionRunResult {
  botId: string;
  added: number;
  skipped: number;
  perSource: Partial<Record<IngestionSourceId, { added: number; skipped: number; reason?: string }>>;
  /** Set when a guard blocked the whole run (pause / privacy / local-only). */
  blocked?: string;
}

/** Default Privacy Mode check: the explicit <dataDir>/privacy-mode.json seam (see header). */
export function defaultPrivacyMode(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'privacy-mode.json'), 'utf8')) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

/** Whether the first-party Google Workspace path can list+read right now. */
export function googleWorkspaceIngestionAvailable(
  dataDir: string,
  injected?: IngestionGoogleDeps,
): { available: boolean; reason?: string } {
  if (injected) return { available: true };
  const cfg = googleWorkspaceConfigStatus(dataDir);
  if (!cfg.credentialsConfigured) return { available: false, reason: 'google workspace not configured' };
  try {
    const status = getOAuthStatus(dataDir).find((s) => s.id === 'google');
    if (!status?.connected) return { available: false, reason: 'google workspace not configured' };
  } catch {
    return { available: false, reason: 'google workspace not configured' };
  }
  return { available: true };
}

export function ingestionSourceStatuses(
  deps: MemoryIngestionDeps,
  botId: string,
): SourceAvailability[] {
  const settings = getIngestionSettings(deps.dataDir, botId);
  const state = getIngestionState(deps.dataDir, botId);
  const google = googleWorkspaceIngestionAvailable(deps.dataDir, deps.google);
  return INGESTION_SOURCES.map((id) => {
    const base: SourceAvailability = {
      id,
      enabled: settings.sources[id] === true,
      available: true,
      lastRunAt: state.lastRunAt,
      lastAdded: state.perSourceLast[id]?.added ?? 0,
    };
    if ((id === 'gmail' || id === 'drive') && !google.available) {
      return { ...base, available: false, unavailableReason: google.reason };
    }
    if (id === 'rss' && (settings.rssFeeds ?? []).length === 0) {
      return { ...base, available: false, unavailableReason: 'no RSS feeds configured' };
    }
    return base;
  });
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.csv',
  '.html', '.xml', '.yml', '.yaml', '.toml', '.rst', '.log',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.worktrees']);
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 500;

function walkTextFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

export class MemoryIngestionEngine {
  constructor(private readonly deps: MemoryIngestionDeps) {}

  private guardBlock(botId: string): string | undefined {
    try {
      if (this.deps.isPaused?.()) return 'system paused';
    } catch { /* a broken gate must not crash ingestion */ }
    try {
      const privacy = this.deps.isPrivacyMode
        ? this.deps.isPrivacyMode(botId)
        : defaultPrivacyMode(this.deps.dataDir);
      if (privacy) return 'privacy mode enabled';
    } catch { /* see above */ }
    try {
      if (this.deps.isLocalOnly?.(botId)) return 'bot is local-only';
    } catch { /* see above */ }
    return undefined;
  }

  /** Run ingestion for one bot. `source` limits the run to one source. */
  async run(botId: string, source?: IngestionSourceId): Promise<IngestionRunResult> {
    const bot = this.deps.getBot(botId);
    if (!bot) throw new Error(`Unknown bot "${botId}"`);
    const blocked = this.guardBlock(botId);
    const settings = getIngestionSettings(this.deps.dataDir, botId);
    if (blocked) {
      return { botId, added: 0, skipped: 0, perSource: {}, blocked };
    }
    const state = getIngestionState(this.deps.dataDir, botId);
    const seen = new Set(state.seenHashes);
    const perSource: IngestionRunResult['perSource'] = {};
    let added = 0;
    let skipped = 0;

    const wanted = (id: IngestionSourceId): boolean =>
      settings.sources[id] === true && (source === undefined || source === id);

    const storeOnce = (
      hashBasis: string,
      fact: string,
      sourceTurn: string,
    ): boolean => {
      const hash = contentHash(hashBasis);
      if (seen.has(hash)) return false;
      this.deps.tieredMemoryStore.storeAtom(
        botId,
        { fact, entities: [], confidence: 0.7 },
        sourceTurn,
        undefined,
        { category: 'summary' },
      );
      seen.add(hash);
      return true;
    };

    // -- files ---------------------------------------------------------------
    if (wanted('files')) {
      const counts: { added: number; skipped: number; reason?: string } = { added: 0, skipped: 0 };
      try {
        const root = this.deps.workspaceDirForBot(bot);
        for (const file of walkTextFiles(root)) {
          const rel = path.relative(root, file).split(path.sep).join('/');
          let content: string;
          try {
            const stat = fs.statSync(file);
            if (stat.size > MAX_FILE_BYTES) { counts.skipped += 1; continue; }
            content = fs.readFileSync(file, 'utf8');
          } catch {
            counts.skipped += 1;
            continue;
          }
          const excerptBudget = Math.max(40, 480 - rel.length);
          const fact = `${rel}: ${extractiveExcerpt(content, excerptBudget)}`;
          if (storeOnce(content, fact, `ingest:files:${rel}`)) counts.added += 1;
          else counts.skipped += 1;
        }
      } catch (err) {
        counts.reason = err instanceof Error ? err.message : String(err);
      }
      perSource.files = counts;
      added += counts.added;
      skipped += counts.skipped;
    }

    // -- rss -----------------------------------------------------------------
    if (wanted('rss')) {
      const counts = { added: 0, skipped: 0 };
      const fetchFn = this.deps.fetchFn ?? fetch;
      for (const feedUrl of settings.rssFeeds ?? []) {
        try {
          const res = await fetchFn(feedUrl);
          if (!res.ok) { counts.skipped += 1; continue; }
          const xml = await res.text();
          for (const item of parseFeedItems(xml)) {
            const fact = extractiveExcerpt(
              `${item.title}${item.summary ? ` — ${item.summary}` : ''}${item.link ? ` (${item.link})` : ''}`,
              480,
            );
            if (storeOnce(`${item.link}|${item.title}|${item.summary}`, fact, `ingest:rss:${feedUrl}`)) counts.added += 1;
            else counts.skipped += 1;
          }
        } catch {
          counts.skipped += 1;
        }
      }
      perSource.rss = counts;
      added += counts.added;
      skipped += counts.skipped;
    }

    // -- gmail / drive ---------------------------------------------------------
    for (const id of ['gmail', 'drive'] as const) {
      if (!wanted(id)) continue;
      const availability = googleWorkspaceIngestionAvailable(this.deps.dataDir, this.deps.google);
      if (!availability.available) {
        perSource[id] = { added: 0, skipped: 0, reason: availability.reason };
        continue;
      }
      const counts = { added: 0, skipped: 0 };
      try {
        const google = this.deps.google ?? {
          client: createFetchGoogleWorkspaceClient(),
          getAccessToken: (d: string) => getValidToken('google', d),
        };
        const token = await google.getAccessToken(this.deps.dataDir);
        if (id === 'gmail') {
          const summaries = await google.client.listMessages(token, '', 10);
          for (const s of summaries) {
            let body = s.snippet ?? '';
            try {
              const full = await google.client.getMessage(token, s.id);
              body = full.bodyText ?? body;
            } catch { /* snippet is enough */ }
            const fact = extractiveExcerpt(
              `Email from ${s.from ?? 'unknown'}: ${s.subject ?? '(no subject)'} — ${body}`,
              480,
            );
            if (storeOnce(`gmail:${s.id}:${s.subject ?? ''}:${body}`, fact, `ingest:gmail:${s.id}`)) counts.added += 1;
            else counts.skipped += 1;
          }
        } else {
          const files = await google.client.listFiles(token, '', 20);
          for (const f of files) {
            const fact = extractiveExcerpt(
              `Drive file: ${f.name ?? f.id} (${f.mimeType ?? 'unknown type'}${f.modifiedTime ? `, modified ${f.modifiedTime}` : ''})`,
              480,
            );
            if (storeOnce(`drive:${f.id}:${f.modifiedTime ?? ''}`, fact, `ingest:drive:${f.id}`)) counts.added += 1;
            else counts.skipped += 1;
          }
        }
      } catch (err) {
        perSource[id] = { ...counts, reason: err instanceof Error ? err.message : String(err) };
        added += counts.added;
        skipped += counts.skipped;
        continue;
      }
      perSource[id] = counts;
      added += counts.added;
      skipped += counts.skipped;
    }

    const now = (this.deps.now ? this.deps.now() : new Date()).toISOString();
    saveIngestionState(this.deps.dataDir, botId, {
      seenHashes: [...seen].slice(-10_000),
      lastRunAt: now,
      lastAdded: added,
      totalAdded: state.totalAdded + added,
      perSourceLast: { ...state.perSourceLast, ...perSource },
    });
    return { botId, added, skipped, perSource };
  }
}

// ---------------------------------------------------------------------------
// Scheduler: every 30 min, enabled bots only, never throws.
// ---------------------------------------------------------------------------

export interface MemoryIngestionScheduler {
  stop: () => void;
  runOnce: () => Promise<void>;
}

export function startMemoryIngestionScheduler(
  deps: MemoryIngestionDeps & { getBotIds: () => string[] },
  opts: { intervalMs?: number } = {},
): MemoryIngestionScheduler {
  const engine = new MemoryIngestionEngine(deps);
  const intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
  const runOnce = async (): Promise<void> => {
    for (const botId of deps.getBotIds()) {
      try {
        const settings = getIngestionSettings(deps.dataDir, botId);
        if (!Object.values(settings.sources).some(Boolean)) continue; // OFF by default
        await engine.run(botId);
      } catch {
        // Ingestion must never crash boot/turns.
      }
    }
  };
  const timer = setInterval(() => {
    void runOnce().catch(() => undefined);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
