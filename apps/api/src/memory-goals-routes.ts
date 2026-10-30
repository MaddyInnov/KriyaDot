// SPDX-License-Identifier: Apache-2.0
// Memory & goals finishes routes (Muse parity audit §4.4).
//
// Register-style router — the coordinator mounts it (see the Wave-5
// wiring note); index.ts / routes.ts are untouched by this module.
//
//   One search box (MEM-4)
//     GET    /search?q=&botId=&limit=
//            merged results: tiered-memory atoms + main-chat excerpts
//            (SessionStore FTS) + channel side-chat excerpts
//            (ChannelSideChatStore, Wave 4) in ONE ranked list.
//   Memory explain (MEM-5)
//     GET    /memory/:botId/:atomId/explain
//            claim provenance (source turn, verbatim quote + its source,
//            grounding, evidence links, tier), confidence with a plain
//            label, conflicts, and the superseded-by / supersedes chains
//            walked over the store's typed links.
//   People & group pages (MEM-9)
//     GET    /people-pages · GET /people-pages/:name
//     POST   /people-pages/refresh { botId } · POST /people-pages/:name/note
//     POST   /people-pages/:name/kind { kind }
//   Paste import (MEM-6)
//     GET    /memory-import/prompt · POST /memory-import/paste { botId, markdown }
//   ZIP chat-export import (MEM-7)
//     POST   /memory-import/zip { botId, data: base64 }
//   Goal finishes (G-2/G-3/G-5/G-6/G-7/G-8) — only when deps.goalFinishes
//   is injected (GoalFinishesStore from @mvp/muse-modules):
//     PATCH  /goals/:id { title?, description? }
//     PATCH  /goals/:id/history/:entryId { note?, pct? }
//     DELETE /goals/:id/history/:entryId
//     POST   /goals/:id/subgoals { title, description? } · GET /goals/:id/subgoals
//     GET    /goals/tree
//     GET    /goals/:id/workspace
//     POST   /goals/:id/files { path, label? } · DELETE /goals/:id/files/:bindingId
//     POST   /goals/:id/jobs { jobId, kind?, label?, cron? } · DELETE /goals/:id/jobs/:bindingId
//     POST   /goals/:id/briefings { kind? } · GET /goals/:id/briefings
//     POST   /goals/:id/briefings/schedule { cron, enabled? }
//     POST   /goals/briefings/generate-due
//     GET    /goals/:id/delete-preview
//     DELETE /goals/:id { confirmTitle }        (confirm-gated + audited)
//   Tracked items (G-10) — only when deps.listTrackedItems is injected:
//     GET    /tracked-items?kind=&status=&goalId=

import { join } from 'node:path';
import express, { type Router } from 'express';
import type { AtomCard, MessageSearchHit, TieredMemoryStore } from '@mvp/agent-runtime';
import type { ChannelSideChatStore } from './channel-side-chats.js';
import { isZipArchive } from './file-intake.js';
import { PeoplePagesStore, type PageKind } from './people-pages.js';
import {
  MEMORY_EXPORT_PROMPT,
  importChatExportZip,
  importPasteMarkdown,
  type ChatExportSummarizer,
} from './memory-import.js';

// ---- Structural deps (the real stores satisfy these) -----------------------

export interface GoalFinishesLike {
  editGoal(id: string, patch: { title?: string; description?: string }): unknown;
  editProgressEntry(goalId: string, entryId: string, patch: { note?: string; pct?: number }): unknown;
  deleteProgressEntry(goalId: string, entryId: string): unknown;
  createSubgoal(parentId: string, input: { title: string; description?: string }): unknown;
  listSubgoals(parentId: string): unknown;
  listGoalTree(status?: 'active' | 'completed'): unknown;
  workspace(goalId: string): unknown;
  bindFile(goalId: string, input: { path: string; label?: string }): unknown;
  unbindFile(goalId: string, bindingId: string): boolean;
  bindJob(goalId: string, input: { jobId: string; kind?: string; label?: string; cron?: string; enabled?: boolean }): unknown;
  unbindJob(goalId: string, bindingId: string): boolean;
  generateBriefing(goalId: string, kind?: 'manual' | 'scheduled'): unknown;
  listBriefings(goalId: string): unknown;
  setBriefingSchedule(goalId: string, input: { cron: string; enabled?: boolean }): unknown;
  generateDueBriefings(): unknown;
  previewDelete(goalId: string): unknown;
  deleteGoalCascade(goalId: string, input: { confirmTitle: string }): unknown;
}

