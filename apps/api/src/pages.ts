// SPDX-License-Identifier: Apache-2.0
// Collaborative Pages — ChatGPT "Space" Pages parity (foundation).
//
// Single-user notes/artifacts exist elsewhere; Pages are the collaborative
// surface: humans and agents co-edit one live markdown document, with
// presence-friendly live updates (SSE), inline comments, @mentions, and
// version history.
//
// - PageStore: pages + version snapshots (SQLite `pages.db`).
// - PageCommentStore: inline comments with resolve workflow.
// - PageMentionStore: @mentions; mentioning a bot triggers an agent turn
//   whose reply is appended to the page (fire-and-forget, status tracked).
//
// Routes (router mounted at /api/pages):
//   GET    /                              → Page[]
//   POST   /                              → { title, content?, createdBy? } → Page (201)
//   GET    /:id                            → Page
//   PUT    /:id                            → { title?, content? } → Page (saves a version)
//   DELETE /:id                            → { ok: true }
//   GET    /:id/versions                   → PageVersion[]
//   GET    /:id/versions/:versionId        → PageVersion
//   POST   /:id/restore/:versionId         → Page (restores snapshot, saves current as a version)
//   GET    /:id/comments                   → PageComment[]
//   POST   /:id/comments                   → { author, text } → PageComment (201)
//   PATCH  /:id/comments/:commentId        → { resolved } → PageComment
//   DELETE /:id/comments/:commentId        → { ok: true }
//   GET    /:id/mentions                   → PageMention[]
//   POST   /:id/mentions                   → { mentioned, context? } → PageMention (201; bot mentions trigger an agent turn)
//   GET    /:id/stream                     → SSE: page | comment | mention | deleted events

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import type { StreamEvent } from '@mvp/agent-runtime';

import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { compileJsxToHtml, JsxCompileError } from './jsx-compile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a page's stored content must be rendered: markdown source, or HTML (authored directly or compiled from JSX). */
export type PageFormat = 'markdown' | 'html';

/** Formats accepted at write time; 'jsx' compiles to stored 'html'. */
export type PageWriteFormat = PageFormat | 'jsx';

export interface Page {
  id: string;
  title: string;
  /** Markdown source, or HTML when `format` is 'html'. */
  content: string;
  format: PageFormat;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic per-page version number (1 = created). */
  version: number;
  /**
   * Representative assistant: true only when the owner explicitly marked
   * this page shared-with-team. Default false — pages are NOT shared
   * unless this flag is set, and only flagged pages may be cited as
   * 'shared-notes' facts about the page's creator.
   */
  sharedWithTeam?: boolean;
}

export interface PageVersion {
  id: string;
  pageId: string;
  version: number;
  title: string;
  content: string;
  createdAt: number;
  createdBy: string;
}

export interface PageComment {
  id: string;
  pageId: string;
  author: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}

export type PageMentionStatus = 'pending' | 'done' | 'failed';

export interface PageMention {
  id: string;
  pageId: string;
  /** Who was mentioned: a bot name/id or a human display name. */
  mentioned: string;
  /** True when the mention resolved to a bot (agent turn triggered). */
  isBot: boolean;
  context: string;
  author: string;
  status: PageMentionStatus;
  createdAt: number;
}

interface PageRow {
  id: string;
  title: string;
  content: string;
  format?: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  version: number;
  shared_with_team?: number | null;
}

interface PageVersionRow {
  id: string;
  page_id: string;
  version: number;
  title: string;
  content: string;
  created_at: number;
  created_by: string;
}

interface PageCommentRow {
  id: string;
  page_id: string;
  author: string;
  text: string;
  created_at: number;
  resolved: number;
}

interface PageMentionRow {
  id: string;
  page_id: string;
  mentioned: string;
  is_bot: number;
  context: string;
  author: string;
  status: string;
  created_at: number;
}

