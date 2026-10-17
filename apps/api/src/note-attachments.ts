// SPDX-License-Identifier: Apache-2.0
// Feature interconnection (P2-E): attach notes/pages to bot context.
//
// A note (or page) can be attached bot-wide (every turn with that bot) or
// to a single chat thread (sessionId). Attached content is injected into
// the bot's context via an AgentRuntime context provider, so it lands in
// the system prompt of every turn — the bot genuinely "sees" it.
//
// Storage: <dataDir>/note-attachments.db (node:sqlite, same pattern as
// thread-scheduler.ts).
//
// Routes (router mounted at /api/note-attachments):
//   GET    /   → { ok, attachments }  (filter ?botId= ?sessionId=; no filter = all)
//   POST   /   → { kind: 'note'|'page', refId, botId?, sessionId? } → 201 { ok, attachment }
//   DELETE /:id → { ok: true }
//
// Wiring (one line at boot, next to the other host wiring in index.ts):
//   import { attachNoteContextProvider } from './note-attachments.js';
//   attachNoteContextProvider(agentRuntime, { dataDir: config.dataDir });
//
// The provider resolves attachments for (bot.id, sessionId) on every turn:
// bot-wide attachments apply to all of the bot's sessions, thread
// attachments only to their own session. Content is read live from the
// note/page stores (titles are denormalized for listing only). Provider
// failures never break a turn (the runtime swallows them per provider).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRuntime } from '@mvp/agent-runtime';
import { NoteStore, type Note } from './notes.js';
import { PageStore, type Page } from './pages.js';

import { openDb } from '@mvp/agent-runtime';

export type AttachmentKind = 'note' | 'page';

export interface NoteAttachment {
  id: string;
  kind: AttachmentKind;
  /** Note id or page id. */
  refId: string;
  /** Denormalized title for listing (content is always read live). */
  title: string;
  /** Bot-wide attachment when set. */
  botId?: string;
  /** Thread attachment when set. */
  sessionId?: string;
  createdAt: number;
}

interface AttachmentRow {
  id: string;
  kind: string;
  ref_id: string;
  title: string;
  bot_id: string | null;
  session_id: string | null;
  created_at: number;
}

function rowToAttachment(r: AttachmentRow): NoteAttachment {
  const a: NoteAttachment = {
    id: r.id,
    kind: r.kind as AttachmentKind,
    refId: r.ref_id,
    title: r.title,
    createdAt: r.created_at,
  };
  if (r.bot_id) a.botId = r.bot_id;
  if (r.session_id) a.sessionId = r.session_id;
  return a;
}

export interface AttachInput {
  kind: AttachmentKind;
  refId: string;
  botId?: string;
  sessionId?: string;
}

export class NoteAttachmentStore {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private readonly noteStore: NoteStore;
  private readonly pageStore: PageStore;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'note-attachments.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_attachments (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        bot_id TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_note_attachments_scope ON note_attachments(bot_id, session_id);
    `);
    this.noteStore = new NoteStore(dataDir);
    this.pageStore = new PageStore(dataDir);
  }

  /** Resolve the live title for a ref; throws when the ref does not exist. */
  private resolveTitle(kind: AttachmentKind, refId: string): string {
    if (kind === 'note') {
      const note: Note | undefined = this.noteStore.get(refId);
      if (!note) throw new Error(`unknown note: ${refId}`);
      return note.title;
    }
    const page: Page | undefined = this.pageStore.get(refId);
    if (!page) throw new Error(`unknown page: ${refId}`);
    return page.title;
  }

  attach(input: AttachInput): NoteAttachment {
    const kind = input.kind;
    if (kind !== 'note' && kind !== 'page') {
      throw new Error(`kind must be "note" or "page", got "${String(input.kind)}"`);
    }
    const refId = typeof input.refId === 'string' ? input.refId.trim() : '';
    if (!refId) throw new Error('refId is required');
    const botId =
      typeof input.botId === 'string' && input.botId.trim() ? input.botId.trim() : undefined;
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : undefined;
    if (!botId && !sessionId) {
      throw new Error('at least one of botId / sessionId is required');
    }
    const title = this.resolveTitle(kind, refId);
    // Idempotent: re-attaching the same ref to the same scope returns the
    // existing row instead of duplicating it.
    const dup = this.listAll().find(
      (a) => a.kind === kind && a.refId === refId && a.botId === botId && a.sessionId === sessionId,
    );
    if (dup) return dup;
    const a: NoteAttachment = {
      id: randomUUID(),
      kind,
      refId,
      title,
      createdAt: Date.now(),
    };
    if (botId) a.botId = botId;
    if (sessionId) a.sessionId = sessionId;
    this.db
      .prepare(
        'INSERT INTO note_attachments (id, kind, ref_id, title, bot_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(a.id, a.kind, a.refId, a.title, a.botId ?? null, a.sessionId ?? null, a.createdAt);
    return a;
  }

  detach(id: string): boolean {
    return this.db.prepare('DELETE FROM note_attachments WHERE id = ?').run(id).changes > 0;
  }

  listAll(): NoteAttachment[] {
    const rows = this.db
      .prepare('SELECT * FROM note_attachments ORDER BY created_at DESC')
      .all() as unknown as AttachmentRow[];
    return rows.map(rowToAttachment);
  }

  /**
   * Attachments that apply to a turn with (botId, sessionId): thread-scoped
   * rows for this session plus bot-wide rows (botId set, no sessionId) for
   * this bot. Used for context injection.
   */
  forTurn(botId: string, sessionId: string): NoteAttachment[] {
    return this.listAll().filter(
      (a) =>
        (a.sessionId !== undefined && a.sessionId === sessionId) ||
        (a.botId !== undefined && a.botId === botId && a.sessionId === undefined),
    );
  }

  /** Read live content for one attachment (note or page). */
  readContent(a: NoteAttachment): { title: string; content: string } | undefined {
    if (a.kind === 'note') {
      const note = this.noteStore.get(a.refId);
      return note ? { title: note.title, content: note.content } : undefined;
    }
    const page = this.pageStore.get(a.refId);
    return page ? { title: page.title, content: page.content } : undefined;
  }

  close(): void {
    this.db.close();
  }
}

// ---- Context injection -------------------------------------------------------

/** Per-attachment content budget; keeps the system prompt bounded. */
export const ATTACHMENT_ITEM_CHAR_BUDGET = 4000;
/** Total budget across all attachments on one turn. */
export const ATTACHMENT_TOTAL_CHAR_BUDGET = 12000;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated to ${max} chars]`;
}