export interface TrackedItemLike {
  id: string;
  kind: string;
  title: string;
  status: string;
  dueAt: number | null;
  overdue: boolean;
  createdAt: number;
  goalId: string | null;
  detail: string;
}

export interface MemoryGoalsDeps {
  dataDir: string;
  memory: TieredMemoryStore;
  /** Main-chat FTS search (SessionStore.searchMessages in production). */
  searchMessages?: (query: string, opts: { botId?: string; sessionId?: string; limit?: number }) => MessageSearchHit[] | Promise<MessageSearchHit[]>;
  /** Wave-4 channel side chats; omit to skip the side-chat leg. */
  sideChats?: ChannelSideChatStore;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Local/mock summariser seam for MEM-7 (never a paid API in tests). */
  summarizer?: ChatExportSummarizer;
  goalFinishes?: GoalFinishesLike;
  listTrackedItems?: (opts: { kind?: string; status?: string; goalId?: string }) => TrackedItemLike[];
  peoplePages?: PeoplePagesStore;
}

// ---- MEM-4: merged search ---------------------------------------------------

export type MergedSearchKind = 'memory' | 'chat' | 'side-chat';

export interface MergedSearchResult {
  kind: MergedSearchKind;
  /** Atom id (memory), message id (chat), or side-chat message id. */
  id: string;
  botId?: string;
  sessionId?: string;
  sideChatId?: string;
  sideChatTitle?: string;
  title: string;
  excerpt: string;
  score: number;
  at: number | null;
}

export interface SideChatExcerpt {
  messageId: string;
  sideChatId: string;
  sideChatTitle: string;
  excerpt: string;
  at: number;
}