function rowToPage(r: PageRow): Page {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    format: r.format === 'html' ? 'html' : 'markdown',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
    sharedWithTeam: r.shared_with_team === 1,
  };
}

function rowToVersion(r: PageVersionRow): PageVersion {
  return {
    id: r.id,
    pageId: r.page_id,
    version: r.version,
    title: r.title,
    content: r.content,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function rowToComment(r: PageCommentRow): PageComment {
  return {
    id: r.id,
    pageId: r.page_id,
    author: r.author,
    text: r.text,
    createdAt: r.created_at,
    resolved: r.resolved === 1,
  };
}

function rowToMention(r: PageMentionRow): PageMention {
  return {
    id: r.id,
    pageId: r.page_id,
    mentioned: r.mentioned,
    isBot: r.is_bot === 1,
    context: r.context,
    author: r.author,
    status: r.status as PageMentionStatus,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Stores (SQLite, one shared pages.db)
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'markdown',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS page_versions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    UNIQUE(page_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, version DESC);
  CREATE TABLE IF NOT EXISTS page_comments (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_page_comments_page ON page_comments(page_id, created_at ASC);
  CREATE TABLE IF NOT EXISTS page_mentions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    mentioned TEXT NOT NULL,
    is_bot INTEGER NOT NULL DEFAULT 0,
    context TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_page_mentions_page ON page_mentions(page_id, created_at DESC);
`;

function openDb(dataDir: string): DatabaseSync {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db = openSqliteDb(join(dataDir, 'pages.db'));
  db.exec(SCHEMA);
  // Migration: format column for pre-existing pages.db files.
  try {
    db.exec("ALTER TABLE pages ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'");
  } catch {
    // Column already exists.
  }
  // Migration: shared-with-team flag for pre-existing pages.db files.
  try {
    db.exec('ALTER TABLE pages ADD COLUMN shared_with_team INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists.
  }
  return db;
}

/**
 * Normalize a write-time format + content: JSX compiles to stored HTML
 * (render paths sanitize it — the sanitizer stays the single enforcement
 * path). Throws a validation error for unknown formats / bad JSX.
 */
function normalizeWriteContent(
  content: string,
  format: PageWriteFormat | undefined,
): { content: string; format: PageFormat } {
  if (format === undefined || format === 'markdown') return { content, format: 'markdown' };
  if (format === 'html') return { content, format: 'html' };
  if (format === 'jsx') {
    try {
      return { content: compileJsxToHtml(content), format: 'html' };
    } catch (err) {
      if (err instanceof JsxCompileError) throw validationError(`JSX compile failed: ${err.message}`);
      throw err;
    }
  }
  throw validationError('"format" must be one of "markdown" | "html" | "jsx"');
}

/** Pages + version snapshots. */
export class PageStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  list(): Page[] {
    const rows = this.db
      .prepare('SELECT * FROM pages ORDER BY updated_at DESC')
      .all() as unknown as PageRow[];
    return rows.map(rowToPage);
  }

  get(id: string): Page | undefined {
    const row = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as unknown as
      | PageRow
      | undefined;
    return row ? rowToPage(row) : undefined;
  }

  /** Pages explicitly marked shared-with-team, optionally for one creator. */
  listSharedWithTeam(createdBy?: string): Page[] {
    return this.list().filter(
      (pg) => pg.sharedWithTeam === true && (createdBy === undefined || pg.createdBy === createdBy),
    );
  }

  /** Set/clear the shared-with-team flag (no content change, no version bump). */
  setSharedWithTeam(id: string, shared: boolean): Page {
    const current = this.get(id);
    if (!current) throw pageNotFound(id);
    this.db.prepare('UPDATE pages SET shared_with_team = ? WHERE id = ?').run(shared ? 1 : 0, id);
    return this.get(id)!;
  }

  create(input: { title: string; content?: string; createdBy?: string; format?: PageWriteFormat; sharedWithTeam?: boolean }): Page {
    const title = requireTitle(input.title);
    const normalized = normalizeWriteContent(requireContent(input.content ?? ''), input.format);
    const now = Date.now();
    const page: Page = {
      id: randomUUID(),
      title,
      content: normalized.content,
      format: normalized.format,
      createdBy: (input.createdBy ?? '').slice(0, 100),
      createdAt: now,
      updatedAt: now,
      version: 1,
      sharedWithTeam: input.sharedWithTeam === true,
    };
    this.db
      .prepare(
        'INSERT INTO pages (id, title, content, format, created_by, created_at, updated_at, version, shared_with_team) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      )
      .run(page.id, page.title, page.content, page.format, page.createdBy, page.createdAt, page.updatedAt, page.sharedWithTeam ? 1 : 0);
    return page;
  }

  /**
   * Update title/content. The pre-update state is snapshotted into
   * page_versions first (no-op when nothing actually changed).
   */
  update(
    id: string,
    input: { title?: string; content?: string; updatedBy?: string; format?: PageWriteFormat; sharedWithTeam?: boolean },
  ): Page {
    const current = this.get(id);
    if (!current) throw pageNotFound(id);
    if (input.sharedWithTeam !== undefined && input.sharedWithTeam !== (current.sharedWithTeam === true)) {
      this.db.prepare('UPDATE pages SET shared_with_team = ? WHERE id = ?').run(input.sharedWithTeam ? 1 : 0, id);
      current.sharedWithTeam = input.sharedWithTeam;
    }
    const title = input.title === undefined ? current.title : requireTitle(input.title);
    const normalized =
      input.content === undefined
        ? { content: current.content, format: current.format }
        : normalizeWriteContent(requireContent(input.content), input.format ?? current.format);
    const { content, format } = normalized;
    if (title === current.title && content === current.content && format === current.format) return current;
    this.snapshot(current);
    const now = Date.now();
    // Monotonic updatedAt even within the same millisecond.
    const updatedAt = Math.max(now, current.updatedAt + 1);
    this.db
      .prepare('UPDATE pages SET title = ?, content = ?, format = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(title, content, format, updatedAt, id);
    const next = this.get(id);
    if (!next) throw pageNotFound(id);
    return next;
  }

  remove(id: string): void {
    const current = this.get(id);
    if (!current) throw pageNotFound(id);
    // Keep version history for audit even after the page is deleted.
    this.db.prepare('DELETE FROM page_comments WHERE page_id = ?').run(id);
    this.db.prepare('DELETE FROM page_mentions WHERE page_id = ?').run(id);
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  }

  listVersions(pageId: string): PageVersion[] {
    if (!this.get(pageId)) throw pageNotFound(pageId);
    const rows = this.db
      .prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY version DESC')
      .all(pageId) as unknown as PageVersionRow[];
    return rows.map(rowToVersion);
  }

  getVersion(pageId: string, versionId: string): PageVersion | undefined {
    const row = this.db
      .prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
      .get(pageId, versionId) as unknown as PageVersionRow | undefined;
    return row ? rowToVersion(row) : undefined;
  }

  /**
   * Restore a snapshot: the current state is snapshotted first, then the
   * page takes the snapshot's title/content with a bumped version.
   */
  restore(pageId: string, versionId: string, restoredBy?: string): Page {
    const current = this.get(pageId);
    if (!current) throw pageNotFound(pageId);
    const snap = this.getVersion(pageId, versionId);
    if (!snap) throw new Error(`unknown page version: ${versionId}`);
    this.snapshot(current);
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    this.db
      .prepare('UPDATE pages SET title = ?, content = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(snap.title, snap.content, updatedAt, pageId);
    void restoredBy;
    const next = this.get(pageId);
    if (!next) throw pageNotFound(pageId);
    return next;
  }

  /** Snapshot the given page state into page_versions (internal). */
  protected snapshot(page: Page): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO page_versions (id, page_id, version, title, content, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), page.id, page.version, page.title, page.content, Date.now(), page.createdBy);
  }
}

/** Inline comments with a resolve workflow. */
export class PageCommentStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  list(pageId: string): PageComment[] {
    const rows = this.db
      .prepare('SELECT * FROM page_comments WHERE page_id = ? ORDER BY created_at ASC')
      .all(pageId) as unknown as PageCommentRow[];
    return rows.map(rowToComment);
  }

  add(pageId: string, input: { author: string; text: string }): PageComment {
    const author = requireAuthor(input.author);
    const text = requireCommentText(input.text);
    const comment: PageComment = {
      id: randomUUID(),
      pageId,
      author,
      text,
      createdAt: Date.now(),
      resolved: false,
    };
    this.db
      .prepare(
        'INSERT INTO page_comments (id, page_id, author, text, created_at, resolved) VALUES (?, ?, ?, ?, ?, 0)',
      )
      .run(comment.id, comment.pageId, comment.author, comment.text, comment.createdAt);
    return comment;
  }

  setResolved(pageId: string, commentId: string, resolved: boolean): PageComment {
    const row = this.db
      .prepare('SELECT * FROM page_comments WHERE page_id = ? AND id = ?')
      .get(pageId, commentId) as unknown as PageCommentRow | undefined;
    if (!row) throw new Error(`unknown comment: ${commentId}`);
    this.db
      .prepare('UPDATE page_comments SET resolved = ? WHERE id = ?')
      .run(resolved ? 1 : 0, commentId);
    return { ...rowToComment(row), resolved };
  }

  remove(pageId: string, commentId: string): void {
    const r = this.db
      .prepare('DELETE FROM page_comments WHERE page_id = ? AND id = ?')
      .run(pageId, commentId);
    if (r.changes === 0) throw new Error(`unknown comment: ${commentId}`);
  }
}

/** @mentions; bot mentions trigger agent turns. */
export class PageMentionStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(dataDir);
  }

  list(pageId: string): PageMention[] {
    const rows = this.db
      .prepare('SELECT * FROM page_mentions WHERE page_id = ? ORDER BY created_at DESC')
      .all(pageId) as unknown as PageMentionRow[];
    return rows.map(rowToMention);
  }

  add(
    pageId: string,
    input: { mentioned: string; isBot: boolean; context?: string; author?: string },
  ): PageMention {
    const mentioned = requireMentioned(input.mentioned);
    const mention: PageMention = {
      id: randomUUID(),
      pageId,
      mentioned,
      isBot: input.isBot,
      context: (input.context ?? '').slice(0, 2000),
      author: (input.author ?? '').slice(0, 100),
      status: 'pending',
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO page_mentions (id, page_id, mentioned, is_bot, context, author, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        mention.id,
        mention.pageId,
        mention.mentioned,
        mention.isBot ? 1 : 0,
        mention.context,
        mention.author,
        mention.status,
        mention.createdAt,
      );
    return mention;
  }

  setStatus(pageId: string, mentionId: string, status: PageMentionStatus): void {
    this.db
      .prepare('UPDATE page_mentions SET status = ? WHERE page_id = ? AND id = ?')
      .run(status, pageId, mentionId);
  }

  removeForPage(pageId: string): void {
    this.db.prepare('DELETE FROM page_mentions WHERE page_id = ?').run(pageId);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface PagesDeps {
  dataDir: string;
  /** Optional pre-built stores (tests). */
  pageStore?: PageStore;
  commentStore?: PageCommentStore;
  mentionStore?: PageMentionStore;
  /** When set, @bot mentions trigger real agent turns. */
  agentRuntime?: AgentRuntime;
  getBots?: () => BotConfig[];
}

type PageEvent =
  | { kind: 'page'; page: Page }
  | { kind: 'comment'; comment: PageComment }
  | { kind: 'mention'; mention: PageMention }
  | { kind: 'deleted'; pageId: string };

export function registerPagesRoutes(router: Router, deps: PagesDeps): void {
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);
  const comments = deps.commentStore ?? new PageCommentStore(deps.dataDir);
  const mentions = deps.mentionStore ?? new PageMentionStore(deps.dataDir);

  // In-process pub/sub for live updates, scoped to this registration.
  const subscribers = new Map<string, Set<Response>>();

  const publish = (pageId: string, event: PageEvent): void => {
    const set = subscribers.get(pageId);
    if (!set || set.size === 0) return;
    const payload = `data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`;
    for (const res of [...set]) {
      try {
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
  };

  /** Fire-and-forget agent turn for a bot @mention; appends the reply. */
  const triggerBotMention = (pageId: string, bot: BotConfig, mention: PageMention, page: Page): void => {
    if (!deps.agentRuntime) {
      mentions.setStatus(pageId, mention.id, 'failed');
      return;
    }
    const sessionId = `page_${pageId}_${bot.id}`;
    const prompt = [
      `You were @mentioned on the collaborative page "${page.title}" (v${page.version}).`,
      `Mention context from ${mention.author || 'a collaborator'}: ${mention.context || '(none)'}`,
      `Current page content (markdown):`,
      '---',
      page.content || '(empty page)',
      '---',
      'Respond to the mention. If the mention asks you to edit or add to the page, describe exactly what you would change. Your reply will be appended to the page as your contribution.',
    ].join('\n');
    void (async () => {
      let text = '';
      try {
        await deps.agentRuntime!.runTurn({
          bot,
          message: prompt,
          sessionId,
          onEvent: async (e: StreamEvent) => {
            if (e.type === 'token') text += e.content;
          },
        });
      } catch (err) {
        mentions.setStatus(pageId, mention.id, 'failed');
        publish(pageId, {
          kind: 'mention',
          mention: { ...mention, status: 'failed' as PageMentionStatus },
        });
        void err;
        return;
      }
      const reply = text.trim();
      mentions.setStatus(pageId, mention.id, reply ? 'done' : 'failed');
      publish(pageId, {
        kind: 'mention',
        mention: { ...mention, status: (reply ? 'done' : 'failed') as PageMentionStatus },
      });
      if (!reply) return;
      try {
        const updated = pages.update(pageId, {
          content: `${page.content}${page.content.endsWith('\n') ? '' : '\n'}\n---\n\n**${bot.name}** (via @mention):\n\n${reply}\n`,
          updatedBy: bot.name,
        });
        publish(pageId, { kind: 'page', page: updated });
      } catch {
        // Page may have been deleted while the turn ran; the mention status
        // already records the outcome.
      }
    })();
  };

  // ---- Pages ---------------------------------------------------------------
  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json(pages.list());
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list pages') });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown; content?: unknown; createdBy?: unknown; format?: unknown; sharedWithTeam?: unknown };
      const page = pages.create({
        title: body.title as string,
        content: body.content as string | undefined,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
        format: typeof body.format === 'string' ? (body.format as PageWriteFormat) : undefined,
        sharedWithTeam: body.sharedWithTeam === true,
      });
      res.status(201).json(page);
    } catch (err) {
      res.status(isValidationError(err) ? 400 : 500).json({ error: errMessage(err, 'failed to create page') });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const page = pages.get(req.params.id);
    if (!page) {
      res.status(404).json({ error: `unknown page: ${req.params.id}` });
      return;
    }
    res.json({ ...page, comments: comments.list(page.id), mentions: mentions.list(page.id) });
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown; content?: unknown; updatedBy?: unknown; format?: unknown; sharedWithTeam?: unknown };
      const page = pages.update(req.params.id, {
        title: body.title as string | undefined,
        content: body.content as string | undefined,
        updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy : undefined,
        format: typeof body.format === 'string' ? (body.format as PageWriteFormat) : undefined,
        sharedWithTeam: typeof body.sharedWithTeam === 'boolean' ? body.sharedWithTeam : undefined,
      });
      publish(page.id, { kind: 'page', page });
      res.json(page);
    } catch (err) {
      const message = errMessage(err, 'failed to update page');
      res.status(isNotFoundError(err) ? 404 : isValidationError(err) ? 400 : 500).json({ error: message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      pages.remove(req.params.id);
      mentions.removeForPage(req.params.id);
      publish(req.params.id, { kind: 'deleted', pageId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      res.status(isNotFoundError(err) ? 404 : 500).json({ error: errMessage(err, 'failed to delete page') });
    }
  });

  // ---- Versions -------------------------------------------------------------
  router.get('/:id/versions', (req: Request, res: Response) => {
    try {
      res.json(pages.listVersions(req.params.id));
    } catch (err) {
      res.status(isNotFoundError(err) ? 404 : 500).json({ error: errMessage(err, 'failed to list versions') });
    }
  });

  router.get('/:id/versions/:versionId', (req: Request, res: Response) => {
    try {
      const snap = pages.getVersion(req.params.id, req.params.versionId);
      if (!snap) {
        res.status(404).json({ error: `unknown page version: ${req.params.versionId}` });
        return;
      }
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to get version') });
    }
  });

  router.post('/:id/restore/:versionId', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { restoredBy?: unknown };
      const page = pages.restore(
        req.params.id,
        req.params.versionId,
        typeof body.restoredBy === 'string' ? body.restoredBy : undefined,
      );
      publish(page.id, { kind: 'page', page });
      res.json(page);
    } catch (err) {
      const message = errMessage(err, 'failed to restore version');
      res.status(isNotFoundError(err) ? 404 : 400).json({ error: message });
    }
  });

  // ---- Comments --------------------------------------------------------------
  router.get('/:id/comments', (req: Request, res: Response) => {
    try {
      if (!pages.get(req.params.id)) {
        res.status(404).json({ error: `unknown page: ${req.params.id}` });
        return;
      }
      res.json(comments.list(req.params.id));
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list comments') });
    }
  });

  router.post('/:id/comments', (req: Request, res: Response) => {
    try {
      if (!pages.get(req.params.id)) {
        res.status(404).json({ error: `unknown page: ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as { author?: unknown; text?: unknown };
      const comment = comments.add(req.params.id, {
        author: body.author as string,
        text: body.text as string,
      });
      publish(req.params.id, { kind: 'comment', comment });
      res.status(201).json(comment);
    } catch (err) {
      res.status(isValidationError(err) ? 400 : 500).json({ error: errMessage(err, 'failed to add comment') });
    }
  });

  router.patch('/:id/comments/:commentId', (req: Request, res: Response) => {
    try {
      if (!pages.get(req.params.id)) {
        res.status(404).json({ error: `unknown page: ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as { resolved?: unknown };
      if (typeof body.resolved !== 'boolean') {
        res.status(400).json({ error: '"resolved" must be a boolean' });
        return;
      }
      const comment = comments.setResolved(req.params.id, req.params.commentId, body.resolved);
      publish(req.params.id, { kind: 'comment', comment });
      res.json(comment);
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'failed to update comment') });
    }
  });

  router.delete('/:id/comments/:commentId', (req: Request, res: Response) => {
    try {
      if (!pages.get(req.params.id)) {
        res.status(404).json({ error: `unknown page: ${req.params.id}` });
        return;
      }
      comments.remove(req.params.id, req.params.commentId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'failed to delete comment') });
    }
  });

  // ---- Mentions ---------------------------------------------------------------
  router.get('/:id/mentions', (req: Request, res: Response) => {
    try {
      if (!pages.get(req.params.id)) {
        res.status(404).json({ error: `unknown page: ${req.params.id}` });
        return;
      }
      res.json(mentions.list(req.params.id));
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list mentions') });
    }
  });

  router.post('/:id/mentions', (req: Request, res: Response) => {
    try {
      const page = pages.get(req.params.id);
      if (!page) {
        res.status(404).json({ error: `unknown page: ${req.params.id}` });
        return;
      }
      const body = (req.body ?? {}) as { mentioned?: unknown; context?: unknown; author?: unknown };
      const mentionedRaw = typeof body.mentioned === 'string' ? body.mentioned.trim() : '';
      if (!mentionedRaw) {
        res.status(400).json({ error: '"mentioned" is required' });
        return;
      }
      // Strip a leading @ if the client sent one.
      const mentioned = mentionedRaw.replace(/^@/, '');
      const bot = deps.getBots?.()?.find(
        (b) => b.id.toLowerCase() === mentioned.toLowerCase() || b.name.toLowerCase() === mentioned.toLowerCase(),
      );
      if (bot && !deps.agentRuntime) {
        res.status(503).json({ error: `bot "${mentioned}" is unavailable: agent runtime not wired` });
        return;
      }
      const mention = mentions.add(req.params.id, {
        mentioned,
        isBot: !!bot,
        context: typeof body.context === 'string' ? body.context : '',
        author: typeof body.author === 'string' ? body.author : '',
      });
      publish(req.params.id, { kind: 'mention', mention });
      res.status(201).json(mention);
      if (bot) triggerBotMention(req.params.id, bot, mention, page);
    } catch (err) {
      res.status(isValidationError(err) ? 400 : 500).json({ error: errMessage(err, 'failed to add mention') });
    }
  });

  // ---- Live updates (SSE) ------------------------------------------------------
  router.get('/:id/stream', (req: Request, res: Response) => {
    const pageId = req.params.id;
    if (!pages.get(pageId)) {
      res.status(404).json({ error: `unknown page: ${pageId}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    let set = subscribers.get(pageId);
    if (!set) {
      set = new Set();
      subscribers.set(pageId, set);
    }
    set.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // client gone; cleanup below handles removal
      }
    }, 15000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      const s = subscribers.get(pageId);
      if (s) {
        s.delete(res);
        if (s.size === 0) subscribers.delete(pageId);
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const CONTENT_MAX = 200_000;
const AUTHOR_MAX = 100;
const COMMENT_MAX = 5000;

function requireTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > TITLE_MAX) {
    throw validationError('page "title" must be a non-empty string (max 200 chars)');
  }
  return title.trim();
}

function requireContent(content: unknown): string {
  if (typeof content !== 'string') throw validationError('page "content" must be a string');
  if (content.length > CONTENT_MAX) throw validationError('page "content" exceeds 200KB');
  return content;
}

function requireAuthor(author: unknown): string {
  if (typeof author !== 'string' || !author.trim() || author.trim().length > AUTHOR_MAX) {
    throw validationError('comment "author" must be a non-empty string (max 100 chars)');
  }
  return author.trim();
}

function requireCommentText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.length > COMMENT_MAX) {
    throw validationError('comment "text" must be a non-empty string (max 5000 chars)');
  }
  return text;
}

function requireMentioned(mentioned: unknown): string {
  if (typeof mentioned !== 'string' || !mentioned.trim() || mentioned.trim().length > AUTHOR_MAX) {
    throw validationError('"mentioned" must be a non-empty string (max 100 chars)');
  }
  return mentioned.trim();
}

const NOT_FOUND_MARK = '__page_not_found__';
const VALIDATION_MARK = '__page_validation__';

function pageNotFound(id: string): Error {
  const err = new Error(`unknown page: ${id}`);
  (err as Error & { code?: string }).code = NOT_FOUND_MARK;
  return err;
}

function validationError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VALIDATION_MARK;
  return err;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === NOT_FOUND_MARK;
}

function isValidationError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === VALIDATION_MARK;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