/**
 * Build the context block for a turn. Returns undefined when nothing
 * attached (or nothing readable) so the provider adds nothing to the
 * prompt. Never throws — a throw means "no context".
 */
export function buildAttachmentContext(
  store: NoteAttachmentStore,
  botId: string,
  sessionId: string,
): string | undefined {
  const attachments = store.forTurn(botId, sessionId);
  if (attachments.length === 0) return undefined;
  const sections: string[] = [];
  let total = 0;
  for (const a of attachments) {
    let doc: { title: string; content: string } | undefined;
    try {
      doc = store.readContent(a);
    } catch {
      doc = undefined;
    }
    if (!doc) continue; // ref deleted since attaching — skip silently
    const body = truncate(doc.content, ATTACHMENT_ITEM_CHAR_BUDGET);
    if (total + body.length > ATTACHMENT_TOTAL_CHAR_BUDGET) break;
    total += body.length;
    sections.push(`## ${doc.title} (${a.kind})\n${body}`);
  }
  if (sections.length === 0) return undefined;
  return `# Attached reference material\nThe user attached the following note${sections.length === 1 ? '' : 's'} to this conversation. Treat ${sections.length === 1 ? 'it' : 'them'} as trusted context for your answers.\n\n${sections.join('\n\n')}`;
}

export interface AttachNoteContextProviderDeps {
  dataDir: string;
}

/** Runtimes already wired (createRouter may run more than once, e.g. tests). */
const wiredRuntimes = new WeakSet<AgentRuntime>();

/**
 * Host wiring: inject attached notes/pages into every bot turn's context.
 * Call once at boot with the main AgentRuntime (idempotent).
 */
export function attachNoteContextProvider(
  agentRuntime: AgentRuntime,
  deps: AttachNoteContextProviderDeps,
): void {
  if (wiredRuntimes.has(agentRuntime)) return;
  wiredRuntimes.add(agentRuntime);
  const store = new NoteAttachmentStore(deps.dataDir);
  agentRuntime.addContextProvider(({ bot, sessionId }) => {
    try {
      return buildAttachmentContext(store, bot.id, sessionId);
    } catch {
      return undefined;
    }
  });
}

// ---- Routes -------------------------------------------------------------------

function errorBody(error: string, detail?: string): Record<string, unknown> {
  return detail ? { error, detail } : { error };
}

export interface NoteAttachmentRouteDeps {
  dataDir: string;
}

/** Mount the /api/note-attachments routes. */
export function registerNoteAttachmentRoutes(router: Router, deps: NoteAttachmentRouteDeps): void {
  const store = new NoteAttachmentStore(deps.dataDir);

  router.get('/', (req: Request, res: Response) => {
    try {
      const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      let attachments = store.listAll();
      if (botId) attachments = attachments.filter((a) => a.botId === botId);
      if (sessionId) attachments = attachments.filter((a) => a.sessionId === sessionId);
      res.json({ ok: true, attachments });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list attachments', err instanceof Error ? err.message : 'unknown'));
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        kind?: unknown;
        refId?: unknown;
        botId?: unknown;
        sessionId?: unknown;
      };
      const attachment = store.attach({
        kind: body.kind as AttachmentKind,
        refId: typeof body.refId === 'string' ? body.refId : '',
        botId: typeof body.botId === 'string' ? body.botId : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      });
      res.status(201).json({ ok: true, attachment });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to attach';
      const status = /unknown (note|page)|kind must|refId is required|at least one of/.test(message) ? 400 : 500;
      res.status(status).json(errorBody(message));
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      if (!store.detach(req.params.id)) {
        res.status(404).json(errorBody(`Unknown attachment "${req.params.id}"`));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to detach', err instanceof Error ? err.message : 'unknown'));
    }
  });
}