/** Case-insensitive all-terms substring search over side-chat transcripts. */
export function searchSideChatExcerpts(sideChats: ChannelSideChatStore, query: string, limit = 20): SideChatExcerpt[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const out: SideChatExcerpt[] = [];
  for (const chat of sideChats.listChats()) {
    for (const msg of sideChats.listMessages(chat.id, 500)) {
      if (!msg.text) continue;
      const lower = msg.text.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const at = lower.indexOf(terms[0]!);
      const start = Math.max(0, at - 60);
      const excerpt = `${start > 0 ? '…' : ''}${msg.text.slice(start, start + 180)}${start + 180 < msg.text.length ? '…' : ''}`;
      out.push({ messageId: msg.id, sideChatId: chat.id, sideChatTitle: chat.title, excerpt, at: Date.parse(msg.createdAt) || 0 });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function cleanSnippet(snippet: string): string {
  return snippet.replace(/\u0001/g, '').replace(/\u0002/g, '').trim();
}

/**
 * Merge the three legs into one ranked list. Each leg arrives
 * relevance-ordered; scores are a documented heuristic interleave
 * (memory: confidence-weighted, chats: position-decayed) so a strong
 * memory outranks a weak chat hit and vice versa, deterministically.
 */
export function mergeSearchResults(input: {
  atoms: AtomCard[];
  chatHits: MessageSearchHit[];
  sideExcerpts: SideChatExcerpt[];
  limit?: number;
}): MergedSearchResult[] {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const results: MergedSearchResult[] = [];
  input.atoms.forEach((atom, i) => {
    results.push({
      kind: 'memory', id: atom.id, botId: atom.botId,
      title: atom.fact.slice(0, 80), excerpt: atom.fact,
      score: 0.5 + atom.confidence * 0.5 - i * 0.01, at: atom.createdAt,
    });
  });
  input.chatHits.forEach((hit, i) => {
    results.push({
      kind: 'chat', id: String(hit.messageId), botId: hit.botId, sessionId: hit.sessionId,
      title: `Chat · ${hit.sessionId}`, excerpt: cleanSnippet(hit.snippet),
      score: Math.max(0.1, 0.9 - i * 0.05), at: Date.parse(hit.ts) || null,
    });
  });
  input.sideExcerpts.forEach((ex, i) => {
    results.push({
      kind: 'side-chat', id: ex.messageId, sideChatId: ex.sideChatId, sideChatTitle: ex.sideChatTitle,
      title: ex.sideChatTitle, excerpt: ex.excerpt,
      score: Math.max(0.1, 0.85 - i * 0.05), at: ex.at || null,
    });
  });
  const kindOrder: Record<MergedSearchKind, number> = { memory: 0, chat: 1, 'side-chat': 2 };
  results.sort((a, b) => b.score - a.score || kindOrder[a.kind] - kindOrder[b.kind]);
  return results.slice(0, limit);
}

// ---- MEM-5: memory explain ----------------------------------------------------

export interface AtomRef {
  id: string;
  fact: string;
  confidence: number;
  active: boolean;
  createdAt: number;
}

export interface MemoryExplanation {
  atom: AtomCard;
  provenance: {
    sourceTurn: string;
    quote: string | null;
    quoteSource: string | null;
    grounding: string | null;
    evidenceLinks: string[];
    category: string;
    tier: string;
    pinned: boolean;
    archived: boolean;
  };
  confidence: { value: number; label: 'high' | 'medium' | 'low' };
  /** Atoms that replaced this one, oldest replacement first (walked via 'supersedes' links). */
  supersededByChain: AtomRef[];
  /** Atoms this one replaced, in the order it replaced them. */
  supersedesChain: AtomRef[];
  conflicts: Array<{ id: string; status: string; winnerId: string | null; other: AtomRef | null }>;
}

function atomRef(atom: AtomCard): AtomRef {
  return { id: atom.id, fact: atom.fact, confidence: atom.confidence, active: atom.active, createdAt: atom.createdAt };
}

export function explainMemoryAtom(memory: TieredMemoryStore, botId: string, atomId: string): MemoryExplanation | null {
  const atom = memory.getAtom(botId, atomId);
  if (!atom) return null;
  const links = memory.getLinks(botId, 2000);

  const walk = (startId: string, direction: 'by' | 'does'): AtomRef[] => {
    const chain: AtomRef[] = [];
    const seen = new Set<string>([startId]);
    let current = startId;
    for (let step = 0; step < 20; step += 1) {
      const link = direction === 'by'
        ? links.find((l) => l.kind === 'supersedes' && l.toAtomId === current)
        : links.find((l) => l.kind === 'supersedes' && l.fromAtomId === current);
      if (!link) break;
      const nextId = direction === 'by' ? link.fromAtomId : link.toAtomId;
      if (seen.has(nextId)) break;
      seen.add(nextId);
      const next = memory.getAtom(botId, nextId);
      if (!next) break;
      chain.push(atomRef(next));
      current = nextId;
    }
    return chain;
  };

  const conflicts = memory
    .listConflicts(botId, 'all')
    .filter((c) => c.atomAId === atomId || c.atomBId === atomId)
    .map((c) => {
      const otherId = c.atomAId === atomId ? c.atomBId : c.atomAId;
      const other = memory.getAtom(botId, otherId);
      return { id: c.id, status: c.status, winnerId: c.winnerId, other: other ? atomRef(other) : null };
    });

  return {
    atom,
    provenance: {
      sourceTurn: atom.sourceTurn,
      quote: atom.quote ?? null,
      quoteSource: atom.quoteSource ?? null,
      grounding: atom.grounding ?? null,
      evidenceLinks: atom.evidenceLinks ?? [],
      category: atom.category,
      tier: atom.tier,
      pinned: atom.pinned,
      archived: atom.archived ?? false,
    },
    confidence: {
      value: atom.confidence,
      label: atom.confidence >= 0.8 ? 'high' : atom.confidence >= 0.5 ? 'medium' : 'low',
    },
    supersededByChain: walk(atomId, 'by'),
    supersedesChain: walk(atomId, 'does'),
    conflicts,
  };
}

// ---- Router -------------------------------------------------------------------

function statusFor(err: unknown): number {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotFoundError') return 404;
  if (name === 'ValidationError') return 400;
  if (name === 'PermissionError') return 403;
  return 500;
}

export interface MemoryGoalsHandle {
  router: Router;
  peoplePages: PeoplePagesStore;
}

export function createMemoryGoalsRouter(deps: MemoryGoalsDeps): MemoryGoalsHandle {
  const router = express.Router();
  const peoplePages = deps.peoplePages ?? new PeoplePagesStore(deps.dataDir);
  const body = (req: express.Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
  const fail = (res: express.Response, err: unknown, fallback: string): void => {
    res.status(statusFor(err)).json({ ok: false, error: err instanceof Error ? err.message : fallback });
  };

  // MEM-4 — one search box over memory + main chat + side chats.
  router.get('/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q.length < 2) { res.status(400).json({ ok: false, error: 'q is required (at least 2 characters)' }); return; }
      const botId = typeof req.query.botId === 'string' && req.query.botId.trim() ? req.query.botId.trim() : undefined;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
      const atoms = botId ? deps.memory.searchAtoms(botId, q, 50) : [];
      const chatHits = deps.searchMessages ? await deps.searchMessages(q, { ...(botId ? { botId } : {}), limit: 50 }) : [];
      const sideExcerpts = deps.sideChats ? searchSideChatExcerpts(deps.sideChats, q, 50) : [];
      const results = mergeSearchResults({ atoms, chatHits, sideExcerpts, limit: Number.isFinite(limit) ? limit : 20 });
      res.json({
        ok: true, query: q, results,
        counts: { memory: atoms.length, chat: chatHits.length, sideChat: sideExcerpts.length },
      });
    } catch (err) { fail(res, err, 'search failed'); }
  });

  // MEM-5 — explain one memory claim.
  router.get('/memory/:botId/:atomId/explain', (req, res) => {
    const explanation = explainMemoryAtom(deps.memory, req.params.botId, req.params.atomId);
    if (!explanation) { res.status(404).json({ ok: false, error: `unknown memory atom: ${req.params.atomId}` }); return; }
    res.json({ ok: true, explanation });
  });

  // MEM-9 — people & group pages.
  router.get('/people-pages', (_req, res) => {
    res.json({ ok: true, pages: peoplePages.listPages() });
  });
  router.get('/people-pages/:name', (req, res) => {
    const page = peoplePages.getPage(req.params.name);
    if (!page) { res.status(404).json({ ok: false, error: `no page for: ${req.params.name}` }); return; }
    res.json({ ok: true, page });
  });
  router.post('/people-pages/refresh', (req, res) => {
    try {
      const botId = String(body(req).botId ?? '');
      if (!botId) { res.status(400).json({ ok: false, error: 'botId is required' }); return; }
      const pages = peoplePages.refreshFromMemory(deps.memory, botId);
      deps.audit('memory.people_pages_refresh', { actor: 'api', detail: { botId, pages: pages.length } });
      res.json({ ok: true, pages });
    } catch (err) { fail(res, err, 'people page refresh failed'); }
  });
  router.post('/people-pages/:name/note', (req, res) => {
    try {
      const page = peoplePages.appendNote(req.params.name, String(body(req).text ?? ''));
      res.status(201).json({ ok: true, page });
    } catch (err) { fail(res, err, 'failed to append note'); }
  });
  router.post('/people-pages/:name/kind', (req, res) => {
    try {
      const page = peoplePages.setKind(req.params.name, String(body(req).kind ?? '') as PageKind);
      res.json({ ok: true, page });
    } catch (err) { fail(res, err, 'failed to set page kind'); }
  });

  // MEM-6 — guided paste-import.
  router.get('/memory-import/prompt', (_req, res) => {
    res.json({ ok: true, prompt: MEMORY_EXPORT_PROMPT });
  });
  router.post('/memory-import/paste', (req, res) => {
    try {
      const b = body(req);
      const botId = String(b.botId ?? '');
      const markdown = String(b.markdown ?? '');
      if (!botId) { res.status(400).json({ ok: false, error: 'botId is required' }); return; }
      if (!markdown.trim()) { res.status(400).json({ ok: false, error: 'markdown is required' }); return; }
      const result = importPasteMarkdown(deps.memory, botId, markdown);
      deps.audit('memory.paste_import', { actor: 'api', detail: { botId, parsed: result.parsed, stored: result.storedAtomIds.length } });
      res.status(201).json({ ok: true, ...result });
    } catch (err) { fail(res, err, 'paste import failed'); }
  });

  // MEM-7 — consumer ZIP chat-export intake.
  router.post('/memory-import/zip', async (req, res) => {
    try {
      const b = body(req);
      const botId = String(b.botId ?? '');
      if (!botId) { res.status(400).json({ ok: false, error: 'botId is required' }); return; }
      if (typeof b.data !== 'string' || !b.data) { res.status(400).json({ ok: false, error: '"data" (base64 zip) is required' }); return; }
      const data = new Uint8Array(Buffer.from(b.data, 'base64'));
      if (!isZipArchive(data)) { res.status(400).json({ ok: false, error: 'payload is not a zip archive' }); return; }
      const result = await importChatExportZip(deps.memory, botId, data, {
        workRoot: join(deps.dataDir, 'memory-import-workspace'),
        ...(deps.summarizer ? { summarizer: deps.summarizer } : {}),
      });
      deps.audit('memory.zip_import', { actor: 'api', detail: { botId, conversations: result.conversations, stored: result.storedAtomIds.length } });
      res.status(201).json({ ok: true, ...result });
    } catch (err) { fail(res, err, 'zip import failed'); }
  });

  // Goal finishes (G-2/G-3/G-5/G-6/G-7/G-8) — injected store only.
  if (deps.goalFinishes) {
    const gf = deps.goalFinishes;
    const goals = express.Router();
    goals.get('/tree', (req, res) => {
      try { res.json({ ok: true, goals: gf.listGoalTree(req.query.status as 'active' | 'completed' | undefined) }); }
      catch (err) { fail(res, err, 'failed to list goal tree'); }
    });
    goals.post('/briefings/generate-due', (_req, res) => {
      try {
        const made = gf.generateDueBriefings() as unknown[];
        deps.audit('goals.briefings_generate_due', { actor: 'api', detail: { generated: made.length } });
        res.status(201).json({ ok: true, briefings: made });
      } catch (err) { fail(res, err, 'failed to generate due briefings'); }
    });
    goals.patch('/:id', (req, res) => {
      try {
        const b = body(req);
        res.json({ ok: true, goal: gf.editGoal(req.params.id, { title: b.title as string | undefined, description: b.description as string | undefined }) });
      } catch (err) { fail(res, err, 'failed to edit goal'); }
    });
    goals.patch('/:id/history/:entryId', (req, res) => {
      try {
        const b = body(req);
        res.json({ ok: true, entry: gf.editProgressEntry(req.params.id, req.params.entryId, { note: b.note as string | undefined, pct: b.pct as number | undefined }) });
      } catch (err) { fail(res, err, 'failed to edit progress entry'); }
    });
    goals.delete('/:id/history/:entryId', (req, res) => {
      try { res.json({ ok: true, ...((gf.deleteProgressEntry(req.params.id, req.params.entryId) as Record<string, unknown>) ?? {}) }); }
      catch (err) { fail(res, err, 'failed to delete progress entry'); }
    });
    goals.post('/:id/subgoals', (req, res) => {
      try {
        const b = body(req);
        res.status(201).json({ ok: true, goal: gf.createSubgoal(req.params.id, { title: String(b.title ?? ''), description: b.description as string | undefined }) });
      } catch (err) { fail(res, err, 'failed to create subgoal'); }
    });
    goals.get('/:id/subgoals', (req, res) => {
      try { res.json({ ok: true, subgoals: gf.listSubgoals(req.params.id) }); }
      catch (err) { fail(res, err, 'failed to list subgoals'); }
    });
    goals.get('/:id/workspace', (req, res) => {
      try { res.json({ ok: true, workspace: gf.workspace(req.params.id) }); }
      catch (err) { fail(res, err, 'failed to read goal workspace'); }
    });
    goals.post('/:id/files', (req, res) => {
      try {
        const b = body(req);
        res.status(201).json({ ok: true, file: gf.bindFile(req.params.id, { path: String(b.path ?? ''), label: b.label as string | undefined }) });
      } catch (err) { fail(res, err, 'failed to bind file'); }
    });
    goals.delete('/:id/files/:bindingId', (req, res) => {
      try { res.json({ ok: true, removed: gf.unbindFile(req.params.id, req.params.bindingId) }); }
      catch (err) { fail(res, err, 'failed to unbind file'); }
    });
    goals.post('/:id/jobs', (req, res) => {
      try {
        const b = body(req);
        res.status(201).json({
          ok: true,
          job: gf.bindJob(req.params.id, {
            jobId: String(b.jobId ?? ''), kind: b.kind as string | undefined,
            label: b.label as string | undefined, cron: b.cron as string | undefined,
            enabled: b.enabled as boolean | undefined,
          }),
        });
      } catch (err) { fail(res, err, 'failed to bind job'); }
    });
    goals.delete('/:id/jobs/:bindingId', (req, res) => {
      try { res.json({ ok: true, removed: gf.unbindJob(req.params.id, req.params.bindingId) }); }
      catch (err) { fail(res, err, 'failed to unbind job'); }
    });
    goals.post('/:id/briefings', (req, res) => {
      try {
        const kind = body(req).kind === 'scheduled' ? 'scheduled' : 'manual';
        res.status(201).json({ ok: true, briefing: gf.generateBriefing(req.params.id, kind) });
      } catch (err) { fail(res, err, 'failed to generate briefing'); }
    });
    goals.get('/:id/briefings', (req, res) => {
      try { res.json({ ok: true, briefings: gf.listBriefings(req.params.id) }); }
      catch (err) { fail(res, err, 'failed to list briefings'); }
    });
    goals.post('/:id/briefings/schedule', (req, res) => {
      try {
        const b = body(req);
        res.status(201).json({ ok: true, schedule: gf.setBriefingSchedule(req.params.id, { cron: String(b.cron ?? ''), enabled: b.enabled as boolean | undefined }) });
      } catch (err) { fail(res, err, 'failed to set briefing schedule'); }
    });
    goals.get('/:id/delete-preview', (req, res) => {
      try { res.json({ ok: true, preview: gf.previewDelete(req.params.id) }); }
      catch (err) { fail(res, err, 'failed to preview deletion'); }
    });
    goals.delete('/:id', (req, res) => {
      try {
        const receipt = gf.deleteGoalCascade(req.params.id, { confirmTitle: String(body(req).confirmTitle ?? '') }) as Record<string, unknown>;
        deps.audit('goals.delete_cascade', { actor: 'api', detail: { goalId: req.params.id, ...receipt } });
        res.json({ ok: true, receipt });
      } catch (err) { fail(res, err, 'failed to delete goal'); }
    });
    router.use('/goals', goals);
  }

  // G-10 — unified tracked-items view (injected provider).
  if (deps.listTrackedItems) {
    router.get('/tracked-items', (req, res) => {
      try {
        const items = deps.listTrackedItems!({
          kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          goalId: typeof req.query.goalId === 'string' ? req.query.goalId : undefined,
        });
        res.json({
          ok: true, items,
          summary: {
            total: items.length,
            overdue: items.filter((i) => i.overdue).length,
            byKind: {
              reminder: items.filter((i) => i.kind === 'reminder').length,
              commitment: items.filter((i) => i.kind === 'commitment').length,
              task: items.filter((i) => i.kind === 'task').length,
            },
          },
        });
      } catch (err) { fail(res, err, 'failed to list tracked items'); }
    });
  }

  return { router, peoplePages };
}
